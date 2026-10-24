/**
 * Permission prompts and agent forms (v2's questions) from any session → Telegram messages
 * with buttons; your taps (or a text reply, for free-form answers) go back to OpenCode.
 */
import { InlineKeyboard } from "grammy";
import type { ApprovalRow, Store } from "./db.ts";
import { logger } from "./log.ts";
import { statusOf, type FormField, type FormRequest, type OpenCode, type PermissionRequest } from "./opencode.ts";
import type { Chat } from "./telegram/chat.ts";
import { escapeHtml } from "./telegram/format.ts";
import { truncate } from "./text.ts";

const log = logger("approvals");

type Reply = "once" | "reject" | "task";
const REPLY_LABEL: Record<Reply, string> = { once: "✅ Allowed once", reject: "❌ Denied", task: "✅ Allowed for this task" };

type FormState = { answers: Record<string, string | string[]>; shown: string[] };

export function describePermission(req: Pick<PermissionRequest, "action" | "resources" | "metadata">): { verb: string; detail: string } {
  const resources = (req.resources ?? []).filter(Boolean);
  const meta = (req.metadata ?? {}) as Record<string, unknown>;
  const description = typeof meta.description === "string" ? meta.description : undefined;
  switch (req.action) {
    case "bash":
    case "shell":
      return { verb: "wants to run", detail: (typeof meta.command === "string" ? meta.command : resources.join("\n")) || "a shell command" };
    case "edit":
      return { verb: "wants to edit", detail: resources.join("\n") || "files" };
    case "external_directory":
      return { verb: "wants to touch files outside its project", detail: resources.join("\n") };
    case "webfetch":
      return { verb: "wants to fetch", detail: resources.join("\n") };
    case "doom_loop":
      return { verb: "keeps repeating the same action and wants to continue", detail: description ?? resources.join("\n") };
    default:
      return { verb: `wants permission for ${req.action}`, detail: description ?? resources.join("\n") };
  }
}

