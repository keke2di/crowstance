/**
 * Add or replace a vault credential (operator-only; there is deliberately no MCP write path).
 * Usage: node scripts/vault-add.ts <handle> <service> [note]   — the value is read from stdin.
 */
import readline from "node:readline";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { loadVaultKey, Vault } from "../src/vault.ts";
import path from "node:path";

const [handle, service, ...noteParts] = process.argv.slice(2);
if (!handle || !service) {
  console.error("usage: node scripts/vault-add.ts <handle> <service> [note]  (value on stdin)");
  process.exit(2);
}

const rl = readline.createInterface({ input: process.stdin });
let value = "";
for await (const line of rl) value += (value ? "\n" : "") + line;
value = value.trim();
if (!value) {
  console.error("no value on stdin");
  process.exit(2);
}

const cfg = loadConfig();
const store = new Store(path.join(cfg.DATA_DIR, "assistant.db"));
const vault = new Vault(store, loadVaultKey(cfg));
vault.put({ handle, service, value, note: noteParts.join(" ") || undefined });
console.log(`stored "${handle}" (${service}) in the vault`);
store.close();
