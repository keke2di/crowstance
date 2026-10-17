import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { correlationId as currentCorrelationId, newCorrelationId } from "./log.ts";
import { migrate } from "./migrations.ts";

export type TaskState = "running" | "waiting" | "finished" | "failed" | "stopped";
export type TaskOutcome = "done" | "blocked" | "needs-input" | "unknown";

export type TaskRow = {
  id: number;
  slug: string;
  title: string;
  brief: string;
  directory: string;
  session_id: string;
  state: TaskState;
  outcome: TaskOutcome | null;
  model: string | null;
  job: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  last_activity_at: number;
  last_report: string | null;
  stuck_notified: number;
  abort_state: "none" | "requested" | "confirmed" | "failed";
  reasoning_variant: string;
};

export type UpdateKind = "task" | "reminder" | "job" | "notify" | "checkin" | "system";
export type UpdateRow = {
  id: number;
  created_at: number;
  kind: UpdateKind;
  text: string;
  urgent: number;
  delivered_at: number | null;
};

export type InboundRow = { id: number; external_id: string | null; text: string; received_at: number; reply_to: string | null; state: string; consumed_at: number | null; correlation_id: string | null };
export type TurnRow = { id: number; generation: number; kind: string; urgency: number; session_id: string | null; reasoning_variant: string; correlation_id: string | null; created_at: number; started_at: number | null; completed_at: number | null; state: string };
export type OutboundEventRow = { id: string; session_id: string | null; source_message_id: string | null; turn_id: number | null; kind: "text" | "location" | string; payload: string; urgent: number; state: string; correlation_id: string | null; created_at: number; completed_at: number | null; failure: string | null };
export type OutboundChunkRow = { event_id: string; seq: number; payload: string; state: string; telegram_message_id: number | null; attempts: number; next_attempt_at: number; failure: string | null };

export type ApprovalKind = "permission" | "question";
export type ApprovalRow = {
  request_id: string;
  kind: ApprovalKind;
  session_id: string;
  directory: string;
  payload: string;
  chat_message_ids: string;
  state: string;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
  nudged: number;
  presentation: string;
  correlation_id: string | null;
};

export type ReminderRow = {
  id: number;
  due_at: number;
  text: string;
  created_at: number;
  fired_at: number | null;
  cancelled: number;
};

export type MonitorRow = {
  name: string;
  script: string;
  every_min: number;
  enabled: number;
  created_at: number;
  last_run_at: number | null;
  pty_id: string | null;
  deadline_at: number | null;
  run_state: "idle" | "running" | "exited" | "failed";
};

/** Set while free disk space is below DISK_MIN_FREE_GB; new tasks are refused meanwhile. */
export const KEY_DISK_LOW = "disk.low";

export type JobRow = {
  id: number;
  name: string;
  cron: string;
  instructions: string;
  model: string | null;
  enabled: number;
  created_at: number;
  last_run_at: number | null;
};

export type StoreMetrics = {
  updates: { pending: number; oldestAgeMs: number | null };
  outbound: { pending: number; retryable: number; unknown: number; sending: number; failed: number; sent: number; retries: number; oldestAgeMs: number | null };
  approvals: { open: number; oldestAgeMs: number | null };
  tasks: { running: number; waiting: number };
  reminders: { upcoming: number; overdue: number };
  spend: { today: number; month: number; reasoningToday: number };
};

/** Cutoffs (epoch ms) for bounded history. `undefined` leaves a category untouched. */
export type RetentionPolicy = {
  updatesBefore?: number;
  inboundBefore?: number;
  outboundBefore?: number;
  approvalsBefore?: number;
  turnsBefore?: number;
  attemptsBefore?: number;
};

export type RetentionResult = { updates: number; inbound: number; outbound: number; approvals: number; turns: number; attempts: number };

