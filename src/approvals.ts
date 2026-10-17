/**
 * Permission prompts and agent questions from any session → Telegram messages with
 * buttons; your taps (or a text reply, for free-form answers) go back to OpenCode.
 */
import { InlineKeyboard } from "grammy";
import type { ApprovalRow, Store } from "./db.ts";
import { logger } from "./log.ts";
import { statusOf, type OpenCode, type PermissionRequest, type QuestionInfo, type QuestionRequest } from "./opencode.ts";
import type { Chat } from "./telegram/chat.ts";
import { escapeHtml } from "./telegram/format.ts";
import { truncate } from "./text.ts";

const log = logger("approvals");

type Reply = "once" | "reject" | "task";
const REPLY_LABEL: Record<Reply, string> = { once: "✅ Allowed once", reject: "❌ Denied", task: "✅ Allowed for this task" };

type QuestionState = { answers: (string[] | null)[]; selected: number[][] };

export function describePermission(req: Pick<PermissionRequest, "permission" | "patterns" | "metadata">): { verb: string; detail: string } {
  const patterns = req.patterns.filter(Boolean);
  const meta = (req.metadata ?? {}) as Record<string, unknown>;
  const description = typeof meta.description === "string" ? meta.description : undefined;
  switch (req.permission) {
    case "bash":
      return { verb: "wants to run", detail: (typeof meta.command === "string" ? meta.command : patterns.join("\n")) || "a shell command" };
    case "edit":
      return { verb: "wants to edit", detail: patterns.join("\n") || "files" };
    case "external_directory":
      return { verb: "wants to touch files outside its project", detail: patterns.join("\n") };
    case "webfetch":
      return { verb: "wants to fetch", detail: patterns.join("\n") };
    case "doom_loop":
      return { verb: "keeps repeating the same action and wants to continue", detail: description ?? patterns.join("\n") };
    default:
      return { verb: `wants permission for ${req.permission}`, detail: description ?? patterns.join("\n") };
  }
}

export class Approvals {
  private readonly store: Store;
  private readonly oc: OpenCode;
  private readonly chat: Chat;
  private readonly labelFor: (sessionID: string) => string;
  private readonly isQuiet: () => boolean;
  /** Requests we're replying to right now; their "replied" events are ours, not "elsewhere". */
  private readonly inFlight = new Set<string>();

  constructor(deps: { store: Store; oc: OpenCode; chat: Chat; labelFor: (sessionID: string) => string; isQuiet: () => boolean }) {
    this.store = deps.store;
    this.oc = deps.oc;
    this.chat = deps.chat;
    this.labelFor = deps.labelFor;
    this.isQuiet = deps.isQuiet;
  }

  // ---- permissions ----

  async onPermissionAsked(req: PermissionRequest, directory: string) {
    const row = this.store.insertApproval({ request_id: req.id, kind: "permission", session_id: req.sessionID, directory, payload: JSON.stringify(req) });
    log.info(`permission asked for ${this.labelFor(req.sessionID)}`, { requestID: req.id, correlationId: row.correlation_id });
    if (row.resolved_at) return;
    // Task-scoped consent: a previous "allow for this task" covers matching requests automatically.
    if (this.grantCovers(req.sessionID, req)) {
      this.inFlight.add(req.id);
      try {
        await this.oc.replyPermission(req.id, row.directory, "once");
        await this.resolve(row, "task-grant", false);
        log.info(`permission auto-allowed by a task grant`, { requestID: req.id });
      } catch (err) {
        if (statusOf(err) !== 404) throw err;
        await this.resolve(row, "expired");
      } finally {
        this.inFlight.delete(req.id);
      }
      return;
    }
    const ids = JSON.parse(row.chat_message_ids) as number[];
    if (ids.length) return;
    const { verb, detail } = describePermission(req);
    const html = `🔐 <b>${escapeHtml(this.labelFor(req.sessionID))}</b> ${escapeHtml(verb)}:\n<pre>${escapeHtml(truncate(detail, 1500))}</pre>`;
    const keyboard = new InlineKeyboard()
      .text("✅ Once", `p:${req.id}:once`)
      .text("✅ Task", `p:${req.id}:task`)
      .text("❌ Deny", `p:${req.id}:reject`);
    const id = await this.chat.sendHtml(html, { keyboard, silent: this.isQuiet() });
    this.store.updateApproval(req.id, { chat_message_ids: JSON.stringify([id]), presentation: JSON.stringify({ steps: [true] }) });
  }

