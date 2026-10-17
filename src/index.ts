import path from "node:path";
import fs from "node:fs";
import { InlineKeyboard } from "grammy";
import { Approvals } from "./approvals.ts";
import { loadConfig, type Config } from "./config.ts";
import { Conversation } from "./conversation.ts";
import { Delivery } from "./delivery.ts";
import { Store } from "./db.ts";
import { logger, setLogLevel } from "./log.ts";
import { startHqServer, type DependencyCheck, type ReadinessReport } from "./mcp.ts";
import { OpenCode, type GlobalEvent } from "./opencode.ts";
import { Scheduler } from "./scheduler.ts";
import { Tasks } from "./tasks.ts";
import { COMMAND_MENU, createBot, registerHandlers } from "./telegram/bot.ts";
import { TelegramChat } from "./telegram/chat.ts";
import { loadVaultKey, Vault } from "./vault.ts";
import { MediaProcessor, TesseractOcr, WhisperCppStt } from "./media.ts";

/** Build the media pipeline from config; undefined when neither engine is configured. */
function buildMedia(cfg: Config, botToken: string): MediaProcessor | undefined {
  const ocr = cfg.TESSERACT_BIN ? new TesseractOcr(cfg.TESSERACT_BIN, cfg.TESSERACT_LANG) : undefined;
  const stt = cfg.WHISPER_BIN && cfg.WHISPER_MODEL ? new WhisperCppStt(cfg.WHISPER_BIN, cfg.WHISPER_MODEL, cfg.WHISPER_LANG, cfg.FFMPEG_BIN) : undefined;
  if (!ocr && !stt) return undefined;
  const apiRoot = `https://api.telegram.org/file/bot${botToken}`;
  return new MediaProcessor({
    ...(ocr ? { ocr } : {}),
    ...(stt ? { stt } : {}),
    download: async (fileId, dest) => {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getFile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
      });
      const meta = (await res.json()) as { ok: boolean; result?: { file_path?: string }; description?: string };
      if (!meta.ok || !meta.result?.file_path) throw new Error(`getFile failed: ${meta.description ?? "unknown"}`);
      const file = await fetch(`${apiRoot}/${meta.result.file_path}`);
      if (!file.ok || !file.body) throw new Error(`download failed: HTTP ${file.status}`);
      await fs.promises.writeFile(dest, Buffer.from(await file.arrayBuffer()));
      return dest;
    },
  });
}

const log = logger("main");

async function ensureHqConnected(oc: OpenCode, cfg: Config) {
  try {
    const hq = (await oc.mcpStatus(cfg.ASSISTANT_HOME)).hq;
    if (!hq) log.warn('OpenCode has no MCP server named "hq" — check opencode/opencode.json is the config OpenCode loads');
    else if (hq.status !== "connected") {
      log.warn(`hq MCP status is ${hq.status}${hq.error ? ` (${hq.error})` : ""}; reconnecting`);
      await oc.mcpConnect("hq", cfg.ASSISTANT_HOME);
    }
  } catch (err) {
    log.warn(`could not check MCP status: ${(err as Error).message}`);
  }
}

