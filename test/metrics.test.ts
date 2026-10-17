import { describe, expect, it } from "vitest";
import { memoryStore } from "./fakes.ts";

describe("operational metrics", () => {
  it("reports pending-update queue age", () => {
    const store = memoryStore();
    const now = Date.now();
    const id = store.enqueueUpdate("task", "waiting");
    store.db.prepare("UPDATE updates SET created_at = ? WHERE id = ?").run(now - 12_000, id);
    const metrics = store.metrics(now);
    expect(metrics.updates.pending).toBe(1);
    expect(metrics.updates.oldestAgeMs).toBe(12_000);
  });

  it("counts delivery retries and outbound queue age", async () => {
    const store = memoryStore();
    const now = Date.now();
    store.enqueueOutbound({ id: "event", kind: "text", payload: {}, chunks: ["hi"] });
    store.db.prepare("UPDATE outbound_events SET created_at = ? WHERE id = 'event'").run(now - 4_000);
    store.db.prepare("UPDATE outbound_chunks SET next_attempt_at = ? WHERE event_id = 'event'").run(now - 4_000);
    store.claimChunk("event", 0, "worker", 1_000, now - 3_000);
    store.finishChunk("event", 0, "retryable", { failure: "503", nextAttemptAt: now - 2_000 });
    store.claimChunk("event", 0, "worker", 1_000, now - 1_000);
    store.finishChunk("event", 0, "sent", { messageID: 5 });

    const metrics = store.metrics(now);
    expect(metrics.outbound.retries).toBe(1);
    expect(metrics.outbound.sent).toBe(1);
    expect(metrics.outbound.pending).toBe(0);
  });

  it("reports spend for today and the month", () => {
    const store = memoryStore();
    const now = Date.now();
    store.recordSpend("m1", "s1", 0.5, now);
    store.recordSpend("m2", "s1", 1.25, now);
    const metrics = store.metrics(now);
    expect(metrics.spend.today).toBeCloseTo(1.75);
    expect(metrics.spend.month).toBeGreaterThanOrEqual(1.75);
  });
});
