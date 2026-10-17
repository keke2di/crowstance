/**
 * The vault: credentials the agent may *use* by handle but never read back.
 *
 * Values are encrypted with AES-256-GCM. The key lives in its own file
 * (VAULT_KEY_FILE, default <DATA_DIR>/vault.key), generated with mode 0600 on
 * first use, and never enters the database, backups, prompts or logs. The agent
 * sees handles, services and notes only; plaintext is returned exclusively to
 * gateway-side action runners (prepare-and-confirm flows), never through MCP.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { logger } from "./log.ts";
import { UserError } from "./tasks.ts";

const log = logger("vault");

export type VaultEntry = {
  handle: string;
  service: string;
  kind: string;
  note: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
};

const HANDLE = /^[a-z0-9][a-z0-9_-]{1,62}$/;

/** Load (or generate) the vault key. Never log or return this. */
export function loadVaultKey(cfg: Config): Buffer {
  const file = cfg.VAULT_KEY_FILE ?? path.join(cfg.DATA_DIR, "vault.key");
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file);
    if (key.length !== 32) throw new Error(`Vault key ${file} must be 32 bytes, got ${key.length}`);
    return key;
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key, { mode: 0o600 });
  log.info(`generated a new vault key at ${file}`);
  return key;
}

export class Vault {
  private readonly store: Store;
  private readonly key: Buffer;

  constructor(store: Store, key: Buffer) {
    this.store = store;
    this.key = key;
  }

  /** Store or replace a credential. Gateway/operator-side only: there is no MCP write path. */
  put(input: { handle: string; service: string; value: string; kind?: string; note?: string }) {
    const handle = input.handle.trim().toLowerCase();
    if (!HANDLE.test(handle)) throw new UserError("Handles must be 2-63 chars of a-z, 0-9, _ or -.");
    if (!input.value) throw new UserError("Empty credentials are not allowed.");
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
    this.store.vaultPut({
      handle,
      service: input.service.trim().toLowerCase(),
      kind: input.kind ?? "secret",
      ciphertext,
      nonce,
      tag: cipher.getAuthTag(),
      note: input.note ?? null,
    });
    log.info(`vault entry "${handle}" stored (${input.service})`);
  }

  remove(handle: string): boolean {
    const gone = this.store.vaultRemove(handle.trim().toLowerCase());
    if (gone) log.info(`vault entry "${handle}" removed`);
    return gone;
  }

  /** Metadata only — safe to show the agent. Never includes the value. */
  list(): VaultEntry[] {
    return this.store.vaultList();
  }

  has(handle: string): boolean {
    return this.store.vaultGet(handle.trim().toLowerCase()) !== undefined;
  }

  /**
   * Decrypt a credential for a gateway-side action runner. This is the only read
   * path, it is never exposed over MCP, and every use is recorded.
   */
  use(handle: string, context: { sessionID?: string; taskSlug?: string }): string {
    const row = this.store.vaultGet(handle.trim().toLowerCase());
    if (!row) throw new UserError(`No vault entry named "${handle}".`);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, row.nonce);
    decipher.setAuthTag(row.tag);
    const value = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
    this.store.vaultTouch(row.handle);
    log.info(`vault entry "${row.handle}" used`, { sessionID: context.sessionID, taskSlug: context.taskSlug });
    return value;
  }
}
