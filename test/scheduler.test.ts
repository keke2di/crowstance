import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KEY_DISK_LOW } from "../src/db.ts";
import { KEY_QUIET, minIntervalMinutes, Scheduler } from "../src/scheduler.ts";
import { Tasks, UserError } from "../src/tasks.ts";
import { FakeOpenCode, memoryStore, testConfig } from "./fakes.ts";

function setup(env: Record<string, string> = {}, freeGb = 100) {
  const cfg = testConfig(env);
  const store = memoryStore();
  const oc = new FakeOpenCode();
  const tasks = new Tasks({ cfg, store, oc: oc.asOpenCode(), onUpdate: () => {} });
  const disk = { freeGb };
  const scheduler = new Scheduler({
    cfg,
    store,
    tasks,
    oc: oc.asOpenCode(),
    onUpdate: () => {},
    housekeeping: async () => {},
    statfs: async () => ({ bavail: Math.round(disk.freeGb * 1e9) / 4096, bsize: 4096 }),
  });
  return { cfg, store, oc, tasks, scheduler, disk };
}

describe("minIntervalMinutes", () => {
  it("measures the tightest gap of a cron pattern", () => {
    expect(minIntervalMinutes("*/10 * * * *")).toBe(10);
    expect(minIntervalMinutes("0 7 * * *")).toBe(24 * 60);
    expect(minIntervalMinutes("0 9,17 * * *")).toBe(8 * 60);
  });
});

describe("Scheduler", () => {
  it("fires due reminders as urgent updates exactly once", async () => {
    const { store, scheduler } = setup();
    const r = scheduler.remind(new Date(Date.now() + 1_000), "stretch");
    expect(r.id).toBe(1);
    await scheduler.tick(new Date(Date.now() + 2_000));
    await scheduler.tick(new Date(Date.now() + 3_000));
    const updates = store.pendingUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.kind).toBe("reminder");
    expect(updates[0]!.urgent).toBe(1);
    expect(updates[0]!.text).toContain("stretch");
  });

  it("rejects reminders in the past and cancels by id", () => {
    const { scheduler } = setup();
    expect(() => scheduler.remind(new Date(Date.now() - 3_600_000), "too late")).toThrow(UserError);
    const { id } = scheduler.remind(new Date(Date.now() + 3_600_000), "later");
    expect(scheduler.listReminders()).toContain("later");
    scheduler.cancelReminder(id);
    expect(scheduler.listReminders()).toBe("No upcoming reminders.");
  });

  it("refuses LLM jobs that run too often, accepts sensible ones", () => {
    const { scheduler } = setup({ MIN_JOB_INTERVAL_MIN: "60" });
    expect(() => scheduler.schedule({ name: "spam", cron: "*/5 * * * *", instructions: "check the site every five minutes" })).toThrow(/monitor_add/);
    expect(() => scheduler.schedule({ name: "bad", cron: "not a cron", instructions: "this pattern is not valid at all" })).toThrow(/Invalid cron/);
    const job = scheduler.schedule({ name: "digest", cron: "0 7 * * *", instructions: "Write the morning digest into digests/" });
    expect(job.next).not.toBe("never");
    expect(scheduler.listJobs()).toContain("digest");
    scheduler.unschedule("digest");
    expect(scheduler.listJobs()).toBe("No scheduled jobs.");
    scheduler.stop();
  });

  it("follows quiet hours unless overridden", () => {
    const { store, scheduler } = setup({ QUIET_HOURS: "23:00-08:00" });
    const night = new Date(2026, 9, 6, 2, 0);
    const noon = new Date(2026, 9, 6, 12, 0);
    expect(scheduler.isQuiet(night)).toBe(true);
    expect(scheduler.isQuiet(noon)).toBe(false);
    store.set(KEY_QUIET, "on");
    expect(scheduler.isQuiet(noon)).toBe(true);
    store.set(KEY_QUIET, "off");
    expect(scheduler.isQuiet(night)).toBe(false);
  });

  it("queues the morning check-in once per day", async () => {
    const { store, scheduler } = setup({ MORNING_CHECKIN: "08:30" });
    await scheduler.tick(new Date(2026, 9, 6, 8, 0));
    expect(store.pendingUpdates()).toHaveLength(0);
    await scheduler.tick(new Date(2026, 9, 6, 8, 31));
    await scheduler.tick(new Date(2026, 9, 6, 9, 0));
    expect(store.pendingUpdates().filter((u) => u.kind === "checkin")).toHaveLength(1);
  });
});

