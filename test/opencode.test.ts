import { describe, expect, it } from "vitest";
import { isClearlyBigRequest, reserveReasoning } from "../src/reasoning.ts";
import { entryName, isAbortError, lastReply, OpenCode } from "../src/opencode.ts";
import { messageText } from "../src/opencode.ts";
import { assistantMessage, memoryStore, testConfig } from "./fakes.ts";

/** Run `fn` against an OpenCode client whose fetch records requests and answers with `reply`. */
async function recording(reply: unknown, fn: (oc: OpenCode) => Promise<unknown>) {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    seen.push({ method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const out = await fn(new OpenCode({ url: "http://127.0.0.1:1", username: "test" }));
    return { seen, out };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("OpenCode 2 adapter", () => {
  it("reads the newest messages (desc) and returns them oldest first", async () => {
    const { seen, out } = await recording({ data: [{ id: "m3" }, { id: "m2" }], cursor: { previous: null, next: null } }, (oc) => oc.messages("ses", "/p", 2));
    expect(seen[0]!.url).toContain("limit=2");
    expect(seen[0]!.url).toContain("order=desc");
    expect((out as { id: string }[]).map((m) => m.id)).toEqual(["m2", "m3"]);
  });

  it("creates a child session with its model and effort, since OpenCode ignores an agent's own model", async () => {
    const { seen } = await recording({ data: { id: "ses_child" } }, (oc) =>
      oc.createSession({ directory: "/home", title: "t", agent: "explore", parentID: "ses_main", model: { providerID: "crowbot", modelID: "kimi-k3", variant: "low" } }),
    );
    expect(seen[0]!.body).toMatchObject({ agent: "explore", parentID: "ses_main", model: { id: "kimi-k3", providerID: "crowbot", variant: "low" }, location: { directory: "/home" } });
  });

  it("switches model with the effort variant before prompting", async () => {
    const { seen } = await recording({ data: {} }, (oc) =>
      oc.prompt({ sessionID: "ses", directory: "/p", model: { providerID: "crowbot", modelID: "gpt-6.1-sol" }, variant: "high", parts: [{ type: "text", text: "hi" }] }),
    );
    expect(seen.map((s) => s.url.replace("http://127.0.0.1:1", "").split("?")[0])).toEqual(["/api/session/ses/model", "/api/session/ses/prompt"]);
    expect(seen[0]!.body).toEqual({ model: { id: "gpt-6.1-sol", providerID: "crowbot", variant: "high" } });
  });

  it("calls a session busy while a run is in progress, though its inbox is already empty", async () => {
    const realFetch = globalThis.fetch;
    let newest: { type: string } | undefined;
    let queued: unknown[] = [];
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      const body = u.includes("/inbox") ? { data: queued } : { data: newest ? [newest] : [], cursor: { previous: null, next: null } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const oc = new OpenCode({ url: "http://127.0.0.1:1", username: "test" });
      newest = { type: "assistant" }; // mid-run (e.g. waiting on a long tool call)
      expect(await oc.sessionStatus("ses", "/p")).toEqual({ type: "busy" });
      newest = { type: "idle" }; // every finished run ends with an idle entry
      expect(await oc.sessionStatus("ses", "/p")).toEqual({ type: "idle" });
      queued = [{ id: "inb_1" }]; // a prompt waiting to be delivered
      expect(await oc.sessionStatus("ses", "/p")).toEqual({ type: "busy" });
      queued = [];
      newest = undefined; // never prompted
      expect(await oc.sessionStatus("ses", "/p")).toEqual({ type: "idle" });
      newest = { type: "assistant", finish: "error", error: { type: "aborted" }, time: { created: 1, completed: 2 } } as never; // a denied permission ends the run with no idle entry
      expect(await oc.sessionStatus("ses", "/p")).toEqual({ type: "idle" });
      newest = { type: "assistant", finish: "tool-calls", time: { created: 1, completed: 2 } } as never; // between steps: more is coming
      expect(await oc.sessionStatus("ses", "/p")).toEqual({ type: "busy" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("treats both v1 and v2 interrupts as aborts, not failures", () => {
    expect(isAbortError("aborted: Step interrupted")).toBe(true);
    expect(isAbortError("MessageAbortedError: aborted")).toBe(true);
    expect(isAbortError("ProviderError: overloaded")).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });

  it("names directory entries listed with a trailing separator", () => {
    expect(entryName({ path: "memory\\", type: "directory" })).toBe("memory");
    expect(entryName({ path: "projects/x/.git/", type: "directory" })).toBe(".git");
    expect(entryName({ path: "AGENTS.md", type: "file" })).toBe("AGENTS.md");
  });

  it("takes a run's answer from the last assistant message that has text", () => {
    const words = assistantMessage("s", "Here is what I found.");
    const toolsOnly = assistantMessage("s", "");
    expect(lastReply([words, toolsOnly]).text).toBe("Here is what I found.");
    expect(lastReply([toolsOnly]).text).toBe("");
  });
});

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
      // Most v2 routes read location[directory]; GET /api/session reads directory. Both are sent.
      expect(seen[0]!.url).toBe("http://127.0.0.1:1/api/session/ses/prompt?directory=%2Fproject&location%5Bdirectory%5D=%2Fproject");
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
