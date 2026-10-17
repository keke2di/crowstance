import crypto from "node:crypto";
import type { Store, OutboundChunkRow, OutboundEventRow } from "./db.ts";
import { logger, runWithCorrelation } from "./log.ts";
import type { Chat, SendOpts } from "./telegram/chat.ts";
import { validateCoordinates } from "./geocoder.ts";

const log = logger("delivery");
export type DeliveryState = "pending" | "sending" | "sent" | "retryable" | "failed" | "unknown";
export type DeliveryOptions = { owner?: string; leaseMs?: number; maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> };

export function backoff(attempt: number, base = 500, max = 60_000, random = Math.random) {
  const cap = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(cap * (0.75 + random() * 0.5));
}

export class Delivery {
  private readonly store: Store;
  private readonly chat: Chat;
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private stopping = false;
  private loopPromise: Promise<void> | undefined;
  /** Event IDs whose permanent failure was already surfaced to the owner (notify once). */
  private readonly notifiedFailures = new Set<string>();

  constructor(store: Store, chat: Chat, opts: DeliveryOptions = {}) {
    this.store = store;
    this.chat = chat;
    this.owner = opts.owner ?? crypto.randomUUID();
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.maxAttempts = opts.maxAttempts ?? 8;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.maxDelayMs = opts.maxDelayMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  recover() { this.store.recoverLeases(this.now()); }

  start() {
    if (this.loopPromise) return;
    this.stopping = false;
    this.loopPromise = this.runLoop();
  }

  async flush() { await this.processAvailable(); }

  async drain(timeoutMs = 10_000) {
    this.stopping = true;
    if (!this.loopPromise) await this.processAvailable();
    else await Promise.race([this.loopPromise, this.sleep(timeoutMs)]);
  }

  private async runLoop() {
    while (!this.stopping) {
      const worked = await this.processAvailable();
      if (!worked) await this.sleep(100);
    }
    await this.processAvailable();
  }

  private async processAvailable() {
    let worked = false;
    for (const chunk of this.store.readyChunks(this.now(), 20)) {
      worked = true;
      await this.deliverChunk(chunk);
    }
    return worked;
  }

  private async deliverChunk(chunk: OutboundChunkRow & { urgent: number }) {
    if (!this.store.claimChunk(chunk.event_id, chunk.seq, this.owner, this.leaseMs, this.now())) return;
    const event = this.store.outboundEvent(chunk.event_id);
    await runWithCorrelation(event?.correlation_id ?? undefined, () => this.sendChunk(chunk, event));
  }

  private async sendChunk(chunk: OutboundChunkRow & { urgent: number }, event: OutboundEventRow | undefined) {
    const opts: SendOpts = { silent: !chunk.urgent };
    let result;
    try {
      if (event?.kind === "location") {
        const payload = JSON.parse(chunk.payload) as { delivery: "location" | "venue"; latitude: number; longitude: number; name?: string; address?: string };
        validateCoordinates(payload);
        result = payload.delivery === "venue" && payload.name && payload.address
          ? await this.chat.sendVenue(payload.latitude, payload.longitude, payload.name, payload.address, opts)
          : await this.chat.sendLocation(payload.latitude, payload.longitude, opts);
      } else result = await this.chat.sendChunk(chunk.payload, opts);
    } catch (err) {
      result = { ok: false as const, kind: "ambiguous" as const, error: err instanceof Error ? err : new Error(String(err)) };
    }
    if (result.ok) {
      this.store.finishChunk(chunk.event_id, chunk.seq, "sent", { messageID: result.messageId, outcome: "sent" });
      return;
    }
    const attempts = this.store.outboundChunk(chunk.event_id, chunk.seq)?.attempts ?? chunk.attempts;
    if (result.kind === "permanent" || attempts >= this.maxAttempts) {
      this.store.finishChunk(chunk.event_id, chunk.seq, "failed", { failure: result.error.message, outcome: result.kind });
      log.error(`permanent Telegram delivery failure for ${chunk.event_id}/${chunk.seq}: ${result.error.message}`);
      if (!this.notifiedFailures.has(chunk.event_id)) {
        this.notifiedFailures.add(chunk.event_id);
        const preview = chunk.payload.length > 120 ? `${chunk.payload.slice(0, 120)}…` : chunk.payload;
        this.store.enqueueUpdate(
          "system",
          `⚠️ A message to you could not be delivered after ${attempts} attempts and was dropped (${result.error.message}). ` +
            `Content: "${preview.replace(/\n+/g, " ")}"`,
          true,
        );
      }
    } else {
      const state: DeliveryState = result.kind === "ambiguous" ? "unknown" : "retryable";
      this.store.finishChunk(chunk.event_id, chunk.seq, state, { failure: result.error.message, nextAttemptAt: this.now() + backoff(attempts, this.baseDelayMs, this.maxDelayMs), outcome: result.kind });
      log.warn(`Telegram delivery ${state} for ${chunk.event_id}/${chunk.seq}: ${result.error.message}`);
    }
  }
}