  /** True when an earlier "allow for this task" grant covers every pattern of this request. */
  private grantCovers(sessionID: string, req: PermissionRequest): boolean {
    const grants = this.store.grantsFor(sessionID).filter((g) => g.permission === req.permission);
    if (!grants.length) return false;
    const wanted = req.patterns.filter(Boolean);
    if (!wanted.length) return false;
    return grants.some((g) => {
      const allowed = new Set(JSON.parse(g.patterns) as string[]);
      return wanted.every((p) => allowed.has(p));
    });
  }

  async answerPermission(requestID: string, reply: Reply, messageID?: number): Promise<string> {
    const row = this.store.approval(requestID);
    if (!row || row.resolved_at || this.inFlight.has(requestID)) return "Already handled";
    if (messageID !== undefined && !(JSON.parse(row.chat_message_ids) as number[]).includes(messageID)) return "That prompt does not match";
    this.inFlight.add(requestID);
    try {
      await this.oc.replyPermission(requestID, row.directory, reply === "task" ? "once" : reply);
      if (reply === "task") {
        const req = JSON.parse(row.payload) as PermissionRequest;
        this.store.grantPermission(row.session_id, req.permission, req.patterns.filter(Boolean));
      }
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
      await this.resolve(row, "expired");
      return "That request has expired";
    } finally {
      this.inFlight.delete(requestID);
    }
    await this.resolve(row, reply);
    return REPLY_LABEL[reply];
  }

  // ---- questions ----

  async onQuestionAsked(req: QuestionRequest, directory: string) {
    const row = this.store.insertApproval({ request_id: req.id, kind: "question", session_id: req.sessionID, directory, payload: JSON.stringify(req) });
    log.info(`question asked by ${this.labelFor(req.sessionID)}`, { requestID: req.id, correlationId: row.correlation_id });
    if (row.resolved_at) return;
    const state: QuestionState = row.state === "{}" ? { answers: req.questions.map(() => null), selected: req.questions.map(() => []) } : JSON.parse(row.state) as QuestionState;
    const ids = JSON.parse(row.chat_message_ids) as number[];
    const presentation = JSON.parse(row.presentation || "{}") as { steps?: boolean[] };
    const steps = presentation.steps ?? req.questions.map((_, i) => !!ids[i]);
    for (const [qi, q] of req.questions.entries()) {
      if (steps[qi]) continue;
      ids[qi] = await this.chat.sendHtml(this.renderQuestion(req.sessionID, q, qi, req.questions.length), { keyboard: this.questionKeyboard(req.id, q, qi, []), silent: this.isQuiet() });
      steps[qi] = true;
      this.store.updateApproval(req.id, { chat_message_ids: JSON.stringify(ids), state: JSON.stringify(state), presentation: JSON.stringify({ steps }) });
    }
    this.store.updateApproval(req.id, { chat_message_ids: JSON.stringify(ids), state: JSON.stringify(state), presentation: JSON.stringify({ steps }) });
  }

  private renderQuestion(sessionID: string, q: QuestionInfo, qi: number, total: number, answer?: string[]) {
    const head = `❓ <b>${escapeHtml(this.labelFor(sessionID))}</b> asks${total > 1 ? ` (${qi + 1}/${total})` : ""}:`;
    const options = q.options.map((o) => `• <b>${escapeHtml(truncate(o.label, 160))}</b>${o.description ? ` — ${escapeHtml(truncate(o.description, 240))}` : ""}`).join("\n");
    const freeText = q.custom === false ? "" : "\n<i>Reply to this message with your answer.</i>";
    const done = answer ? `\n\n➡️ <b>${escapeHtml(truncate(answer.join(", "), 300))}</b>` : freeText;
    return truncate(`${head}\n${escapeHtml(truncate(q.question, 900))}${options ? `\n\n${options}` : ""}${done}`, 3500);
  }

