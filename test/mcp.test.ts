import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHqServer } from "../src/mcp.ts";
import type { Geocoder } from "../src/geocoder.ts";
import { Scheduler } from "../src/scheduler.ts";
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
