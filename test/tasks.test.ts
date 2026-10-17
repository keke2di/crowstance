import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeState, formatTodos, isInside, progress, Tasks, UserError } from "../src/tasks.ts";
import { FakeOpenCode, memoryStore, testConfig } from "./fakes.ts";

function setup(env: Record<string, string> = {}) {
  const cfg = testConfig(env);
  const store = memoryStore();
  const oc = new FakeOpenCode();
  let updates = 0;
  const tasks = new Tasks({ cfg, store, oc: oc.asOpenCode(), onUpdate: () => updates++ });
  return { cfg, store, oc, tasks, updates: () => updates };
}

describe("todo helpers", () => {
  const todos = [
    { content: "scrape site A", status: "completed", priority: "high" },
    { content: "scrape site B", status: "in_progress", priority: "high" },
    { content: "write tests", status: "pending", priority: "medium" },
    { content: "old idea", status: "cancelled", priority: "low" },
  ];
  it("summarises progress, ignoring cancelled items", () => {
    expect(progress(todos)).toBe("1/3 steps done");
    expect(progress([])).toBeUndefined();
  });
  it("renders a readable checklist", () => {
    expect(formatTodos(todos)).toBe("  [x] scrape site A\n  [>] scrape site B\n  [ ] write tests\n  [-] old idea");
  });
});

describe("paths", () => {
  it("only accepts projects inside the projects dir", () => {
    const { cfg, tasks } = setup();
    expect(tasks.resolveProjectDir("Price Tracker")).toBe(path.join(cfg.PROJECTS_DIR, "price-tracker"));
    expect(tasks.resolveProjectDir(path.join(cfg.PROJECTS_DIR, "x"))).toBe(path.join(cfg.PROJECTS_DIR, "x"));
    expect(() => tasks.resolveProjectDir(path.resolve("/etc"))).toThrow(UserError);
    expect(() => tasks.resolveProjectDir(cfg.PROJECTS_DIR)).toThrow(UserError);
    expect(isInside(path.join(cfg.PROJECTS_DIR, "..", "evil"), cfg.PROJECTS_DIR)).toBe(false);
  });
});