export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    migrate(this.db);
  }

  close() {
    this.db.close();
  }

  // ---- kv ----
  get(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  set(key: string, value: string) {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  delete(key: string) {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  // ---- tasks ----
  insertTask(t: Omit<TaskRow, "id" | "updated_at" | "finished_at" | "last_report" | "stuck_notified" | "outcome" | "last_activity_at" | "abort_state" | "reasoning_variant"> & { reasoning_variant?: string }) {
    const now = t.created_at;
    this.db
      .prepare(
         `INSERT INTO tasks (slug, title, brief, directory, session_id, state, model, job, reasoning_variant, created_at, updated_at, last_activity_at)
          VALUES (@slug, @title, @brief, @directory, @session_id, @state, @model, @job, COALESCE(@reasoning_variant, 'max'), @created_at, @now, @now)`,
      )
      .run({ reasoning_variant: t.reasoning_variant ?? null, ...t, now });
    return this.taskBySlug(t.slug)!;
  }

  reserveTask(token: string, slug: string, directory: string, maxWorkers: number, excludeSlug?: string) {
    try {
      const active = (this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE state IN ('running','waiting') AND (? IS NULL OR slug != ?)").get(excludeSlug ?? null, excludeSlug ?? null) as { n: number }).n;
      const reserved = (this.db.prepare("SELECT COUNT(*) AS n FROM task_reservations").get() as { n: number }).n;
      if (active + reserved >= maxWorkers) return false;
      if (this.slugExists(slug)) return false;
      if (this.db.prepare("SELECT 1 FROM tasks WHERE directory=? AND state IN ('running','waiting') AND (? IS NULL OR slug != ?)").get(directory, excludeSlug ?? null, excludeSlug ?? null)) return false;
      if (this.db.prepare("SELECT 1 FROM task_reservations WHERE directory=?").get(directory)) return false;
      this.db.prepare("INSERT INTO task_reservations(token,slug,directory,created_at) VALUES(?,?,?,?)").run(token, slug, directory, Date.now());
      return true;
    } catch (err) {
      if (String(err).includes("UNIQUE")) return false;
      throw err;
    }
  }
  releaseTaskReservation(token: string) { this.db.prepare("DELETE FROM task_reservations WHERE token=?").run(token); }
  taskReservation(token: string) { return this.db.prepare("SELECT * FROM task_reservations WHERE token=?").get(token) as { token: string; slug: string; directory: string } | undefined; }
  activeJob(name: string) { return this.db.prepare("SELECT * FROM tasks WHERE job=? AND state IN ('running','waiting') LIMIT 1").get(name) as TaskRow | undefined; }
  activeDirectory(directory: string) { return this.db.prepare("SELECT 1 FROM tasks WHERE directory=? AND state IN ('running','waiting') UNION SELECT 1 FROM task_reservations WHERE directory=? LIMIT 1").get(directory, directory) !== undefined; }
  transitionTask(slug: string, from: TaskState | TaskState[], patch: Partial<Omit<TaskRow, "id" | "slug">>) {
    const states = Array.isArray(from) ? from : [from];
    const fields = Object.keys(patch);
    const params: Record<string, unknown> = { ...patch, __slug: slug, __now: Date.now() };
    const assignments = [...fields.map((f) => `${f}=@${f}`), "updated_at=@__now"].join(", ");
    return this.db.prepare(`UPDATE tasks SET ${assignments} WHERE slug=@__slug AND state IN (${states.map((_, i) => `@__state${i}`).join(",")})`).run(Object.assign(params, Object.fromEntries(states.map((s, i) => [`__state${i}`, s])))).changes > 0;
  }
  transitionTaskAndEnqueue(slug: string, from: TaskState | TaskState[], patch: Partial<Omit<TaskRow, "id" | "slug">>, kind: UpdateKind, text: string, urgent = false) {
    return this.db.transaction(() => {
      const changed = this.transitionTask(slug, from, patch);
      if (changed) this.db.prepare("INSERT INTO updates (created_at, kind, text, urgent) VALUES (?, ?, ?, ?)").run(Date.now(), kind, text, urgent ? 1 : 0);
      return changed;
    })();
  }

  taskBySlug(slug: string) {
    return this.db.prepare("SELECT * FROM tasks WHERE slug = ?").get(slug) as TaskRow | undefined;
  }

  taskBySession(sessionID: string) {
    return this.db.prepare("SELECT * FROM tasks WHERE session_id = ?").get(sessionID) as TaskRow | undefined;
  }

  slugExists(slug: string) {
    return this.db.prepare("SELECT 1 FROM tasks WHERE slug = ?").get(slug) !== undefined;
  }

  /** Active = running or waiting on the user. */
  activeTasks() {
    return this.db.prepare("SELECT * FROM tasks WHERE state IN ('running','waiting') ORDER BY created_at").all() as TaskRow[];
  }

  recentTasks(sinceMs: number) {
    return this.db
      .prepare("SELECT * FROM tasks WHERE state IN ('running','waiting') OR updated_at >= ? ORDER BY created_at")
      .all(sinceMs) as TaskRow[];
  }

  updateTask(slug: string, patch: Partial<Omit<TaskRow, "id" | "slug">>) {
    const fields = Object.keys(patch);
    if (fields.length === 0) return;
    const assignments = [...fields.map((f) => `${f} = @${f}`), "updated_at = @__now"].join(", ");
    this.db.prepare(`UPDATE tasks SET ${assignments} WHERE slug = @__slug`).run({ ...patch, __now: Date.now(), __slug: slug });
  }

  updateTaskAndEnqueue(slug: string, patch: Partial<Omit<TaskRow, "id" | "slug">>, kind: UpdateKind, text: string, urgent = false) {
    this.db.transaction(() => {
      const fields = Object.keys(patch);
      if (fields.length) this.db.prepare(`UPDATE tasks SET ${[...fields.map((f) => `${f} = @${f}`), "updated_at = @__now"].join(", ")} WHERE slug = @__slug`).run({ ...patch, __now: Date.now(), __slug: slug });
      this.db.prepare("INSERT INTO updates (created_at, kind, text, urgent) VALUES (?, ?, ?, ?)").run(Date.now(), kind, text, urgent ? 1 : 0);
    })();
  }

  touchTask(sessionID: string, at: number) {
    this.db.prepare("UPDATE tasks SET last_activity_at = ?, stuck_notified = 0 WHERE session_id = ?").run(at, sessionID);
  }

  // ---- updates queue (notes for the main session) ----
  enqueueUpdate(kind: UpdateKind, text: string, urgent = false) {
    const info = this.db.prepare("INSERT INTO updates (created_at, kind, text, urgent) VALUES (?, ?, ?, ?)").run(Date.now(), kind, text, urgent ? 1 : 0);
    return Number(info.lastInsertRowid);
  }

  pendingUpdates() {
    return this.db.prepare("SELECT * FROM updates WHERE delivered_at IS NULL ORDER BY id").all() as UpdateRow[];
  }

  markUpdatesDelivered(ids: number[]) {
    const stmt = this.db.prepare("UPDATE updates SET delivered_at = ? WHERE id = ?");
    const now = Date.now();
    this.db.transaction(() => ids.forEach((id) => stmt.run(now, id)))();
  }

  insertInbound(input: { text: string; receivedAt: number; replyTo?: string; externalId?: string; correlationId?: string }) {
    const correlation = input.correlationId ?? newCorrelationId("in");
    const info = this.db.prepare("INSERT INTO inbound_messages(external_id,text,received_at,reply_to,correlation_id) VALUES(?,?,?,?,?)").run(input.externalId ?? null, input.text, input.receivedAt, input.replyTo ?? null, correlation);
    return this.inbound(Number(info.lastInsertRowid))!;
  }

  inbound(id: number) { return this.db.prepare("SELECT * FROM inbound_messages WHERE id = ?").get(id) as InboundRow | undefined; }
  bufferedInbound() { return this.db.prepare("SELECT * FROM inbound_messages WHERE state = 'buffered' ORDER BY id").all() as InboundRow[]; }
  markInboundConsumed(ids: number[]) { const stmt = this.db.prepare("UPDATE inbound_messages SET state='consumed', consumed_at=? WHERE id=?"); const now = Date.now(); this.db.transaction(() => ids.forEach((id) => stmt.run(now, id)))(); }

  createTurn(kind: string, urgency: boolean, sessionID?: string, reasoningVariant = "max", correlationID?: string) {
    const generation = Number((this.db.prepare("SELECT COALESCE(MAX(generation), 0) + 1 AS n FROM turns").get() as { n: number }).n);
    const correlation = correlationID ?? currentCorrelationId() ?? newCorrelationId("turn");
    const info = this.db.prepare("INSERT INTO turns(generation,kind,urgency,session_id,reasoning_variant,correlation_id,created_at) VALUES(?,?,?,?,?,?,?)").run(generation, kind, urgency ? 1 : 0, sessionID ?? null, reasoningVariant, correlation, Date.now());
    return this.turn(Number(info.lastInsertRowid))!;
  }
  turn(id: number) { return this.db.prepare("SELECT * FROM turns WHERE id=?").get(id) as TurnRow | undefined; }
  updateTurn(id: number, state: string, sessionID?: string) { this.db.prepare("UPDATE turns SET state=?, session_id=COALESCE(?,session_id), started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END, completed_at=CASE WHEN ? IN ('done','failed') THEN ? ELSE completed_at END WHERE id=?").run(state, sessionID ?? null, state, Date.now(), state, Date.now(), id); }

  enqueueOutbound(event: { id: string; sessionID?: string; sourceMessageID?: string; turnID?: number; kind: string; payload: unknown; urgent?: boolean; chunks: string[]; correlationID?: string }) {
    const now = Date.now();
    const correlation = event.correlationID ?? (event.turnID !== undefined ? this.turn(event.turnID)?.correlation_id : undefined) ?? currentCorrelationId() ?? newCorrelationId("out");
    this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO outbound_events(id,session_id,source_message_id,turn_id,kind,payload,urgent,correlation_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(event.id, event.sessionID ?? null, event.sourceMessageID ?? null, event.turnID ?? null, event.kind, JSON.stringify(event.payload), event.urgent ? 1 : 0, correlation, now);
      const stmt = this.db.prepare("INSERT OR IGNORE INTO outbound_chunks(event_id,seq,payload,next_attempt_at) VALUES(?,?,?,?)");
      event.chunks.forEach((chunk, seq) => stmt.run(event.id, seq, chunk, now));
    })();
    return this.outboundEvent(event.id)!;
  }
  enqueueLocation(event: { id: string; sessionID?: string; sourceMessageID?: string; turnID?: number; payload: unknown; urgent?: boolean; correlationID?: string }) {
    return this.enqueueOutbound({ ...event, kind: "location", chunks: [JSON.stringify(event.payload)] });
  }
  outboundEvent(id: string) { return this.db.prepare("SELECT * FROM outbound_events WHERE id=?").get(id) as OutboundEventRow | undefined; }
  outboundChunk(eventID: string, seq: number) { return this.db.prepare("SELECT * FROM outbound_chunks WHERE event_id=? AND seq=?").get(eventID, seq) as OutboundChunkRow | undefined; }
  readyChunks(now = Date.now(), limit = 20) { return this.db.prepare("SELECT c.*, e.urgent FROM outbound_chunks c JOIN outbound_events e ON e.id=c.event_id WHERE c.state IN ('pending','retryable','unknown') AND c.next_attempt_at <= ? ORDER BY e.urgent DESC,c.next_attempt_at,c.event_id,c.seq LIMIT ?").all(now, limit) as (OutboundChunkRow & { urgent: number })[]; }
  recoverLeases(now = Date.now()) { this.db.prepare("UPDATE outbound_chunks SET state='retryable', next_attempt_at=? WHERE state='sending' AND EXISTS (SELECT 1 FROM delivery_leases l WHERE l.event_id=outbound_chunks.event_id AND l.seq=outbound_chunks.seq AND l.leased_until < ?)").run(now, now); this.db.prepare("DELETE FROM delivery_leases WHERE leased_until < ?").run(now); }
  claimChunk(eventID: string, seq: number, owner: string, leaseMs: number, now = Date.now()) {
    return this.db.transaction(() => { this.db.prepare("DELETE FROM delivery_leases WHERE leased_until < ?").run(now); const changed = this.db.prepare("UPDATE outbound_chunks SET state='sending', attempts=attempts+1 WHERE event_id=? AND seq=? AND state IN ('pending','retryable','unknown') AND next_attempt_at<=? AND NOT EXISTS(SELECT 1 FROM delivery_leases WHERE event_id=? AND seq=?)").run(eventID, seq, now, eventID, seq).changes; if (!changed) return false; this.db.prepare("INSERT INTO delivery_leases(event_id,seq,owner,leased_until) VALUES(?,?,?,?)").run(eventID, seq, owner, now + leaseMs); const row = this.outboundChunk(eventID, seq)!; this.db.prepare("INSERT INTO delivery_attempts(event_id,seq,attempt,started_at,outcome) VALUES(?,?,?,?,?)").run(eventID, seq, row.attempts, now, "started"); return true; })();
  }
  finishChunk(eventID: string, seq: number, state: string, result: { messageID?: number; failure?: string; nextAttemptAt?: number; outcome?: string }) {
    const now = Date.now();
    this.db.transaction(() => { this.db.prepare("UPDATE outbound_chunks SET state=?, telegram_message_id=COALESCE(?,telegram_message_id), failure=?, next_attempt_at=COALESCE(?,next_attempt_at) WHERE event_id=? AND seq=?").run(state, result.messageID ?? null, result.failure ?? null, result.nextAttemptAt ?? now, eventID, seq); this.db.prepare("DELETE FROM delivery_leases WHERE event_id=? AND seq=?").run(eventID, seq); this.db.prepare("UPDATE delivery_attempts SET finished_at=?, outcome=?, error=? WHERE event_id=? AND seq=? AND finished_at IS NULL").run(now, result.outcome ?? state, result.failure ?? null, eventID, seq); const remaining = this.db.prepare("SELECT COUNT(*) AS n FROM outbound_chunks WHERE event_id=? AND state NOT IN ('sent')").get(eventID) as { n: number }; if (remaining.n === 0) this.db.prepare("UPDATE outbound_events SET state='sent', completed_at=? WHERE id=?").run(now, eventID); else if (state === 'failed') this.db.prepare("UPDATE outbound_events SET state='failed', failure=? WHERE id=?").run(result.failure ?? 'delivery failed', eventID); })();
  }

  // ---- approvals ----
  insertApproval(a: Pick<ApprovalRow, "request_id" | "kind" | "session_id" | "directory" | "payload"> & { correlationId?: string }) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO approvals (request_id, kind, session_id, directory, payload, correlation_id, created_at)
         VALUES (@request_id, @kind, @session_id, @directory, @payload, @correlation_id, @now)`,
      )
      .run({ ...a, correlation_id: a.correlationId ?? currentCorrelationId() ?? newCorrelationId("approval"), now: Date.now() });
    return this.approval(a.request_id)!;
  }

  approval(requestID: string) {
    return this.db.prepare("SELECT * FROM approvals WHERE request_id = ?").get(requestID) as ApprovalRow | undefined;
  }

  openApprovals() {
    return this.db.prepare("SELECT * FROM approvals WHERE resolved_at IS NULL ORDER BY created_at").all() as ApprovalRow[];
  }

  updateApproval(requestID: string, patch: Partial<Pick<ApprovalRow, "chat_message_ids" | "state" | "resolved_at" | "resolution" | "nudged" | "presentation">>) {
    const fields = Object.keys(patch);
    if (fields.length === 0) return;
    this.db
      .prepare(`UPDATE approvals SET ${fields.map((f) => `${f} = @${f}`).join(", ")} WHERE request_id = @__id`)
      .run({ ...patch, __id: requestID });
  }

  approvalSnapshot(directory: string, kind: "permission" | "question", completedAt = Date.now()) {
    this.db.prepare(`INSERT INTO approval_snapshots(directory,kind,completed_at) VALUES(?,?,?) ON CONFLICT(directory,kind) DO UPDATE SET completed_at=excluded.completed_at`).run(directory, kind, completedAt);
  }

  approvalSnapshotCompleted(directory: string, kind: "permission" | "question") {
    return !!this.db.prepare("SELECT 1 FROM approval_snapshots WHERE directory=? AND kind=?").get(directory, kind);
  }

  // ---- reminders ----
  addReminder(dueAt: number, text: string) {
    const info = this.db.prepare("INSERT INTO reminders (due_at, text, created_at) VALUES (?, ?, ?)").run(dueAt, text, Date.now());
    return Number(info.lastInsertRowid);
  }

  dueReminders(now: number) {
    return this.db
      .prepare("SELECT * FROM reminders WHERE fired_at IS NULL AND cancelled = 0 AND due_at <= ? ORDER BY due_at")
      .all(now) as ReminderRow[];
  }

  upcomingReminders() {
    return this.db.prepare("SELECT * FROM reminders WHERE fired_at IS NULL AND cancelled = 0 ORDER BY due_at").all() as ReminderRow[];
  }

  markReminderFired(id: number) {
    this.db.prepare("UPDATE reminders SET fired_at = ? WHERE id = ?").run(Date.now(), id);
  }

  fireReminderAndEnqueue(id: number, kind: UpdateKind, text: string, urgent = false) {
    this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE reminders SET fired_at = ? WHERE id = ? AND fired_at IS NULL AND cancelled = 0").run(Date.now(), id).changes;
      if (changed) this.db.prepare("INSERT INTO updates (created_at, kind, text, urgent) VALUES (?, ?, ?, ?)").run(Date.now(), kind, text, urgent ? 1 : 0);
    })();
  }

  cancelReminder(id: number) {
    return this.db.prepare("UPDATE reminders SET cancelled = 1 WHERE id = ? AND fired_at IS NULL AND cancelled = 0").run(id).changes > 0;
  }

  // ---- jobs ----
  upsertJob(j: Pick<JobRow, "name" | "cron" | "instructions" | "model">) {
    this.db
      .prepare(
        `INSERT INTO jobs (name, cron, instructions, model, created_at) VALUES (@name, @cron, @instructions, @model, @now)
         ON CONFLICT(name) DO UPDATE SET cron = excluded.cron, instructions = excluded.instructions, model = excluded.model, enabled = 1`,
      )
      .run({ ...j, now: Date.now() });
    return this.job(j.name)!;
  }

  job(name: string) {
    return this.db.prepare("SELECT * FROM jobs WHERE name = ?").get(name) as JobRow | undefined;
  }

  enabledJobs() {
    return this.db.prepare("SELECT * FROM jobs WHERE enabled = 1 ORDER BY name").all() as JobRow[];
  }

  disableJob(name: string) {
    return this.db.prepare("UPDATE jobs SET enabled = 0 WHERE name = ? AND enabled = 1").run(name).changes > 0;
  }

  markJobRun(name: string, at: number) {
    this.db.prepare("UPDATE jobs SET last_run_at = ? WHERE name = ?").run(at, name);
  }

  // ---- monitors ----
  upsertMonitor(m: Pick<MonitorRow, "name" | "script" | "every_min">) {
    this.db
      .prepare(
        `INSERT INTO monitors (name, script, every_min, created_at) VALUES (@name, @script, @every_min, @now)
         ON CONFLICT(name) DO UPDATE SET script = excluded.script, every_min = excluded.every_min, enabled = 1, last_run_at = NULL`,
      )
      .run({ ...m, now: Date.now() });
    return this.monitor(m.name)!;
  }

  monitor(name: string) {
    return this.db.prepare("SELECT * FROM monitors WHERE name = ?").get(name) as MonitorRow | undefined;
  }

  enabledMonitors() {
    return this.db.prepare("SELECT * FROM monitors WHERE enabled = 1 ORDER BY name").all() as MonitorRow[];
  }

  disableMonitor(name: string) {
    return this.db.prepare("UPDATE monitors SET enabled = 0 WHERE name = ? AND enabled = 1").run(name).changes > 0;
  }

  markMonitorRun(name: string, at: number) {
    this.db.prepare("UPDATE monitors SET last_run_at = ? WHERE name = ?").run(at, name);
  }
  claimMonitor(name: string, ptyID: string, deadline: number, at: number) {
    return this.db.prepare("UPDATE monitors SET last_run_at=?, pty_id=?, deadline_at=?, run_state='running' WHERE name=? AND enabled=1 AND run_state!='running' AND (last_run_at IS NULL OR last_run_at <= ?)").run(at, ptyID, deadline, name, at).changes > 0;
  }
  finishMonitor(name: string, state: "exited" | "failed", ptyID?: string) { this.db.prepare("UPDATE monitors SET run_state=?, pty_id=NULL, deadline_at=NULL WHERE name=? AND (? IS NULL OR pty_id=?)").run(state, name, ptyID ?? null, ptyID ?? null); }
  runningMonitors() { return this.db.prepare("SELECT * FROM monitors WHERE enabled=1 AND run_state='running'").all() as MonitorRow[]; }

  // ---- spend ----
  recordSpend(messageID: string, sessionID: string, cost: number, completedAt: number) {
    this.db
      .prepare(
        `INSERT INTO spend (message_id, session_id, cost, completed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET cost = excluded.cost, completed_at = excluded.completed_at`,
      )
      .run(messageID, sessionID, cost, completedAt);
  }

  spendSince(sinceMs: number): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(cost), 0) AS total FROM spend WHERE completed_at >= ?").get(sinceMs) as { total: number };
    return row.total;
  }

  spendBySessionSince(sinceMs: number) {
    return this.db
      .prepare("SELECT session_id, SUM(cost) AS total FROM spend WHERE completed_at >= ? GROUP BY session_id ORDER BY total DESC")
      .all(sinceMs) as { session_id: string; total: number }[];
  }

  reserveReasoning(requestID: string, sessionID: string, scope: string, variant: string, estimatedCost: number) {
    this.db.prepare("INSERT OR IGNORE INTO reasoning_usage(request_id,session_id,scope,variant,estimated_cost,created_at) VALUES(?,?,?,?,?,?)").run(requestID, sessionID, scope, variant, estimatedCost, Date.now());
  }
  reasoningSpendSince(sinceMs: number) {
    const row = this.db.prepare("SELECT COALESCE(SUM(COALESCE(actual_cost, estimated_cost)),0) AS total FROM reasoning_usage WHERE created_at >= ?").get(sinceMs) as { total: number };
    return row.total;
  }
  recordReasoningUsage(requestID: string, inputTokens: number, outputTokens: number, reasoningTokens: number, cost: number, completedAt: number) {
    const changed = this.db.prepare("UPDATE reasoning_usage SET input_tokens=?, output_tokens=?, reasoning_tokens=?, actual_cost=?, completed_at=? WHERE request_id=?").run(inputTokens, outputTokens, reasoningTokens, cost, completedAt, requestID).changes;
    if (!changed) this.db.prepare("UPDATE reasoning_usage SET input_tokens=?, output_tokens=?, reasoning_tokens=?, actual_cost=?, completed_at=? WHERE session_id=? AND completed_at IS NULL AND rowid=(SELECT MAX(rowid) FROM reasoning_usage WHERE session_id=? AND completed_at IS NULL)").run(inputTokens, outputTokens, reasoningTokens, cost, completedAt, requestID.replace("session-", ""), requestID.replace("session-", ""));
  }
  reasoningUsageSince(sinceMs: number) { return this.db.prepare("SELECT * FROM reasoning_usage WHERE created_at >= ? ORDER BY created_at").all(sinceMs); }

  // ---- observability: queue age, retries and spend ----
  metrics(now = Date.now()): StoreMetrics {
    const day = new Date(now); day.setHours(0, 0, 0, 0);
    const month = new Date(day.getFullYear(), day.getMonth(), 1);
    const updates = this.db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM updates WHERE delivered_at IS NULL").get() as { n: number; oldest: number | null };
    const outbound = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(state='pending'), 0) AS pending,
           COALESCE(SUM(state='retryable'), 0) AS retryable,
           COALESCE(SUM(state='unknown'), 0) AS unknown,
           COALESCE(SUM(state='sending'), 0) AS sending,
           COALESCE(SUM(state='failed'), 0) AS failed,
           COALESCE(SUM(state='sent'), 0) AS sent,
           COALESCE(SUM(CASE WHEN attempts > 1 THEN attempts - 1 ELSE 0 END), 0) AS retries
         FROM outbound_chunks`,
      )
      .get() as { pending: number; retryable: number; unknown: number; sending: number; failed: number; sent: number; retries: number };
    const oldestOutbound = this.db
      .prepare(
        `SELECT MIN(e.created_at) AS oldest FROM outbound_chunks c
         JOIN outbound_events e ON e.id = c.event_id
         WHERE c.state IN ('pending','retryable','unknown','sending')`,
      )
      .get() as { oldest: number | null };
    const approvals = this.db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM approvals WHERE resolved_at IS NULL").get() as { n: number; oldest: number | null };
    const tasks = this.db.prepare("SELECT COALESCE(SUM(state='running'),0) AS running, COALESCE(SUM(state='waiting'),0) AS waiting FROM tasks").get() as { running: number; waiting: number };
    const reminders = this.db.prepare("SELECT COALESCE(SUM(due_at <= ?),0) AS overdue, COUNT(*) AS upcoming FROM reminders WHERE fired_at IS NULL AND cancelled = 0").get(now) as { overdue: number; upcoming: number };
    return {
      updates: { pending: updates.n, oldestAgeMs: updates.oldest === null ? null : Math.max(0, now - updates.oldest) },
      outbound: { ...outbound, oldestAgeMs: oldestOutbound.oldest === null ? null : Math.max(0, now - oldestOutbound.oldest) },
      approvals: { open: approvals.n, oldestAgeMs: approvals.oldest === null ? null : Math.max(0, now - approvals.oldest) },
      tasks,
      reminders,
      spend: { today: this.spendSince(day.getTime()), month: this.spendSince(month.getTime()), reasoningToday: this.reasoningSpendSince(day.getTime()) },
    };
  }

  /**
   * Delete bounded history. Only terminal, already-handled rows are eligible:
   * pending updates, buffered inbound, unsent outbound chunks, unresolved
   * approvals and unfired reminders are never touched.
   */
  applyRetention(policy: RetentionPolicy): RetentionResult {
    const result: RetentionResult = { updates: 0, inbound: 0, outbound: 0, approvals: 0, turns: 0, attempts: 0 };
    this.db.transaction(() => {
      if (policy.updatesBefore !== undefined) {
        result.updates = this.db.prepare("DELETE FROM updates WHERE delivered_at IS NOT NULL AND delivered_at < ?").run(policy.updatesBefore).changes;
      }
      if (policy.inboundBefore !== undefined) {
        result.inbound = this.db.prepare("DELETE FROM inbound_messages WHERE state = 'consumed' AND consumed_at IS NOT NULL AND consumed_at < ?").run(policy.inboundBefore).changes;
      }
      if (policy.attemptsBefore !== undefined) {
        result.attempts = this.db.prepare("DELETE FROM delivery_attempts WHERE finished_at IS NOT NULL AND finished_at < ?").run(policy.attemptsBefore).changes;
      }
      if (policy.outboundBefore !== undefined) {
        const ids = this.db.prepare("SELECT id FROM outbound_events WHERE state = 'sent' AND completed_at IS NOT NULL AND completed_at < ?").all(policy.outboundBefore) as { id: string }[];
        for (const { id } of ids) {
          this.db.prepare("DELETE FROM delivery_leases WHERE event_id = ?").run(id);
          this.db.prepare("DELETE FROM delivery_attempts WHERE event_id = ?").run(id);
          this.db.prepare("DELETE FROM outbound_chunks WHERE event_id = ?").run(id);
          this.db.prepare("DELETE FROM outbound_events WHERE id = ?").run(id);
        }
        result.outbound = ids.length;
      }
      if (policy.approvalsBefore !== undefined) {
        result.approvals = this.db.prepare("DELETE FROM approvals WHERE resolved_at IS NOT NULL AND resolved_at < ?").run(policy.approvalsBefore).changes;
      }
      if (policy.turnsBefore !== undefined) {
        result.turns = this.db.prepare("DELETE FROM turns WHERE state IN ('done','failed') AND completed_at IS NOT NULL AND completed_at < ?").run(policy.turnsBefore).changes;
      }
    })();
    return result;
  }
}
