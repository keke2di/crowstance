import { describe, expect, it } from "vitest";
import { isClearlyBigRequest, reserveReasoning } from "../src/reasoning.ts";
import { OpenCode } from "../src/opencode.ts";
import { messageText } from "../src/opencode.ts";
import { memoryStore, testConfig } from "./fakes.ts";

describe("M5 reasoning contract", () => {
  it("sends prompts to the v2 prompt endpoint", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      seen.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify({ data: { id: "msg_1", sessionID: "ses", type: "user" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const oc = new OpenCode({ url: "http://127.0.0.1:1", username: "test" });
      await oc.prompt({ sessionID: "ses", directory: "/project", parts: [{ type: "text", text: "hello" }] });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe("http://127.0.0.1:1/api/session/ses/prompt?directory=%2Fproject");
      expect(seen[0]!.body).toEqual({ text: "hello" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("hands off only clearly big build work; chat, questions and reminders stay with the assistant", () => {
    const big = [
      "Build me a scraper for these three shops that saves prices to CSV, then set up a daily run with tests",
      "Implement the new export feature in the app, then write tests and also update the docs",
      "Refactor the bot's database layer: move the queries into a module; add migrations; finally deploy it",
    ];
    const small = [
      "write me a short poem about crows and then make it rhyme",
      "remind me tomorrow at 10 to call the bank and also buy milk",
      "whats the time and what model are you?",
      "can you fix the typo on my site",
      "research the best vps providers and compare prices",
      "how would you build a scraper and then deploy it?",
      "hey whats the weather like and should i take an umbrella?",
    ];
    for (const m of big) expect(isClearlyBigRequest(m), m).toBe(true);
    for (const m of small) expect(isClearlyBigRequest(m), m).toBe(false);
  });

  it("accounts reasoning reservations as output cost", () => {
    const store = memoryStore();
    const cfg = testConfig({ REASONING_DAILY_BUDGET_USD: "1" });
    reserveReasoning(store, cfg, "r1", "s1", "chat", "x".repeat(1000));
    expect(store.reasoningSpendSince(0)).toBeGreaterThan(0);
    expect(store.reasoningUsageSince(0)[0]).toMatchObject({ scope: "chat", variant: "default" });
  });

  it("blocks new work at the configured daily reasoning threshold", () => {
    const store = memoryStore();
    const cfg = testConfig({ REASONING_DAILY_BUDGET_USD: "0.3" });
    reserveReasoning(store, cfg, "chat", "chat-session", "chat", "x".repeat(100_000));
    expect(() => reserveReasoning(store, cfg, "worker", "worker-session", "worker", "x".repeat(100_000))).toThrow(/budget would be exceeded/);
  });

  it("does not expose reasoning content in delivered text", () => {
    expect(
      messageText({
        id: "m1",
        type: "assistant",
        agent: "assistant",
        model: { id: "m", providerID: "p" },
        time: { created: 1, completed: 2 },
        content: [
          { type: "reasoning", text: "private trace" },
          { type: "text", text: "public answer" },
        ],
      }),
    ).toBe("public answer");
  });
});
