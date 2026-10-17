import { afterEach, describe, expect, it } from "vitest";
import { composeUpdateTurn, composeUserTurn, Conversation } from "../src/conversation.ts";
import type { UpdateRow } from "../src/db.ts";
import { FakeChat, FakeOpenCode, memoryStore, testConfig, tick } from "./fakes.ts";

function setup(opts: { quiet?: boolean } = {}) {
  const cfg = testConfig();
  const store = memoryStore();
  const oc = new FakeOpenCode();
  const chat = new FakeChat();
  let quiet = opts.quiet ?? false;
  const conv = new Conversation({ cfg, store, oc: oc.asOpenCode(), chat, isQuiet: () => quiet });
  return { cfg, store, oc, chat, conv, setQuiet: (q: boolean) => (quiet = q) };
}

let live: Conversation[] = [];
afterEach(() => {
  for (const c of live) c.shutdown();
  live = [];
});

describe("composing turns", () => {
  it("stamps the time and carries reply context", () => {
    const text = composeUserTurn([
      { text: "hey", at: new Date(2026, 9, 6, 14, 32) },
      { text: "this one", at: new Date(2026, 9, 6, 14, 33), replyTo: "the  scraper\nis done" },
    ]);
    expect(text).toBe('[Tue 6 Oct 2026, 14:33]\nhey\n(replying to: "the scraper is done")\nthis one');
  });

  it("tells the assistant which model it runs on", () => {
    expect(composeUserTurn([{ text: "what model are you?", at: new Date(2026, 9, 6, 17, 26) }], "crowbot/deepseek-v4.1-flash")).toBe(
      "[Tue 6 Oct 2026, 17:26 · you are running on crowbot/deepseek-v4.1-flash]\nwhat model are you?",
    );
  });

  it("wraps updates and tells the model it may stay quiet", () => {
    const u: UpdateRow = { id: 1, created_at: new Date(2026, 9, 6, 9, 0).getTime(), kind: "reminder", text: "call the bank", urgent: 1, delivered_at: null };
    const text = composeUpdateTurn([u], new Date(2026, 9, 6, 9, 1));
    expect(text).toContain('<update time="Tue 6 Oct 2026, 09:01">');
    expect(text).toContain("- [reminder, urgent · Tue 6 Oct 2026, 09:00] call the bank");
    expect(text).toContain("NO_REPLY");
  });
});

