import path from "node:path";
import fs from "node:fs";
import { InlineKeyboard } from "grammy";
import { Approvals } from "./approvals.ts";
import { Catalog } from "./catalog.ts";
import { loadConfig, type Config } from "./config.ts";
import { Conversation } from "./conversation.ts";
import { Delivery } from "./delivery.ts";
import { Store, type TokenTotals } from "./db.ts";
import { Kinds } from "./kinds.ts";
import { Limits, type Breach } from "./limits.ts";
import { logger, setLogLevel } from "./log.ts";
import { startHqServer, type DependencyCheck, type ReadinessReport } from "./mcp.ts";
import { OpenCode, type GlobalEvent } from "./opencode.ts";
import { crowbotBalance } from "./provider.ts";
import { Roles } from "./roles.ts";
import { Scheduler } from "./scheduler.ts";
import { Subagents } from "./subagents.ts";
import { Tasks } from "./tasks.ts";
import { usd } from "./text.ts";
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
    const deleted = store.applyRetention({ updatesBefore: cutoff, inboundBefore: cutoff, outboundBefore: cutoff, approvalsBefore: cutoff, turnsBefore: cutoff, attemptsBefore: cutoff, subagentsBefore: cutoff });
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
  // Subagents, model routing and spend caps.
  const catalog = new Catalog({ cfg, store, oc });
  const kinds = new Kinds({ cfg, oc });
  let roles: Roles;
  /** What a session runs on, so its tokens can be priced with crowbot's catalog. */
  const modelFor = (sessionID: string): string | undefined => {
    if (sessionID === conversation.sessionID) {
      try {
        return roles.resolve("chat").ref;
      } catch {
        return undefined;
      }
    }
    return store.taskBySession(sessionID)?.model ?? store.subagentRunBySession(sessionID)?.model ?? undefined;
  };
  const crowbotKey = cfg.CROWBOT_API_KEY;
  const limits = new Limits({ cfg, store, catalog, kinds, modelFor, ...(crowbotKey ? { balance: async () => (await crowbotBalance(crowbotKey)).balanceUsd } : {}) });
  roles = new Roles({ cfg, store, catalog, kinds, maxPrice: () => limits.get("price") });
  const subagents = new Subagents({ cfg, store, oc, kinds, roles, limits, parent: () => conversation.currentTurn(), onUpdate: kick });
  tasks.attach({ roles, limits });
  conversation.attach({ roles, limits, subagents });

  /** Interrupt whatever a live usage event says broke a cap. Period caps tell the owner once a day. */
  const handleBreaches = async (breaches: Breach[]) => {
    for (const b of breaches) {
      switch (b.cap) {
        case "task":
          await tasks.stopForCap(b.sessionID, `it reached its ${usd(b.limit)} cost cap (spent ${usd(b.spent)})`);
          break;
        case "call":
          await subagents.stop(b.runID, "capped", `reached its ${usd(b.limit)} cap`);
          break;
        case "turn":
          await subagents.stopTurn(b.turnID, "capped", `this turn's delegations reached ${usd(b.limit)}`);
          break;
        case "subagents":
          await subagents.stopAll("capped", `today's subagent budget of ${usd(b.limit)} is used up`);
          if (limits.firstTrip("subagents")) log.warn(`subagent budget reached: ${usd(b.spent)} of ${usd(b.limit)}`);
          break;
        case "daily":
        case "monthly": {
          const why = `the ${b.cap} budget of ${usd(b.limit)} is used up (${usd(b.spent)})`;
          await subagents.stopAll("capped", why);
          await tasks.stopAll(why);
          if (limits.firstTrip(b.cap)) {
            log.warn(`${b.cap} budget reached; stopped background work`);
            await chat
              .sendText(`⚠️ Spending cap: ${why}. I stopped background work and won't start more until it resets or you raise it (/limits).`, { bubbles: false })
              .catch((err) => log.warn(`cap notice not delivered: ${(err as Error).message}`));
          }
          break;
        }
      }
    }
  };

  /** Tell the assistant once when crowbot's catalog and OpenCode's model list drift apart. */
  const refreshCatalog = async () => {
    await catalog.refresh();
    if (!catalog.hasCrowbot()) return;
    const drift = catalog.drift();
    const signature = JSON.stringify(drift);
    if ((drift.missing.length || drift.prices.length) && store.get("catalog.driftNotified") !== signature) {
      store.set("catalog.driftNotified", signature);
      const bits = [
        drift.missing.length ? `crowbot serves ${drift.missing.join(", ")}, which OpenCode can't run yet` : "",
        drift.prices.length ? `opencode.json has stale prices for ${drift.prices.map((p) => p.id).join(", ")} (caps use crowbot's)` : "",
      ].filter(Boolean);
      log.warn(`model catalog drift: ${bits.join("; ")}`);
      store.enqueueUpdate("system", `Model catalog drift: ${bits.join("; ")}. The operator can fix it with \`npm run models:sync\` and a redeploy. Mention it to the user only if they ask about models.`);
    }
  };

  /**
   * Rediscover the kinds. OpenCode lists hq's tools once when it connects and keeps that list, and
   * hq_delegate exists (with its kind enum) only once kinds are known, so reconnect hq when they change.
   */
  let kindSignature = "";
  const syncKinds = async () => {
    const complete = await kinds.refresh();
    const signature = kinds.list().map((k) => `${k.id}:${k.when ?? ""}:${(k.tools ?? []).join("+")}`).join(",");
    if (signature !== kindSignature) {
      kindSignature = signature;
      await oc.mcpReconnect("hq", cfg.ASSISTANT_HOME).catch((err) => log.warn(`could not reconnect hq to refresh its tools: ${(err as Error).message}`));
      log.info(`subagent kinds: ${kinds.list().map((k) => `${k.id} → ${roles.describe(k.id)}`).join("; ") || "none"}`);
    }
    return complete;
  };

  const labelFor = (sessionID: string) => {
    if (sessionID === conversation.sessionID) return "me (main chat)";
    const t = store.taskBySession(sessionID);
    if (t) return `task ${t.slug}`;
    const kind = subagents.kindOf(sessionID);
    return kind ? `subagent ${kind} (for me)` : "another session";
  };
  const approvals = new Approvals({ store, oc, chat, labelFor, isQuiet });
  /**
   * Every few minutes, show any permission or question OpenCode is waiting on that we never saw
   * (a missed or renamed event), so a turn can't sit blocked on a prompt nobody was shown.
   */
  let lastSweep = 0;
  const sweepApprovals = async () => {
    if (Date.now() - lastSweep < 3 * 60_000) return;
    lastSweep = Date.now();
    await approvals.reconcile([cfg.ASSISTANT_HOME, ...tasks.directories()]).catch((err) => log.warn(`approval sweep failed: ${(err as Error).message}`));
  };
  scheduler = new Scheduler({
    cfg,
    store,
    tasks,
    oc,
    onUpdate: kick,
    housekeeping: async () => {
      await approvals.nudge();
      await conversation.watchdog();
      await limits.refreshBalance();
      await sweepApprovals();
      pruneHistory();
    },
  });

  // The MCP endpoint must be up before OpenCode tries to connect to it.
  const hq = await startHqServer({ cfg, store, tasks, scheduler, onUpdate: kick, vault, readiness, subagents, kinds, roles, limits });
  await oc.waitUntilHealthy();
  await ensureHqConnected(oc, cfg);
  // The catalog first, so the kinds' models are resolved (and logged) against crowbot's list.
  await Promise.all([refreshCatalog(), limits.refreshBalance()]);
  const kindsComplete = await syncKinds();
  if (!kindsComplete) setTimeout(() => void syncKinds(), 30_000).unref();
  subagents.recover();
  await conversation.ensureMainSession();
  const catalogTimer = setInterval(() => void refreshCatalog().catch((err) => log.warn(`catalog refresh failed: ${(err as Error).message}`)), cfg.CATALOG_REFRESH_MIN * 60_000);
  catalogTimer.unref();

  const reconcile = async () => {
    await ensureHqConnected(oc, cfg);
    await syncKinds();
    await refreshCatalog().catch((err) => log.warn(`catalog refresh failed: ${(err as Error).message}`));
    await conversation.reconcile();
    await tasks.reconcile();
    await subagents.reconcile();
    await approvals.reconcile([cfg.ASSISTANT_HOME, ...tasks.directories()]);
  };

  const dispatch = async (ev: GlobalEvent) => {
    const directory = ev.location?.directory ?? cfg.ASSISTANT_HOME;
    const d = ev.data as Record<string, unknown>;
    const sessionID = typeof d.sessionID === "string" ? d.sessionID : undefined;
    switch (ev.type) {
      case "server.connected":
        void reconcile().catch((err) => log.error("reconcile failed", err));
        return;
      case "session.execution.started": {
        if (!sessionID) return;
        if (sessionID === conversation.sessionID) conversation.onMainBusy();
        else if (!subagents.isSubagent(sessionID)) tasks.onBusy(sessionID);
        return;
      }
      case "session.execution.succeeded": {
        if (!sessionID) return;
        if (sessionID === conversation.sessionID) void conversation.onMainIdle();
        else if (tasks.isWorker(sessionID)) await tasks.onIdle(sessionID);
        else if (subagents.isSubagent(sessionID)) void subagents.onIdle(sessionID, "succeeded");
        return;
      }
      case "session.execution.interrupted": {
        // An interrupt is deliberate (stop button); let the idle handler close the turn out.
        if (!sessionID) return;
        if (sessionID === conversation.sessionID) void conversation.onMainIdle();
        else if (tasks.isWorker(sessionID)) await tasks.onIdle(sessionID);
        else if (subagents.isSubagent(sessionID)) void subagents.onIdle(sessionID, "interrupted");
        return;
      }
      case "session.execution.failed": {
        if (!sessionID) return;
        tasks.onError(sessionID, d.error);
        if (sessionID === conversation.sessionID) void conversation.onMainIdle();
        else if (tasks.isWorker(sessionID)) await tasks.onIdle(sessionID);
        else if (subagents.isSubagent(sessionID)) {
          subagents.onError(sessionID, d.error);
          void subagents.onIdle(sessionID, "failed");
        }
        return;
      }
      case "session.usage.updated": {
        // OpenCode reports the session's running totals; Limits records the increase and checks the caps.
        if (!sessionID) return;
        const tokens = d.tokens as TokenTotals | undefined;
        const cost = typeof d.cost === "number" ? d.cost : 0;
        const at = typeof ev.created === "number" ? ev.created : Date.now();
        const { breaches } = limits.recordUsage(sessionID, cost, tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, at);
        if (tokens) store.recordReasoningUsage(`session-${sessionID}`, tokens.input, tokens.output, tokens.reasoning, cost, at);
        tasks.onActivity(sessionID);
        if (breaches.length) void handleBreaches(breaches).catch((err) => log.error("enforcing a spending cap failed", err));
        return;
      }
      // OpenCode 2.0.32 sends permission.asked (the request itself) and form.created ({form}); the
      // older names are kept so a server bump in either direction doesn't silently drop prompts.
      case "permission.asked":
      case "permission.requested":
        await approvals.onPermissionAsked(d as unknown as Parameters<Approvals["onPermissionAsked"]>[0], directory);
        return;
      case "form.created":
      case "form.requested":
        await approvals.onFormRequested((d.form ?? d) as unknown as Parameters<Approvals["onFormRequested"]>[0], directory);
        return;
      case "permission.replied":
      case "form.replied":
      case "form.rejected":
      case "form.cancelled": {
        const id = [d.requestID, d.formID, d.id].find((v): v is string => typeof v === "string");
        if (id) await approvals.onReplied(id);
        return;
      }
      case "session.step.ended":
      case "session.text.delta":
      case "session.reasoning.delta":
      case "session.tool.called":
      case "session.tool.success":
      case "session.tool.failed":
      case "session.inbox.enqueued":
      case "session.inbox.delivered":
        if (sessionID) tasks.onActivity(sessionID);
        return;
    }
  };

  const abort = new AbortController();
  void (async () => {
    for await (const ev of oc.events(abort.signal)) {
      try {
        await dispatch(ev);
      } catch (err) {
        log.error(`handling ${ev.type} failed`, err);
      }
    }
  })();

  scheduler.start();
  const media = buildMedia(cfg, cfg.TELEGRAM_BOT_TOKEN);
  if (media) log.info(`media pipeline: ${media.capabilities()}`);
  registerHandlers(bot, { cfg, store, oc, conversation, tasks, approvals, scheduler, labelFor, roles, limits, catalog, subagents, ...(media ? { media } : {}) });
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
    clearInterval(catalogTimer);
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
