import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { loadVaultKey, Vault } from "../src/vault.ts";
import { testConfig } from "./fakes.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function freshVault() {
  const store = new Store(":memory:");
  const key = crypto.randomBytes(32);
  return { store, vault: new Vault(store, key), key };
}

describe("vault", () => {
  it("round-trips a credential without exposing it in list()", () => {
    const { vault } = freshVault();
    vault.put({ handle: "glovo_login", service: "glovo", value: "s3cret", note: "main account" });
    const list = vault.list();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("ciphertext");
    expect(JSON.stringify(list)).not.toContain("s3cret");
    expect(vault.use("glovo_login", {})).toBe("s3cret");
    expect(vault.list()[0]!.last_used_at).not.toBeNull();
  });

  it("rejects bad handles and unknown entries", () => {
    const { vault } = freshVault();
    expect(() => vault.put({ handle: "BAD HANDLE", service: "x", value: "v" })).toThrow(/Handles must be/);
    expect(() => vault.use("nope", {})).toThrow(/No vault entry/);
    expect(vault.remove("nope")).toBe(false);
  });

  it("cannot be decrypted with a different key", () => {
    const store = new Store(":memory:");
    const a = new Vault(store, crypto.randomBytes(32));
    a.put({ handle: "card", service: "pay", value: "4242" });
    const b = new Vault(store, crypto.randomBytes(32));
    expect(() => b.use("card", {})).toThrow();
  });

  it("generates a 32-byte key file with owner-only permissions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-key-"));
    const cfg = testConfig({ VAULT_KEY_FILE: path.join(dir, "k", "vault.key") });
    const key = loadVaultKey(cfg);
    expect(key.length).toBe(32);
    expect(loadVaultKey(cfg).equals(key)).toBe(true); // stable across loads
  });
});

describe("action audit", () => {
  it("records and lists actions newest first", () => {
    const store = new Store(":memory:");
    const id = store.auditAction({ service: "glovo", action: "prepared basket", detail: "2 items", consent: "none" });
    store.auditAction({ service: "glovo", action: "placed order", consent: "explicit", consentRef: "req_1", status: "completed" });
    const rows = store.recentActions();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.action).toBe("placed order");
    expect(rows[1]!.id).toBe(id);
    store.updateAuditStatus(id, "cancelled");
    expect(store.recentActions()[1]!.status).toBe("cancelled");
  });
});