async function main() {
  const cfg = loadConfig();
  setLogLevel(cfg.LOG_LEVEL);

  const store = new Store(path.join(cfg.DATA_DIR, "assistant.db"));
  const vault = new Vault(store, loadVaultKey(cfg));
  const oc = new OpenCode({ url: cfg.OPENCODE_URL, username: cfg.OPENCODE_SERVER_USERNAME, password: cfg.OPENCODE_SERVER_PASSWORD });
  const bot = createBot(cfg.TELEGRAM_BOT_TOKEN);
  const chat = new TelegramChat(bot.api, cfg.OWNER_TELEGRAM_ID);
  const delivery = new Delivery(store, chat);
  delivery.recover();
  delivery.start();

  // Readiness is separate from liveness: /health only says the process serves,
  // /ready reports whether the dependencies the gateway needs actually answer.
  const readiness = async (): Promise<ReadinessReport> => {
    const checks: Record<string, DependencyCheck> = {};
    try {
      store.db.prepare("SELECT 1 AS ok").get();
      checks.store = { ok: true };
    } catch (err) {
      checks.store = { ok: false, detail: (err as Error).message };
    }
    try {
      await oc.health();
      checks.opencode = { ok: true };
    } catch (err) {
      checks.opencode = { ok: false, detail: (err as Error).message };
    }
    const telegram = bot.isInited();
    checks.telegram = telegram ? { ok: true } : { ok: false, detail: "Telegram polling is not running" };
    return { ready: Object.values(checks).every((c) => c.ok), checks };
  };

  // Prune terminal history at most once a day. Pending work is never eligible.
  const pruneHistory = () => {
    const now = Date.now();
    if (now - Number(store.get("retention.last") ?? 0) < 24 * 3_600_000) return;
    const cutoff = now - cfg.RETENTION_DAYS * 86_400_000;
    const deleted = store.applyRetention({ updatesBefore: cutoff, inboundBefore: cutoff, outboundBefore: cutoff, approvalsBefore: cutoff, turnsBefore: cutoff, attemptsBefore: cutoff });
    store.set("retention.last", String(now));
    const total = Object.values(deleted).reduce((sum, n) => sum + n, 0);
    if (total > 0) log.info("retention pruned terminal history", deleted);
  };

  // Wiring has a cycle (quiet hours live in the scheduler, which needs tasks, which nudge the conversation).
  let scheduler: Scheduler | undefined;
  const isQuiet = () => scheduler?.isQuiet() ?? false;
  let tasks: Tasks;
  const conversation = new Conversation({ cfg, store, oc, chat, isQuiet, delivery, delegate: (title, brief) => tasks.start({ title, brief }) });
  const kick = () => void conversation.pump();
  tasks = new Tasks({
    cfg,
    store,
    oc,
    onUpdate: kick,
    onStuck: (t, idleFor) => {
      const kb = new InlineKeyboard().text("Keep waiting", `st:k:${t.slug}`).text("Stop it", `st:s:${t.slug}`);
      void chat
        .sendHtml(`⚠️ Task <b>${t.slug}</b> ("${t.title.replace(/</g, "&lt;")}") has shown no activity for ${idleFor}. It may be stuck.`, { keyboard: kb })
        .catch((err) => {
          log.warn(`stuck-task alert not delivered (${(err as Error).message}); falling back to an update note`);
          store.enqueueUpdate("task", `Task ${t.slug} ("${t.title}") has shown no activity for ${idleFor}. It may be stuck.`);
          kick();
        });
    },
  });
  const labelFor = (sessionID: string) => {
    if (sessionID === conversation.sessionID) return "me (main chat)";
    const t = store.taskBySession(sessionID);
    return t ? `task ${t.slug}` : "another session";
  };
  const approvals = new Approvals({ store, oc, chat, labelFor, isQuiet });
  scheduler = new Scheduler({
    cfg,
    store,
    tasks,
    oc,
    onUpdate: kick,
    housekeeping: async () => {
      await approvals.nudge();
      await conversation.watchdog();
      pruneHistory();
    },
  });

  // The MCP endpoint must be up before OpenCode tries to connect to it.
  const hq = await startHqServer({ cfg, store, tasks, scheduler, onUpdate: kick, vault, readiness });
  await oc.waitUntilHealthy();
  await ensureHqConnected(oc, cfg);
  await conversation.ensureMainSession();

  const reconcile = async () => {
    await ensureHqConnected(oc, cfg);
    await conversation.reconcile();
    await tasks.reconcile();
    await approvals.reconcile([cfg.ASSISTANT_HOME, ...tasks.directories()]);
  };

  const dispatch = async ({ directory, payload: ev }: GlobalEvent) => {
    switch (ev.type) {
      case "server.connected":
        void reconcile().catch((err) => log.error("reconcile failed", err));
        return;
      case "session.status": {
        const { sessionID, status } = ev.properties;
        if (sessionID === conversation.sessionID) {
          if (status.type !== "idle") conversation.onMainBusy();
        } else if (status.type === "busy") tasks.onBusy(sessionID);
        return;
      }
      case "session.idle": {
        const { sessionID } = ev.properties;
        if (sessionID === conversation.sessionID) void conversation.onMainIdle();
        else if (tasks.isWorker(sessionID)) await tasks.onIdle(sessionID);
        return;
      }
      case "session.error":
        if (ev.properties.sessionID && tasks.isWorker(ev.properties.sessionID)) tasks.onError(ev.properties.sessionID, ev.properties.error);
        return;
      case "permission.asked":
        await approvals.onPermissionAsked(ev.properties, directory ?? cfg.ASSISTANT_HOME);
        return;
      case "question.asked":
        await approvals.onQuestionAsked(ev.properties, directory ?? cfg.ASSISTANT_HOME);
        return;
      case "permission.replied":
      case "question.replied":
      case "question.rejected":
        await approvals.onReplied(ev.properties.requestID);
        return;
      case "message.updated": {
        const info = ev.properties.info;
        if (info.role === "assistant" && info.time.completed) {
          store.recordSpend(info.id, info.sessionID, info.cost, info.time.completed);
          const tokens = info.tokens;
          if (tokens) store.recordReasoningUsage(`session-${info.sessionID}`, tokens.input, tokens.output, tokens.reasoning, info.cost, info.time.completed);
        }
        tasks.onActivity(ev.properties.sessionID);
        return;
      }
      case "message.part.updated":
      case "todo.updated":
        tasks.onActivity(ev.properties.sessionID);
        return;
    }
  };

  const abort = new AbortController();
  void (async () => {
    for await (const ev of oc.events(abort.signal)) {
      try {
        await dispatch(ev);
      } catch (err) {
        log.error(`handling ${ev.payload.type} failed`, err);
      }
    }
  })();

  scheduler.start();
  const media = buildMedia(cfg, cfg.TELEGRAM_BOT_TOKEN);
  if (media) log.info(`media pipeline: ${media.capabilities()}`);
  registerHandlers(bot, { cfg, store, oc, conversation, tasks, approvals, scheduler, labelFor, ...(media ? { media } : {}) });
  await bot.api.setMyCommands(COMMAND_MENU).catch((err) => log.warn(`could not set the command menu: ${(err as Error).message}`));
  bot.start({ onStart: (me) => log.info(`telegram bot @${me.username} is listening (owner ${cfg.OWNER_TELEGRAM_ID})`) }).catch((err) => {
    log.error("Telegram polling stopped (bad TELEGRAM_BOT_TOKEN, or another instance is polling the same bot)", err);
    process.exit(1);
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: shutting down`);
    abort.abort();
    scheduler?.stop();
    conversation.shutdown();
    await bot.stop().catch(() => {});
    await delivery.drain();
    hq.close();
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