describe("Tasks lifecycle", () => {
  it("starts a worker with a brief in its own repo", async () => {
    const { cfg, oc, tasks, store } = setup();
    const t = await tasks.start({ title: "Price tracker", brief: "Track prices of X daily and save to prices.csv" });
    expect(t.slug).toBe("price-tracker");
    expect(oc.repos).toEqual([path.join(cfg.PROJECTS_DIR, "price-tracker")]);
    expect(oc.prompts[0]!.agent).toBe("worker");
    expect(oc.prompts[0]!.text).toContain("Track prices of X daily");
    expect(store.activeTasks()).toHaveLength(1);

    store.updateTask("price-tracker", { state: "finished" });
    const again = await tasks.start({ title: "Price tracker", brief: "Second attempt with a different approach" });
    expect(again.slug).toBe("price-tracker-2");
  });

  it("enforces the worker limit and daily budget", async () => {
    const { tasks, store } = setup({ MAX_WORKERS: "1", DAILY_BUDGET_USD: "5" });
    await tasks.start({ title: "one", brief: "a first task brief that is long enough" });
    await expect(tasks.start({ title: "two", brief: "a second task brief that is long enough" })).rejects.toThrow(/limit is 1/);

    store.updateTask("one", { state: "finished" });
    store.recordSpend("msg_1", "ses_x", 6, Date.now());
    await expect(tasks.start({ title: "three", brief: "a third task brief that is long enough" })).rejects.toThrow(/Daily budget/);
  });

  it("turns a finished worker into an update with its report", async () => {
    const { oc, tasks, store, updates } = setup();
    const t = await tasks.start({ title: "Research cameras", brief: "Compare three mirrorless cameras under 1000 EUR" });
    oc.reply(t.session_id, "Compared Sony, Fuji, Canon. Saved report.md.\n\nStatus: done\nWhat I did: research");
    await tasks.onIdle(t.session_id);

    const row = store.taskBySlug(t.slug)!;
    expect(row.state).toBe("finished");
    expect(row.outcome).toBe("done");
    const [u] = store.pendingUpdates();
    expect(u!.text).toContain("research-cameras");
    expect(u!.text).toContain("Saved report.md");
    expect(updates()).toBe(1);

    await tasks.onIdle(t.session_id); // duplicate idle → no second update
    expect(store.pendingUpdates()).toHaveLength(1);
  });

  it("marks needs-input as waiting and failures as failed", async () => {
    const { oc, tasks, store } = setup();
    const a = await tasks.start({ title: "Need key", brief: "Use the weather API to build a forecast bot" });
    oc.reply(a.session_id, "I need an API key.\nStatus: needs-input");
    await tasks.onIdle(a.session_id);
    expect(store.taskBySlug(a.slug)!.state).toBe("waiting");

    const b = await tasks.start({ title: "Broken", brief: "Something that will fail at the provider" });
    tasks.onError(b.session_id, { name: "APIError", data: { message: "overloaded" } });
    oc.reply(b.session_id, "partial work");
    await tasks.onIdle(b.session_id);
    expect(store.taskBySlug(b.slug)!.state).toBe("failed");
    expect(store.pendingUpdates().at(-1)!.text).toContain("overloaded");
  });

  it("describes status from todos, cost and the latest words", async () => {
    const { oc, tasks } = setup();
    const t = await tasks.start({ title: "Scraper", brief: "Scrape the three listed shops for prices" });
    oc.statusMap[t.session_id] = { type: "busy" };
    oc.todos.set(t.session_id, [
      { content: "shop A", status: "completed", priority: "high" },
      { content: "shop B", status: "in_progress", priority: "high" },
    ]);
    oc.sessions.get(t.session_id)!.cost = 0.82;
    oc.sessions.get(t.session_id)!.summary = { files: 4, additions: 120, deletions: 3 };
    oc.reply(t.session_id, "Shop B uses a JSON API, switching to that.");

    const text = await tasks.describe("scraper");
    expect(text).toContain("running (working right now)");
    expect(text).toContain("1/2 steps done");
    expect(text).toContain("[>] shop B");
    expect(text).toContain("Files changed: 4 (+120 −3)");
    expect(text).toContain("$0.82");
    expect(text).toContain("JSON API");
  });

  it("phrases task states", () => {
    const { store } = setup();
    const row = { ...store.insertTask({ slug: "x", title: "X", brief: "b", directory: "/p/x", session_id: "ses_x", state: "running", model: null, job: null, created_at: Date.now() }) };
    expect(describeState(row, { type: "retry", attempt: 1, message: "rate limited", next: 0 })).toMatch(/retrying.*rate limited/);
    expect(describeState({ ...row, state: "finished", outcome: "blocked" }, undefined)).toBe("finished (blocked)");
  });

  it("flags stuck tasks once", async () => {
    const { tasks, store } = setup({ STUCK_AFTER_MIN: "10" });
    const t = await tasks.start({ title: "Slow", brief: "Something that takes a long time" });
    tasks.checkStuck(Date.now() + 11 * 60_000);
    tasks.checkStuck(Date.now() + 12 * 60_000);
    expect(store.pendingUpdates().filter((u) => u.text.includes("may be stuck"))).toHaveLength(1);
    expect(store.taskBySlug(t.slug)!.stuck_notified).toBe(1);
  });

  it("reserves worker capacity and slugs before concurrent session creation", async () => {
    const { tasks, oc, store } = setup({ MAX_WORKERS: "2" });
    oc.createSessionDelay = 10;
    const results = await Promise.allSettled([
      tasks.start({ title: "Same title", brief: "first" }),
      tasks.start({ title: "Same title", brief: "second" }),
      tasks.start({ title: "Third", brief: "third" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(store.activeTasks()).toHaveLength(2);
    expect(new Set(store.activeTasks().map((t) => t.slug)).size).toBe(2);
    expect(store.activeTasks().every((t) => oc.sessions.has(t.session_id))).toBe(true);
  });

  it("uses CAS for idle completion and records failed abort separately", async () => {
    const { oc, tasks, store } = setup();
    const t = await tasks.start({ title: "Race", brief: "race" });
    oc.reply(t.session_id, "Status: done");
    store.transitionTask(t.slug, "running", { abort_state: "requested" });
    await Promise.all([tasks.onIdle(t.session_id), tasks.onIdle(t.session_id)]);
    expect(store.pendingUpdates()).toHaveLength(1);
    oc.abortError = new Error("abort unavailable");
    const stopped = await tasks.start({ title: "Cannot stop", brief: "stop" });
    await tasks.stop(stopped.slug);
    expect(store.taskBySlug(stopped.slug)).toMatchObject({ state: "running", abort_state: "failed" });
  });

  it("checks budget and capacity before resuming a waiting task", async () => {
    const { tasks, store } = setup({ MAX_WORKERS: "1", DAILY_BUDGET_USD: "1" });
    const t = await tasks.start({ title: "Waiting", brief: "wait" });
    store.updateTask(t.slug, { state: "waiting" });
    const other = await tasks.start({ title: "Other", brief: "other" }).catch(() => undefined);
    expect(other).toBeUndefined();
    store.recordSpend("expensive", "s", 2, Date.now());
    await expect(tasks.message(t.slug, "resume")).rejects.toThrow(/Daily budget/);
  });
});
