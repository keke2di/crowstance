import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Catalog } from "../src/catalog.ts";
import { Kinds } from "../src/kinds.ts";
import { Limits } from "../src/limits.ts";
import { startHqServer } from "../src/mcp.ts";
import type { Geocoder } from "../src/geocoder.ts";
import { Roles } from "../src/roles.ts";
import { Scheduler } from "../src/scheduler.ts";
import { Subagents } from "../src/subagents.ts";
import { Tasks } from "../src/tasks.ts";
import { FakeOpenCode, memoryStore, testConfig } from "./fakes.ts";

const cfg = testConfig({ HQ_PORT: "0" });
const store = memoryStore();
const oc = new FakeOpenCode();
const tasks = new Tasks({ cfg, store, oc: oc.asOpenCode(), onUpdate: () => {} });
const scheduler = new Scheduler({ cfg, store, tasks, oc: oc.asOpenCode(), onUpdate: () => {}, housekeeping: async () => {} });
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = await startHqServer({ cfg, store, tasks, scheduler, onUpdate: () => {} });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  scheduler.stop();
});

async function rpc(method: string, params: unknown, token = cfg.HQ_MCP_TOKEN) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as { result?: any; error?: any }) : undefined };
}

describe("/notify", () => {
  it("requires the notify token and queues an update", async () => {
    const denied = await fetch(`${base}/notify`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
    expect(denied.status).toBe(401);

    const res = await fetch(`${base}/notify`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.HQ_NOTIFY_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "example.com returned 503", urgent: true, source: "uptime" }),
    });
    expect(res.status).toBe(202);
    const [u] = store.pendingUpdates();
    expect(u).toMatchObject({ kind: "notify", urgent: 1, text: "[uptime] example.com returned 503" });
  });

  it("rejects malformed bodies", async () => {
    const res = await fetch(`${base}/notify`, { method: "POST", headers: { authorization: `Bearer ${cfg.HQ_NOTIFY_TOKEN}` }, body: JSON.stringify({ urgent: true }) });
    expect(res.status).toBe(400);
  });
});

