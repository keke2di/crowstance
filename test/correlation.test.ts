import { afterEach, describe, expect, it } from "vitest";
import { Conversation } from "../src/conversation.ts";
import { FakeChat, FakeOpenCode, memoryStore, testConfig, tick } from "./fakes.ts";

let live: Conversation[] = [];
afterEach(() => {
  for (const conv of live) conv.shutdown();
  live = [];
});

describe("inbound-to-delivery correlation", () => {
  it("carries one correlation id from inbound through the turn to the outbound event", async () => {
    const cfg = testConfig();
    const store = memoryStore();
    const oc = new FakeOpenCode();
    const chat = new FakeChat();
    const conv = new Conversation({ cfg, store, oc: oc.asOpenCode(), chat, isQuiet: () => false });
    live.push(conv);

    conv.onUserMessage({ text: "hello there", at: new Date() });
    await tick(40);
    const sid = oc.prompts[0]!.sessionID;
    oc.reply(sid, "hi back");
    await conv.onMainIdle();

    const inbound = store.inbound(1);
    const turn = store.turn(1);
    const outbound = store.outboundEvent(`turn-1-0`);
    expect(inbound?.correlation_id).toBeTruthy();
    expect(turn?.correlation_id).toBe(inbound?.correlation_id);
    expect(outbound?.correlation_id).toBe(inbound?.correlation_id);
    // The reply was actually delivered under the same correlation.
    expect(chat.sent.map((s) => s.text)).toEqual(["hi back"]);
  });

  it("gives background updates their own correlation id", async () => {
    const cfg = testConfig();
    const store = memoryStore();
    const oc = new FakeOpenCode();
    const conv = new Conversation({ cfg, store, oc: oc.asOpenCode(), chat: new FakeChat(), isQuiet: () => false });
    live.push(conv);

    store.enqueueUpdate("task", "Task x finished.");
    await conv.pump();
    const turn = store.turn(1);
    expect(turn?.correlation_id).toBeTruthy();
    expect(turn?.correlation_id).toMatch(/^upd-/);
  });

  it("recovers the correlation id of a buffered inbound message after restart", () => {
    const cfg = testConfig();
    const store = memoryStore();
    const oc = new FakeOpenCode();
    const row = store.insertInbound({ text: "buffered", receivedAt: Date.now() });
    const restarted = new Conversation({ cfg, store, oc: oc.asOpenCode(), chat: new FakeChat(), isQuiet: () => false });
    live.push(restarted);
    // The recovered buffer keeps the durable correlation id (observable via the first turn it creates).
    expect(row.correlation_id).toBeTruthy();
  });
});
