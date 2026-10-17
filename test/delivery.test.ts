import { describe, expect, it } from "vitest";
import { Delivery } from "../src/delivery.ts";
import { FakeChat, memoryStore } from "./fakes.ts";

describe("delivery", () => {
  it("retries transient errors with bounded backoff", async () => {
    const store = memoryStore();
    const chat = new FakeChat();
    let calls = 0;
    chat.sendChunk = async () => calls++ === 0 ? { ok: false, kind: "transient", error: new Error("503") } : { ok: true, messageId: 12 };
    store.enqueueOutbound({ id: "retry", kind: "text", payload: {}, chunks: ["hello"] });
    // Capture the clock after enqueue so next_attempt_at is not a millisecond ahead.
    let now = Date.now();
    const delivery = new Delivery(store, chat, { now: () => now, baseDelayMs: 1, sleep: async () => {} });
    await delivery.flush();
    expect(store.outboundChunk("retry", 0)?.state).toBe("retryable");
    now += 2_000;
    await delivery.flush();
    expect(store.outboundChunk("retry", 0)?.state).toBe("sent");
    expect(calls).toBe(2);
  });

  it("marks timeout outcomes unknown and keeps them eligible for the duplicate-over-loss policy", async () => {
    const store = memoryStore();
    const chat = new FakeChat();
    chat.sendChunk = async () => ({ ok: false, kind: "ambiguous", error: new Error("request timeout") });
    store.enqueueOutbound({ id: "timeout", kind: "text", payload: {}, chunks: ["important"] });
    const now = Date.now();
    const delivery = new Delivery(store, chat, { now: () => now, baseDelayMs: 1, sleep: async () => {} });
    await delivery.flush();
    expect(store.outboundChunk("timeout", 0)?.state).toBe("unknown");
    expect(store.outboundChunk("timeout", 0)?.failure).toContain("timeout");
  });

  it("delivers partial multi-chunk events independently and drains", async () => {
    const store = memoryStore();
    const chat = new FakeChat();
    let calls = 0;
    chat.sendChunk = async () => ({ ok: true, messageId: ++calls });
    store.enqueueOutbound({ id: "partial", kind: "text", payload: {}, chunks: ["one", "two", "three"] });
    const delivery = new Delivery(store, chat);
    delivery.start();
    await delivery.drain(1000);
    expect(store.outboundEvent("partial")?.state).toBe("sent");
    expect(store.outboundChunk("partial", 0)?.telegram_message_id).toBe(1);
    expect(store.outboundChunk("partial", 2)?.telegram_message_id).toBe(3);
    store.close();
  });

  it("delivers a location payload through the same durable ledger", async () => {
    const store = memoryStore();
    const chat = new FakeChat();
    store.enqueueLocation({ id: "location", payload: { delivery: "location", latitude: 0, longitude: 180, name: "Dateline" } });
    await new Delivery(store, chat).flush();
    expect(chat.locations).toEqual([{ latitude: 0, longitude: 180, opts: { silent: true } }]);
    expect(store.outboundChunk("location", 0)?.telegram_message_id).toBe(100);
    expect(store.outboundEvent("location")?.state).toBe("sent");
  });

  it("uses venue delivery only for verified name and address", async () => {
    const store = memoryStore();
    const chat = new FakeChat();
    store.enqueueLocation({ id: "venue", payload: { delivery: "venue", latitude: 1.5, longitude: 2.5, name: "Cafe", address: "Main Street 1" } });
    await new Delivery(store, chat).flush();
    expect(chat.venues[0]).toMatchObject({ latitude: 1.5, longitude: 2.5, title: "Cafe", address: "Main Street 1" });
  });
});
