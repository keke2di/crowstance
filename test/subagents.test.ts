import { describe, expect, it } from "vitest";
import { Catalog } from "../src/catalog.ts";
import { Kinds, type PolicyFile } from "../src/kinds.ts";
import { Limits } from "../src/limits.ts";
import { Roles } from "../src/roles.ts";
import { Subagents } from "../src/subagents.ts";
import { crowbotListing, FakeOpenCode, fakeFetch, memoryStore, testConfig, tick } from "./fakes.ts";

const policy: PolicyFile = {
  every: { model: "crowbot/kimi-k3" },
  kinds: { explore: { model: "crowbot/deepseek-v4.1-flash", effort: "low", max_call_usd: 0.1 } },
};

async function setup(env: Record<string, string> = {}) {
  const cfg = testConfig({ CROWBOT_API_KEY: "k", ...env });
  const store = memoryStore();
  const oc = new FakeOpenCode();
  const catalog = new Catalog({
    cfg,
    store,
    oc: oc.asOpenCode(),
    fetchImpl: fakeFetch(crowbotListing([{ id: "deepseek-v4.1-flash", input: 0.03, output: 0.12 }, { id: "kimi-k3", input: 0.27, output: 1.35 }])),
  });
  const kinds = new Kinds({ cfg, oc: oc.asOpenCode(), policy, retryDelaysMs: [] });
  await Promise.all([catalog.refresh(), kinds.refresh()]);
  const limits = new Limits({ cfg, store, catalog, kinds });
  const roles = new Roles({ cfg, store, catalog, kinds });
  const parent = { sessionID: "ses_main" as string | undefined, turnID: 1 as number | undefined };
  let updates = 0;
  const subagents = new Subagents({ cfg, store, oc: oc.asOpenCode(), kinds, roles, limits, parent: () => parent, onUpdate: () => updates++ });
  return { cfg, store, oc, limits, roles, subagents, parent, updates: () => updates };
}

/** Wait until the delegation's prompt reached OpenCode, then return its child session id. */
async function promptedSession(oc: FakeOpenCode, n = 1): Promise<string> {
  for (let i = 0; i < 200 && oc.prompts.length < n; i++) await tick(5);
  return oc.prompts[n - 1]!.sessionID;
}

