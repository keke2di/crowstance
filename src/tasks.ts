/**
 * Background workers: each task is its own OpenCode session (agent "worker") in
 * PROJECTS_DIR/<project>. This module starts/steers/stops them, tracks their
 * state from server events, and composes status reports from real data.
 */
import path from "node:path";
import crypto from "node:crypto";
import type { Config } from "./config.ts";
import { parseModelRef } from "./config.ts";
import { KEY_DISK_LOW, type Store, type TaskRow, type TaskState } from "./db.ts";
import { logger } from "./log.ts";
import { errorText, isAssistant, messageText, type OpenCode, type SessionStatus, type Todo } from "./opencode.ts";
import { ago, duration, parseOutcome, slugify, stamp, startOfLocalDay, tail, truncate, usd } from "./text.ts";
import { reserveReasoning } from "./reasoning.ts";
import { validateReasoningEffort } from "./opencode.ts";

const log = logger("tasks");

export const KEY_WORKER_MODEL = "model.worker";

/** Errors whose message should be shown to the assistant/user verbatim. */
export class UserError extends Error {}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const TODO_MARK: Record<string, string> = { completed: "[x]", in_progress: "[>]", cancelled: "[-]", pending: "[ ]" };

export function formatTodos(todos: Todo[]): string {
  return todos.map((t) => `  ${TODO_MARK[t.status] ?? "[ ]"} ${t.content}`).join("\n");
}

export function progress(todos: Todo[]): string | undefined {
  const relevant = todos.filter((t) => t.status !== "cancelled");
  if (relevant.length === 0) return undefined;
  return `${relevant.filter((t) => t.status === "completed").length}/${relevant.length} steps done`;
}

export function describeState(t: TaskRow, live: SessionStatus | undefined): string {
  if (t.state === "running") {
    if (live?.type === "retry") return `running (retrying after a provider error: ${truncate(live.message, 120)})`;
    return live?.type === "busy" ? "running (working right now)" : "running";
  }
  if (t.state === "waiting") return "waiting for input from the user";
  if (t.state === "finished") return `finished (${t.outcome ?? "unknown outcome"})`;
  return t.state;
}

export class Tasks {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly oc: OpenCode;
  private readonly onUpdate: () => void;
  /** Optional direct-to-user alert with keep/stop buttons when a task looks stuck. Falls back to an update note. */
  private readonly onStuck?: (task: TaskRow, idleFor: string) => void;
  private readonly lastTouch = new Map<string, number>();
  private readonly lastError = new Map<string, string>();
  private readonly idleLocks = new Map<string, Promise<void>>();

  constructor(deps: { cfg: Config; store: Store; oc: OpenCode; onUpdate: () => void; onStuck?: (task: TaskRow, idleFor: string) => void }) {
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.oc = deps.oc;
    this.onUpdate = deps.onUpdate;
    this.onStuck = deps.onStuck;
  }

  workerModel(override?: string) {
    const ref = override ?? this.store.get(KEY_WORKER_MODEL) ?? this.cfg.WORKER_MODEL;
    return ref ? parseModelRef(ref) : undefined;
  }

  /** "scraper", "~/projects/scraper" or an absolute path inside PROJECTS_DIR → absolute directory. */
  resolveProjectDir(project: string): string {
    const p = project.trim();
    const expanded = p.startsWith("~/") ? path.join(path.dirname(this.cfg.ASSISTANT_HOME), p.slice(2)) : p;
    if (path.isAbsolute(expanded)) {
      const abs = path.resolve(expanded);
      if (!isInside(abs, this.cfg.PROJECTS_DIR) || abs === this.cfg.PROJECTS_DIR) {
        throw new UserError(`Projects must live inside ${this.cfg.PROJECTS_DIR}; got ${abs}`);
      }
      return abs;
    }
    return path.join(this.cfg.PROJECTS_DIR, slugify(p));
  }

  /** Find a task by id, or loosely by title words. */
  find(ref: string): TaskRow | undefined {
    const exact = this.store.taskBySlug(ref.trim()) ?? this.store.taskBySlug(slugify(ref));
    if (exact) return exact;
    const needle = slugify(ref);
    const candidates = this.store.recentTasks(0).filter((t) => t.slug.includes(needle) || slugify(t.title).includes(needle));
    return candidates.at(-1);
  }

  private require(ref: string): TaskRow {
    const t = this.find(ref);
    if (!t) throw new UserError(`No task matches "${ref}". Use task_list to see task ids.`);
    return t;
  }

