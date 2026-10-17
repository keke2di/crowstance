/**
 * Encrypted, verifiable state backups and restore.
 *
 * A backup directory contains three files, all encrypted with AES-256-GCM under
 * a key derived from a passphrase via scrypt:
 *
 *   state.db.enc       consistent SQLite snapshot (sessions, tasks, reminders, …)
 *   memory.json.enc    selected assistant memory files (path → base64 content)
 *   manifest.json.enc  file names, sizes and SHA-256 checksums, also encrypted
 *
 * The manifest is encrypted too, so filenames/metadata do not leak. Restoring
 * verifies every checksum before writing anything, and writes into the caller's
 * target paths (a clean temporary directory for the drill).
 *
 * CLI:
 *   node src/backup.ts export  --db <file> --out <dir> [--memory <dir>] --passphrase-file <file>
 *   node src/backup.ts restore --backup <dir> --db <file> [--memory <dir>] --passphrase-file <file>
 *   node src/backup.ts verify  --backup <dir> --passphrase-file <file>
 *   node src/backup.ts check   --db <file> [--memory <dir>] [--require-data]
 *   node src/backup.ts prune   --dir <dir> --keep <n>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const BACKUP_FORMAT = "crowstance-state-backup";
export const DB_FILE = "state.db.enc";
export const MEMORY_FILE = "memory.json.enc";
export const MANIFEST_FILE = "manifest.json.enc";

const MAGIC = Buffer.from("CRS1");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SCRYPT = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export type BackupFile = { name: string; sha256: string; bytes: number };
export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  version: 1;
  createdAt: number;
  database: BackupFile;
  memory: (BackupFile & { files: number }) | null;
};

export function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (!passphrase) throw new Error("empty backup passphrase");
  return crypto.scryptSync(passphrase, salt, 32, SCRYPT);
}

export function encrypt(plain: Buffer, passphrase: string): Buffer {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(payload: Buffer, passphrase: string): Buffer {
  const header = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
  if (payload.length < header || !payload.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a crowstance state backup");
  const salt = payload.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = payload.subarray(MAGIC.length + SALT_BYTES, MAGIC.length + SALT_BYTES + IV_BYTES);
  const tag = payload.subarray(MAGIC.length + SALT_BYTES + IV_BYTES, header);
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(payload.subarray(header)), decipher.final()]);
  } catch {
    throw new Error("could not decrypt backup (wrong passphrase or corrupted file)");
  }
}

type MemoryBundle = { files: { path: string; content: string; bytes: number }[] };

function collectMemory(root: string): MemoryBundle {
  const files: MemoryBundle["files"] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(full);
        files.push({ path: path.relative(root, full).split(path.sep).join("/"), content: bytes.toString("base64"), bytes: bytes.length });
      }
    }
  };
  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files };
}

function writeMemory(root: string, bundle: MemoryBundle) {
  for (const file of bundle.files) {
    const rel = file.path.replace(/\\/g, "/");
    if (rel.startsWith("/") || rel.split("/").includes("..")) throw new Error(`unsafe memory path in backup: ${file.path}`);
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(file.content, "base64"), { mode: 0o600 });
  }
}

/** Snapshot `db` and optional `memoryDir` into `outDir`, encrypted. */
export async function exportState(opts: { db: Database.Database; outDir: string; passphrase: string; memoryDir?: string; now?: number }): Promise<BackupManifest> {
  const { db, outDir, passphrase, memoryDir } = opts;
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const snapshot = path.join(outDir, `.snapshot-${process.pid}.db`);
  fs.rmSync(snapshot, { force: true });
  try {
    await db.backup(snapshot);
    const dbBytes = fs.readFileSync(snapshot);
    fs.writeFileSync(path.join(outDir, DB_FILE), encrypt(dbBytes, passphrase), { mode: 0o600 });
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: opts.now ?? Date.now(),
      database: { name: DB_FILE, sha256: sha256(dbBytes), bytes: dbBytes.length },
      memory: null,
    };
    if (memoryDir && fs.existsSync(memoryDir)) {
      const bundle = collectMemory(memoryDir);
      const memBytes = Buffer.from(JSON.stringify(bundle), "utf8");
      fs.writeFileSync(path.join(outDir, MEMORY_FILE), encrypt(memBytes, passphrase), { mode: 0o600 });
      manifest.memory = { name: MEMORY_FILE, sha256: sha256(memBytes), bytes: memBytes.length, files: bundle.files.length };
    }
    fs.writeFileSync(path.join(outDir, MANIFEST_FILE), encrypt(Buffer.from(JSON.stringify(manifest), "utf8"), passphrase), { mode: 0o600 });
    return manifest;
  } finally {
    fs.rmSync(snapshot, { force: true });
  }
}

export function readManifest(backupDir: string, passphrase: string): BackupManifest {
  const encrypted = fs.readFileSync(path.join(backupDir, MANIFEST_FILE));
  const manifest = JSON.parse(decrypt(encrypted, passphrase).toString("utf8")) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT || manifest.version !== 1) throw new Error("unrecognized backup format or version");
  return manifest;
}

/** Verify checksums without writing anything. */
export function verifyBackup(backupDir: string, passphrase: string): BackupManifest {
  const manifest = readManifest(backupDir, passphrase);
  const check = (file: BackupFile) => {
    const bytes = decrypt(fs.readFileSync(path.join(backupDir, file.name)), passphrase);
    if (sha256(bytes) !== file.sha256) throw new Error(`checksum mismatch for ${file.name}`);
    if (bytes.length !== file.bytes) throw new Error(`size mismatch for ${file.name}`);
  };
  check(manifest.database);
  if (manifest.memory) check(manifest.memory);
  return manifest;
}