describe("monitors", () => {
  it("only accepts scripts inside the assistant home", () => {
    const { cfg, scheduler } = setup();
    expect(scheduler.addMonitor({ name: "site-up", script: "scripts/monitors/site-up.sh", everyMinutes: 5 }).script).toBe("scripts/monitors/site-up.sh");
    expect(scheduler.addMonitor({ name: "abs", script: path.join(cfg.ASSISTANT_HOME, "scripts", "x.sh"), everyMinutes: 1 }).script).toBe("scripts/x.sh");
    expect(() => scheduler.addMonitor({ name: "evil", script: "../../etc/passwd", everyMinutes: 5 })).toThrow(UserError);
    expect(() => scheduler.addMonitor({ name: "Bad Name", script: "scripts/a.sh", everyMinutes: 5 })).toThrow(UserError);
    expect(() => scheduler.addMonitor({ name: "zero", script: "scripts/a.sh", everyMinutes: 0 })).toThrow(UserError);
  });

  it("runs due monitors through OpenCode on their interval and kills hung ones later", async () => {
    const { cfg, oc, scheduler } = setup();
    scheduler.addMonitor({ name: "site-up", script: "scripts/monitors/site-up.sh", everyMinutes: 5 });
    const t0 = Date.now();
    await scheduler.tick(new Date(t0));
    expect(oc.spawned).toEqual([{ id: "pty_1", cwd: cfg.ASSISTANT_HOME, command: "bash", args: ["scripts/monitors/site-up.sh"] }]);

    await scheduler.tick(new Date(t0 + 2 * 60_000));
    expect(oc.spawned).toHaveLength(1); // not due yet
    await scheduler.tick(new Date(t0 + 5 * 60_000));
    expect(oc.spawned).toHaveLength(2);

    expect(scheduler.listMonitors()).toContain("site-up: scripts/monitors/site-up.sh every 5 min");
    scheduler.removeMonitor("site-up");
    await scheduler.tick(new Date(t0 + 20 * 60_000));
    expect(oc.spawned).toHaveLength(2);
    expect(scheduler.listMonitors()).toBe("No monitors.");
  });
});

describe("disk watchdog", () => {
  it("pauses new tasks and alerts once when space runs low, then recovers", async () => {
    const { store, tasks, scheduler, disk } = setup({ DISK_MIN_FREE_GB: "5" }, 3);
    await scheduler.tick();
    await scheduler.tick();
    expect(store.get(KEY_DISK_LOW)).toBe("1");
    const alerts = store.pendingUpdates().filter((u) => u.kind === "system");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.urgent).toBe(1);
    await expect(tasks.start({ title: "big job", brief: "something that needs disk space" })).rejects.toThrow(/low on disk space/);

    disk.freeGb = 6; // above the limit but below the 1.5× hysteresis band
    await scheduler.tick();
    expect(store.get(KEY_DISK_LOW)).toBe("1");
    disk.freeGb = 20;
    await scheduler.tick();
    expect(store.get(KEY_DISK_LOW)).toBeUndefined();
    await expect(tasks.start({ title: "big job", brief: "something that needs disk space" })).resolves.toMatchObject({ slug: "big-job" });
  });
});

describe("morning check-in window", () => {
  it("doesn't fire when the gateway starts in the afternoon", async () => {
    const { store, scheduler } = setup({ MORNING_CHECKIN: "08:30" });
    await scheduler.tick(new Date(2026, 9, 6, 17, 22));
    expect(store.pendingUpdates().filter((u) => u.kind === "checkin")).toHaveLength(0);
    await scheduler.tick(new Date(2026, 9, 7, 9, 15));
    expect(store.pendingUpdates().filter((u) => u.kind === "checkin")).toHaveLength(1);
  });

  it("does not overlap a scheduled job in its shared project", async () => {
    const { scheduler, tasks, store } = setup();
    await tasks.start({ title: "digest", brief: "already running", project: "job-digest", job: "digest" });
    store.upsertJob({ name: "digest", cron: "0 7 * * *", instructions: "new run", model: null });
    await (scheduler as unknown as { runJob: (name: string) => Promise<void> }).runJob("digest");
    expect(store.pendingUpdates().at(-1)!.text).toContain("still active");
  });

  it("serializes housekeeping ticks", async () => {
    let active = 0;
    let max = 0;
    const releases: (() => void)[] = [];
    const { cfg, store, tasks, oc } = setup();
    const housekeeping = async () => {
      active++;
      max = Math.max(max, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
    };
    const scheduler = new Scheduler({ cfg, store, tasks, oc: oc.asOpenCode(), onUpdate: () => {}, housekeeping });
    const first = scheduler.tick();
    await vi.waitFor(() => expect(releases).toHaveLength(1)); // the first tick is inside housekeeping
    await scheduler.tick(); // an overlapping tick is skipped and returns right away
    expect(releases).toHaveLength(1);
    releases.shift()!();
    await first;
    const third = scheduler.tick(); // once the first is done, ticks run again
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();
    await third;
    expect(max).toBe(1);
  });
});
