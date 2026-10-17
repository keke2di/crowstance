import { describe, expect, it } from "vitest";
import { memoryStore } from "./fakes.ts";

describe("bounded retention", () => {
  it("prunes terminal history but never pending work, however old", () => {
    const store = memoryStore();
    const now = Date.now();
    const old = now - 90 * 86_400_000;

    // Pending work (must survive).
    const pendingUpdate = store.enqueueUpdate("task", "still pending");
    store.db.prepare("UPDATE updates SET created_at = ? WHERE id = ?").run(old, pendingUpdate);
    const buffered = store.insertInbound({ text: "not consumed", receivedAt: old });
    store.enqueueOutbound({ id: "pending-out", kind: "text", payload: {}, chunks: ["unsent"] });
    store.db.prepare("UPDATE outbound_events SET created_at = ? WHERE id = 'pending-out'").run(old);
    store.insertApproval({ request_id: "ap-open", kind: "permission", session_id: "s", directory: "/p", payload: "{}" });
    store.db.prepare("UPDATE approvals SET created_at = ? WHERE request_id = 'ap-open'").run(old);
    const pendingTurn = store.createTurn("user", false, "s");
    store.db.prepare("UPDATE turns SET created_at = ? WHERE id = ?").run(old, pendingTurn.id);

    // Terminal history (must be pruned).
    const deliveredUpdate = store.enqueueUpdate("task", "delivered");
    store.markUpdatesDelivered([deliveredUpdate]);
    store.db.prepare("UPDATE updates SET delivered_at = ? WHERE id = ?").run(old, deliveredUpdate);
    const consumed = store.insertInbound({ text: "consumed", receivedAt: old });
    store.markInboundConsumed([consumed.id]);
    store.db.prepare("UPDATE inbound_messages SET consumed_at = ? WHERE id = ?").run(old, consumed.id);
    store.enqueueOutbound({ id: "sent-out", kind: "text", payload: {}, chunks: ["sent"] });
    store.db.prepare("UPDATE outbound_chunks SET next_attempt_at = ? WHERE event_id = 'sent-out'").run(old);
    store.claimChunk("sent-out", 0, "w", 1_000, old);
    store.finishChunk("sent-out", 0, "sent", { messageID: 1 });
    store.db.prepare("UPDATE delivery_attempts SET finished_at = ? WHERE event_id = 'sent-out'").run(old);
    store.db.prepare("UPDATE outbound_events SET completed_at = ? WHERE id = 'sent-out'").run(old);
    store.insertApproval({ request_id: "ap-done", kind: "question", session_id: "s", directory: "/p", payload: "{}" });
    store.updateApproval("ap-done", { resolved_at: old, resolution: "answered" });
    const doneTurn = store.createTurn("update", false, "s");
    store.updateTurn(doneTurn.id, "done", "s");
    store.db.prepare("UPDATE turns SET completed_at = ? WHERE id = ?").run(old, doneTurn.id);

    const deleted = store.applyRetention({ updatesBefore: now, inboundBefore: now, outboundBefore: now, approvalsBefore: now, turnsBefore: now, attemptsBefore: now });

    expect(deleted).toEqual({ updates: 1, inbound: 1, outbound: 1, approvals: 1, turns: 1, attempts: 1 });
    // Pending work survives regardless of age.
    expect(store.pendingUpdates().map((u) => u.id)).toEqual([pendingUpdate]);
    expect(store.bufferedInbound().map((m) => m.id)).toEqual([buffered.id]);
    expect(store.outboundEvent("pending-out")).toBeTruthy();
    expect(store.outboundChunk("pending-out", 0)?.state).toBe("pending");
    expect(store.approval("ap-open")).toBeTruthy();
    expect(store.turn(pendingTurn.id)).toBeTruthy();
    // Terminal history is gone.
    expect(store.outboundEvent("sent-out")).toBeUndefined();
    expect(store.approval("ap-done")).toBeUndefined();
    expect(store.turn(doneTurn.id)).toBeUndefined();
  });
});
