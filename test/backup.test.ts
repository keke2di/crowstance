import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { DB_FILE, MANIFEST_FILE, exportState, inspectState, pruneBackups, readManifest, restoreState, verifyBackup } from "../src/backup.ts";
import { Store } from "../src/db.ts";

const roots: string[] = [];
const stores: Store[] = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crowstance-backup-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const PASSPHRASE = "correct horse battery staple";

function seeded() {
  const root = tempRoot();
  const store = new Store(path.join(root, "assistant.db"));
  stores.push(store);
  store.set("main.session", "ses_main");
  store.insertTask({ slug: "backup-task", title: "Backup the state", brief: "b", directory: "/projects/x", session_id: "ses_task", state: "running", model: null, job: null, created_at: Date.now() });
  store.addReminder(Date.now() + 3_600_000, "call the bank");
  const memory = path.join(root, "memory");
  fs.mkdirSync(path.join(memory, "notes"), { recursive: true });
  fs.writeFileSync(path.join(memory, "profile.md"), "the user likes short answers\n");
  fs.writeFileSync(path.join(memory, "notes", "x.md"), "project note\n");
  return { root, store, memory };
}

describe("encrypted state backup", () => {
  it("writes an encrypted manifest and restores sessions, tasks, reminders and memory", async () => {
    const { store, memory } = seeded();
    const outDir = path.join(tempRoot(), "backup");
    const manifest = await exportState({ db: store.db, outDir, passphrase: PASSPHRASE, memoryDir: memory, now: 1_700_000_000_000 });
    expect(manifest.format).toBe("crowstance-state-backup");
    expect(manifest.memory?.files).toBe(2);

    // The manifest and payloads are encrypted: no plaintext metadata or content leaks.
    const manifestBytes = fs.readFileSync(path.join(outDir, MANIFEST_FILE)).toString("utf8");
    expect(manifestBytes).not.toContain("crowstance-state-backup");
    expect(manifestBytes).not.toContain("main.session");
    const dbBytes = fs.readFileSync(path.join(outDir, DB_FILE)).toString("utf8");
    expect(dbBytes).not.toContain("main.session");
    expect(dbBytes).not.toContain("Backup the state");

    expect(verifyBackup(outDir, PASSPHRASE).database.sha256).toBe(manifest.database.sha256);
    expect(() => readManifest(outDir, "wrong passphrase")).toThrow(/wrong passphrase|decrypt/);

    // Restore into a clean temporary environment and verify what survived.
    const target = tempRoot();
    const restoredDb = path.join(target, "assistant.db");
    const restoredMemory = path.join(target, "memory");
    restoreState({ backupDir: outDir, passphrase: PASSPHRASE, targetDb: restoredDb, targetMemoryDir: restoredMemory });

    const state = inspectState(restoredDb, restoredMemory);
    expect(state).toEqual({ session: "ses_main", tasks: 1, reminders: 1, memory: 2 });

    const reopened = new Store(restoredDb);
    stores.push(reopened);
    expect(reopened.taskBySlug("backup-task")?.title).toBe("Backup the state");
    expect(reopened.upcomingReminders().map((r) => r.text)).toEqual(["call the bank"]);
    expect(fs.readFileSync(path.join(restoredMemory, "profile.md"), "utf8")).toContain("short answers");
    expect(fs.readFileSync(path.join(restoredMemory, "notes", "x.md"), "utf8")).toContain("project note");
  });

  it("refuses to restore a tampered payload", async () => {
    const { store } = seeded();
    const outDir = path.join(tempRoot(), "backup");
    await exportState({ db: store.db, outDir, passphrase: PASSPHRASE });
    const file = path.join(outDir, DB_FILE);
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    fs.writeFileSync(file, bytes);
    expect(() => verifyBackup(outDir, PASSPHRASE)).toThrow(/decrypt|checksum/);
    expect(() => restoreState({ backupDir: outDir, passphrase: PASSPHRASE, targetDb: path.join(tempRoot(), "x.db") })).toThrow(/decrypt|checksum/);
  });

  it("prunes old backups but keeps the newest", async () => {
    const dir = tempRoot();
    for (const name of ["20260101T000000Z", "20260102T000000Z", "20260103T000000Z"]) fs.mkdirSync(path.join(dir, name));
    expect(pruneBackups(dir, 2)).toEqual(["20260101T000000Z"]);
    expect(fs.readdirSync(dir).sort()).toEqual(["20260102T000000Z", "20260103T000000Z"]);
  });

  it("runs as a command when started through the release symlink", () => {
    const root = tempRoot();
    const app = path.join(root, "app"); // like /opt/crowstance/app -> releases/<id>
    fs.symlinkSync(process.cwd(), app, "junction");
    const dir = path.join(root, "backups");
    for (const name of ["20260101T000000Z", "20260102T000000Z"]) fs.mkdirSync(path.join(dir, name), { recursive: true });
    const out = execFileSync(process.execPath, [path.join(app, "src", "backup.ts"), "prune", "--dir", dir, "--keep", "1"], { encoding: "utf8" });
    expect(JSON.parse(out)).toEqual({ removed: ["20260101T000000Z"] });
    expect(fs.readdirSync(dir)).toEqual(["20260102T000000Z"]);
  });
});