describe("/mcp", () => {
  it("rejects requests without the MCP token", async () => {
    expect((await rpc("tools/list", {}, "nope")).status).toBe(401);
  });

  it("initializes and lists the hq tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.body?.result?.serverInfo?.name).toBe("hq");

    const list = await rpc("tools/list", {});
    const names = (list.body?.result?.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual([
      "action_list",
      "action_record",
      "jobs",
      "location_share",
      "monitor_add",
      "monitor_remove",
      "monitors",
      "provider_balance",
      "remind",
      "reminder_cancel",
      "reminders",
      "schedule",
      "task_list",
      "task_message",
      "task_start",
      "task_status",
      "task_stop",
      "unschedule",
      "vault_list",
    ]);
  });

  it("reports spending without needing the provider key", async () => {
    store.recordSpend("msg_a", "ses_a", 0.25, Date.now());
    const res = await rpc("tools/call", { name: "provider_balance", arguments: {} });
    const text = res.body?.result?.content?.[0]?.text as string;
    expect(text).toContain("$0.25 today");
    expect(text).toContain("isn't available");
  });

  it("queues a confident owner location without calling Telegram from MCP", async () => {
    const res = await rpc("tools/call", { name: "location_share", arguments: { name: "Dateline", latitude: 0, longitude: 180, confidence: "high", source: "user" } });
    expect(res.body?.result?.content?.[0]?.text).toContain("Queued a location pin");
    const row = store.db.prepare("SELECT id FROM outbound_events WHERE kind='location' ORDER BY created_at DESC LIMIT 1").get() as { id: string };
    const event = store.outboundEvent(row.id);
    expect(event?.kind).toBe("location");
  });

  it("reports missing geocoder configuration instead of guessing", async () => {
    const res = await rpc("tools/call", { name: "location_share", arguments: { name: "Some Place", confidence: "low", source: "model" } });
    expect(res.body?.result?.isError).toBe(true);
    expect(res.body?.result?.content?.[0]?.text).toContain("No geocoder is configured");
  });

  it("uses an explicitly requested maps URL as a durable fallback", async () => {
    const res = await rpc("tools/call", { name: "location_share", arguments: { name: "Some Place", maps_url: "https://maps.example/place", confidence: "low", source: "user" } });
    expect(res.body?.result?.content?.[0]?.text).toContain("maps link");
    expect(store.pendingUpdates()).toBeDefined();
    const row = store.db.prepare("SELECT kind FROM outbound_events WHERE kind='text' ORDER BY created_at DESC LIMIT 1").get() as { kind: string };
    expect(row.kind).toBe("text");
  });

  it("returns ambiguous candidates without creating an outbound pin", async () => {
    const candidateGeocoder: Geocoder = { search: async () => [
      { name: "Central Station North", latitude: 1.5, longitude: 2.5 },
      { name: "Central Station South", latitude: 1.6, longitude: 2.6 },
    ] };
    const ambiguousServer = await startHqServer({ cfg, store, tasks, scheduler, onUpdate: () => {}, geocoder: candidateGeocoder });
    const port = (ambiguousServer.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { authorization: `Bearer ${cfg.HQ_MCP_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "location_share", arguments: { name: "Central Station", confidence: "medium", source: "search" } } }) });
    const body = await response.json() as { result: { content: { text: string }[] } };
    expect(body.result.content[0]!.text).toContain("multiple possible locations");
    ambiguousServer.close();
  });

  it("runs tools and reports expected failures as tool errors", async () => {
    const ok = await rpc("tools/call", { name: "remind", arguments: { text: "call the bank", in_minutes: 30 } });
    expect(ok.body?.result?.content?.[0]?.text).toMatch(/^Reminder #1 set for .* \(in 30m\)\.$/);

    const bad = await rpc("tools/call", { name: "task_status", arguments: { task: "does-not-exist" } });
    expect(bad.body?.result?.isError).toBe(true);
    expect(bad.body?.result?.content?.[0]?.text).toContain('No task matches "does-not-exist"');

    const started = await rpc("tools/call", { name: "task_start", arguments: { title: "Uptime page", brief: "Build a tiny status page for my sites" } });
    expect(started.body?.result?.content?.[0]?.text).toMatch(/^Started task uptime-page in /);
    expect(oc.prompts.at(-1)!.text).toContain("Build a tiny status page");
  });
});

describe("hq_delegate", () => {
  it("is offered with every discovered kind, what it is for and its tools", async () => {
    const dcfg = testConfig({ HQ_PORT: "0" });
    const dstore = memoryStore();
    const doc = new FakeOpenCode();
    const catalog = new Catalog({ cfg: dcfg, store: dstore, oc: doc.asOpenCode() });
    const kinds = new Kinds({
      cfg: dcfg,
      oc: doc.asOpenCode(),
      policy: { kinds: { explore: { effort: "low", when: "quick lookups", max_call_usd: 0.15 } } },
      agentTools: { explore: { edit: false, write: false, bash: false, execute: false } },
      retryDelaysMs: [],
    });
    await Promise.all([catalog.refresh(), kinds.refresh()]);
    const limits = new Limits({ cfg: dcfg, store: dstore, catalog, kinds });
    const roles = new Roles({ cfg: dcfg, store: dstore, catalog, kinds });
    const subagents = new Subagents({ cfg: dcfg, store: dstore, oc: doc.asOpenCode(), kinds, roles, limits, parent: () => ({ sessionID: "ses_main" }), onUpdate: () => {} });
    const dtasks = new Tasks({ cfg: dcfg, store: dstore, oc: doc.asOpenCode(), onUpdate: () => {} });
    const dsched = new Scheduler({ cfg: dcfg, store: dstore, tasks: dtasks, oc: doc.asOpenCode(), onUpdate: () => {}, housekeeping: async () => {} });
    const s = await startHqServer({ cfg: dcfg, store: dstore, tasks: dtasks, scheduler: dsched, onUpdate: () => {}, subagents, kinds, roles, limits });
    try {
      const port = (s.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${dcfg.HQ_MCP_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      const tools = ((await res.json()) as { result: { tools: { name: string; description: string; inputSchema: { properties: { kind: { enum: string[] } } } }[] } }).result.tools;
      const delegate = tools.find((t) => t.name === "delegate")!;
      expect(delegate.inputSchema.properties.kind.enum).toEqual(["explore", "analyst"]);
      expect(delegate.description).toContain("- explore: Finds things and reports them Good for: quick lookups Tools: read, glob, grep, webfetch, websearch.");
      expect(delegate.description).toContain("- analyst: Thinks hard about one question");
    } finally {
      s.close();
      dsched.stop();
    }
  });
});
