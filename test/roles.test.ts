import { describe, expect, it } from "vitest";
import { Catalog } from "../src/catalog.ts";
import { UserError } from "../src/errors.ts";
import { Kinds, type PolicyFile } from "../src/kinds.ts";
import { Roles } from "../src/roles.ts";
import { crowbotListing, FakeOpenCode, fakeFetch, memoryStore, testConfig } from "./fakes.ts";

const listing = crowbotListing([
  { id: "deepseek-v4.1-flash", input: 0.03, output: 0.12 },
  { id: "gpt-6.1-sol", input: 0.14, output: 0.7 },
  { id: "kimi-k3", input: 0.27, output: 1.35 },
  { id: "crow-2", input: 3.5, output: 5 },
]);

const policy: PolicyFile = {
  every: { model: "crowbot/gpt-6.1-sol", effort: "medium" },
  workers: { model: "crowbot/kimi-k3", effort: "high" },
  kinds: { explore: { effort: "low" }, analyst: { model: "crowbot/kimi-k3", effort: "high" } },
};

async function setup(env: Record<string, string> = {}, p: PolicyFile = policy, models = listing) {
  const cfg = testConfig({ CROWBOT_API_KEY: "k", ...env });
  const store = memoryStore();
  const oc = new FakeOpenCode();
  const catalog = new Catalog({ cfg, store, oc: oc.asOpenCode(), fetchImpl: fakeFetch(models) });
  const kinds = new Kinds({ cfg, oc: oc.asOpenCode(), policy: p, retryDelaysMs: [] });
  await Promise.all([catalog.refresh(), kinds.refresh()]);
  return { cfg, store, oc, catalog, kinds, roles: new Roles({ cfg, store, catalog, kinds }) };
}

describe("roles resolver", () => {
  it("lists the chat, all subagents, each discovered kind, then the workers", async () => {
    const { roles } = await setup();
    expect(roles.ids()).toEqual(["chat", "every", "explore", "analyst", "workers"]);
  });

  it("gives a kind its own model and effort, else the default for all subagents", async () => {
    const { roles } = await setup();
    expect(roles.resolve("analyst")).toMatchObject({ ref: "crowbot/kimi-k3", effort: "high", source: "policy", from: "config/kinds.json" });
    // explore has its own effort but no model of its own, so the model comes from `every`.
    expect(roles.resolve("explore")).toMatchObject({ ref: "crowbot/gpt-6.1-sol", effort: "low", source: "every-policy" });
    expect(roles.resolve("explore").model).toEqual({ providerID: "crowbot", modelID: "gpt-6.1-sol", variant: "low" });
    expect(roles.resolve("every")).toMatchObject({ ref: "crowbot/gpt-6.1-sol", effort: "medium" });
    expect(roles.resolve("workers")).toMatchObject({ ref: "crowbot/kimi-k3", effort: "high", source: "policy" });
  });

  it("follows the call, your pick for the kind, the kind's entry, your pick for all, then the `every` default", async () => {
    const { roles } = await setup();
    roles.setModel("every", "crowbot/deepseek-v4.1-flash");
    expect(roles.resolve("explore")).toMatchObject({ ref: "crowbot/deepseek-v4.1-flash", source: "every-pin", from: "your pick for all subagents" });
    expect(roles.resolve("analyst").ref).toBe("crowbot/kimi-k3"); // its own entry beats the all-subagents pick
    roles.setModel("analyst", "crowbot/gpt-6.1-sol");
    expect(roles.resolve("analyst")).toMatchObject({ ref: "crowbot/gpt-6.1-sol", source: "pin", from: "your pick" });
    expect(roles.resolve("analyst", "crowbot/deepseek-v4.1-flash")).toMatchObject({ source: "call" });
    roles.setModel("analyst", undefined);
    roles.setModel("every", undefined);
    expect(roles.resolve("explore").source).toBe("every-policy");
  });

  it("inherits effort along the same chain", async () => {
    const { roles } = await setup();
    roles.setEffort("every", "high");
    expect(roles.resolve("explore").effort).toBe("low"); // the kind's own effort wins
    roles.setEffort("explore", "medium");
    expect(roles.resolve("explore").effort).toBe("medium");
    expect(() => roles.setEffort("explore", "max")).toThrow(/Effort is one of/);
  });

  it("falls back to the chat's model when nothing names one", async () => {
    const { roles } = await setup({}, { kinds: { explore: { effort: "low" } } });
    expect(roles.resolve("explore")).toMatchObject({ ref: "crowbot/deepseek-v4.1-flash", source: "chat", from: "same as the chat", effort: "low" });
  });

  it("never falls back silently: unknown, unusable or over-ceiling models are refused", async () => {
    const { roles } = await setup();
    expect(() => roles.resolve("explore", "crowbot/nope")).toThrow(/isn't usable/);
    expect(() => roles.resolve("explore", "crowbot/crow-2")).toThrow(/over the \$2\/1M ceiling/);
    expect(() => roles.setModel("every", "crowbot/crow-2")).toThrow(UserError);
    expect(() => roles.resolve("nobody")).toThrow(/No subagent kind "nobody"/);
    expect(() => roles.resolve("explore", "kimi-k3")).toThrow(/provider\/model/);
  });

  it("refuses a configured default that went bad instead of quietly using another", async () => {
    const { roles } = await setup({}, { every: { model: "crowbot/crow-2" } });
    expect(roles.describe("explore")).toMatch(/^⚠️ crowbot\/crow-2 \(config\/kinds.json \(all subagents\)\) costs/);
  });

  it("lets WORKER_MODEL override the workers' entry", async () => {
    const { roles } = await setup({ WORKER_MODEL: "crowbot/gpt-6.1-sol" });
    expect(roles.resolve("workers")).toMatchObject({ ref: "crowbot/gpt-6.1-sol", source: "env", effort: "high" });
  });

  it("drops effort for a model that doesn't reason", async () => {
    const models = crowbotListing([{ id: "gpt-6.1-sol", input: 0.14, output: 0.7, reasoning: false }, { id: "deepseek-v4.1-flash", input: 0.03, output: 0.12 }]);
    const { roles } = await setup({}, policy, models);
    const r = roles.resolve("explore");
    expect(r.ref).toBe("crowbot/gpt-6.1-sol");
    expect(r.effort).toBeUndefined();
    expect(r.model?.variant).toBeUndefined();
  });

  it("resolves the chat from your pick, CHAT_MODEL, then the assistant agent's model, with no ceiling", async () => {
    const a = await setup();
    expect(a.roles.resolve("chat")).toMatchObject({ ref: "crowbot/deepseek-v4.1-flash", source: "agent" });
    a.roles.setModel("chat", "anthropic/claude-opus-5-5");
    expect(a.roles.resolve("chat")).toMatchObject({ ref: "anthropic/claude-opus-5-5", source: "pin" });
    expect(() => a.roles.setModel("chat", "nobody/none")).toThrow(/Unknown model/);
    const b = await setup({ CHAT_MODEL: "crowbot/kimi-k3" });
    expect(b.roles.resolve("chat")).toMatchObject({ ref: "crowbot/kimi-k3", source: "env" });
  });

  it("uses a lower /limits price ceiling", async () => {
    const { cfg, store, catalog, kinds } = await setup();
    const roles = new Roles({ cfg, store, catalog, kinds, maxPrice: () => 0.2 });
    expect(() => roles.resolve("analyst")).toThrow(/ceiling/);
  });
});