  async start(p: { title: string; brief: string; project?: string; model?: string; job?: string; reasoningVariant?: string }): Promise<TaskRow> {
    if (this.store.get(KEY_DISK_LOW) === "1") {
      throw new UserError("The server is low on disk space, so new tasks are paused. Free some space first (the user has been told).");
    }
    const spent = this.store.spendSince(startOfLocalDay());
    if (spent >= this.cfg.DAILY_BUDGET_USD) {
      throw new UserError(`Daily budget reached (${usd(spent)} of ${usd(this.cfg.DAILY_BUDGET_USD)}). Ask the user before starting more work; they can raise DAILY_BUDGET_USD.`);
    }
    const directory = this.resolveProjectDir(p.project ?? p.title);
    const token = crypto.randomUUID();
    const base = slugify(p.title, 32);
    let slug: string | undefined;
    for (let i = 1; i < 1000 && !slug; i++) {
      const candidate = i === 1 ? base : `${base}-${i}`;
      if (this.store.reserveTask(token, candidate, directory, this.cfg.MAX_WORKERS)) slug = candidate;
    }
    if (!slug) throw new UserError(`Already running ${this.cfg.MAX_WORKERS} tasks; the limit is ${this.cfg.MAX_WORKERS}. Wait for one to finish or stop one.`);
    try {
      await this.oc.ensureGitRepo(directory, this.cfg.PROJECTS_DIR);
      const session = await this.oc.createSession({ directory, title: `task: ${p.title}`, agent: this.cfg.WORKER_AGENT, metadata: { hq: { kind: "worker", slug } } });
      const modelRef = p.model ?? this.store.get(KEY_WORKER_MODEL) ?? this.cfg.WORKER_MODEL ?? null;
      const reasoningVariant = validateReasoningEffort(p.reasoningVariant ?? this.cfg.REASONING_VARIANT);
      reserveReasoning(this.store, this.cfg, `task-${slug}-${Date.now()}`, session.id, p.job ? "scheduled-worker" : "worker", p.brief);
      const row = this.store.insertTask({
      slug,
      title: p.title,
      brief: p.brief,
      directory,
      session_id: session.id,
      state: "running",
       model: modelRef,
       reasoning_variant: reasoningVariant,
      job: p.job ?? null,
      created_at: Date.now(),
    });
      this.store.releaseTaskReservation(token);

      const text = [
      `# Task: ${p.title}`,
      `Task id: ${slug} · started ${stamp()} · working directory: ${directory}`,
      "",
      p.brief.trim(),
    ].join("\n");
      try {
      await this.oc.prompt({
        sessionID: session.id,
        directory,
        agent: this.cfg.WORKER_AGENT,
        model: modelRef ? parseModelRef(modelRef) : undefined,
        parts: [{ type: "text", text }],
        variant: reasoningVariant,
      });
      } catch (err) {
        if (this.store.taskBySlug(slug)) this.store.updateTask(slug, { state: "failed", last_report: `Could not start: ${(err as Error).message}`, finished_at: Date.now() });
        throw err;
      }
      log.info("task started", { slug, directory, sessionID: session.id, model: modelRef, variant: reasoningVariant });
      return row;
    } catch (err) {
      this.store.releaseTaskReservation(token);
      throw err;
    }
  }

  async message(ref: string, text: string) {
    const t = this.require(ref);
    let resumeToken: string | undefined;
    if (t.state !== "running") {
      if (this.store.get(KEY_DISK_LOW) === "1") throw new UserError("The server is low on disk space, so this task cannot be resumed yet.");
      if (this.store.spendSince(startOfLocalDay()) >= this.cfg.DAILY_BUDGET_USD) throw new UserError("Daily budget reached; this task cannot be resumed.");
      resumeToken = crypto.randomUUID();
      if (!this.store.reserveTask(resumeToken, `${t.slug}-resume-${Date.now()}`, t.directory, this.cfg.MAX_WORKERS, t.slug)) throw new UserError(`The worker limit is ${this.cfg.MAX_WORKERS}; wait for capacity before resuming.`);
    }
    reserveReasoning(this.store, this.cfg, `resume-${t.slug}-${Date.now()}`, t.session_id, "resumed-worker", text);
    try { await this.oc.prompt({
      sessionID: t.session_id,
      directory: t.directory,
      agent: this.cfg.WORKER_AGENT,
      model: t.model ? parseModelRef(t.model) : undefined,
      parts: [{ type: "text", text: `[Message from the user, relayed by the assistant · ${stamp()}]\n${text}` }],
      variant: t.reasoning_variant,
    }); } catch (err) { if (resumeToken) this.store.releaseTaskReservation(resumeToken); throw err; }
    if (resumeToken) this.store.releaseTaskReservation(resumeToken);
    this.store.updateTask(t.slug, { state: "running", outcome: null, finished_at: null, stuck_notified: 0 });
    return t;
  }

