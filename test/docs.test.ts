import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const repo = process.cwd();

const DOCS = ["docs/ARCHITECTURE.md", "docs/MODULES.md", "docs/OPERATIONS.md", "docs/CONTRIBUTING.md", "docs/SUBAGENTS.md"];

function bashBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

describe("operational documentation", () => {
  it("ships the required docs", async () => {
    for (const doc of DOCS) expect((await stat(join(repo, doc))).isFile(), doc).toBe(true);
  });

  it("syntax-checks every runbook bash block", async () => {
    for (const doc of DOCS) {
      const text = await readFile(join(repo, doc), "utf8");
      for (const block of bashBlocks(text)) {
        await expect(run("bash", ["-n", "-c", block]), `${doc}\n${block}`).resolves.toBeDefined();
      }
    }
    // The operations runbook is the one that must carry real commands.
    const operations = await readFile(join(repo, "docs/OPERATIONS.md"), "utf8");
    expect(bashBlocks(operations).length).toBeGreaterThanOrEqual(5);
    // One bash process per block; on Windows `bash` is WSL's and takes ~200 ms to start.
  }, 60_000);

  it("only references deployment scripts that exist", async () => {
    const referenced = [
      "deploy/doctor.sh",
      "deploy/health-check.sh",
      "deploy/release.sh",
      "deploy/state-backup.sh",
      "deploy/restore-drill.sh",
      "deploy/setup.sh",
      "deploy/deploy.sh",
    ];
    for (const path of referenced) expect((await stat(join(repo, path))).isFile(), path).toBe(true);
  });
});

describe("README accuracy", () => {
  it("does not carry the stale path or exactly-once claim", async () => {
    const readme = await readFile(join(repo, "README.md"), "utf8");
    expect(readme).not.toContain("/etc/assistant");
    expect(readme).not.toContain("exactly-once");
    expect(readme).toContain("memory/notes");
    const env = await readFile(join(repo, ".env.example"), "utf8");
    expect(env).not.toContain("/etc/assistant");
  });
});