/** Fields we can render as Telegram buttons (choices); everything else is a text reply. */
function optionsOf(f: FormField): { value: string; label: string; description?: string }[] {
  return f.options ?? [];
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
        await this.oc.replyPermission(req.sessionID, req.id, "once");
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
    const grants = this.store.grantsFor(sessionID).filter((g) => g.permission === req.action);
    if (!grants.length) return false;
    const wanted = (req.resources ?? []).filter(Boolean);
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
      await this.oc.replyPermission(row.session_id, requestID, reply === "task" ? "once" : reply);
      if (reply === "task") {
        const req = JSON.parse(row.payload) as PermissionRequest;
        this.store.grantPermission(row.session_id, req.action, (req.resources ?? []).filter(Boolean));
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

  // ---- forms (questions in v2) ----

  async onFormRequested(form: FormRequest, directory: string) {
    const row = this.store.insertApproval({ request_id: form.id, kind: "question", session_id: form.sessionID, directory, payload: JSON.stringify(form) });
    log.info(`form requested by ${this.labelFor(form.sessionID)}`, { requestID: form.id, correlationId: row.correlation_id });
    if (row.resolved_at) return;
    const fields = form.fields.filter((f) => !f.hidden);
    const state: FormState = row.state === "{}" ? { answers: {}, shown: [] } : (JSON.parse(row.state) as FormState);
    const ids = JSON.parse(row.chat_message_ids) as number[];
    for (const [fi, field] of fields.entries()) {
      if (state.shown.includes(field.key)) continue;
      const id = await this.chat.sendHtml(this.renderField(form.sessionID, field, fi, fields.length), { keyboard: this.fieldKeyboard(form.id, field, state), silent: this.isQuiet() });
      ids.push(id);
      state.shown.push(field.key);
      this.store.updateApproval(form.id, { chat_message_ids: JSON.stringify(ids), state: JSON.stringify(state), presentation: JSON.stringify({ steps: state.shown.map(() => true) }) });
    }
  }

  private renderField(sessionID: string, f: FormField, fi: number, total: number, answer?: string | string[], selected?: string[]) {
    const head = `❓ <b>${escapeHtml(this.labelFor(sessionID))}</b> asks${total > 1 ? ` (${fi + 1}/${total})` : ""}:`;
    const title = f.title ?? f.key;
    const options = optionsOf(f)
      .map((o) => `• <b>${escapeHtml(truncate(o.label, 160))}</b>${o.description ? ` — ${escapeHtml(truncate(o.description, 240))}` : ""}`)
      .join("\n");
    const showFreeText = optionsOf(f).length === 0 || (f.custom !== false && f.type !== "multiselect");
    const freeText = showFreeText ? "\n<i>Reply to this message with your answer.</i>" : "";
    const picked = selected?.length ? `\n\n<b>${selected.map((v) => `☑ ${escapeHtml(truncate(v, 40))}`).join("  ")}</b>` : "";
    const done = answer !== undefined ? `\n\n➡️ <b>${escapeHtml(truncate(Array.isArray(answer) ? answer.join(", ") : answer, 300))}</b>` : picked + freeText;
    return truncate(`${head}\n${escapeHtml(truncate(title, 900))}${options ? `\n\n${options}` : ""}${done}`, 3500);
  }

  private fieldKeyboard(formID: string, f: FormField, state: FormState) {
    const kb = new InlineKeyboard();
    const options = optionsOf(f);
    const current = state.answers[f.key];
    const selected = Array.isArray(current) ? current : [];
    for (const [oi, o] of options.entries()) {
      const mark = selected.includes(o.value) ? "☑ " : "☐ ";
      kb.text(truncate(`${mark}${o.label}`, 40), `q:${formID}:${f.key}:${oi}`).row();
    }
    // A single choice is sent on tap; only a multiselect needs a Send button.
    if (options.length && f.type === "multiselect") kb.text("Send ✓", `qd:${formID}:${f.key}`);
    kb.text("Dismiss", `qx:${formID}`);
    return kb;
  }

  async tapOption(requestID: string, key: string, oi: number, messageID?: number): Promise<string> {
    const row = this.store.approval(requestID);
    if (!row || row.resolved_at || this.inFlight.has(requestID)) return "Already handled";
    const form = JSON.parse(row.payload) as FormRequest;
    const field = form.fields.find((f) => f.key === key);
    const option = field ? optionsOf(field)[oi] : undefined;
    if (!field || !option) return "Unknown option";
    const state = JSON.parse(row.state) as FormState;
    const current = state.answers[key];
    const selected = Array.isArray(current) ? current : [];
    const multi = field.type === "multiselect";
    // OpenCode 2 wants a string for a single-choice field and a list only for a multiselect.
    state.answers[key] = multi ? (selected.includes(option.value) ? selected.filter((v) => v !== option.value) : [...selected, option.value]) : option.value;
    this.store.updateApproval(requestID, { state: JSON.stringify(state) });
    const msgId = this.messageForField(row, key);
    if (msgId) {
      const fi = form.fields.filter((f) => !f.hidden).findIndex((f) => f.key === key);
      await this.chat.editHtml(msgId, this.renderField(form.sessionID, field, fi, form.fields.filter((f) => !f.hidden).length, undefined, multi ? (state.answers[key] as string[]) : []), this.fieldKeyboard(requestID, field, state));
    }
    if (!multi) return this.finishForm(row, state);
    return "Toggled";
  }

  async submitMultiple(requestID: string, key: string, messageID?: number): Promise<string> {
    const row = this.store.approval(requestID);
    if (!row || row.resolved_at || this.inFlight.has(requestID)) return "Already handled";
    const form = JSON.parse(row.payload) as FormRequest;
    const field = form.fields.find((f) => f.key === key);
    const state = JSON.parse(row.state) as FormState;
    const selected = state.answers[key];
    if (!field || !Array.isArray(selected) || selected.length === 0) return "Pick at least one option";
    return this.finishForm(row, state);
  }

  /** A text reply to a form message becomes a free-form answer. Returns true if it was one. */
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
        const form = JSON.parse(row.payload) as FormRequest;
        const field = form.fields.filter((f) => !f.hidden)[qi];
        if (!field) return false;
        if (field.custom === false) return false; // fixed-choice fields need the buttons
        if (field.type === "multiselect") return false;
        const state = JSON.parse(row.state) as FormState;
        state.answers[field.key] = text;
        this.store.updateApproval(row.request_id, { state: JSON.stringify(state) });
        const msgId = (JSON.parse(row.chat_message_ids) as number[])[qi];
        const fields = form.fields.filter((f) => !f.hidden);
        if (msgId) await this.chat.editHtml(msgId, this.renderField(form.sessionID, field, qi, fields.length, text));
        await this.finishForm(row, state);
        return true;
      }
    }
    return false;
  }

  private messageForField(row: ApprovalRow, key: string): number | undefined {
    const form = JSON.parse(row.payload) as FormRequest;
    const fields = form.fields.filter((f) => !f.hidden);
    const idx = fields.findIndex((f) => f.key === key);
    return idx >= 0 ? (JSON.parse(row.chat_message_ids) as number[])[idx] : undefined;
  }

  /** All required fields answered → send the form answer to OpenCode. */
  private async finishForm(row: ApprovalRow, state: FormState): Promise<string> {
    const form = JSON.parse(row.payload) as FormRequest;
    const missing = form.fields.filter((f) => f.required !== false && !f.hidden && state.answers[f.key] === undefined);
    if (missing.length) return "Got it";
    if (this.inFlight.has(row.request_id)) return "Already handling";
    this.inFlight.add(row.request_id);
    try {
      await this.oc.replyForm(form.sessionID, form.id, state.answers as Record<string, unknown>);
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
      // v2 has no explicit reject for forms; replying with an empty answer cancels the prompt.
      const form = JSON.parse(row.payload) as FormRequest;
      await this.oc.replyForm(form.sessionID, form.id, {}).catch((err) => {
        if (statusOf(err) !== 404 && statusOf(err) !== 400) throw err;
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
    const form = JSON.parse(row.payload) as FormRequest;
    return `❓ <b>${escapeHtml(this.labelFor(form.sessionID))}</b>: ${escapeHtml(truncate(form.fields.map((f) => f.title ?? f.key).join(" / "), 500))}`;
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
      const perms = await this.oc.pendingPermissions(dir).catch(() => undefined);
      if (perms) {
        snapshots.add(`${dir}:permission`);
        this.store.approvalSnapshot(dir, "permission");
        for (const p of perms) {
          live.add(p.id);
          await this.onPermissionAsked(p, dir);
        }
      }
      // Every pending form in the directory, so a question whose event was missed still gets shown.
      // Without that listing, fall back to polling the sessions we already track.
      let formLists: FormRequest[][];
      const all = await this.oc.formsIn(dir).catch(() => undefined);
      if (all) formLists = [all];
      else {
        const sessionIDs = [...new Set(this.store.openApprovals().filter((a) => a.directory === dir).map((a) => a.session_id))];
        formLists = await Promise.all(sessionIDs.map((sid) => this.oc.pendingForms(sid, dir).catch(() => [] as FormRequest[])));
      }
      snapshots.add(`${dir}:question`);
      this.store.approvalSnapshot(dir, "question");
      for (const forms of formLists) {
        for (const f of forms) {
          live.add(f.id);
          await this.onFormRequested(f, dir);
        }
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
