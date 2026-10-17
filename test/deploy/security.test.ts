import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, afterEach } from "vitest";

const run = promisify(execFile);
async function runChecked(file: string, args: string[], options: Parameters<typeof execFile>[2]) {
  try {
    return await run(file, args, options);
  } catch (error) {
    const detail = error as { stderr?: string; stdout?: string; message?: string };
    throw new Error(JSON.stringify(detail));
  }
}
const repo = process.cwd();
const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "crowstance-deploy-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deployment security boundaries", () => {
  it("renders units with backup isolation and netguard ordering", async () => {
    const backup = await readFile(join(repo, "deploy/systemd/crowstance-backup.service"), "utf8");
    const opencode = await readFile(join(repo, "deploy/systemd/crowstance-opencode.service"), "utf8");
    const netguard = await readFile(join(repo, "deploy/systemd/crowstance-netguard.service"), "utf8");
    const stateBackup = await readFile(join(repo, "deploy/systemd/crowstance-state-backup.service"), "utf8");
    expect(backup).toContain("User=crow-backup");
    expect(backup).toContain("PrivateNetwork=true");
    expect(backup).toContain("ProtectSystem=strict");
    expect(backup).toContain("BindReadOnlyPaths=/home/crow-agent/assistant/memory");
    expect(backup).toContain("ReadWritePaths=/var/lib/crowstance-backup");
    expect(backup).not.toContain("User=crow-gateway");
    expect(backup).not.toContain("git push");
    expect(opencode).toContain("Requires=crowstance-netguard.service");
    expect(opencode).toContain("After=network-online.target crowstance-netguard.service");
    expect(netguard).toContain("Before=crowstance-opencode.service");
    // The encrypted state backup has no network and writes only its own directory.
    expect(stateBackup).toContain("PrivateNetwork=true");
    expect(stateBackup).toContain("ProtectSystem=strict");
    expect(stateBackup).toContain("ReadWritePaths=/var/lib/crowstance-backup");
    expect(await readFile(join(repo, "deploy/netguard.sh"), "utf8")).toContain("does not\n# cover UDP listeners");
  });

  it("lets every timer actually re-run its service", async () => {
    const dir = join(repo, "deploy/systemd");
    const timers = (await readdir(dir)).filter((f) => f.endsWith(".timer"));
    expect(timers.length).toBeGreaterThan(0);
    for (const timer of timers) {
      const unit = /^Unit=(.+)$/m.exec(await readFile(join(dir, timer), "utf8"))?.[1] ?? timer.replace(/\.timer$/, ".service");
      // A oneshot that stays "active" after exiting is never started again by its timer.
      expect(await readFile(join(dir, unit), "utf8"), unit).not.toMatch(/^RemainAfterExit=(yes|true|1|on)\s*$/m);
    }
  });

  it("exports only memory and cannot run a source hook", async () => {
    const root = await tempRoot();
    const source = join(root, "source");
    const exportDir = join(root, "export");
    const hooks = join(root, "hooks");
    const marker = join(root, "hook-ran");
    await mkdir(join(source, "memory"), { recursive: true });
    await mkdir(join(source, "scripts"), { recursive: true });
    await writeFile(join(source, "memory", "note.md"), "allowed\n");
    await writeFile(join(source, "scripts", "outside.txt"), "not exported\n");
    await mkdir(join(source, ".git", "hooks"), { recursive: true });
    await writeFile(join(source, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(join(source, ".git", "hooks", "pre-commit"), 0o755);
    await runChecked("bash", [join(repo, "deploy/backup.sh")], {
      env: { ...process.env, BACKUP_SOURCE_DIR: source, BACKUP_EXPORT_DIR: exportDir, BACKUP_HOOKS_DIR: hooks },
    });
    expect(await readFile(join(exportDir, "memory", "note.md"), "utf8")).toBe("allowed\n");
    await expect(readFile(join(exportDir, "scripts", "outside.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("keeps privileged source artifacts non-writable to service users", async () => {
    const artifacts = [
      "deploy/backup.sh",
      "deploy/netguard.sh",
      "deploy/install-units.sh",
      "deploy/setup.sh",
      "deploy/update.sh",
      "deploy/release.sh",
      "deploy/health-check.sh",
      "deploy/ssh-guard.sh",
      "deploy/state-backup.sh",
      "deploy/restore-drill.sh",
      "deploy/systemd/crowstance-backup.service",
      "deploy/systemd/crowstance-state-backup.service",
      "deploy/systemd/crowstance-netguard.service",
    ];
    for (const relative of artifacts) {
      const mode = (await stat(join(repo, relative))).mode & 0o777;
      expect(mode & 0o022, relative).toBe(0);
    }
    const setup = await readFile(join(repo, "deploy/setup.sh"), "utf8");
    const release = await readFile(join(repo, "deploy/release.sh"), "utf8");
    expect(setup).toContain("chown -R root:root");
    expect(release).toContain("chown -R root:root");
    // The live release tree is only changed by an atomic symlink replacement.
    expect(release).toContain("mv -Tf");
  });
});
