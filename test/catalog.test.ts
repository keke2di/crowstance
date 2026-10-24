import { describe, expect, it } from "vitest";
import { blendedPrice, Catalog, costOf } from "../src/catalog.ts";
import { crowbotListing, FakeOpenCode, fakeFetch, memoryStore, testConfig } from "./fakes.ts";

const listing = crowbotListing([
  { id: "deepseek-v4.1-flash", input: 0.03, output: 0.12 },
  { id: "gpt-6.1-sol", input: 0.14, output: 0.7 },
  { id: "kimi-k3", input: 0.27, output: 1.35 },
  { id: "gemini-4-argon", input: 0.3, output: 1.5 }, // crowbot serves it, OpenCode can't run it yet
]);

describe("model catalog", () => {
  it("is crowbot's models that OpenCode can run, priced by crowbot, cheapest first", async () => {
    const oc = new FakeOpenCode();
    const catalog = new Catalog({ cfg: testConfig({ CROWBOT_API_KEY: "k" }), store: memoryStore(), oc: oc.asOpenCode(), fetchImpl: fakeFetch(listing) });
    expect(await catalog.refresh()).toEqual({ ok: true });
    expect(catalog.usable().map((m) => m.id)).toEqual(["deepseek-v4.1-flash", "gpt-6.1-sol", "kimi-k3"]);
    expect(catalog.get("crowbot/gpt-6.1-sol")!.price).toMatchObject({ input: 0.14, output: 0.7 });
    expect(catalog.get("kimi-k3")!.efforts).toEqual(["low", "medium", "high"]);
    // crow-2 is in opencode.json but crowbot no longer serves it, so it isn't usable.
    expect(catalog.get("crowbot/crow-2")).toBeUndefined();
  });

  it("reports drift: models OpenCode lacks and stale opencode.json prices", async () => {
    const oc = new FakeOpenCode();
    const catalog = new Catalog({ cfg: testConfig({ CROWBOT_API_KEY: "k" }), store: memoryStore(), oc: oc.asOpenCode(), fetchImpl: fakeFetch(listing) });
    await catalog.refresh();
    const drift = catalog.drift();
    expect(drift.missing).toEqual(["gemini-4-argon"]);
    expect(drift.prices.map((p) => p.id).sort()).toEqual(["deepseek-v4.1-flash", "gpt-6.1-sol"]);
  });

  it("keeps the last good catalog when crowbot fails, across restarts", async () => {
    const store = memoryStore();
    const oc = new FakeOpenCode();
    const cfg = testConfig({ CROWBOT_API_KEY: "k" });
    await new Catalog({ cfg, store, oc: oc.asOpenCode(), fetchImpl: fakeFetch(listing) }).refresh();

    const later = new Catalog({ cfg, store, oc: oc.asOpenCode(), fetchImpl: fakeFetch({ error: "down" }, 503) });
    const res = await later.refresh();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("HTTP 503");
    expect(later.usable()).toHaveLength(3);
    expect(later.hasCrowbot()).toBe(true);
  });

  it("refuses an empty or malformed listing instead of wiping the catalog", async () => {
    const store = memoryStore();
    const oc = new FakeOpenCode();
    const cfg = testConfig({ CROWBOT_API_KEY: "k" });
    await new Catalog({ cfg, store, oc: oc.asOpenCode(), fetchImpl: fakeFetch(listing) }).refresh();
    const empty = new Catalog({ cfg, store, oc: oc.asOpenCode(), fetchImpl: fakeFetch({ data: [] }) });
    expect((await empty.refresh()).error).toContain("empty model list");
    expect(empty.usable()).toHaveLength(3);
    const junk = new Catalog({ cfg, store, oc: oc.asOpenCode(), fetchImpl: fakeFetch({ data: [{ id: "x" }] }) });
    expect((await junk.refresh()).error).toContain("unexpected catalog shape");
  });

  it("falls back to OpenCode's own list and prices without a crowbot key", async () => {
    const oc = new FakeOpenCode();
    const catalog = new Catalog({ cfg: testConfig(), store: memoryStore(), oc: oc.asOpenCode() });
    await catalog.refresh();
    expect(catalog.hasCrowbot()).toBe(false);
    expect(catalog.usable().map((m) => m.id)).toEqual(["deepseek-v4.1-flash", "gpt-6.1-sol", "kimi-k3", "crow-2"]);
    expect(catalog.get("crowbot/crow-2")).toMatchObject({ source: "opencode", price: { input: 5, output: 5 }, toolCalling: true, reasoning: true });
    expect(catalog.runnable()).toContain("anthropic/claude-opus-5-5");
  });

  it("prices tokens with reasoning billed as output", () => {
    const m = { price: { input: 1, cached: 0.1, output: 2 } };
    expect(blendedPrice(m)).toBe(1.25);
    expect(costOf(m, { input: 1_000_000, output: 250_000, reasoning: 250_000, cache: { read: 1_000_000, write: 0 } })).toBeCloseTo(1 + 0.1 + 1, 6);
  });
});
