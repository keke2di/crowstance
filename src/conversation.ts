/**
 * The one long-lived "main" conversation you have with the assistant.
 * Buffers bursts of messages, queues while the session is busy, shows a typing
 * indicator, records replies durably before delivery, and feeds background
 * updates in when the assistant is free. Telegram retries may duplicate an
 * ambiguous send; losing content silently is the worse outcome.
 */
import type { Config } from "./config.ts";
import { parseModelRef } from "./config.ts";
import type { Store, UpdateRow } from "./db.ts";
import { logger, newCorrelationId, runWithCorrelation } from "./log.ts";
import { errorText, messageText, type ModelRef, type OpenCode } from "./opencode.ts";
import type { Chat } from "./telegram/chat.ts";
import { Delivery } from "./delivery.ts";
import { isNoReply, stamp, stripNoReply, truncate } from "./text.ts";
import { completeBrief, isClearlyBigRequest, reserveReasoning } from "./reasoning.ts";
import crypto from "node:crypto";

const log = logger("conversation");

export type Inbound = { text: string; at: Date; replyTo?: string };
type TurnKind = "user" | "update" | "rotate";
type RotateMode = "manual" | "auto";

export const KEY_SESSION = "main.session";
const KEY_SINCE = "main.since";
const KEY_DELIVERED = "main.delivered";
/** Last time anything happened in the chat (a message in, a reply out). */
const KEY_ACTIVITY = "main.lastActivity";
/** Approximate context size of the main session after its latest turn. */
const KEY_CONTEXT = "main.contextTokens";
/** User turns in the current main session (nothing to compact when 0). */
const KEY_USER_TURNS = "main.userTurns";
export const KEY_CHAT_MODEL = "model.chat";
export const HANDOFF_FILE = "memory/handoff.md";

/** Provider hiccups worth one automatic retry before bothering the user. */
const TRANSIENT_ERROR = /upstream_error|try again|overloaded|temporar|timed? ?out|ECONNRESET|ETIMEDOUT|rate.?limit|\b(429|500|502|503|504)\b/i;

/** `model` tells the assistant what it runs on (models often don't know, or guess wrong). */
export function composeUserTurn(batch: Inbound[], model?: string): string {
  const head = `[${stamp(batch.at(-1)!.at)}${model ? ` · you are running on ${model}` : ""}]`;
  const body = batch
    .map((m) => (m.replyTo ? `(replying to: "${truncate(m.replyTo.replace(/\s+/g, " "), 300)}")\n` : "") + m.text)
    .join("\n");
  return `${head}\n${body}`;
}

export function composeUpdateTurn(updates: UpdateRow[], now = new Date()): string {
  const items = updates
    .map((u) => `- [${u.kind}${u.urgent ? ", urgent" : ""} · ${stamp(new Date(u.created_at))}] ${u.text}`)
    .join("\n");
  return [
    `<update time="${stamp(now)}">`,
    items,
    `</update>`,
    `These are background events from your gateway, not messages from the user. Always pass reminders on. ` +
      `For everything else, text the user only if it's worth their attention right now; otherwise reply exactly NO_REPLY.`,
  ].join("\n");
}

export class Conversation {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly oc: OpenCode;
  private readonly chat: Chat;
  private readonly isQuiet: () => boolean;
  private readonly delivery: Delivery;