/** Restore a backup into clean target paths, verifying every checksum first. */
export function restoreState(opts: { backupDir: string; passphrase: string; targetDb: string; targetMemoryDir?: string }): BackupManifest {
  const manifest = readManifest(opts.backupDir, opts.passphrase);
  const dbBytes = decrypt(fs.readFileSync(path.join(opts.backupDir, DB_FILE)), opts.passphrase);
  if (sha256(dbBytes) !== manifest.database.sha256) throw new Error("database checksum mismatch; refusing to restore");
  fs.mkdirSync(path.dirname(opts.targetDb), { recursive: true });
  fs.writeFileSync(opts.targetDb, dbBytes, { mode: 0o600 });
  if (manifest.memory) {
    if (!opts.targetMemoryDir) throw new Error("backup contains memory; provide targetMemoryDir");
    const memBytes = decrypt(fs.readFileSync(path.join(opts.backupDir, MEMORY_FILE)), opts.passphrase);
    if (sha256(memBytes) !== manifest.memory.sha256) throw new Error("memory checksum mismatch; refusing to restore");
    writeMemory(opts.targetMemoryDir, JSON.parse(memBytes.toString("utf8")) as MemoryBundle);
  }
  return manifest;
}

export type RestoredState = { session: string | null; tasks: number; reminders: number; memory: number };

function countFiles(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(path.join(root, entry.name));
    else if (entry.isFile()) count++;
  }
  return count;
}

/** Inspect a restored database (and optional memory dir) to confirm what survived. */
export function inspectState(dbPath: string, memoryDir?: string): RestoredState {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const session = db.prepare("SELECT value FROM kv WHERE key = 'main.session'").get() as { value?: string } | undefined;
    const tasks = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    const reminders = (db.prepare("SELECT COUNT(*) AS n FROM reminders").get() as { n: number }).n;
    return { session: session?.value ?? null, tasks, reminders, memory: memoryDir ? countFiles(memoryDir) : 0 };
  } finally {
    db.close();
  }
}

/** Keep the newest `keep` timestamp-named backup directories. */
export function pruneBackups(dir: string, keep: number): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const remove = entries.slice(0, Math.max(0, entries.length - keep));
  for (const name of remove) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  return remove;
}

// ---- CLI ---------------------------------------------------------------------

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function readPassphrase(args: string[]): string {
  const file = argValue(args, "--passphrase-file");
  const value = file ? fs.readFileSync(file, "utf8").trim() : process.env.CROW_BACKUP_PASSPHRASE;
  if (!value) throw new Error("a backup passphrase is required (--passphrase-file or CROW_BACKUP_PASSPHRASE)");
  return value;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "export": {
      const dbPath = argValue(args, "--db");
      const outDir = argValue(args, "--out");
      if (!dbPath || !outDir) throw new Error("usage: backup.ts export --db <file> --out <dir> [--memory <dir>] --passphrase-file <file>");
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const manifest = await exportState({ db, outDir, passphrase: readPassphrase(args), memoryDir: argValue(args, "--memory") });
        console.log(JSON.stringify(manifest));
      } finally {
        db.close();
      }
      return;
    }
    case "restore": {
      const backupDir = argValue(args, "--backup");
      const targetDb = argValue(args, "--db");
      if (!backupDir || !targetDb) throw new Error("usage: backup.ts restore --backup <dir> --db <file> [--memory <dir>] --passphrase-file <file>");
      const manifest = restoreState({ backupDir, passphrase: readPassphrase(args), targetDb, targetMemoryDir: argValue(args, "--memory") });
      console.log(JSON.stringify(manifest));
      return;
    }
    case "verify": {
      const backupDir = argValue(args, "--backup");
      if (!backupDir) throw new Error("usage: backup.ts verify --backup <dir> --passphrase-file <file>");
      console.log(JSON.stringify(verifyBackup(backupDir, readPassphrase(args))));
      return;
    }
    case "check": {
      const dbPath = argValue(args, "--db");
      if (!dbPath) throw new Error("usage: backup.ts check --db <file> [--memory <dir>] [--require-data]");
      const state = inspectState(dbPath, argValue(args, "--memory"));
      console.log(JSON.stringify(state));
      // A real backup must contain the main session and the memory files. Tasks and reminders may
      // legitimately be zero, so they are reported but not required.
      if (args.includes("--require-data") && (!state.session || (argValue(args, "--memory") !== undefined && state.memory === 0))) {
        throw new Error(`restored state is missing required data: ${JSON.stringify(state)}`);
      }
      return;
    }
    case "prune": {
      const dir = argValue(args, "--dir");
      const keep = Number(argValue(args, "--keep") ?? "7");
      if (!dir || !Number.isInteger(keep) || keep < 1) throw new Error("usage: backup.ts prune --dir <dir> --keep <n>");
      console.log(JSON.stringify({ removed: pruneBackups(dir, keep) }));
      return;
    }
    default:
      throw new Error("usage: backup.ts {export|restore|verify|check|prune} ...");
  }
}

// import.meta.main, not an argv/URL comparison: the release symlink makes those two paths differ.
if (import.meta.main) {
  main().catch((err) => {
    console.error(`backup: ${(err as Error).message}`);
    process.exit(1);
  });
}