  private questionKeyboard(requestID: string, q: QuestionInfo, qi: number, selected: number[]) {
    const kb = new InlineKeyboard();
    if (q.multiple || q.custom === false) q.options.forEach((o, oi) => {
      const mark = q.multiple ? (selected.includes(oi) ? "☑ " : "☐ ") : "";
      kb.text(truncate(`${mark}${o.label}`, 40), `q:${requestID}:${qi}:${oi}`).row();
    });
    if (q.multiple) kb.text("Send ✓", `qd:${requestID}:${qi}`);
    kb.text("Dismiss", `qx:${requestID}`);
    return kb;
  }

  async tapOption(requestID: string, qi: number, oi: number, messageID?: number): Promise<string> {
    const row = this.store.approval(requestID);
    if (!row || row.resolved_at || this.inFlight.has(requestID)) return "Already handled";
    if (messageID !== undefined && (JSON.parse(row.chat_message_ids) as number[])[qi] !== messageID) return "That prompt does not match";
    const req = JSON.parse(row.payload) as QuestionRequest;
    const q = req.questions[qi];
    const option = q?.options[oi];
    if (!q || !option) return "Unknown option";
    const state = JSON.parse(row.state) as QuestionState;
    if (q.multiple) {
      const sel = state.selected[qi] ?? [];
      state.selected[qi] = sel.includes(oi) ? sel.filter((x) => x !== oi) : [...sel, oi];
      this.store.updateApproval(requestID, { state: JSON.stringify(state) });
      const msgId = (JSON.parse(row.chat_message_ids) as number[])[qi];
      if (msgId) await this.chat.editHtml(msgId, this.renderQuestion(req.sessionID, q, qi, req.questions.length), this.questionKeyboard(requestID, q, qi, state.selected[qi]!));
      return "Toggled";
    }
    return this.setAnswer(row, qi, [option.label]);
  }

  async submitMultiple(requestID: string, qi: number, messageID?: number): Promise<string> {
    const row = this.store.approval(requestID);
    if (!row || row.resolved_at || this.inFlight.has(requestID)) return "Already handled";
    if (messageID !== undefined && (JSON.parse(row.chat_message_ids) as number[])[qi] !== messageID) return "That prompt does not match";
    const req = JSON.parse(row.payload) as QuestionRequest;
    const state = JSON.parse(row.state) as QuestionState;
    const labels = (state.selected[qi] ?? []).map((oi) => req.questions[qi]?.options[oi]?.label).filter((l): l is string => !!l);
    if (labels.length === 0) return "Pick at least one option";
    return this.setAnswer(row, qi, labels);
  }

  /** A text reply to a question message becomes a free-form answer. Returns true if it was one. */
  async answerByReply(replyToMessageId: number, text: string): Promise<boolean> {
    for (const row of this.store.openApprovals()) {
      const qi = (JSON.parse(row.chat_message_ids) as number[]).indexOf(replyToMessageId);
      if (qi >= 0) {
        if (row.kind === "permission") {
          const command = text.trim().toLowerCase();
          if (command === "allow once") await this.answerPermission(row.request_id, "once");
          else if (command === "deny") await this.answerPermission(row.request_id, "reject");
          else return false;
          return true;
        }
        if (row.kind !== "question") continue;
        const req = JSON.parse(row.payload) as QuestionRequest;
        if (req.questions[qi]?.custom === false) return false;
        await this.setAnswer(row, qi, [text]);
        return true;
      }
    }
    return false;
  }

  private async setAnswer(row: ApprovalRow, qi: number, answer: string[]): Promise<string> {
    if (this.inFlight.has(row.request_id)) return "Already handling";
    const req = JSON.parse(row.payload) as QuestionRequest;
    const state = JSON.parse(row.state) as QuestionState;
    if (state.answers[qi] === null) {
      state.answers[qi] = answer;
      this.store.updateApproval(row.request_id, { state: JSON.stringify(state) });
    }
    const complete = !state.answers.some((a) => a === null);
    if (complete) this.inFlight.add(row.request_id);
    const msgId = (JSON.parse(row.chat_message_ids) as number[])[qi];
    if (msgId) await this.chat.editHtml(msgId, this.renderQuestion(req.sessionID, req.questions[qi]!, qi, req.questions.length, answer));

    if (!complete) return "Got it";
    try {
      await this.oc.replyQuestion(row.request_id, row.directory, state.answers as string[][]);
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
      await this.resolve(row, "expired");
      return "That question has expired";
    } finally {
      this.inFlight.delete(row.request_id);
    }
    await this.resolve(row, "answered", false);
    return "Sent";
  }

