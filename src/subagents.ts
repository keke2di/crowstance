/**
 * Gateway-owned subagents. The chat calls hq_delegate; the gateway creates a child session of the
 * main session with the kind's agent, model and effort, waits for it to go idle, and hands back
 * its answer. Every delegation is a subagent_runs row, so it is visible, capped and attributed.
 *
 * A delegation that outlives SUBAGENT_SYNC_SEC is *detached*: the tool call returns, and the
 * answer arrives later as an update. One that outlives its timeout or its cost cap is interrupted.
 */
import type { Config } from "./config.ts";
import type { Store, SubagentRunRow, SubagentState } from "./db.ts";
import { UserError } from "./errors.ts";
import type { Kinds } from "./kinds.ts";
import type { Limits } from "./limits.ts";
import { logger } from "./log.ts";
import { errorText, isAbortError, lastReply, type OpenCode } from "./opencode.ts";
import type { Roles } from "./roles.ts";
import { ago, duration, stamp, tail, truncate, usd } from "./text.ts";

const log = logger("subagents");

/** How much of a subagent's answer goes back into the chat's context. */
const MAX_RESULT_CHARS = 12_000;

type Outcome = "succeeded" | "failed" | "interrupted";

export class Subagents {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly oc: OpenCode;
  private readonly kinds: Kinds;
  private readonly roles: Roles;
  private readonly limits: Limits;
  /** The main session and its current turn: the only place delegation is allowed from. */
  private readonly parent: () => { sessionID?: string; turnID?: number };
  private readonly onUpdate: () => void;
  private readonly waiters = new Map<string, (row: SubagentRunRow) => void>();
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly settling = new Map<string, Promise<void>>();
  /** Errors reported by session.execution.failed, read when the session settles. */
  private readonly errors = new Map<string, string>();

  constructor(deps: { cfg: Config; store: Store; oc: OpenCode; kinds: Kinds; roles: Roles; limits: Limits; parent: () => { sessionID?: string; turnID?: number }; onUpdate: () => void }) {
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.oc = deps.oc;
    this.kinds = deps.kinds;
    this.roles = deps.roles;
    this.limits = deps.limits;
    this.parent = deps.parent;
    this.onUpdate = deps.onUpdate;
  }

  get directory() {
    return this.cfg.ASSISTANT_HOME;
  }

  /** After a restart nobody is waiting on running delegations any more: their answers become updates. */
  recover() {
    for (const run of this.store.runningSubagents()) {
      if (!run.detached) this.store.updateSubagentRun(run.id, { detached: 1 });
      this.arm(run);
    }
  }