describe("Conversation", () => {
  it("merges a burst of messages into one prompt and shows typing", async () => {
    const { oc, chat, conv } = setup();
    live.push(conv);
    conv.onUserMessage({ text: "hey", at: new Date() });
    conv.onUserMessage({ text: "can you check something", at: new Date() });
    conv.onUserMessage({ text: "the disk usage", at: new Date() });
    await tick(60);
    expect(oc.prompts).toHaveLength(1);
    expect(oc.prompts[0]!.text).toMatch(/hey\ncan you check something\nthe disk usage$/);
    expect(oc.prompts[0]!.text).toContain("you are running on crowbot/deepseek-v4.1-flash");
    expect(oc.prompts[0]!.agent).toBe("assistant");
    expect(chat.typingCount).toBeGreaterThan(0);
  });

  it("queues messages while busy and delivers each reply exactly once", async () => {
    const { oc, chat, conv } = setup();
    live.push(conv);
    conv.onUserMessage({ text: "first", at: new Date() });
    await tick(40);
    const sid = oc.prompts[0]!.sessionID;

    conv.onUserMessage({ text: "second", at: new Date() });
    await tick(40);
    expect(oc.prompts).toHaveLength(1); // still busy with the first

    oc.reply(sid, "Answer to first");
    await conv.onMainIdle();
    expect(chat.sent.map((s) => s.text)).toEqual(["Answer to first"]);
    expect(oc.prompts).toHaveLength(2);
    expect(oc.prompts[1]!.text).toMatch(/second$/);

    await conv.onMainIdle(); // duplicate idle event
    expect(chat.sent).toHaveLength(1);
  });

  it("does not re-send old replies after a restart", async () => {
    const { cfg, store, oc, chat, conv } = setup();
    live.push(conv);
    conv.onUserMessage({ text: "hi", at: new Date() });
    await tick(40);
    oc.reply(oc.prompts[0]!.sessionID, "hello!");
    await conv.onMainIdle();
    expect(chat.sent).toHaveLength(1);

    const chat2 = new FakeChat();
    const restarted = new Conversation({ cfg, store, oc: oc.asOpenCode(), chat: chat2, isQuiet: () => false });
    live.push(restarted);
    await restarted.reconcile();
    expect(chat2.sent).toHaveLength(0);
  });

  it("feeds updates to the assistant and suppresses NO_REPLY", async () => {
    const { store, oc, chat, conv } = setup();
    live.push(conv);
    store.enqueueUpdate("task", "Task x finished (done).");
    await conv.pump();
    expect(oc.prompts).toHaveLength(1);
    expect(oc.prompts[0]!.text).toContain("<update");
    expect(store.pendingUpdates()).toHaveLength(0);

    oc.reply(oc.prompts[0]!.sessionID, "NO_REPLY");
    await conv.onMainIdle();
    expect(chat.sent).toHaveLength(0);
  });

  it("holds non-urgent updates during quiet hours but lets urgent ones through", async () => {
    const { store, oc, conv, setQuiet } = setup({ quiet: true });
    live.push(conv);
    store.enqueueUpdate("task", "routine news");
    await conv.pump();
    expect(oc.prompts).toHaveLength(0);

    store.enqueueUpdate("reminder", "take meds", true);
    await conv.pump();
    expect(oc.prompts).toHaveLength(1);
    expect(oc.prompts[0]!.text).toContain("take meds");
    expect(oc.prompts[0]!.text).not.toContain("routine news");

    oc.reply(oc.prompts[0]!.sessionID, "Reminder: take your meds 💊");
    await conv.onMainIdle();
    setQuiet(false);
    await conv.pump();
    expect(oc.prompts).toHaveLength(2);
    expect(oc.prompts[1]!.text).toContain("routine news");
  });

  it("reports model errors and keeps a failed user message for later", async () => {
    const { oc, chat, conv } = setup();
    live.push(conv);
    oc.failPrompts = true;
    conv.onUserMessage({ text: "are you there?", at: new Date() });
    await tick(40);
    expect(chat.sent.at(-1)!.text).toMatch(/can't reach my brain/);

    oc.failPrompts = false;
    await conv.pump();
    expect(oc.prompts).toHaveLength(1);
    expect(oc.prompts[0]!.text).toMatch(/are you there\?$/);

    oc.reply(oc.prompts[0]!.sessionID, "", { error: { name: "APIError", data: { message: "credit balance too low" } } });
    await conv.onMainIdle();
    expect(chat.sent.at(-1)!.text).toContain("credit balance too low");
  });
});

describe("Conversation notifications", () => {
  it("rings for urgent updates in quiet hours, stays silent for routine ones", async () => {
    const { store, oc, chat, conv } = setup({ quiet: true });
    live.push(conv);
    store.enqueueUpdate("notify", "[uptime] example.com is down", true);
    await conv.pump();
    oc.reply(oc.prompts[0]!.sessionID, "Heads up: example.com is down (503).");
    await conv.onMainIdle();
    expect(chat.sent.at(-1)!.opts?.silent).toBe(false);

    store.set("quiet.override", "on");
    store.enqueueUpdate("checkin", "Morning check-in", true);
    await conv.pump();
    oc.reply(oc.prompts[1]!.sessionID, "Morning! Two tasks still running.");
    await conv.onMainIdle();
    expect(chat.sent.at(-1)!.opts?.silent).toBe(false);
  });
});

describe("Conversation delivery edge cases", () => {
  it("sends nothing when the turn ends in NO_REPLY, even after narration", async () => {
    const { store, oc, chat, conv } = setup();
    live.push(conv);
    store.enqueueUpdate("checkin", "Morning check-in", true);
    await conv.pump();
    const sid = oc.prompts[0]!.sessionID;
    oc.reply(sid, "I'll check what's going on.");
    oc.reply(sid, "NO_REPLY");
    await conv.onMainIdle();
    expect(chat.sent).toHaveLength(0);
  });

  it("keeps going when Telegram refuses a message", async () => {
    const { oc, chat, conv } = setup();
    live.push(conv);
    conv.onUserMessage({ text: "first", at: new Date() });
    await tick(40);
    conv.onUserMessage({ text: "second", at: new Date() });
    await tick(40);
    chat.sendText = async () => {
      throw new Error("Call to 'sendMessage' failed! (400: Bad Request: chat not found)");
    };
    oc.reply(oc.prompts[0]!.sessionID, "reply to first");
    await conv.onMainIdle();
    expect(oc.prompts).toHaveLength(2); // the queued message still went out
  });

  it("hands clearly big work to a worker and still tells the assistant about it", async () => {
    const { oc } = setup();
    const briefs: string[] = [];
    const conv = new Conversation({
      cfg: testConfig(),
      store: memoryStore(),
      oc: oc.asOpenCode(),
      chat: new FakeChat(),
      isQuiet: () => false,
      delegate: async (_title, brief) => {
        briefs.push(brief);
        return { slug: "price-scraper" };
      },
    });
    live.push(conv);
    conv.onUserMessage({ text: "Build me a scraper for these three shops that saves prices to CSV, then set up a daily run with tests", at: new Date() });
    await tick(40);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toContain("User request:");
    expect(oc.prompts).toHaveLength(1); // the assistant sees the message too
    expect(oc.prompts[0]!.text).toContain('background task "price-scraper" was already started');
  });

  it("leaves everyday messages to the assistant, including multi-part ones", async () => {
    const { oc } = setup();
    let delegated = 0;
    const conv = new Conversation({
      cfg: testConfig(),
      store: memoryStore(),
      oc: oc.asOpenCode(),
      chat: new FakeChat(),
      isQuiet: () => false,
      delegate: async () => {
        delegated++;
        return { slug: "x" };
      },
    });
    live.push(conv);
    conv.onUserMessage({ text: "remind me tomorrow at 10 to call the bank and also buy milk", at: new Date() });
    await tick(40);
    expect(delegated).toBe(0);
    expect(oc.prompts).toHaveLength(1);
    expect(oc.prompts[0]!.text).not.toContain("background task");
  });

  it("falls back to the assistant when the automatic hand-off fails", async () => {
    const { oc } = setup();
    const conv = new Conversation({
      cfg: testConfig(),
      store: memoryStore(),
      oc: oc.asOpenCode(),
      chat: new FakeChat(),
      isQuiet: () => false,
      delegate: async () => {
        throw new Error("Already running 3 tasks");
      },
    });
    live.push(conv);
    conv.onUserMessage({ text: "Implement the export feature in the app, then write tests and also update the docs", at: new Date() });
    await tick(40);
    expect(oc.prompts).toHaveLength(1);
    expect(oc.prompts[0]!.text).not.toContain("background task");
  });

  it("retries once quietly after a provider hiccup, then explains if it fails again", async () => {
    const { cfg, store, oc, chat } = setup();
    const conv = new Conversation({ cfg, store, oc: oc.asOpenCode(), chat, isQuiet: () => false, retryDelayMs: 0 });
    live.push(conv);
    conv.onUserMessage({ text: "hello?", at: new Date() });
    await tick(40);
    const sid = oc.prompts[0]!.sessionID;
    const upstream = { name: "UnknownError", data: { message: '{"message":"The model provider returned an error. Please try again.","type":"upstream_error"}' } };
    oc.reply(sid, "", { error: upstream });
    await conv.onMainIdle();
    expect(chat.sent).toHaveLength(0); // nothing shown yet

    await conv.pump();
    expect(oc.prompts).toHaveLength(2);
    expect(oc.prompts[1]!.text).toContain("temporary error");
    oc.reply(sid, "", { error: upstream });
    await conv.onMainIdle();
    expect(chat.sent.at(-1)!.text).toContain("having trouble right now");
    await conv.pump();
    expect(oc.prompts).toHaveLength(2); // only one retry
  });

  it("tells the user once (not every tick) when the reasoning budget is spent", async () => {
    const { oc, chat, conv } = setup();
    live.push(conv);
    const original = oc.prompt.bind(oc);
    oc.prompt = async () => {
      throw new Error("Reasoning budget would be exceeded (5.00 + 0.01 of 5.00 USD)");
    };
    conv.onUserMessage({ text: "hi", at: new Date() });
    await tick(40);
    await conv.pump();
    await conv.pump();
    expect(chat.sent.filter((s) => s.text.includes("reasoning budget"))).toHaveLength(1);
    oc.prompt = original;
  });

  it("preserves maximum reasoning across a restart", async () => {
    const { cfg, store, oc, chat } = setup();
    const first = new Conversation({ cfg, store, oc: oc.asOpenCode(), chat, isQuiet: () => false });
    first.onUserMessage({ text: "hello", at: new Date() });
    await tick(40);
    expect(oc.prompts[0]!.variant).toBe("max");
    first.shutdown();
    const second = new Conversation({ cfg, store, oc: oc.asOpenCode(), chat: new FakeChat(), isQuiet: () => false });
    expect(store.turn(1)?.reasoning_variant).toBe("max");
    second.shutdown();
  });
});

describe("automatic fresh sessions", () => {
  const HOUR = 3_600_000;
  function aged(store: ReturnType<typeof memoryStore>, opts: { ageH: number; quietMin: number; userTurns?: number; context?: number }) {
    const now = Date.now();
    store.set("main.since", String(now - opts.ageH * HOUR));
    store.set("main.lastActivity", String(now - opts.quietMin * 60_000));
    store.set("main.userTurns", String(opts.userTurns ?? 3));
    store.set("main.contextTokens", String(opts.context ?? 20_000));
  }

  it("rotates only when the chat is old (or huge) and has been quiet for a while", async () => {
    const { store, oc, conv } = setup();
    live.push(conv);
    await conv.ensureMainSession();
    aged(store, { ageH: 1, quietMin: 60 });
    expect(conv.shouldAutoRotate()).toBe(false); // young
    aged(store, { ageH: 5, quietMin: 2 });
    expect(conv.shouldAutoRotate()).toBe(false); // mid-conversation
    aged(store, { ageH: 5, quietMin: 20, userTurns: 0 });
    expect(conv.shouldAutoRotate()).toBe(false); // nothing to compact
    aged(store, { ageH: 5, quietMin: 20 });
    expect(conv.shouldAutoRotate()).toBe(true);
    aged(store, { ageH: 1, quietMin: 20, context: 200_000 });
    expect(conv.shouldAutoRotate()).toBe(true); // context got big
    expect(oc.prompts).toHaveLength(0);
  });

  it("saves memory and a handoff, then continues in a fresh session seeded with it", async () => {
    const { store, oc, chat, conv } = setup();
    live.push(conv);
    const first = await conv.ensureMainSession();
    aged(store, { ageH: 5, quietMin: 20 });

    await conv.watchdog();
    expect(oc.prompts).toHaveLength(1);
    expect(oc.prompts[0]!.text).toContain("memory/profile.md"); // learn about the user before forgetting the chat
    expect(oc.prompts[0]!.text).toContain("memory/handoff.md");
    expect(oc.prompts[0]!.text).toContain("NO_REPLY");

    oc.files.set("memory/handoff.md", "We were planning the trip to Tampere; waiting on hotel prices.");
    oc.reply(first, "NO_REPLY");
    await conv.onMainIdle();

    const second = conv.sessionID!;
    expect(second).not.toBe(first);
    const seed = oc.prompts.at(-1)!;
    expect(seed.sessionID).toBe(second);
    expect(seed.noReply).toBe(true);
    expect(seed.text).toContain("trip to Tampere");
    expect(chat.sent).toHaveLength(0); // automatic resets are silent
    expect(conv.shouldAutoRotate()).toBe(false); // fresh session starts the clock over
  });

  it("starts /new as a clean chat and keeps the handoff on disk for later", async () => {
    const { oc, chat, conv } = setup();
    live.push(conv);
    const first = await conv.ensureMainSession();
    expect(await conv.requestNewSession()).toBe("ok");
    expect(chat.sent.at(-1)!.text).toContain("Saving where we left off"); // the save turn shows no typing
    const save = oc.prompts.at(-1)!;
    expect(save.sessionID).toBe(first);
    expect(save.text).toContain("memory/profile.md");
    expect(save.text).toContain("memory/handoff.md");

    oc.files.set("memory/handoff.md", "We were planning the trip to Tampere; waiting on hotel prices.");
    oc.reply(first, "NO_REPLY");
    await conv.onMainIdle();

    const second = conv.sessionID!;
    expect(second).not.toBe(first);
    expect(oc.prompts.filter((p) => p.sessionID === second)).toHaveLength(0); // nothing carried over
    expect(chat.sent.at(-1)!.text).toContain("New chat");
  });
});