describe("subagents", () => {
  it("runs a delegation as a child of the main session on its kind's model and returns the answer", async () => {
    const { oc, store, subagents } = await setup();
    const pending = subagents.delegate({ kind: "explore", prompt: "Find where the reminder table is defined and report the file and line." });
    const sessionID = await promptedSession(oc);
    expect(oc.created.at(-1)).toMatchObject({ agent: "explore", parentID: "ses_main", model: { providerID: "crowbot", modelID: "deepseek-v4.1-flash", variant: "low" } });
    expect(oc.prompts[0]!.text).toContain("Find where the reminder table is defined");

    oc.reply(sessionID, "src/migrations.ts:11 creates the reminders table.");
    oc.reply(sessionID, ""); // a last step of tool calls only: the answer is the message before it
    await subagents.onIdle(sessionID);
    const text = await pending;
    expect(text).toContain("Subagent explore (crowbot/deepseek-v4.1-flash, effort low");
    expect(text).toContain("src/migrations.ts:11 creates the reminders table.");
    expect(store.subagentRunBySession(sessionID)).toMatchObject({ state: "done", kind: "explore", turn_id: 1, model_from: "config/kinds.json" });
  });

  it("detaches a slow delegation and delivers its answer as an update", async () => {
    const { oc, store, subagents, updates } = await setup({ SUBAGENT_SYNC_SEC: "1" });
    const text = await (async () => {
      const pending = subagents.delegate({ kind: "analyst", prompt: "Review this plan carefully and list the three biggest risks." });
      await promptedSession(oc);
      return pending;
    })();
    expect(text).toMatch(/still working \(delegation #1/);
    const sessionID = oc.prompts[0]!.sessionID;
    oc.reply(sessionID, "Risk one, risk two, risk three.");
    await subagents.onIdle(sessionID);
    expect(updates()).toBe(1);
    const [u] = store.pendingUpdates();
    expect(u).toMatchObject({ kind: "subagent" });
    expect(u!.text).toContain("Risk one, risk two, risk three.");
  });

  it("refuses unknown kinds, delegation outside the chat, and work past the per-turn and concurrency limits", async () => {
    const { oc, subagents, parent } = await setup({ SUBAGENT_MAX_CONCURRENT: "1", SUBAGENT_MAX_PER_TURN: "2" });
    await expect(subagents.delegate({ kind: "general", prompt: "Do something general for me please." })).rejects.toThrow(/No subagent kind "general"/);

    const first = subagents.delegate({ kind: "explore", prompt: "Look up the first thing and report it back." });
    const s1 = await promptedSession(oc, 1);
    await expect(subagents.delegate({ kind: "explore", prompt: "Look up the second thing and report it back." })).rejects.toThrow(/already running/);
    oc.reply(s1, "first answer");
    await subagents.onIdle(s1);
    await first;

    const second = subagents.delegate({ kind: "explore", prompt: "Look up the third thing and report it back." });
    const s2 = await promptedSession(oc, 2);
    oc.reply(s2, "second answer");
    await subagents.onIdle(s2);
    await second;
    await expect(subagents.delegate({ kind: "explore", prompt: "Look up the fourth thing and report it back." })).rejects.toThrow(/2 delegations in this turn/);

    parent.sessionID = undefined;
    await expect(subagents.delegate({ kind: "explore", prompt: "Look up a fifth thing and report it back." })).rejects.toThrow(/Only the main chat/);
  });

  it("stops a delegation at its cap, keeps its partial answer and tells the chat why", async () => {
    const { oc, store, subagents } = await setup();
    const pending = subagents.delegate({ kind: "explore", prompt: "Search everything for the config option and report it." });
    const sessionID = await promptedSession(oc);
    const run = store.subagentRunBySession(sessionID)!;
    oc.reply(sessionID, "Found two candidates so far.");
    await subagents.stop(run.id, "capped", "reached its $0.10 cap");
    expect(oc.aborted).toContain(sessionID);
    await subagents.onIdle(sessionID, "interrupted");
    const text = await pending;
    expect(text).toContain("was stopped at its cost cap (reached its $0.10 cap)");
    expect(text).toContain("Found two candidates so far.");
    expect(store.subagentRun(run.id)!.state).toBe("capped");
  });

  it("refuses to start when the subagent budget can't cover the call's cap", async () => {
    const { store, subagents } = await setup({ SUBAGENT_DAILY_BUDGET_USD: "0.15" });
    const run = store.insertSubagentRun({ parent_session: "ses_main", turn_id: 0, kind: "explore", prompt: "p", model: null, effort: null, model_from: null });
    store.updateSubagentRun(run.id, { session_id: "ses_old" });
    store.recordSessionUsage("ses_old", 0.1, { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, Date.now());
    await expect(subagents.delegate({ kind: "explore", prompt: "Look something up and report it back." })).rejects.toThrow(/Subagent budget for today reached/);
  });

  it("marks a failed run and reports its error", async () => {
    const { oc, subagents } = await setup();
    const pending = subagents.delegate({ kind: "explore", prompt: "Look something up and report it back to me." });
    const sessionID = await promptedSession(oc);
    subagents.onError(sessionID, { type: "ProviderError", message: "overloaded" });
    await subagents.onIdle(sessionID, "failed");
    expect(await pending).toContain("failed: ProviderError: overloaded");
  });

  it("turns a delegation that was running across a restart into an update", async () => {
    const { oc, store, subagents } = await setup();
    const run = store.insertSubagentRun({ parent_session: "ses_main", turn_id: 1, kind: "explore", prompt: "p", model: null, effort: null, model_from: null });
    store.updateSubagentRun(run.id, { session_id: "ses_9" });
    subagents.recover();
    oc.reply("ses_9", "late answer");
    await subagents.onIdle("ses_9");
    expect(store.pendingUpdates()[0]!.text).toContain("late answer");
  });
});