  async stop(ref: string) {
    const t = this.require(ref);
    if (!this.store.transitionTask(t.slug, ["running", "waiting"], { abort_state: "requested" })) return this.store.taskBySlug(t.slug)!;
    log.info("task stop requested", { slug: t.slug, sessionID: t.session_id });
    try {
      await this.oc.abort(t.session_id, t.directory);
      this.store.transitionTask(t.slug, ["running", "waiting"], { state: "stopped", abort_state: "confirmed", finished_at: Date.now() });
    } catch (err) {
      this.store.transitionTask(t.slug, ["running", "waiting"], { abort_state: "failed", last_report: `Abort failed: ${(err as Error).message}` });
      log.warn("task abort failed", { slug: t.slug, error: (err as Error).message });
    }
    return t;
  }

  /** One line per task plus a short detail block for anything running: what /tasks shows. */
  async list(includeFinishedHours = 24): Promise<string> {
    const tasks = this.store.recentTasks(Date.now() - includeFinishedHours * 3_600_000);
    if (tasks.length === 0) return "No tasks right now.";
    const lines = await Promise.all(
      tasks.map(async (t) => {
        const [live, todos, session] = await Promise.all([
          this.liveStatus(t),
          this.oc.todo(t.session_id, t.directory).catch(() => [] as Todo[]),
          this.oc.getSession(t.session_id, t.directory).catch(() => undefined),
        ]);
        const pending = this.store.openApprovals().filter((a) => a.session_id === t.session_id).length;
        const bits = [
          describeState(t, live),
          t.state === "running" || t.state === "waiting" ? `for ${duration(Date.now() - t.created_at)}` : `${ago(t.updated_at)}`,
          progress(todos),
          session ? usd(session.cost ?? 0) : undefined,
          t.state === "running" ? `last activity ${ago(t.last_activity_at)}` : undefined,
          pending > 0 ? `⚠️ waiting on your approval` : undefined,
        ].filter(Boolean);
        let line = `- ${t.slug}: ${t.title} — ${bits.join(", ")}`;
        if (t.state === "running") {
          const doing = todos.find((x) => x.status === "in_progress")?.content;
          if (doing) line += `\n  working on: ${truncate(doing, 120)}`;
        }
        return line;
      }),
    );
    return lines.join("\n");
  }

  /** Detailed status for "where are we with X?". */
  async describe(ref: string): Promise<string> {
    const t = this.require(ref);
    const [live, todos, session, msgs, pending] = await Promise.all([
      this.liveStatus(t),
      this.oc.todo(t.session_id, t.directory).catch(() => [] as Todo[]),
      this.oc.getSession(t.session_id, t.directory).catch(() => undefined),
      this.oc.messages(t.session_id, t.directory, 12).catch(() => []),
      Promise.resolve(this.store.openApprovals().filter((a) => a.session_id === t.session_id)),
    ]);

    const lines = [
      `Task "${t.title}" (id ${t.slug})`,
      `State: ${describeState(t, live)}`,
      `Started ${ago(t.created_at)}; last activity ${ago(t.last_activity_at)}; directory ${t.directory}`,
    ];
    const prog = progress(todos);
    if (prog) lines.push(`Progress: ${prog}`, formatTodos(todos));
    else lines.push("Progress: the worker hasn't written a todo list yet");
    if (session?.summary && session.summary.files > 0) {
      lines.push(`Files changed: ${session.summary.files} (+${session.summary.additions} −${session.summary.deletions})`);
    }
    if (session) lines.push(`Cost so far: ${usd(session.cost ?? 0)}`);
    for (const a of pending) {
      const payload = JSON.parse(a.payload) as { permission?: string; patterns?: string[]; questions?: { question: string }[] };
      lines.push(
        a.kind === "permission"
          ? `Waiting for the user's approval: ${payload.permission} ${(payload.patterns ?? []).join(" ")}`
          : `Waiting for the user to answer: ${(payload.questions ?? []).map((q) => q.question).join(" / ")}`,
      );
    }
    if (t.state === "finished" || t.state === "waiting" || t.state === "failed") {
      if (t.last_report) lines.push(`Final report:\n${tail(t.last_report, 1500)}`);
    } else {
      const recent = msgs
        .filter((m) => isAssistant(m.info))
        .map((m) => messageText(m.parts))
        .filter(Boolean)
        .slice(-2);
      if (recent.length) lines.push(`Latest from the worker:\n${tail(recent.join("\n\n"), 900)}`);
    }
    return lines.join("\n");
  }

  private async liveStatus(t: TaskRow): Promise<SessionStatus | undefined> {
    if (t.state !== "running") return undefined;
    try {
      return (await this.oc.statuses(t.directory))[t.session_id];
    } catch {
      return undefined;
    }
  }

