import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fileStore() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowstance-m1-")); const store = new Store(path.join(dir, "ledger.db")); stores.push(store); return { store, file: path.join(dir, "ledger.db") }; }

describe("durable ledger", () => {
  it("runs versioned migrations on a file-backed database and recovers inbound rows", () => {
    const { store, file } = fileStore();
    const row = store.insertInbound({ text: "buffer me", receivedAt: 123, replyTo: "old" });
    expect(store.bufferedInbound().map((m) => m.text)).toEqual(["buffer me"]);
    store.close();
    const reopened = new Store(file); stores.push(reopened);
    expect(reopened.inbound(row.id)?.reply_to).toBe("old");
    expect((reopened.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version).toBe(8);
  });

  it("persists successful approval snapshot watermarks", () => {
    const { store } = fileStore();
    expect(store.approvalSnapshotCompleted("/p", "permission")).toBe(false);
    store.approvalSnapshot("/p", "permission", 42);
    expect(store.approvalSnapshotCompleted("/p", "permission")).toBe(true);
  });

  it("claims a chunk only once and persists successful Telegram ids", () => {
    const { store } = fileStore();
    store.enqueueOutbound({ id: "event-1", kind: "text", payload: { text: "hello" }, chunks: ["hello", "world"] });
    expect(store.claimChunk("event-1", 0, "a", 10_000)).toBe(true);
    expect(store.claimChunk("event-1", 0, "b", 10_000)).toBe(false);
    store.finishChunk("event-1", 0, "sent", { messageID: 77 });
    expect(store.outboundChunk("event-1", 0)?.telegram_message_id).toBe(77);
    expect(store.outboundEvent("event-1")?.state).toBe("pending");
  });

  it("recovers expired sending leases", () => {
    const { store } = fileStore();
    store.enqueueOutbound({ id: "event-2", kind: "text", payload: {}, chunks: ["x"] });
    const now = Date.now();
    expect(store.claimChunk("event-2", 0, "crashed", 1, now)).toBe(true);
    store.recoverLeases(now + 2);
    expect(store.outboundChunk("event-2", 0)?.state).toBe("retryable");
  });
});
