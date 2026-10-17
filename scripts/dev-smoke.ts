import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

process.loadEnvFile(".env");
const required = ["TELEGRAM_BOT_TOKEN", "OWNER_TELEGRAM_ID"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(", ")}`);
  process.exit(1);
}

const root = process.cwd();
const assistantHome = path.resolve(process.env.ASSISTANT_HOME ?? path.join(root, ".dev-assistant"));
const projectsDir = path.resolve(process.env.PROJECTS_DIR ?? path.join(root, ".dev-projects"));
if (!fs.existsSync(assistantHome)) fs.cpSync(path.join(root, "home"), assistantHome, { recursive: true });
fs.cpSync(path.join(root, "opencode", "prompts"), path.join(assistantHome, "prompts"), { recursive: true });
fs.mkdirSync(projectsDir, { recursive: true });

const env = {
  ...process.env,
  ASSISTANT_HOME: assistantHome,
  PROJECTS_DIR: projectsDir,
  DATA_DIR: process.env.DATA_DIR ?? path.join(root, ".dev-data"),
  OPENCODE_URL: process.env.OPENCODE_URL ?? "http://127.0.0.1:4096",
  OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
  OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD ?? "dev-opencode-password",
  HQ_PORT: process.env.HQ_PORT ?? "7801",
  HQ_MCP_TOKEN: process.env.HQ_MCP_TOKEN ?? "dev-hq-token-0123456789",
  HQ_NOTIFY_TOKEN: process.env.HQ_NOTIFY_TOKEN ?? "dev-notify-token-0123456789",
  OPENCODE_CONFIG: path.resolve("opencode/opencode.dev.json").replaceAll("\\", "/"),
};

const children: ChildProcess[] = [];
function start(command: string, args: string[], name: string) {
  console.log(`[smoke] starting ${name}`);
  const child = spawn(command, args, { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[smoke] ${name} exited (${signal ?? code ?? 0})`);
    void shutdown(code ?? 1);
  });
}

let stopping = false;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown(0));

start(process.execPath, ["scripts/dev-stub-model.ts"], "stub model");
start("opencode", ["serve", "--hostname", "127.0.0.1", "--port", new URL(env.OPENCODE_URL).port || "4096"], "OpenCode");
start(process.execPath, ["--watch", "--env-file-if-exists=.env", "src/index.ts"], "gateway");