  // ---- server events ----

  isWorker(sessionID: string) {
    return this.store.taskBySession(sessionID) !== undefined;
  }

  onActivity(sessionID: string) {
    const now = Date.now();
    if (now - (this.lastTouch.get(sessionID) ?? 0) < 30_000) return;
    this.lastTouch.set(sessionID, now);
    this.store.touchTask(sessionID, now);
  }

  onBusy(sessionID: string) {
    const t = this.store.taskBySession(sessionID);
    if (t && (t.state === "finished" || t.state === "waiting")) this.store.updateTask(t.slug, { state: "running", outcome: null, finished_at: null });
    this.onActivity(sessionID);
  }

  onError(sessionID: string, error: unknown) {
    const e = error as { name?: string; data?: { message?: string } } | undefined;
    if (!e || e.name === "MessageAbortedError") return;
    this.lastError.set(sessionID, `${e.name ?? "Error"}${e.data?.message ? `: ${e.data.message}` : ""}`);
  }

  async onIdle(sessionID: string) {
    const prior = this.idleLocks.get(sessionID);
    if (prior) return prior;
    const work = this.finishIdle(sessionID).finally(() => this.idleLocks.delete(sessionID));
    this.idleLocks.set(sessionID, work);
    return work;
  }

  private async finishIdle(sessionID: string) {
    const t = this.store.taskBySession(sessionID);
    if (!t || t.state === "stopped" || t.state === "failed") return;
    if (t.state === "finished" || t.state === "waiting") return; // already reported

    const msgs = await this.oc.messages(sessionID, t.directory, 10);
    const last = msgs.filter((m) => isAssistant(m.info)).at(-1);
    const report = last ? messageText(last.parts) : "";
    const error = this.lastError.get(sessionID) ?? (last ? errorText(last.info) : undefined);
    this.lastError.delete(sessionID);

    let reported: { state: TaskState; outcome?: string };
    if (error && !error.startsWith("MessageAbortedError")) {
      reported = { state: "failed" };
      this.store.transitionTaskAndEnqueue(t.slug, "running", { state: "failed", last_report: `${error}\n\n${report}`.trim(), finished_at: Date.now() }, "task", `Task ${t.slug} ("${t.title}") failed: ${truncate(error, 300)}${report ? `\nLast words: ${tail(report, 600)}` : ""}`);
    } else {
      const outcome = parseOutcome(report);
      const state: TaskState = outcome === "needs-input" ? "waiting" : "finished";
      reported = { state, outcome };
      const finishedAt = Date.now();
      const label = outcome === "unknown" ? "stopped working (no status line)" : outcome;
      this.store.transitionTaskAndEnqueue(t.slug, "running", { state, outcome, last_report: report || null, finished_at: finishedAt }, "task", `Task ${t.slug} ("${t.title}") ${label}.${t.job ? ` (scheduled job "${t.job}")` : ""}\nReport:\n${tail(report || "(no report)", 1500)}`);
    }
    log.info("task went idle", { slug: t.slug, ...reported });
    this.onUpdate();
  }

  /** Flag running tasks with no activity for a while (once per quiet spell). */
  checkStuck(now = Date.now()) {
    for (const t of this.store.activeTasks()) {
      if (t.state !== "running" || t.stuck_notified) continue;
      if (now - t.last_activity_at < this.cfg.STUCK_AFTER_MIN * 60_000) continue;
      this.store.updateTask(t.slug, { stuck_notified: 1 });
      log.warn("task looks stuck", { slug: t.slug, idleMs: now - t.last_activity_at });
      if (this.onStuck) {
        this.onStuck(t, duration(now - t.last_activity_at));
      } else {
        this.store.enqueueUpdate("task", `Task ${t.slug} ("${t.title}") has shown no activity for ${duration(now - t.last_activity_at)}. It may be stuck.`);
      }
      this.onUpdate();
    }
  }

  /** After reconnecting: catch idles we missed while the event stream was down. */
  async reconcile() {
    const byDir = new Map<string, TaskRow[]>();
    for (const t of this.store.activeTasks()) byDir.set(t.directory, [...(byDir.get(t.directory) ?? []), t]);
    for (const [dir, tasks] of byDir) {
      const statuses = await this.oc.statuses(dir).catch(() => undefined);
      if (!statuses) continue;
      for (const t of tasks) {
        if (t.state === "running" && (!statuses[t.session_id] || statuses[t.session_id]!.type === "idle")) await this.onIdle(t.session_id);
      }
    }
  }

  directories(): string[] {
    return [...new Set(this.store.activeTasks().map((t) => t.directory))];
  }
}