  /** Run one delegation. Resolves with the text that goes back to the chat. */
  async delegate(p: { kind: string; prompt: string; model?: string }): Promise<string> {
    const kind = this.kinds.get(p.kind);
    if (!kind) throw new UserError(`No subagent kind "${p.kind}". Kinds: ${this.kinds.list().map((k) => k.id).join(", ") || "none"}.`);
    const parent = this.parent();
    if (!parent.sessionID) throw new UserError("Only the main chat can delegate to subagents.");
    const resolved = this.roles.resolve(kind.id, p.model);
    const cap = this.limits.callCap(kind.id);
    this.limits.preflight("subagent", cap);
    if (this.store.runningSubagents().length >= this.limits.get("concurrent")) {
      throw new UserError(`${this.limits.get("concurrent")} subagents are already running (the limit); wait for one to finish or do this yourself.`);
    }
    if (parent.turnID !== undefined) {
      const turn = this.limits.turnUsage(parent.turnID);
      if (turn.count >= this.limits.get("per-turn")) throw new UserError(`That's ${turn.count} delegations in this turn, the limit; answer with what you have.`);
      if (turn.spent >= this.limits.get("turn")) throw new UserError(`Delegations in this turn already cost ${usd(turn.spent)}, the turn's cap; answer with what you have.`);
    }

    const row = this.store.insertSubagentRun({
      parent_session: parent.sessionID,
      turn_id: parent.turnID ?? null,
      kind: kind.id,
      prompt: p.prompt,
      model: resolved.ref ?? null,
      effort: resolved.effort ?? null,
      model_from: resolved.from,
    });
    let sessionID: string;
    try {
      const session = await this.oc.createSession({
        directory: this.directory,
        title: `subagent ${kind.id}: ${truncate(p.prompt.replace(/\s+/g, " "), 60)}`,
        agent: kind.id,
        parentID: parent.sessionID,
        ...(resolved.model ? { model: resolved.model } : {}),
        metadata: { hq: { kind: "subagent", run: row.id, subagent: kind.id } },
      });
      sessionID = session.id;
      this.store.updateSubagentRun(row.id, { session_id: sessionID });
    } catch (err) {
      this.store.finishSubagentRun(row.id, "failed", { error: (err as Error).message });
      throw err;
    }

    const done = new Promise<SubagentRunRow>((resolve) => this.waiters.set(sessionID, resolve));
    const started = this.store.subagentRun(row.id)!;
    this.arm(started);
    try {
      await this.oc.prompt({
        sessionID,
        directory: this.directory,
        parts: [{ type: "text", text: `[Delegated by the main assistant · ${stamp()}]\n${p.prompt.trim()}` }],
      });
    } catch (err) {
      this.waiters.delete(sessionID);
      this.disarm(row.id);
      this.store.finishSubagentRun(row.id, "failed", { error: (err as Error).message });
      throw err;
    }
    log.info("delegated", { run: row.id, kind: kind.id, sessionID, model: resolved.ref, effort: resolved.effort });

    const syncMs = Math.min(this.cfg.SUBAGENT_SYNC_SEC, kind.timeoutSec ?? this.cfg.SUBAGENT_TIMEOUT_SEC) * 1000;
    let syncTimer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([done, new Promise<"detach">((resolve) => (syncTimer = setTimeout(() => resolve("detach"), syncMs)))]);
    if (syncTimer) clearTimeout(syncTimer);
    if (outcome === "detach") {
      this.store.updateSubagentRun(row.id, { detached: 1 });
      // The waiter stays: settle() sees `detached` and turns the answer into an update.
      return `Subagent ${kind.id} is still working (delegation #${row.id}, over ${duration(syncMs)}). Its answer will arrive as an update; carry on without it, or tell the user it's coming.`;
    }
    return this.format(outcome);
  }

  /** Arm the hard timeout for a running delegation. */
  private arm(run: SubagentRunRow) {
    const kind = this.kinds.get(run.kind);
    const timeoutMs = (kind?.timeoutSec ?? this.cfg.SUBAGENT_TIMEOUT_SEC) * 1000;
    const left = Math.max(1000, run.started_at + timeoutMs - Date.now());
    this.disarm(run.id);
    const timer = setTimeout(() => void this.stop(run.id, "timeout", `ran past its ${duration(timeoutMs)} limit`), left);
    timer.unref?.();
    this.timers.set(run.id, timer);
  }

  private disarm(runID: number) {
    const t = this.timers.get(runID);
    if (t) clearTimeout(t);
    this.timers.delete(runID);
  }

  isSubagent(sessionID: string): boolean {
    return this.store.subagentRunBySession(sessionID) !== undefined;
  }

  onError(sessionID: string, error: unknown) {
    const e = error as { type?: string; name?: string; message?: string; data?: { message?: string } } | undefined;
    if (!e) return;
    this.errors.set(sessionID, `${e.type ?? e.name ?? "Error"}${e.message ? `: ${e.message}` : e.data?.message ? `: ${e.data.message}` : ""}`);
  }

  /** The child session went idle (or failed, or was interrupted). */
  onIdle(sessionID: string, outcome: Outcome = "succeeded"): Promise<void> {
    const prior = this.settling.get(sessionID);
    if (prior) return prior;
    const work = this.settle(sessionID, outcome).finally(() => this.settling.delete(sessionID));
    this.settling.set(sessionID, work);
    return work;
  }

  private async settle(sessionID: string, outcome: Outcome) {
    const run = this.store.subagentRunBySession(sessionID);
    if (!run) return;
    this.disarm(run.id);
    const msgs = await this.oc.messages(sessionID, this.directory, 20).catch(() => []);
    const reply = lastReply(msgs);
    const error = this.errors.get(sessionID) ?? (reply.message ? errorText(reply.message) : undefined);
    this.errors.delete(sessionID);
    const text = reply.text || null;
    if (run.state === "running") {
      const state: SubagentState = error && !isAbortError(error) ? "failed" : outcome === "interrupted" || isAbortError(error) ? "stopped" : "done";
      this.store.finishSubagentRun(run.id, state, { result: text, error: state === "failed" ? (error ?? "failed") : null });
    } else if (text) {
      // Stopped by a cap, the timeout or /stop: keep the partial answer it had.
      this.store.updateSubagentRun(run.id, { result: text });
    }
    const final = this.store.subagentRun(run.id)!;
    log.info("delegation finished", { run: run.id, kind: run.kind, state: final.state, cost: this.store.sessionSpend(sessionID) });
    const waiter = this.waiters.get(sessionID);
    this.waiters.delete(sessionID);
    if (final.detached) {
      this.store.enqueueUpdate("subagent", `Delegation #${final.id} to ${final.kind} (started ${ago(final.started_at)}) ${this.format(final)}`);
      this.onUpdate();
    }
    waiter?.(final);
  }