  private buffer: (Inbound & { id: number; correlationId: string })[] = [];
  private debounce: NodeJS.Timeout | undefined;
  private busy = false;
  private busySince = 0;
  private turn: TurnKind | undefined;
  /** The current update turn carries something urgent (reminder, urgent alert): notify even in quiet hours. */
  private turnUrgent = false;
  private turnID: number | undefined;
  private typingTimer: NodeJS.Timeout | undefined;
  private rotatePending = false;
  private rotateMode: RotateMode = "manual";
  /** 0 for a fresh turn, then 1/2 for automatic retries after a provider hiccup. */
  private turnAttempt = 0;
  private retryPending: { kind: TurnKind; urgent: boolean; at: number; attempt: number } | undefined;
  private readonly lastNotice = new Map<string, number>();
  private readonly retryDelayMs: number;
  /** Maximum automatic retries of a turn that hit a provider hiccup. */
  private readonly maxRetries = 2;
  private verified = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: {
    cfg: Config;
    store: Store;
    oc: OpenCode;
    chat: Chat;
    isQuiet: () => boolean;
    delivery?: Delivery;
    delegate?: (title: string, brief: string) => Promise<{ slug: string }>;
    /** Wait before retrying a turn that hit a provider hiccup (default 15s). */
    retryDelayMs?: number;
  }) {
    this.retryDelayMs = deps.retryDelayMs ?? 15_000;
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.oc = deps.oc;
    this.chat = deps.chat;
    this.isQuiet = deps.isQuiet;
    this.delivery = deps.delivery ?? new Delivery(this.store, this.chat);
    this.delegate = deps.delegate;
    this.buffer = this.store.bufferedInbound().map((m) => ({ id: m.id, text: m.text, at: new Date(m.received_at), ...(m.reply_to ? { replyTo: m.reply_to } : {}), correlationId: m.correlation_id ?? newCorrelationId("in") }));
  }
  private readonly delegate?: (title: string, brief: string) => Promise<{ slug: string }>;

  get directory() {
    return this.cfg.ASSISTANT_HOME;
  }

  get sessionID(): string | undefined {
    return this.store.get(KEY_SESSION);
  }

  isBusy() {
    return this.busy;
  }

  /** Serialize everything that touches the main session. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch((err) => log.error("conversation step failed", err));
    return next;
  }

  async ensureMainSession(): Promise<string> {
    const existing = this.store.get(KEY_SESSION);
    if (existing && (this.verified || (await this.oc.getSession(existing, this.directory)))) {
      this.verified = true;
      if (!this.store.get(KEY_SINCE)) this.store.set(KEY_SINCE, String(Date.now()));
      return existing;
    }
    const session = await this.oc.createSession({
      directory: this.directory,
      title: "Main conversation",
      agent: this.cfg.ASSISTANT_AGENT,
      metadata: { hq: { kind: "main" } },
    });
    this.store.set(KEY_SESSION, session.id);
    this.store.set(KEY_SINCE, String(Date.now()));
    this.store.set(KEY_DELIVERED, "[]");
    this.store.set(KEY_USER_TURNS, "0");
    this.store.set(KEY_CONTEXT, "0");
    this.verified = true;
    log.info(`created main session ${session.id}`);
    return session.id;
  }

  chatModel(): ModelRef | undefined {
    const ref = this.store.get(KEY_CHAT_MODEL) ?? this.cfg.CHAT_MODEL;
    return ref ? parseModelRef(ref) : undefined;
  }

  private agentDefaultModel: string | undefined;

  /** "provider/model" the main session runs on: the /model choice, else the agent's default from opencode.json. */
  async chatModelLabel(): Promise<string | undefined> {
    const ref = this.store.get(KEY_CHAT_MODEL) ?? this.cfg.CHAT_MODEL;
    if (ref) return ref;
    if (this.agentDefaultModel === undefined) {
      const agent = (await this.oc.agents(this.directory).catch(() => [])).find((a) => a.name === this.cfg.ASSISTANT_AGENT);
      this.agentDefaultModel = agent?.model ? `${agent.model.providerID}/${agent.model.modelID}` : "";
    }
    return this.agentDefaultModel || undefined;
  }

  // ---- inbound ----

  onUserMessage(msg: Inbound) {
    this.store.set(KEY_ACTIVITY, String(Date.now()));
    const row = this.store.insertInbound({ text: msg.text, receivedAt: msg.at.getTime(), replyTo: msg.replyTo });
    this.buffer.push({ ...msg, id: row.id, correlationId: row.correlation_id ?? newCorrelationId("in") });
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.pump();
    }, this.cfg.DEBOUNCE_MS);
  }

  /** Send whatever is waiting (user messages first, then background updates) if the session is free. */
  pump(): Promise<void> {
    return this.run(() => this.pumpLocked());
  }

  private async pumpLocked() {
    if (this.busy || this.debounce) return;
    if (this.buffer.length) {
      this.retryPending = undefined; // a new message supersedes an automatic retry
      const batch = this.buffer.splice(0);
      const correlation = batch[0]!.correlationId;
      try {
        await runWithCorrelation(correlation, async () => {
          const userText = batch.map((m) => m.text).join("\n");
          // Clearly big build work starts a worker right away, but the assistant still sees the message
          // (and knows about the task), so the conversation keeps its context.
          let note = "";
          if (this.delegate && isClearlyBigRequest(userText)) {
            try {
              const task = await this.delegate(truncate(batch[0]!.text.replace(/\s+/g, " "), 70) || "Big request", completeBrief(userText));
              note =
                `\n\n[gateway: this looked like a big multi-step job, so background task "${task.slug}" was already started with the ` +
                `message above as its brief. Don't start another one for it. Tell the user it's underway; use hq_task_message to add ` +
                `context if the brief needs more.]`;
            } catch (err) {
              log.warn(`automatic hand-off skipped: ${(err as Error).message}`);
            }
          }
          await this.send("user", composeUserTurn(batch, await this.chatModelLabel()) + note, false, correlation);
          this.store.markInboundConsumed(batch.map((m) => m.id));
          this.store.set(KEY_USER_TURNS, String(Number(this.store.get(KEY_USER_TURNS) ?? 0) + 1));
        });
      } catch (err) {
        this.buffer.unshift(...batch);
        const message = (err as Error).message;
        if (/budget would be exceeded/i.test(message)) {
          await this.notifyOnce(
            "budget",
            "⚠️ I've used up today's reasoning budget. I'll answer when it resets at midnight, or sooner if you raise REASONING_DAILY_BUDGET_USD.",
            6 * 3_600_000,
          );
        } else {
          await this.notifyOnce("unreachable", `⚠️ I can't reach my brain right now (${truncate(message, 200)}). I'll pick your message up as soon as it's back.`, 10 * 60_000);
        }
      }
      return;
    }
    if (this.rotatePending) return;
    if (this.retryPending) {
      if (Date.now() < this.retryPending.at) return;
      const retry = this.retryPending;
      this.retryPending = undefined;
      log.info(`retrying the ${retry.kind} turn after a provider hiccup`);
      await this.send(
        retry.kind,
        `[${stamp()}]\n<system>Your previous reply failed because the model provider had a temporary error. Answer the latest message again now.</system>`,
        retry.urgent,
        undefined,
        retry.attempt,
      );
      return;
    }
    const updates = this.store.pendingUpdates().filter((u) => u.urgent || !this.isQuiet());
    if (updates.length) {
      const correlation = newCorrelationId("upd");
      await runWithCorrelation(correlation, () => this.send("update", composeUpdateTurn(updates), updates.some((u) => u.urgent), correlation));
      this.store.markUpdatesDelivered(updates.map((u) => u.id));
    }
  }

  private async send(kind: TurnKind, text: string, urgent = false, correlationId?: string, attempt = 0) {
    const sessionID = await this.ensureMainSession();
    this.busy = true;
    this.busySince = Date.now();
    this.turn = kind;
    this.turnUrgent = urgent;
    this.turnAttempt = attempt;
    const turn = this.store.createTurn(kind, urgent, sessionID, this.cfg.REASONING_VARIANT, correlationId);
    this.turnID = turn.id;
    this.store.updateTurn(turn.id, "running", sessionID);
    log.debug(`turn ${turn.id} (${kind}) started`, { correlationId: turn.correlation_id, sessionID });
    if (kind === "user") this.startTyping();
    try {
      reserveReasoning(this.store, this.cfg, `turn-${turn.id}-${crypto.randomUUID()}`, sessionID, kind === "update" ? "chat-update" : "chat", text);
      await this.oc.prompt({
        sessionID,
        directory: this.directory,
        agent: this.cfg.ASSISTANT_AGENT,
        model: this.chatModel(),
        parts: [{ type: "text", text }],
        variant: this.cfg.REASONING_VARIANT,
      });
    } catch (err) {
      this.store.updateTurn(turn.id, "failed", sessionID);
      this.busy = false;
      this.turn = undefined;
      this.turnID = undefined;
      this.stopTyping();
      throw err;
    }
  }

  // ---- session lifecycle events ----

  onMainBusy() {
    if (!this.busy) {
      this.busy = true;
      this.busySince = Date.now();
    }
  }

  onMainIdle(): Promise<void> {
    return this.run(async () => {
      const kind = this.turn;
      const urgent = this.turnUrgent;
      const turnID = this.turnID;
      const attempt = this.turnAttempt;
      this.busy = false;
      this.turn = undefined;
      this.turnID = undefined;
      this.turnUrgent = false;
      this.turnAttempt = 0;
      this.stopTyping();
      await this.deliver(kind, urgent, turnID, attempt);
      if (kind === "rotate" && this.rotatePending) await this.rotateNow();
      await this.pumpLocked();
    });
  }

  /** Called after (re)connecting to OpenCode and periodically as a watchdog. */
  async reconcile() {
    const sessionID = await this.run(() => this.ensureMainSession());
    const status = (await this.oc.statuses(this.directory))[sessionID];
    if (!status || status.type === "idle") await this.onMainIdle();
    else this.onMainBusy();
  }

  async watchdog() {
    if (this.busy && Date.now() - this.busySince > this.cfg.BUSY_WATCHDOG_SEC * 1000) await this.reconcile();
    else if (!this.busy) {
      await this.pump();
      await this.maybeAutoRotate();
    }
  }

  /** Time for a fresh session? Only when the chat is old or big AND has been quiet for a while. */
  shouldAutoRotate(now = Date.now()): boolean {
    if (this.cfg.ROTATE_AFTER_HOURS <= 0) return false;
    if (this.busy || this.rotatePending || this.retryPending || this.buffer.length || this.debounce) return false;
    if (Number(this.store.get(KEY_USER_TURNS) ?? 0) === 0) return false;
    const since = Number(this.store.get(KEY_SINCE) ?? now);
    const activity = Number(this.store.get(KEY_ACTIVITY) ?? since);
    if (now - activity < this.cfg.ROTATE_IDLE_MIN * 60_000) return false;
    const old = now - since >= this.cfg.ROTATE_AFTER_HOURS * 3_600_000;
    const big = Number(this.store.get(KEY_CONTEXT) ?? 0) >= this.cfg.ROTATE_CONTEXT_TOKENS;
    return old || big;
  }

  private maybeAutoRotate(): Promise<void> {
    return this.run(async () => {
      if (!this.shouldAutoRotate()) return;
      log.info("starting a fresh main session (age/size limit reached while quiet)");
      await this.startRotation("auto");
    });
  }

  private async notifyOnce(key: string, text: string, everyMs: number) {
    const last = this.lastNotice.get(key) ?? 0;
    if (Date.now() - last < everyMs) return;
    this.lastNotice.set(key, Date.now());
    await this.chat.sendText(text, { bubbles: false }).catch((err) => log.warn(`notice not delivered: ${(err as Error).message}`));
  }

  private async deliver(kind: TurnKind | undefined, urgent = false, turnID?: number, attempt = 0) {
    const sessionID = this.sessionID;
    if (!sessionID) return;
    const since = Number(this.store.get(KEY_SINCE) ?? Date.now());
    const delivered = new Set<string>(JSON.parse(this.store.get(KEY_DELIVERED) ?? "[]") as string[]);

    const done = (await this.oc.messages(sessionID, this.directory, 40))
      .filter((m) => m.info.role === "assistant" && m.info.time.created >= since && !delivered.has(m.info.id))
      .filter((m) => m.info.role === "assistant" && (m.info.time.completed !== undefined || m.info.error !== undefined))
      .sort((a, b) => a.info.time.created - b.info.time.created);
    if (done.length === 0) return;

    const texts = done.map((m) => messageText(m.parts)).filter(Boolean);
    // A turn that ends in NO_REPLY sends nothing, including any narration before it.
    const reply = texts.length === 0 || isNoReply(texts.at(-1)!) ? "" : stripNoReply(texts.join("\n\n"));
    const errors = done.map((m) => errorText(m.info)).filter((e): e is string => !!e && !e.startsWith("MessageAbortedError"));
    const turn = turnID ? this.store.turn(turnID) : this.store.createTurn(kind ?? "user", urgent, sessionID);
    if (!turn) return;

    this.store.set(KEY_ACTIVITY, String(Date.now()));
    const last = done.at(-1)!.info as { tokens?: { input?: number; cache?: { read?: number } } };
    if (last.tokens) this.store.set(KEY_CONTEXT, String((last.tokens.input ?? 0) + (last.tokens.cache?.read ?? 0)));

    // A provider hiccup with nothing said yet: retry the turn, quietly, before telling the user.
    const transient = !reply && errors.length > 0 && errors.every((e) => TRANSIENT_ERROR.test(e));
    if (transient && attempt < this.maxRetries && (kind === "user" || kind === "update")) {
      for (const m of done) delivered.add(m.info.id);
      this.store.set(KEY_DELIVERED, JSON.stringify([...delivered].slice(-300)));
      this.store.updateTurn(turn.id, "done", sessionID);
      // Bounded backoff: retryDelay, 4×retryDelay, each with ±25% jitter.
      const delay = Math.floor(this.retryDelayMs * 4 ** attempt * (0.75 + Math.random() * 0.5));
      this.retryPending = { kind, urgent, at: Date.now() + delay, attempt: attempt + 1 };
      log.warn(`model provider hiccup (${truncate(errors.at(-1)!, 160)}); retry ${attempt + 1}/${this.maxRetries} in ${Math.round(delay / 1000)}s`);
      return;
    }
    const errorNotice = !errors.length
      ? ""
      : transient
        ? "⚠️ My model provider is having trouble right now (several attempts failed). Try again in a bit."
        : `⚠️ Something went wrong on my side: ${truncate(errors.at(-1)!, 400)}`;

    const correlation = turn.correlation_id ?? newCorrelationId("out");
    await runWithCorrelation(correlation, async () => {
      for (const [i, text] of [reply, errorNotice].filter(Boolean).entries()) {
        this.store.enqueueOutbound({ id: `turn-${turn.id}-${i}`, sessionID, turnID: turn.id, sourceMessageID: done.at(-1)!.info.id, kind: errors.length && i === 1 ? "error" : "text", payload: { text }, urgent: urgent || kind === "user", chunks: [text], correlationID: correlation });
      }
      for (const m of done) delivered.add(m.info.id);
      this.store.set(KEY_DELIVERED, JSON.stringify([...delivered].slice(-300)));
      await this.delivery.flush();
    });
    this.store.updateTurn(turn.id, "done", sessionID);
  }

  // ---- commands ----

  async abortTurn(): Promise<boolean> {
    const sessionID = this.sessionID;
    if (!sessionID || !this.busy) return false;
    await this.oc.abort(sessionID, this.directory);
    return true;
  }

  /** /new: let the assistant save what matters to memory, then start a clean session. */
  requestNewSession(): Promise<"ok" | "busy"> {
    return this.run(async () => {
      if (this.busy) return "busy" as const;
      await this.startRotation("manual");
      // Saving takes a model turn, which shows no typing indicator; say what's happening.
      await this.chat.sendText("Saving where we left off, then starting a clean chat…", { bubbles: false });
      return "ok" as const;
    });
  }

  /** Ask the assistant to save memory and a handoff; the new session starts when that turn goes idle. */
  private async startRotation(mode: RotateMode) {
    this.rotatePending = true;
    this.rotateMode = mode;
    const why =
      mode === "manual"
        ? "The user asked for a clean chat (/new). The next chat starts without this conversation and without the handoff; " +
          "it reads the handoff only if the user asks to pick up where you left off, so make it self-contained."
        : "This conversation has been going for a while, so it's being reset to keep your context small. " +
          "The next session starts with your handoff, so it can carry on seamlessly.";
    try {
      await this.send(
        "rotate",
        `[${stamp()}]\n<system>${why} Before your context is reset:\n` +
          `1. Update memory/profile.md with anything new you learned about the user here: who they are, how they work, ` +
          `how they like things done, likes and dislikes, and corrections they gave you.\n` +
          `2. Save anything else worth keeping into memory/notes/ and today's journal.\n` +
          `3. Overwrite ${HANDOFF_FILE} with a short handoff: what you and the user were in the middle of, open loops, ` +
          `and what you'd need to carry on (a few lines).\nThen reply exactly NO_REPLY.</system>`,
      );
    } catch (err) {
      this.rotatePending = false;
      throw err;
    }
  }

  private async rotateNow() {
    this.rotatePending = false;
    const mode = this.rotateMode;
    this.store.delete(KEY_SESSION);
    this.verified = false;
    const sessionID = await this.ensureMainSession();
    if (mode === "manual") {
      // /new is a clean slate. The handoff stays on disk for when the user asks to pick up where they left off.
      log.info(`main session reset by /new to ${sessionID}`);
      await this.chat.sendText("🧹 New chat. If you want to continue the last one, just ask me to pick it up.", { bubbles: false });
      return;
    }
    // Automatic resets carry on: seed the fresh session with the handoff (as context only; no reply is generated).
    const handoff = (await this.oc.readFile(this.directory, HANDOFF_FILE))?.trim();
    if (handoff) {
      await this.oc
        .prompt({
          sessionID,
          directory: this.directory,
          agent: this.cfg.ASSISTANT_AGENT,
          model: this.chatModel(),
          noReply: true,
          variant: this.cfg.REASONING_VARIANT,
          parts: [
            {
              type: "text",
              text:
                `[${stamp()}]\n<system>Handoff you wrote at the end of your previous conversation (it was reset to keep context ` +
                `small; long-term facts are in your memory files):\n\n${truncate(handoff, 4000)}</system>`,
            },
          ],
        })
        .catch((err) => log.warn(`handoff not passed to the new session: ${(err as Error).message}`));
    }
    log.info(`main session rotated to ${sessionID}${handoff ? " with a handoff" : ""}`);
  }

  // ---- typing indicator ----

  private startTyping() {
    this.stopTyping();
    const started = Date.now();
    void this.chat.typing();
    this.typingTimer = setInterval(() => {
      if (Date.now() - started > 15 * 60_000) return this.stopTyping();
      void this.chat.typing();
    }, 4500);
  }

  private stopTyping() {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = undefined;
  }

  shutdown() {
    this.stopTyping();
    if (this.debounce) clearTimeout(this.debounce);
  }
}
