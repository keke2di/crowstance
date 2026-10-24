import { describe, expect, it } from "vitest";
import { Catalog } from "../src/catalog.ts";
import { BudgetError } from "../src/errors.ts";
import { Limits } from "../src/limits.ts";
import { crowbotListing, FakeOpenCode, fakeFetch, memoryStore, testConfig } from "./fakes.ts";

const tokens = (input: number, output: number) => ({ input, output, reasoning: 0, cache: { read: 0, write: 0 } });

function setup(env: Record<string, string> = {}) {
  const cfg = testConfig(env);
  const store = memoryStore();
  return { cfg, store, limits: new Limits({ cfg, store }) };
}

describe("caps", () => {
  it("lets /limits tighten a cap and relax it back, never past the env ceiling", () => {
    const { limits } = setup({ DAILY_BUDGET_USD: "10" });
    expect(limits.get("daily")).toBe(10);
    expect(limits.set("daily", 4)).toEqual({ value: 4, clamped: false });
    expect(limits.get("daily")).toBe(4);
    expect(limits.set("daily", 50)).toEqual({ value: 10, clamped: true });
    expect(limits.get("daily")).toBe(10);
    limits.set("daily", 3);
    expect(limits.set("daily", undefined).value).toBe(10);
  });

  it("treats the balance floor the other way round: it can only go up", () => {
    const { limits } = setup({ BALANCE_FLOOR_USD: "2" });
    expect(limits.set("floor", 1)).toEqual({ value: 2, clamped: true });
    expect(limits.set("floor", 5).value).toBe(5);
    expect(limits.get("floor")).toBe(5);
  });

  it("refuses counts that aren't whole numbers", () => {
    const { limits } = setup();
    expect(() => limits.set("concurrent", 1.5)).toThrow(/whole number/);
  });

  it("refuses new work at the daily and monthly budgets, and a delegation whose cap won't fit", () => {
    const { store, limits } = setup({ DAILY_BUDGET_USD: "2", SUBAGENT_DAILY_BUDGET_USD: "1" });
    limits.preflight("chat");
    store.recordSpend("a", "ses_x", 1.8, Date.now());
    expect(() => limits.preflight("subagent", 0.5)).toThrow(BudgetError);
    limits.preflight("worker");
    store.recordSpend("b", "ses_x", 0.3, Date.now());
    expect(() => limits.preflight("chat")).toThrow(/Daily budget reached/);
  });

  it("stops new background work below the balance floor, but not the chat", async () => {
    const { cfg, store } = setup({ BALANCE_FLOOR_USD: "1" });
    const limits = new Limits({ cfg, store, balance: async () => 0.4 });
    await limits.refreshBalance();
    expect(limits.balance()).toBe(0.4);
    limits.preflight("chat");
    expect(() => limits.preflight("worker")).toThrow(/below the \$1.00 floor/);
  });
});

describe("live usage", () => {
  it("records only the increase of OpenCode's running totals", () => {
    const { store, limits } = setup();
    limits.recordUsage("ses_1", 0.02, tokens(1000, 500), 1);
    limits.recordUsage("ses_1", 0.022, tokens(2000, 1000), 2);
    limits.recordUsage("ses_1", 0.022, tokens(2000, 1000), 3); // repeated total: nothing new
    expect(store.spendSince(0)).toBeCloseTo(0.022, 9);
    expect(store.sessionSpend("ses_1")).toBeCloseTo(0.022, 9);
  });

  it("prices the token increase with crowbot's catalog when that is higher than OpenCode's figure", async () => {
    const cfg = testConfig({ CROWBOT_API_KEY: "k" });
    const store = memoryStore();
    const oc = new FakeOpenCode();
    const catalog = new Catalog({ cfg, store, oc: oc.asOpenCode(), fetchImpl: fakeFetch(crowbotListing([{ id: "kimi-k3", input: 1, output: 2 }])) });
    await catalog.refresh();
    const limits = new Limits({ cfg, store, catalog, modelFor: () => "crowbot/kimi-k3" });
    // OpenCode says $0 (stale price); crowbot's prices say 1M in + 1M out = $3.
    limits.recordUsage("ses_1", 0, tokens(1_000_000, 1_000_000), 1);
    expect(store.sessionSpend("ses_1")).toBeCloseTo(3, 9);
  });

  it("reports a task over its cap, a delegation over its call cap and the turn over its cap", () => {
    const { store, limits } = setup({ TASK_MAX_USD: "1", SUBAGENT_CALL_MAX_USD: "0.5", SUBAGENT_TURN_MAX_USD: "0.8" });
    store.insertTask({ slug: "t", title: "t", brief: "b", directory: "/p", session_id: "ses_task", state: "running", model: null, job: null, created_at: Date.now() });
    expect(limits.recordUsage("ses_task", 0.5, tokens(1, 1)).breaches).toEqual([]);
    expect(limits.recordUsage("ses_task", 1.2, tokens(2, 2)).breaches.map((b) => b.cap)).toEqual(["task"]);

    const a = store.insertSubagentRun({ parent_session: "ses_main", turn_id: 7, kind: "explore", prompt: "p", model: null, effort: null, model_from: null });
    const b = store.insertSubagentRun({ parent_session: "ses_main", turn_id: 7, kind: "explore", prompt: "p", model: null, effort: null, model_from: null });
    store.updateSubagentRun(a.id, { session_id: "ses_a" });
    store.updateSubagentRun(b.id, { session_id: "ses_b" });
    limits.recordUsage("ses_a", 0.45, tokens(1, 1));
    const over = limits.recordUsage("ses_b", 0.4, tokens(1, 1)).breaches;
    expect(over).toContainEqual(expect.objectContaining({ cap: "turn", turnID: 7 }));
    expect(limits.recordUsage("ses_a", 0.6, tokens(2, 2)).breaches).toContainEqual(expect.objectContaining({ cap: "call", runID: a.id }));
  });

  it("reports the daily budget, and says so once a day", () => {
    const { limits } = setup({ DAILY_BUDGET_USD: "1" });
    expect(limits.recordUsage("ses_main", 1.5, tokens(1, 1)).breaches.map((b) => b.cap)).toEqual(["daily"]);
    expect(limits.firstTrip("daily")).toBe(true);
    expect(limits.firstTrip("daily")).toBe(false);
  });

  it("caps a kind's call at the stricter of its own cap and the global one", () => {
    const { limits } = setup({ SUBAGENT_CALL_MAX_USD: "0.5" });
    expect(limits.callCap()).toBe(0.5);
  });
});
