import { chmod, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, afterEach } from "vitest";

// These suites run the real deploy scripts: bash, symlinks, file modes and systemd-style layouts.
// They target the Linux server, so they run on Linux (and CI) and are skipped on Windows.
const linuxOnly = describe.skipIf(process.platform === "win32");

const run = promisify(execFile);
const repo = process.cwd();
const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "crowstance-atomic-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeExec(path: string, body: string) {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

async function runScript(file: string, args: string[], env: NodeJS.ProcessEnv) {
  try {
    const result = await run(file, args, { env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const detail = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof detail.code === "number" ? detail.code : 1,
      stdout: detail.stdout ?? "",
      stderr: detail.stderr ?? detail.message ?? "",
    };
  }
}

interface Fixture {
  root: string;
  app: string;
  releases: string;
  state: string;
  staging: string;
  etc: string;
  systemd: string;
  bin: string;
  env: NodeJS.ProcessEnv;
}

async function makeFixture(opts: { npmFails?: boolean; restartFails?: boolean } = {}): Promise<Fixture> {
  const root = await tempRoot();
  const releases = join(root, "releases");
  const app = join(root, "app");
  const state = join(root, "state");
  const staging = join(root, "staging");
  const etc = join(root, "etc");
  const systemd = join(root, "systemd");
  const bin = join(root, "bin");
  await mkdir(join(releases, "old", "deploy"), { recursive: true });
  await mkdir(join(releases, "old", "opencode"), { recursive: true });
  await mkdir(join(releases, "old", "home", "scripts"), { recursive: true });
  await mkdir(join(staging, "new", "deploy", "systemd"), { recursive: true });
  await mkdir(join(staging, "new", "opencode"), { recursive: true });
  await mkdir(join(staging, "new", "home", "scripts"), { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(etc, { recursive: true });
  await mkdir(systemd, { recursive: true });
  await mkdir(bin, { recursive: true });

  // Existing, healthy release.
  await writeFile(join(releases, "old", "package.json"), '{"name":"old"}\n');
  await writeFile(join(releases, "old", ".env"), "OPERATOR=1\n");
  await writeFile(join(releases, "old", "deploy", "secrets.env"), "SECRET=old\n");
  await symlink(join(releases, "old"), app);
  await writeFile(join(state, "known-good"), "old\n");

  // Uploaded next release.
  await writeFile(join(staging, "new", "package.json"), '{"name":"new"}\n');
  await writeFile(join(staging, "new", ".env"), "FROM_STAGING=1\n");
  await writeFile(join(staging, "new", "deploy", "secrets.env"), "SECRET=staging\n");
  await writeFile(join(staging, "new", "deploy", "systemd", "sample.service"), "[Service]\n");
  await writeExec(
    join(staging, "new", "deploy", "install-units.sh"),
    `#!/bin/sh\nset -eu\nfor f in "$CROW_APP"/deploy/systemd/*; do cp "$f" "$CROW_SYSTEMD_DIR/$(basename "$f")"; done\n`,
  );

  await writeExec(
    join(bin, "npm"),
    `#!/bin/sh\nprintf '%s\\n' npm-called >> "$NPM_LOG"\n${opts.npmFails ? "exit 1\n" : ""}`,
  );
  await writeExec(
    join(bin, "systemctl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"\ncase "$*" in *restart*) ${
      opts.restartFails ? "exit 1" : "exit 0"
    };; esac\nexit 0\n`,
  );
  await writeExec(join(bin, "chown"), "#!/bin/sh\nexit 0\n");
  await writeFile(
    join(etc, "setup.env"),
    "CPU_WEIGHT=100\nCPU_QUOTA=100%\nMEMORY_MAX=1G\nSWAP_MAX=infinity\nIO_WEIGHT=100\nTASKS_MAX=100\nNICE=0\nSHARED=0\n",
  );
  await writeFile(join(etc, "gateway.env"), "KEEP_ME=1\n");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CROW_APP: app,
    CROW_RELEASES: releases,
    CROW_STATE: state,
    CROW_STAGING: staging,
    CROW_ETC: etc,
    CROW_SYSTEMD_DIR: systemd,
    CROW_BIN: bin,
    CROW_NODE: root,
    NPM_LOG: join(root, "npm.log"),
    SYSTEMCTL_LOG: join(root, "systemctl.log"),
    CROW_HEALTH_TIMEOUT: "1",
    CROW_HEALTH_INTERVAL: "0",
    PATH: `${bin}:${process.env.PATH}`,
  };
  return { root, app, releases, state, staging, etc, systemd, bin, env };
}

const updateScript = () => join(repo, "deploy", "update.sh");

async function currentTarget(app: string) {
  return readlink(app);
}

/** A throwaway project holding this repo's deploy.sh, and an ssh stand-in that keeps what gets uploaded. */
async function deployFixture(opts: { git?: boolean } = {}) {
  const root = await tempRoot();
  const project = join(root, "project");
  const remote = join(root, "remote");
  const bin = join(root, "bin");
  await mkdir(join(project, "deploy"), { recursive: true });
  await mkdir(remote, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(project, "deploy", "deploy.sh"), await readFile(join(repo, "deploy", "deploy.sh"), "utf8"));
  await writeFile(join(project, "package.json"), '{"name":"crowstance"}\n');
  // Keep uploads (a remote "tee <path>"), log every other remote command.
  await writeExec(
    join(bin, "ssh"),
    `#!/bin/sh\nshift\ncase "$1" in\n  *"tee "*) dest=$(printf '%s\\n' "$1" | sed -n 's/.*tee \\([^ ]*\\).*/\\1/p'); cat > "$REMOTE/$(basename "$dest")" ;;\n  *) printf '%s\\n' "$1" >> "$REMOTE/commands.log" ;;\nesac\n`,
  );
  const git = (...args: string[]) => run("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args]);
  if (opts.git) {
    await git("init", "-q", "-b", "main");
    await git("add", "-A");
    await git("commit", "-qm", "First release");
  }
  const env = { ...process.env, REMOTE: remote, PATH: `${bin}:${process.env.PATH}` };
  const deploy = (...args: string[]) => runScript("bash", [join(project, "deploy", "deploy.sh"), "root@example.test", ...args], env);
  return { root, project, remote, git, deploy };
}

/** The archive and manifest named by the last update command deploy.sh sent. */
async function uploaded(remote: string) {
  const update = (await readFile(join(remote, "commands.log"), "utf8")).trim().split("\n").at(-1)!;
  return {
    archive: join(remote, basename(/--archive (\S+)/.exec(update)![1]!)),
    manifest: join(remote, basename(/--manifest (\S+)/.exec(update)![1]!)),
  };
}

async function unpack(fx: { root: string; remote: string }) {
  const out = await mkdtemp(join(fx.root, "out-"));
  await run("tar", ["xzf", (await uploaded(fx.remote)).archive, "-C", out]);
  return out;
}

linuxOnly("atomic deploy, health gate and rollback", () => {
  it("rejects an upload whose checksum manifest does not match", async () => {
    const fx = await makeFixture();
    const archive = join(fx.root, "release.tar.gz");
    const manifest = join(fx.root, "release.tar.gz.sha256");
    await writeFile(archive, "this is not the archive the manifest describes\n");
    await writeFile(manifest, `${"0".repeat(64)}  release.tar.gz\n`);

    const result = await runScript(
      "bash",
      [updateScript(), "--id", "new", "--archive", archive, "--manifest", manifest],
      fx.env,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("checksum");
    expect(await currentTarget(fx.app)).toBe(join(fx.releases, "old"));
    await expect(readFile(join(fx.releases, "new", "package.json"), "utf8")).rejects.toThrow();
  });

  it("accepts the archive and manifest exactly as deploy.sh uploads them", async () => {
    const fx = await deployFixture();
    const deploy = await fx.deploy();
    expect(deploy.stderr).toBe("");
    expect(deploy.code).toBe(0);
    const { archive, manifest } = await uploaded(fx.remote);
    const verify = await runScript("bash", [join(repo, "deploy", "release.sh"), "verify", archive, manifest], process.env);
    expect(verify.stderr).toBe("");
    expect(verify.code).toBe(0);
  });

  it("ships the commit it was built from, with that commit's history", async () => {
    const fx = await deployFixture({ git: true });
    const head = (await fx.git("rev-parse", "HEAD")).stdout.trim();
    const deploy = await fx.deploy();
    expect(deploy.stderr).toBe("");
    expect(deploy.code).toBe(0);

    const out = await unpack(fx);
    const version = await readFile(join(out, "VERSION"), "utf8");
    expect(version).toContain(`commit: ${head}`);
    expect(version).toContain("subject: First release");
    // The assistant's own copy fetches the running version from the release's bundle.
    const copy = join(fx.root, "copy");
    await run("git", ["init", "-q", copy]);
    await run("git", ["-C", copy, "fetch", "-q", join(out, "source.bundle"), "+HEAD:refs/remotes/live/main"]);
    expect((await run("git", ["-C", copy, "rev-parse", "live/main"])).stdout.trim()).toBe(head);
  });

  it("refuses to ship uncommitted changes unless told to", async () => {
    const fx = await deployFixture({ git: true });
    await writeFile(join(fx.project, "package.json"), '{"name":"crowstance","edited":true}\n');
    const refused = await fx.deploy();
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("uncommitted changes");
    expect(await readdir(fx.remote)).toEqual([]); // nothing was uploaded

    const forced = await fx.deploy("--allow-dirty");
    expect(forced.code).toBe(0);
    expect(await readFile(join(await unpack(fx), "VERSION"), "utf8")).toContain("uncommitted changes");
  });

  it("leaves the current release untouched when dependency installation fails", async () => {
    const fx = await makeFixture({ npmFails: true });
    const result = await runScript(
      "bash",
      [updateScript(), "--id", "new", "--upload", join(fx.staging, "new")],
      fx.env,
    );
    expect(result.code).not.toBe(0);
    expect(await currentTarget(fx.app)).toBe(join(fx.releases, "old"));
    expect(await readFile(join(fx.releases, "old", "package.json"), "utf8")).toContain("old");
    expect((await readFile(join(fx.state, "known-good"), "utf8")).trim()).toBe("old");
    await expect(readFile(join(fx.releases, "new", "package.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(fx.state, "pending"), "utf8")).rejects.toThrow();
  });

  it("switches the pointer atomically, preserves overlays and keeps the old release", async () => {
    const fx = await makeFixture();
    const result = await runScript(
      "bash",
      [updateScript(), "--id", "new", "--upload", join(fx.staging, "new")],
      { ...fx.env, CROW_HEALTH_CMD: "exit 0" },
    );
    expect(result.stderr + result.stdout).toContain("release new is active and healthy");
    expect(await currentTarget(fx.app)).toBe(join(fx.releases, "new"));
    expect((await readFile(join(fx.state, "known-good"), "utf8")).trim()).toBe("new");
    // Operator overlays from the live release survive; uploads never overwrite them.
    expect(await readFile(join(fx.releases, "new", ".env"), "utf8")).toBe("OPERATOR=1\n");
    expect(await readFile(join(fx.releases, "new", "deploy", "secrets.env"), "utf8")).toBe("SECRET=old\n");
    // The previous release remains available for rollback.
    expect((await stat(join(fx.releases, "old"))).isDirectory()).toBe(true);
    // Config overlays outside the release tree are untouched.
    expect(await readFile(join(fx.etc, "gateway.env"), "utf8")).toBe("KEEP_ME=1\n");
    // Dependencies were installed and units rendered for the new release.
    expect(await readFile(join(fx.root, "npm.log"), "utf8")).toContain("npm-called");
    expect(await readFile(join(fx.root, "systemctl.log"), "utf8")).toContain("restart crowstance-gateway");
    expect(await readFile(join(fx.systemd, "sample.service"), "utf8")).toContain("[Service]");
    await expect(readFile(join(fx.state, "pending"), "utf8")).rejects.toThrow();
  });

  it("rolls back to the last known-good release when the readiness gate fails", async () => {
    const fx = await makeFixture();
    // Healthy only while the pointer still names the old release.
    const health = `[ "$(basename "$(readlink -f "$CROW_APP")")" = old ] || { echo "health: gateway not ready" >&2; exit 1; }`;
    const result = await runScript(
      "bash",
      [updateScript(), "--id", "new", "--upload", join(fx.staging, "new")],
      { ...fx.env, CROW_HEALTH_CMD: health },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("rolling back");
    // Only the last failed attempt is reported, not every retry inside the wait.
    expect(result.stderr.split("health: gateway not ready").length - 1).toBe(1);
    expect(await currentTarget(fx.app)).toBe(join(fx.releases, "old"));
    expect((await readFile(join(fx.state, "known-good"), "utf8")).trim()).toBe("old");
    // The failed release is kept for inspection, not deleted.
    expect((await stat(join(fx.releases, "new"))).isDirectory()).toBe(true);
    await expect(readFile(join(fx.state, "pending"), "utf8")).rejects.toThrow();
  });

  it("hides the expected misses while services restart and reports the final result", async () => {
    const fx = await makeFixture();
    const count = join(fx.root, "health-attempts");
    const health = `n=$(( $(cat "${count}" 2>/dev/null || echo 0) + 1 )); echo $n > "${count}"; if [ $n -lt 3 ]; then echo "health: not ready yet" >&2; exit 1; fi; echo "health: all ready"`;
    const result = await runScript(
      "bash",
      [updateScript(), "--id", "new", "--upload", join(fx.staging, "new")],
      { ...fx.env, CROW_HEALTH_CMD: health, CROW_HEALTH_TIMEOUT: "10" },
    );
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("not ready yet");
    expect(result.stdout).toContain("health: all ready");
    expect(await currentTarget(fx.app)).toBe(join(fx.releases, "new"));
  });

  it("rolls back when the service restart fails", async () => {
    const fx = await makeFixture({ restartFails: true });
    const result = await runScript(
      "bash",
      [updateScript(), "--id", "new", "--upload", join(fx.staging, "new")],
      { ...fx.env, CROW_HEALTH_CMD: "exit 0" },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("restart failed");
    expect(await currentTarget(fx.app)).toBe(join(fx.releases, "old"));
  });

  it("recovers an interrupted update by rolling back to known-good", async () => {
    const fx = await makeFixture();
    await mkdir(join(fx.releases, "new"), { recursive: true });
    await writeFile(join(fx.releases, "new", "package.json"), '{"name":"new"}\n');
    await rm(fx.app);
    await symlink(join(fx.releases, "new"), fx.app);
    await writeFile(join(fx.state, "pending"), "new=new\nprevious=old\n");

    const result = await runScript("bash", [join(repo, "deploy", "release.sh"), "recover"], {
      ...fx.env,
      CROW_HEALTH_CMD: "exit 1",
    });
    expect(result.code).toBe(0);
    expect(await currentTarget(fx.app)).toBe(join(fx.releases, "old"));
    await expect(readFile(join(fx.state, "pending"), "utf8")).rejects.toThrow();
    expect((await stat(join(fx.releases, "new"))).isDirectory()).toBe(true);
  });

  it("adopts an interrupted update that is already healthy", async () => {
    const fx = await makeFixture();
    await mkdir(join(fx.releases, "new"), { recursive: true });
    await writeFile(join(fx.releases, "new", "package.json"), '{"name":"new"}\n');
    await rm(fx.app);
    await symlink(join(fx.releases, "new"), fx.app);
    await writeFile(join(fx.state, "pending"), "new=new\nprevious=old\n");

    const result = await runScript("bash", [join(repo, "deploy", "release.sh"), "recover"], {
      ...fx.env,
      CROW_HEALTH_CMD: "exit 0",
    });
    expect(result.code).toBe(0);
    expect(await currentTarget(fx.app)).toBe(join(fx.releases, "new"));
    expect((await readFile(join(fx.state, "known-good"), "utf8")).trim()).toBe("new");
    await expect(readFile(join(fx.state, "pending"), "utf8")).rejects.toThrow();
  });
});

linuxOnly("doctor release-state detection", () => {
  async function installHelper(releaseDir: string) {
    await mkdir(join(releaseDir, "deploy"), { recursive: true });
    await writeFile(join(releaseDir, "deploy", "release.sh"), await readFile(join(repo, "deploy", "release.sh"), "utf8"));
  }

  it("reports a mixed active/known-good state", async () => {
    const fx = await makeFixture();
    await installHelper(join(fx.releases, "new"));
    await writeFile(join(fx.releases, "new", "package.json"), '{"name":"new"}\n');
    await rm(fx.app);
    await symlink(join(fx.releases, "new"), fx.app);
    const result = await runScript("bash", [join(repo, "deploy", "doctor.sh")], fx.env);
    expect(result.stdout + result.stderr).toContain("MIXED STATE");
  });

  it("reports an interrupted update", async () => {
    const fx = await makeFixture();
    await installHelper(join(fx.releases, "old"));
    await writeFile(join(fx.state, "pending"), "new=new\nprevious=old\n");
    const result = await runScript("bash", [join(repo, "deploy", "doctor.sh")], fx.env);
    expect(result.stdout + result.stderr).toContain("interrupted");
  });
});

linuxOnly("ssh lockout guard", () => {
  async function sshFixture(overrides: { keys?: string; group?: string; sudoers?: string; sshd?: string }) {
    const root = await tempRoot();
    const passwd = join(root, "passwd");
    const group = join(root, "group");
    const keys = join(root, "authorized_keys");
    const sudoers = join(root, "sudoers");
    const sshd = join(root, "sshd-T");
    await writeFile(passwd, "root:x:0:0::/root:/bin/bash\nadmin:x:1000:1000::/home/admin:/bin/bash\n");
    await writeFile(group, overrides.group ?? "admin:x:1000:\nsudo:x:27:admin\n");
    await writeFile(keys, overrides.keys ?? "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA admin@host\n");
    await writeFile(sudoers, overrides.sudoers ?? "admin ALL=(ALL) NOPASSWD:ALL\n");
    await writeFile(sshd, overrides.sshd ?? "pubkeyauthentication yes\npermitrootlogin no\n");
    return { root, passwd, group, keys, sudoers, sshd };
  }

  async function guard(fx: Awaited<ReturnType<typeof sshFixture>>) {
    return runScript(
      "bash",
      [
        join(repo, "deploy", "ssh-guard.sh"),
        "--admin-user",
        "admin",
        "--authorized-keys",
        fx.keys,
        "--passwd",
        fx.passwd,
        "--group",
        fx.group,
        "--sudoers-file",
        fx.sudoers,
        "--sshd-config",
        fx.sshd,
      ],
      process.env,
    );
  }

  it("accepts a usable, sudo-capable admin with a public key", async () => {
    const fx = await sshFixture({});
    expect((await guard(fx)).code).toBe(0);
  });

  it("refuses when the admin has no usable key", async () => {
    const fx = await sshFixture({ keys: "# no keys here\n" });
    const result = await guard(fx);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no usable SSH public key");
  });

  it("refuses when the admin cannot sudo", async () => {
    const fx = await sshFixture({ group: "admin:x:1000:\n", sudoers: "# empty\n" });
    const result = await guard(fx);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not in a sudo group");
  });

  it("refuses when effective sshd config disables public-key auth", async () => {
    const fx = await sshFixture({ sshd: "pubkeyauthentication no\n" });
    const result = await guard(fx);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("PubkeyAuthentication is disabled");
  });

  it("refuses a root admin or a nologin shell", async () => {
    const fx = await sshFixture({});
    const rootAdmin = await runScript(
      "bash",
      [join(repo, "deploy", "ssh-guard.sh"), "--admin-user", "root", "--authorized-keys", fx.keys, "--passwd", fx.passwd],
      process.env,
    );
    expect(rootAdmin.code).not.toBe(0);
    await writeFile(fx.passwd, "admin:x:1000:1000::/home/admin:/usr/sbin/nologin\n");
    const nologin = await guard(fx);
    expect(nologin.code).not.toBe(0);
  });
});

linuxOnly("readiness health check", () => {
  async function healthFixture(opts: { systemctlExit?: string } = {}) {
    const root = await tempRoot();
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeExec(
      join(bin, "curl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CURL_LOG"\ncase "$*" in *--config*) cat >> "$CURL_LOG.stdin" ;; esac\nprintf '%s\\n' '{"ok":true}'\nexit "\${CURL_EXIT:-0}"\n`,
    );
    await writeExec(join(bin, "systemctl"), `#!/bin/sh\nexit ${opts.systemctlExit ?? "0"}\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CURL_LOG: join(root, "curl.log"),
      CROW_ETC: join(root, "etc"),
    };
    return { root, env };
  }

  it("checks the gateway readiness endpoint and fails when it is not ready", async () => {
    const fx = await healthFixture();
    const fail = await runScript(
      "bash",
      [join(repo, "deploy", "health-check.sh"), "--gateway-only"],
      { ...fx.env, HQ_PORT: "7801", CURL_EXIT: "7" },
    );
    expect(fail.code).not.toBe(0);
    const okLog = join(fx.root, "ok.log");
    const ok = await runScript(
      "bash",
      [join(repo, "deploy", "health-check.sh"), "--gateway-only"],
      { ...fx.env, HQ_PORT: "7801", CURL_EXIT: "0", CURL_LOG: okLog },
    );
    expect(ok.code).toBe(0);
    // The gateway gate must hit readiness, not merely liveness.
    expect(await readFile(okLog, "utf8")).toContain("/ready");
  });

  it("checks the OpenCode /api/info endpoint", async () => {
    const fx = await healthFixture({});
    const result = await runScript(
      "bash",
      [join(repo, "deploy", "health-check.sh"), "--opencode-only"],
      { ...fx.env, OPENCODE_URL: "http://127.0.0.1:4096" },
    );
    expect(result.code).toBe(0);
    // OpenCode 2 has no /global/health; health-check.sh probes /api/info since the v2 migration.
    expect(await readFile(join(fx.root, "curl.log"), "utf8")).toContain("/api/info");
  });

  it("authenticates to OpenCode without putting the password on the command line", async () => {
    const fx = await healthFixture({});
    const result = await runScript("bash", [join(repo, "deploy", "health-check.sh"), "--opencode-only"], {
      ...fx.env,
      OPENCODE_URL: "http://127.0.0.1:4096",
      OPENCODE_SERVER_PASSWORD: "s3cret-pw",
    });
    expect(result.code).toBe(0);
    expect(await readFile(join(fx.root, "curl.log"), "utf8")).not.toContain("s3cret-pw");
    expect(await readFile(join(fx.root, "curl.log.stdin"), "utf8")).toContain('user = "opencode:s3cret-pw"');
  });

  it("works as the unprivileged ExecStartPost when the env files are root-only", async () => {
    const fx = await healthFixture({});
    await mkdir(join(fx.root, "etc"), { recursive: true });
    await writeFile(join(fx.root, "etc", "opencode.env"), "OPENCODE_SERVER_PASSWORD=from-file\n");
    await chmod(join(fx.root, "etc", "opencode.env"), 0o000);
    const result = await runScript("bash", [join(repo, "deploy", "health-check.sh"), "--opencode-only"], {
      ...fx.env,
      OPENCODE_PORT: "4096",
      OPENCODE_SERVER_PASSWORD: "from-unit-env",
    });
    await chmod(join(fx.root, "etc", "opencode.env"), 0o600);
    expect(result.code).toBe(0);
    expect(await readFile(join(fx.root, "curl.log.stdin"), "utf8")).toContain("from-unit-env");
  });

  it("requires the systemd units to be active in the full check", async () => {
    const fx = await healthFixture({ systemctlExit: "3" });
    const result = await runScript("bash", [join(repo, "deploy", "health-check.sh")], {
      ...fx.env,
      HQ_PORT: "7801",
      OPENCODE_URL: "http://127.0.0.1:4096",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not active");
  });
});
