/**
 * `npm run opencode`: start a local OpenCode server wired to this repo's config,
 * using the values from .env (so OpenCode and the gateway agree on tokens and paths).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const required = ["OPENCODE_SERVER_PASSWORD", "HQ_MCP_TOKEN", "ASSISTANT_HOME", "PROJECTS_DIR"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(", ")}`);
  process.exit(1);
}

const home = process.env.ASSISTANT_HOME!;
if (!fs.existsSync(home)) {
  fs.cpSync("home", home, { recursive: true });
  console.log(`Seeded the assistant home at ${home}`);
}
fs.mkdirSync(process.env.PROJECTS_DIR!, { recursive: true });

const port = new URL(process.env.OPENCODE_URL ?? "http://127.0.0.1:4096").port || "4096";
const env = {
  ...process.env,
  OPENCODE_CONFIG: path.resolve("opencode/opencode.json").replaceAll("\\", "/"),
  OPENCODE_ENABLE_EXA: process.env.OPENCODE_ENABLE_EXA ?? "1",
  HQ_PORT: process.env.HQ_PORT ?? "7801",
};

console.log(`Starting OpenCode on 127.0.0.1:${port} (home ${home})`);
const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", port], {
  cwd: home,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
