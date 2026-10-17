import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { startHqServer, type ReadinessReport } from "../src/mcp.ts";
import { Scheduler } from "../src/scheduler.ts";
import { Tasks } from "../src/tasks.ts";
import { FakeOpenCode, memoryStore, testConfig } from "./fakes.ts";

const cfg = testConfig({ HQ_PORT: "0" });
const store = memoryStore();
const oc = new FakeOpenCode();
const tasks = new Tasks({ cfg, store, oc: oc.asOpenCode(), onUpdate: () => {} });
const scheduler = new Scheduler({ cfg, store, tasks, oc: oc.asOpenCode(), onUpdate: () => {}, housekeeping: async () => {} });
const servers: http.Server[] = [];

async function start(readiness?: () => Promise<ReadinessReport>) {
  const server = await startHqServer({ cfg, store, tasks, scheduler, onUpdate: () => {}, readiness });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});
afterAll(() => scheduler.stop());

describe("liveness and readiness", () => {
  it("keeps liveness meaningful when a dependency is down, and reports it in readiness", async () => {
    const readiness = async (): Promise<ReadinessReport> => ({
      ready: false,
      checks: { store: { ok: true }, opencode: { ok: false, detail: "connection refused" }, telegram: { ok: true } },
    });
    const base = await start(readiness);

    const live = await fetch(`${base}/health`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ ok: true, status: "alive" });

    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as { ok: boolean; ready: boolean; checks: Record<string, { ok: boolean; detail?: string }> };
    expect(body.ok).toBe(false);
    expect(body.checks.opencode).toEqual({ ok: false, detail: "connection refused" });
  });

  it("reports ready when every dependency answers", async () => {
    const base = await start(async () => ({ ready: true, checks: { store: { ok: true }, opencode: { ok: true }, telegram: { ok: true } } }));
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, ready: true });
  });

  it("serves queue age, retries and spend metrics", async () => {
    const base = await start();
    const id = store.enqueueUpdate("task", "pending");
    const now = Date.now();
    store.db.prepare("UPDATE updates SET created_at = ? WHERE id = ?").run(now - 5_000, id);
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metrics: { updates: { pending: number; oldestAgeMs: number } } };
    expect(body.metrics.updates.pending).toBeGreaterThanOrEqual(1);
    expect(body.metrics.updates.oldestAgeMs).toBeGreaterThanOrEqual(5_000);
  });

  it("returns and honors a correlation id for each request", async () => {
    const base = await start();
    const generated = await fetch(`${base}/health`);
    expect(generated.headers.get("x-correlation-id")).toBeTruthy();
    const echoed = await fetch(`${base}/health`, { headers: { "x-correlation-id": "cor-from-opencode" } });
    expect(echoed.headers.get("x-correlation-id")).toBe("cor-from-opencode");
  });
});
