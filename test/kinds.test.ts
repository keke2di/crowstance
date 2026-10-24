import { describe, expect, it } from "vitest";
import { enabledTools, Kinds, readAgentTools, readPolicy } from "../src/kinds.ts";
import type { AgentInfo } from "../src/opencode.ts";
import { FakeOpenCode, testConfig } from "./fakes.ts";

describe("subagent kinds", () => {
  it("are OpenCode's non-primary agents, minus disabled, hidden and reserved ones, with policy merged in", async () => {
    const oc = new FakeOpenCode();
    oc.agentList.push(
      { id: "general", name: "general", mode: "subagent", hidden: false },
      { id: "workers", name: "workers", mode: "subagent", hidden: false },
      { id: "secret", name: "secret", mode: "subagent", hidden: true },
    );
    const kinds = new Kinds({
      cfg: testConfig(),
      oc: oc.asOpenCode(),
      policy: { kinds: { explore: { model: "crowbot/kimi-k3", effort: "low", max_call_usd: 0.1, when: "lookups" }, general: { enabled: false }, ghost: { effort: "high" } } },
      agentTools: { explore: { "hq_*": false, task: false, edit: false, write: false, bash: false, question: false, execute: false } },
      retryDelaysMs: [],
    });
    expect(await kinds.refresh()).toBe(true);
    expect(kinds.list().map((k) => k.id)).toEqual(["explore", "analyst"]);
    expect(kinds.get("explore")).toMatchObject({ model: "crowbot/kimi-k3", effort: "low", maxCallUsd: 0.1, when: "lookups", tools: ["read", "glob", "grep", "webfetch", "websearch"] });
    expect(kinds.get("analyst")).toEqual({ id: "analyst", description: "Thinks hard about one question" });
    expect(kinds.orphanPolicies()).toEqual(["ghost"]);
    expect(kinds.reservedClashes()).toEqual(["workers"]);
    expect(kinds.agentModel("assistant")).toBe("crowbot/deepseek-v4.1-flash");
  });

  it("waits out OpenCode's cold start: an empty list, then only built-ins, then the configured agents", async () => {
    const oc = new FakeOpenCode();
    const full = oc.agentList;
    const builtins: AgentInfo[] = [{ id: "general", name: "general", mode: "subagent", hidden: false }];
    const answers = [[], builtins, full];
    oc.agents = async () => answers.shift() ?? full;
    const kinds = new Kinds({ cfg: testConfig(), oc: oc.asOpenCode(), policy: {}, retryDelaysMs: [1, 1, 1] });
    expect(await kinds.refresh()).toBe(true);
    expect(kinds.list().map((k) => k.id)).toEqual(["explore", "analyst"]);
  });

  it("keeps a good list when a later refresh only sees a partial one", async () => {
    const oc = new FakeOpenCode();
    const kinds = new Kinds({ cfg: testConfig(), oc: oc.asOpenCode(), policy: {}, retryDelaysMs: [] });
    await kinds.refresh();
    oc.agents = async () => [];
    expect(await kinds.refresh()).toBe(false);
    expect(kinds.list()).toHaveLength(2);
  });

  it("ships a valid policy file, and read-only tools for every shipped kind", () => {
    const policy = readPolicy("config/kinds.json");
    expect(Object.keys(policy.kinds ?? {})).toEqual(["explore", "research", "analyst", "general"]);
    expect(policy.kinds?.general?.enabled).toBe(false);
    expect(policy.every?.model).toMatch(/^crowbot\//);
    const tools = readAgentTools("opencode/opencode.json");
    for (const kind of ["explore", "research", "analyst"]) expect(enabledTools(tools[kind]!), kind).toEqual(["read", "glob", "grep", "webfetch", "websearch"]);
  });
});