  /** The tool result (or update text) for a finished delegation. */
  format(run: SubagentRunRow): string {
    const cost = run.session_id ? this.store.sessionSpend(run.session_id) : 0;
    const head = `Subagent ${run.kind} (${run.model ?? "default model"}${run.effort ? `, effort ${run.effort}` : ""}, ${usd(cost)})`;
    const answer = run.result ? tail(run.result, MAX_RESULT_CHARS) : "";
    switch (run.state) {
      case "done":
        return `${head} answered:\n\n${answer || "(it finished without a reply)"}`;
      case "failed":
        return `${head} failed: ${run.error ?? "unknown error"}${answer ? `\nWhat it had so far:\n${answer}` : ""}`;
      default: {
        const why = run.state === "capped" ? "was stopped at its cost cap" : run.state === "timeout" ? "ran out of time" : "was stopped";
        return `${head} ${why}${run.error ? ` (${run.error})` : ""}.${answer ? `\nPartial answer:\n${answer}` : " It had no answer yet."}`;
      }
    }
  }

  /** Interrupt one delegation and record why. */
  async stop(runID: number, state: "capped" | "stopped" | "timeout", reason: string) {
    const run = this.store.subagentRun(runID);
    if (!run || run.state !== "running") return;
    this.disarm(runID);
    if (!this.store.finishSubagentRun(runID, state, { error: reason })) return;
    log.warn("delegation stopped", { run: runID, kind: run.kind, state, reason });
    if (!run.session_id) return;
    await this.oc.abort(run.session_id, this.directory).catch((err) => log.warn(`abort of ${run.session_id} failed: ${(err as Error).message}`));
    // The interrupted event normally settles it; don't leave the chat waiting if it never comes.
    const sessionID = run.session_id;
    setTimeout(() => {
      if (this.waiters.has(sessionID)) void this.onIdle(sessionID, "interrupted");
    }, 5000).unref?.();
  }

  async stopTurn(turnID: number, state: "capped" | "stopped", reason: string) {
    for (const run of this.store.subagentsInTurn(turnID)) if (run.state === "running") await this.stop(run.id, state, reason);
  }

  async stopAll(state: "capped" | "stopped", reason: string) {
    for (const run of this.store.runningSubagents()) await this.stop(run.id, state, reason);
  }

  running(): SubagentRunRow[] {
    return this.store.runningSubagents();
  }

  /** Delegations that finished without anyone noticing (events missed while the stream was down). */
  async reconcile() {
    const running = this.store.runningSubagents();
    if (!running.length) return;
    const statuses = await this.oc.statuses(this.directory).catch(() => undefined);
    if (!statuses) return;
    for (const run of running) {
      if (!run.session_id) continue;
      const s = statuses[run.session_id];
      if (!s || s.type === "idle") await this.onIdle(run.session_id);
    }
  }

  /** For /tasks and task_list: running delegations and the last few finished ones. */
  list(sinceHours = 24): string {
    const runs = this.store.recentSubagents(Date.now() - sinceHours * 3_600_000).slice(-10);
    if (!runs.length) return "";
    const line = (r: SubagentRunRow) =>
      `- #${r.id} ${r.kind}: ${truncate(r.prompt.replace(/\s+/g, " "), 60)} — ${r.state === "running" ? `running for ${duration(Date.now() - r.started_at)}` : `${r.state} ${ago(r.finished_at ?? r.started_at)}`}, ${usd(r.session_id ? this.store.sessionSpend(r.session_id) : 0)} on ${r.model ?? "default"}`;
    return ["Subagents:", ...runs.map(line)].join("\n");
  }

  /** The kind a session belongs to, for labels. */
  kindOf(sessionID: string): string | undefined {
    return this.store.subagentRunBySession(sessionID)?.kind;
  }
}
