/**
 * Time-based things: reminders, recurring LLM jobs (cron), monitor scripts, the morning
 * check-in, quiet hours, the disk watchdog, and the periodic housekeeping tick.
 */
import fs from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import type { Config } from "./config.ts";
import { toMinutes } from "./config.ts";
import { KEY_DISK_LOW, type JobRow, type Store } from "./db.ts";
import { logger } from "./log.ts";
import type { OpenCode } from "./opencode.ts";
import { isInside, UserError, type Tasks } from "./tasks.ts";
import { ago, duration, inRange, minutesOfDay, stamp } from "./text.ts";

const log = logger("scheduler");

export const KEY_QUIET = "quiet.override"; // "on" | "off" | absent (= follow QUIET_HOURS)
const KEY_CHECKIN = "checkin.last";

type StatFs = (p: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

/** Minimum gap between consecutive runs of a cron pattern, sampled over its next runs. */
export function minIntervalMinutes(pattern: string, from = new Date()): number {
  const cron = new Cron(pattern, { paused: true });
  const runs = cron.nextRuns(6, from);
  cron.stop();
  if (runs.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 1; i < runs.length; i++) min = Math.min(min, (runs[i]!.getTime() - runs[i - 1]!.getTime()) / 60_000);
  return min;
}

export class Scheduler {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly tasks: Tasks;
  private readonly oc: OpenCode;
  private readonly onUpdate: () => void;
  private readonly crons = new Map<string, Cron>();
  private timer: NodeJS.Timeout | undefined;
  private readonly housekeeping: () => Promise<void>;
  private readonly statfs: StatFs;
  private ticking = false;
  private readonly monitorTimers = new Map<string, NodeJS.Timeout>();

  constructor(deps: {
    cfg: Config;
    store: Store;
    tasks: Tasks;
    oc: OpenCode;
    onUpdate: () => void;
    housekeeping: () => Promise<void>;
    statfs?: StatFs;
  }) {
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.tasks = deps.tasks;
    this.oc = deps.oc;
    this.onUpdate = deps.onUpdate;
    this.housekeeping = deps.housekeeping;
    this.statfs = deps.statfs ?? ((p) => fs.promises.statfs(p));
  }

  start() {
    for (const job of this.store.enabledJobs()) this.arm(job);
    this.timer = setInterval(() => void this.tick(), 20_000);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.crons.values()) c.stop();
    this.crons.clear();
    for (const timer of this.monitorTimers.values()) clearTimeout(timer);
    this.monitorTimers.clear();
  }

  // ---- quiet hours ----

  isQuiet(now = new Date()): boolean {
    const override = this.store.get(KEY_QUIET);
    if (override === "on") return true;
    if (override?.startsWith("on-until:")) {
      const until = Number(override.slice(9));
      if (until > now.getTime()) return true;
      this.store.delete(KEY_QUIET); // expired
      return this.cfg.quietHours ? inRange(minutesOfDay(now), this.cfg.quietHours) : false;
    }
    if (override === "off") return false;
    return this.cfg.quietHours ? inRange(minutesOfDay(now), this.cfg.quietHours) : false;
  }

  // ---- reminders ----

  remind(dueAt: Date, text: string) {
    if (Number.isNaN(dueAt.getTime())) throw new UserError("Invalid time for the reminder.");
    if (dueAt.getTime() < Date.now() - 60_000) throw new UserError(`That time (${stamp(dueAt)}) is in the past.`);
    const id = this.store.addReminder(dueAt.getTime(), text);
    return { id, due: stamp(dueAt), in: duration(dueAt.getTime() - Date.now()) };
  }

  listReminders(): string {
    const rows = this.store.upcomingReminders();
    if (rows.length === 0) return "No upcoming reminders.";
    return rows.map((r) => `- #${r.id} ${stamp(new Date(r.due_at))}: ${r.text}`).join("\n");
  }

  cancelReminder(id: number) {
    if (!this.store.cancelReminder(id)) throw new UserError(`No upcoming reminder #${id}.`);
  }

  // ---- recurring jobs ----

  schedule(p: { name: string; cron: string; instructions: string; model?: string }) {
    let interval: number;
    try {
      interval = minIntervalMinutes(p.cron);
    } catch (err) {
      throw new UserError(`Invalid cron pattern "${p.cron}": ${(err as Error).message}`);
    }
    if (interval < this.cfg.MIN_JOB_INTERVAL_MIN) {
      throw new UserError(
        `That runs every ${Math.round(interval)} min; the minimum for LLM jobs is ${this.cfg.MIN_JOB_INTERVAL_MIN} min. ` +
          `For frequent checks, write a script that calls notify.sh only when something is wrong and register it with monitor_add.`,
      );
    }
    // A job's model is checked now, not at 3am when the run would fail.
    this.tasks.checkModel(p.model);
    const job = this.store.upsertJob({ name: p.name, cron: p.cron, instructions: p.instructions, model: p.model ?? null });
    this.arm(job);
    const next = this.crons.get(job.name)?.nextRun();
    return { name: job.name, next: next ? stamp(next) : "never" };
  }

  unschedule(name: string) {
    if (!this.store.disableJob(name)) throw new UserError(`No active job named "${name}".`);
    this.crons.get(name)?.stop();
    this.crons.delete(name);
  }

  listJobs(): string {
    const jobs = this.store.enabledJobs();
    if (jobs.length === 0) return "No scheduled jobs.";
    return jobs
      .map((j) => {
        const next = this.crons.get(j.name)?.nextRun();
        return `- ${j.name} (${j.cron}) — next ${next ? stamp(next) : "?"}${j.last_run_at ? `, last ran ${stamp(new Date(j.last_run_at))}` : ""}\n  ${j.instructions.split("\n")[0]}`;
      })
      .join("\n");
  }

  private arm(job: JobRow) {
    this.crons.get(job.name)?.stop();
    const cron = new Cron(job.cron, { protect: true, catch: (err) => log.error(`job ${job.name} failed`, err) }, () => this.runJob(job.name));
    this.crons.set(job.name, cron);
  }

  private async runJob(name: string) {
    const job = this.store.job(name);
    if (!job?.enabled) return;
    if (this.store.activeJob(name)) {
      this.store.enqueueUpdate("job", `Scheduled job "${name}" was skipped because its previous run is still active.`);
      this.onUpdate();
      return;
    }
    this.store.markJobRun(name, Date.now());
    const date = new Date().toISOString().slice(0, 10);
    try {
      await this.tasks.start({ title: `${name} ${date}`, brief: job.instructions, project: `job-${name}`, model: job.model ?? undefined, job: name });
    } catch (err) {
      this.store.enqueueUpdate("job", `Scheduled job "${name}" was skipped: ${(err as Error).message}`);
      this.onUpdate();
    }
  }

  // ---- monitors: cheap scripts run on an interval, no model calls ----

  /** `script` is relative to the assistant home (or absolute inside it). */
  addMonitor(p: { name: string; script: string; everyMinutes: number }) {
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(p.name)) throw new UserError("Monitor names use lowercase letters, digits and dashes.");
    if (!Number.isInteger(p.everyMinutes) || p.everyMinutes < 1) throw new UserError("every_minutes must be a whole number ≥ 1.");
    const home = this.cfg.ASSISTANT_HOME;
    const abs = path.resolve(home, p.script);
    if (!isInside(abs, home) || abs === home) throw new UserError(`Monitor scripts must live inside ${home}.`);
    const script = path.relative(home, abs).split(path.sep).join("/");
    this.store.upsertMonitor({ name: p.name, script, every_min: p.everyMinutes });
    return { name: p.name, script, every: p.everyMinutes };
  }

  removeMonitor(name: string) {
    if (!this.store.disableMonitor(name)) throw new UserError(`No active monitor named "${name}".`);
    const timer = this.monitorTimers.get(name);
    if (timer) clearTimeout(timer);
    this.monitorTimers.delete(name);
  }

  listMonitors(): string {
    const rows = this.store.enabledMonitors();
    if (rows.length === 0) return "No monitors.";
    return rows
      .map((m) => `- ${m.name}: ${m.script} every ${m.every_min} min${m.last_run_at ? `, last ran ${ago(m.last_run_at)}` : ", hasn't run yet"}`)
      .join("\n");
  }

  private async runDueMonitors(now: number) {
    await this.recoverMonitors();
    for (const m of this.store.enabledMonitors()) {
      if (m.last_run_at && now - m.last_run_at < m.every_min * 60_000 - 5_000) continue;
      try {
        const id = await this.oc.spawn(this.cfg.ASSISTANT_HOME, "bash", [m.script], `monitor: ${m.name}`);
        const limit = Math.min(m.every_min * 60_000, this.cfg.MONITOR_TIMEOUT_SEC * 1000);
        const deadline = now + limit;
        if (!this.store.claimMonitor(m.name, id, deadline, now)) {
          await this.oc.kill(id, this.cfg.ASSISTANT_HOME);
          log.warn("monitor already running; skipped this interval", { monitor: m.name });
          continue;
        }
        const timer = setTimeout(() => void this.oc.kill(id, this.cfg.ASSISTANT_HOME).finally(() => this.store.finishMonitor(m.name, "failed", id)), limit);
        timer.unref();
        this.monitorTimers.set(m.name, timer);
      } catch (err) {
        log.warn("monitor could not start", { monitor: m.name, error: (err as Error).message });
      }
    }
  }

  private async recoverMonitors() {
    for (const m of this.store.runningMonitors()) {
      if (!m.pty_id) { this.store.finishMonitor(m.name, "failed"); continue; }
      if (m.deadline_at && m.deadline_at <= Date.now()) {
        await this.oc.kill(m.pty_id, this.cfg.ASSISTANT_HOME);
        this.store.finishMonitor(m.name, "failed", m.pty_id);
        continue;
      }
      const ptys = await this.oc.listPtys(this.cfg.ASSISTANT_HOME).catch(() => []);
      const pty = ptys.find((p) => p.id === m.pty_id);
      if (!pty || pty.status === "exited") {
        this.store.finishMonitor(m.name, pty?.exitCode === 0 ? "exited" : "failed", m.pty_id);
      }
    }
  }

  // ---- disk watchdog ----

  private async checkDisk() {
    let freeGb: number;
    try {
      const s = await this.statfs(this.cfg.DISK_CHECK_PATH);
      freeGb = (Number(s.bavail) * Number(s.bsize)) / 1e9;
    } catch {
      return;
    }
    const low = this.store.get(KEY_DISK_LOW) === "1";
    if (!low && freeGb < this.cfg.DISK_MIN_FREE_GB) {
      this.store.set(KEY_DISK_LOW, "1");
      this.store.enqueueUpdate(
        "system",
        `The server is low on disk space: ${freeGb.toFixed(1)} GB free. New tasks are paused until there's more room. ` +
          `Tell the user, and suggest what could be cleaned up (big files in projects, caches, node_modules).`,
        true,
      );
      log.warn(`disk low: ${freeGb.toFixed(1)} GB free`);
    } else if (low && freeGb > this.cfg.DISK_MIN_FREE_GB * 1.5) {
      this.store.delete(KEY_DISK_LOW);
      this.store.enqueueUpdate("system", `Disk space is fine again (${freeGb.toFixed(1)} GB free); new tasks are allowed again.`);
    }
  }

  // ---- tick ----

  async tick(now = new Date()) {
    if (this.ticking) {
      log.warn("housekeeping tick still running; skipping this interval");
      return;
    }
    this.ticking = true;
    try {
      for (const r of this.store.dueReminders(now.getTime())) {
        this.store.fireReminderAndEnqueue(r.id, "reminder", `Reminder (set for ${stamp(new Date(r.due_at))}): ${r.text}`, true);
      }
      this.maybeCheckin(now);
      this.tasks.checkStuck(now.getTime());
      await this.checkDisk();
      await this.runDueMonitors(now.getTime());
      await this.housekeeping();
    } catch (err) {
      log.error("tick failed", err);
    } finally {
      this.ticking = false;
    }
    this.onUpdate();
  }

  private maybeCheckin(now: Date) {
    if (!this.cfg.MORNING_CHECKIN) return;
    const today = now.toDateString();
    if (this.store.get(KEY_CHECKIN) === today) return;
    // Only within three hours of the set time, so a restart in the afternoon doesn't trigger a "morning" check-in.
    const start = toMinutes(this.cfg.MORNING_CHECKIN);
    const minute = minutesOfDay(now);
    if (minute < start || minute > start + 180) return;
    this.store.set(KEY_CHECKIN, today);
    this.store.enqueueUpdate(
      "checkin",
      "Morning check-in: give the user a short, friendly rundown — open tasks and their progress (use task_list), today's reminders, " +
        "and anything waiting on them. Skip what's not useful; if there's nothing at all, reply NO_REPLY.",
      true,
    );
  }
}
