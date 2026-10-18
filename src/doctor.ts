/**
 * `npm run doctor`: checks the setup end to end without starting the Telegram bot
 * and without spending any model tokens. `--write` also test-creates a project repo.
 */
import net from "node:net";
import path from "node:path";
import { loadConfig, parseModelRef } from "./config.ts";
import { Store } from "./db.ts";
import { setLogLevel } from "./log.ts";
import { startHqServer } from "./mcp.ts";
import { OpenCode } from "./opencode.ts";
import { crowbotBalance } from "./provider.ts";
import { Scheduler } from "./scheduler.ts";
import { Tasks } from "./tasks.ts";

let failures = 0;
const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const warn = (msg: string) => console.log(`  ⚠️  ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`  ❌ ${msg}`);
};

async function portInUse(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

async function main() {
  setLogLevel("warn");
  console.log("Config");
  let cfg;
  try {
    cfg = loadConfig();
    ok(`loaded (owner ${cfg.OWNER_TELEGRAM_ID}, home ${cfg.ASSISTANT_HOME}, projects ${cfg.PROJECTS_DIR})`);
  } catch (err) {
    fail((err as Error).message);
    process.exit(1);
  }

  console.log("Telegram");
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/getMe`);
    const body = (await res.json()) as { ok: boolean; result?: { username: string }; description?: string };
    if (body.ok) {
      ok(`bot token works: @${body.result!.username}`);
      const chat = (await (await fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/getChat?chat_id=${cfg.OWNER_TELEGRAM_ID}`)).json()) as {
        ok: boolean;
        description?: string;
      };
      if (chat.ok) ok("the bot can message you");
      else fail(`the bot can't message you yet (${chat.description}): open @${body.result!.username} in Telegram and press Start`);
    } else fail(`bot token rejected: ${body.description}`);
  } catch (err) {
    fail(`could not reach Telegram: ${(err as Error).message}`);
  }

  console.log("OpenCode");
  const oc = new OpenCode({ url: cfg.OPENCODE_URL, username: cfg.OPENCODE_SERVER_USERNAME, password: cfg.OPENCODE_SERVER_PASSWORD });
  try {
    const h = await oc.health();
    ok(`server ${h.version} at ${cfg.OPENCODE_URL}`);
    if (!h.version.startsWith("2.")) warn(`this gateway was built against OpenCode 2.x; you're running ${h.version}`);
  } catch (err) {
    fail(`not reachable at ${cfg.OPENCODE_URL}: ${(err as Error).message}`);
    process.exit(1);
  }

  // Models in use: per-agent defaults from opencode.json, overridden by CHAT_MODEL / WORKER_MODEL.
  const inUse = new Map<string, string>();
  try {
    const agents = await oc.agents(cfg.ASSISTANT_HOME);
    for (const [name, override] of [
      [cfg.ASSISTANT_AGENT, cfg.CHAT_MODEL],
      [cfg.WORKER_AGENT, cfg.WORKER_MODEL],
    ] as const) {
      const agent = agents.find((a) => a.id === name || a.name === name);
      if (!agent) {
        fail(`agent "${name}" missing — is OpenCode started with OPENCODE_CONFIG pointing at opencode/opencode.json?`);
        continue;
      }
      ok(`agent "${name}" is defined`);
      const ref = override ?? (agent.model ? `${agent.model.providerID}/${agent.model.id}` : undefined);
      if (ref) inUse.set(ref, [inUse.get(ref), name].filter(Boolean).join(" + "));
    }
  } catch (err) {
    fail(`could not list agents: ${(err as Error).message}`);
  }

  try {
    const { providers, choices } = await oc.modelChoices(cfg.ASSISTANT_HOME);
    ok(`providers available: ${providers.map((p) => p.id).join(", ") || "none"}`);
    for (const [ref, users] of inUse) {
      if (!choices.includes(ref)) fail(`${ref} (${users}): no such model — is its provider's API key set?`);
      else ok(`${users} → ${ref}`);
    }
  } catch (err) {
    fail(`could not list models: ${(err as Error).message}`);
  }

  if (cfg.CROWBOT_API_KEY) {
    try {
      ok(`crowbot account works, balance $${(await crowbotBalance(cfg.CROWBOT_API_KEY)).balanceUsd.toFixed(2)}`);
    } catch (err) {
      fail(`crowbot balance check failed: ${(err as Error).message}`);
    }
  } else warn("CROWBOT_API_KEY isn't set for the gateway, so /cost can't show the balance");

  try {
    const entries = (await oc.listDir(cfg.ASSISTANT_HOME)).map((e) => e.name ?? e.path.split(/[\\/]/).pop());
    if (entries.includes("AGENTS.md") && entries.includes("memory")) ok(`assistant home looks right (${entries.length} entries)`);
    else warn(`assistant home ${cfg.ASSISTANT_HOME} has no AGENTS.md/memory — seed it from home/`);
  } catch (err) {
    fail(`OpenCode can't read ${cfg.ASSISTANT_HOME}: ${(err as Error).message}`);
  }

  console.log("Media (OCR/STT)");
  {
    const { execFile } = await import("node:child_process");
    const run = (bin: string, args: string[]) =>
      new Promise<boolean>((resolve) => {
        execFile(bin, args, { timeout: 15_000 }, (err) => resolve(!err));
      });
    if (cfg.TESSERACT_BIN) {
      if (await run(cfg.TESSERACT_BIN, ["--version"])) ok(`tesseract works (${cfg.TESSERACT_BIN})`);
      else fail(`TESSERACT_BIN set but not runnable: ${cfg.TESSERACT_BIN}`);
    } else warn("TESSERACT_BIN unset — the bot can't read photos");
    if (cfg.WHISPER_BIN && cfg.WHISPER_MODEL) {
      const fs = await import("node:fs");
      if (!fs.existsSync(cfg.WHISPER_MODEL)) fail(`WHISPER_MODEL missing: ${cfg.WHISPER_MODEL}`);
      else if (await run(cfg.WHISPER_BIN, ["--help"])) ok(`whisper.cpp works (${cfg.WHISPER_BIN}, model ${cfg.WHISPER_MODEL})`);
      else fail(`WHISPER_BIN set but not runnable: ${cfg.WHISPER_BIN}`);
    } else warn("WHISPER_BIN/WHISPER_MODEL unset — the bot can't hear voice messages");
  }

  console.log("hq (MCP + notify)");
  const running = await portInUse(cfg.HQ_HOST, cfg.HQ_PORT);
  let temp: Awaited<ReturnType<typeof startHqServer>> | undefined;
  let tempStore: Store | undefined;
  let tempScheduler: Scheduler | undefined;
  if (running) ok(`something is listening on ${cfg.HQ_HOST}:${cfg.HQ_PORT} (the gateway, presumably)`);
  else {
    tempStore = new Store(":memory:");
    const tasks = new Tasks({ cfg, store: tempStore, oc, onUpdate: () => {} });
    tempScheduler = new Scheduler({ cfg, store: tempStore, tasks, oc, onUpdate: () => {}, housekeeping: async () => {} });
    temp = await startHqServer({ cfg, store: tempStore, tasks, scheduler: tempScheduler, onUpdate: () => {} });
    ok(`started a temporary hq server on ${cfg.HQ_HOST}:${cfg.HQ_PORT}`);
  }
  try {
    await oc.mcpConnect("hq", cfg.ASSISTANT_HOME).catch(() => {});
    const hq = (await oc.mcpStatus(cfg.ASSISTANT_HOME)).hq;
    if (!hq) fail('OpenCode has no MCP server named "hq" in its config');
    else if (hq.status === "connected") ok("OpenCode is connected to hq");
    else fail(`OpenCode can't use hq: ${hq.status}${hq.error ? ` (${hq.error})` : ""} — do HQ_MCP_TOKEN values match?`);
  } catch (err) {
    fail(`could not check MCP status: ${(err as Error).message}`);
  }
  temp?.close();
  tempScheduler?.stop();
  tempStore?.close();

  if (process.argv.includes("--write")) {
    console.log("Projects");
    const probe = path.join(cfg.PROJECTS_DIR, "doctor-probe");
    try {
      await oc.ensureGitRepo(probe, cfg.PROJECTS_DIR);
      ok(`created a git repo as the OpenCode user at ${probe} (safe to delete)`);
    } catch (err) {
      fail(`could not create a project repo: ${(err as Error).message}`);
    }
  }

  console.log(failures ? `\n${failures} problem(s) found.` : "\nAll good.");
  process.exit(failures ? 1 : 0);
}

void main();