  async dismissQuestion(requestID: string, messageID?: number): Promise<string> {
    const row = this.store.approval(requestID);
    if (!row || row.resolved_at) return "Already handled";
    if (messageID !== undefined && !(JSON.parse(row.chat_message_ids) as number[]).includes(messageID)) return "That prompt does not match";
    this.inFlight.add(requestID);
    try {
      await this.oc.rejectQuestion(requestID, row.directory).catch((err) => {
        if (statusOf(err) !== 404) throw err;
      });
    } finally {
      this.inFlight.delete(requestID);
    }
    await this.resolve(row, "dismissed");
    return "Dismissed";
  }

  // ---- shared ----

  /** Mark resolved and update the Telegram message(s). */
  private async resolve(row: ApprovalRow, resolution: string, rewrite = true) {
    this.store.updateApproval(row.request_id, { resolved_at: Date.now(), resolution });
    if (!rewrite) return;
    const ids = JSON.parse(row.chat_message_ids) as number[];
    const note =
      resolution in REPLY_LABEL ? REPLY_LABEL[resolution as Reply] : resolution === "task-grant" ? "✅ Auto-allowed (task grant)" : resolution === "dismissed" ? "🚫 Dismissed" : resolution === "elsewhere" ? "✔️ Answered elsewhere" : "⌛ Expired";
    for (const id of ids) {
      await this.chat.editHtml(id, `${this.renderResolved(row)}\n\n<i>${escapeHtml(note)}</i>`).catch((err) => log.debug(`edit failed: ${(err as Error).message}`));
    }
  }

  private renderResolved(row: ApprovalRow): string {
    if (row.kind === "permission") {
      const req = JSON.parse(row.payload) as PermissionRequest;
      const { verb, detail } = describePermission(req);
      return `🔐 <b>${escapeHtml(this.labelFor(req.sessionID))}</b> ${escapeHtml(verb)}:\n<pre>${escapeHtml(truncate(detail, 1500))}</pre>`;
    }
    const req = JSON.parse(row.payload) as QuestionRequest;
    return `❓ <b>${escapeHtml(this.labelFor(req.sessionID))}</b>: ${escapeHtml(truncate(req.questions.map((q) => q.question).join(" / "), 500))}`;
  }

  /** Replied/rejected events (also fire when answered from the TUI or after our own reply). */
  async onReplied(requestID: string) {
    if (this.inFlight.has(requestID)) return;
    const row = this.store.approval(requestID);
    if (row && !row.resolved_at) await this.resolve(row, "elsewhere");
  }

  /** After reconnecting: show anything pending we haven't shown; close what's gone. */
  async reconcile(directories: string[]) {
    const live = new Set<string>();
    const snapshots = new Set<string>();
    for (const dir of directories) {
      const [perms, questions] = await Promise.allSettled([this.oc.pendingPermissions(dir), this.oc.pendingQuestions(dir)]);
      if (perms.status === "fulfilled") {
        snapshots.add(`${dir}:permission`);
        this.store.approvalSnapshot(dir, "permission");
        for (const p of perms.value) { live.add(p.id); await this.onPermissionAsked(p, dir); }
      }
      if (questions.status === "fulfilled") {
        snapshots.add(`${dir}:question`);
        this.store.approvalSnapshot(dir, "question");
        for (const q of questions.value) { live.add(q.id); await this.onQuestionAsked(q, dir); }
      }
    }
    for (const row of this.store.openApprovals()) {
      if (directories.includes(row.directory) && snapshots.has(`${row.directory}:${row.kind}`) && !live.has(row.request_id)) await this.resolve(row, "expired");
    }
  }

  /** Nudge once about requests left unanswered for 30+ minutes. */
  async nudge(now = Date.now()) {
    if (this.isQuiet()) return;
    for (const row of this.store.openApprovals()) {
      if (row.nudged || now - row.created_at < 30 * 60_000) continue;
      this.store.updateApproval(row.request_id, { nudged: 1 });
      const first = (JSON.parse(row.chat_message_ids) as number[])[0];
      await this.chat.sendHtml(`⏳ Still waiting on you for <b>${escapeHtml(this.labelFor(row.session_id))}</b> — the work is paused until you answer.`, { replyTo: first });
    }
  }
}
