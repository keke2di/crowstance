/**
 * Local HTTP endpoint (127.0.0.1 only):
 *   POST /mcp     MCP server "hq": the assistant's tools (OpenCode shows them as hq_*)
 *   POST /notify  for monitor scripts: {"text": "...", "urgent": true}
 *   GET  /health  liveness: the process is up and serving
 *   GET  /ready   readiness: dependencies (store, OpenCode, Telegram) are healthy
 *   GET  /metrics queue age, retries, spend and other operational counters
 */
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import crypto from "node:crypto";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { logger, newCorrelationId, runWithCorrelation } from "./log.ts";
import { crowbotBalance, describeBalance } from "./provider.ts";
import type { Scheduler } from "./scheduler.ts";
import { UserError, type Tasks } from "./tasks.ts";
import { startOfLocalDay, startOfLocalMonth, truncate, usd } from "./text.ts";
import type { Vault } from "./vault.ts";
import { configuredGeocoder, validateCoordinates, validateLocationText, validateMapsUrl, MAX_LOCATION_ADDRESS, MAX_LOCATION_NAME, type Geocoder } from "./geocoder.ts";

const log = logger("hq");

export type MappedLocationPayload = { delivery: "location" | "venue"; latitude: number; longitude: number; name: string; address?: string; maps_url?: string; source: string; confidence: string };
export type DependencyCheck = { ok: boolean; detail?: string };
export type ReadinessReport = { ready: boolean; checks: Record<string, DependencyCheck> };
type Deps = { cfg: Config; store: Store; tasks: Tasks; scheduler: Scheduler; onUpdate: () => void; geocoder?: Geocoder; vault?: Vault; readiness?: () => Promise<ReadinessReport> };
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

/** Expected failures go back to the model as readable tool errors; bugs get logged. */
async function guarded(name: string, fn: () => Promise<string> | string): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    if (!(err instanceof UserError)) log.error(`tool ${name} failed`, err);
    return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
  }
}

export function buildMcpServer({ cfg, store, tasks, scheduler, geocoder, vault }: Deps): McpServer {
  const server = new McpServer({ name: "hq", version: "0.1.0" });
  const locationGeocoder = geocoder ?? configuredGeocoder(cfg);

  server.registerTool("location_share", {
    description: "Send the owner one Telegram-native tappable map location. Use this when they ask where a place is or ask you to send a place. Prefer confident coordinates; otherwise geocode a specific address/place. Ambiguous results are returned for the user to choose and never sent automatically. This tool cannot target another chat.",
    inputSchema: {
      name: z.string().min(1).max(MAX_LOCATION_NAME), address: z.string().min(1).max(MAX_LOCATION_ADDRESS).optional(),
      latitude: z.number().finite().min(-90).max(90).optional(), longitude: z.number().finite().min(-180).max(180).optional(),
      maps_url: z.string().optional(), confidence: z.enum(["high", "verified", "medium", "low"]), source: z.string().min(1).max(80),
    },
  }, ({ name, address, latitude, longitude, maps_url, confidence, source }) => guarded("location_share", async () => {
    const cleanName = validateLocationText(name, "name");
    const cleanAddress = address ? validateLocationText(address, "address") : undefined;
    const cleanUrl = maps_url ? validateMapsUrl(maps_url) : undefined;
    if ((latitude === undefined) !== (longitude === undefined)) throw new UserError("latitude and longitude must be provided together");
    let chosen = latitude === undefined || longitude === undefined ? undefined : validateCoordinates({ latitude, longitude });
    let resolvedName = cleanName;
    let resolvedAddress = cleanAddress;
    let resolvedSource = source;
    if (!chosen) {
      if (!locationGeocoder && cleanUrl) {
        store.enqueueOutbound({ id: crypto.randomUUID(), kind: "text", payload: { name: cleanName, maps_url: cleanUrl }, chunks: [`${cleanName}${cleanAddress ? `\n${cleanAddress}` : ""}\n${cleanUrl}`] });
        return `Queued the maps link for ${cleanName} because no coordinates were available.`;
      }
      if (!locationGeocoder) throw new UserError("No geocoder is configured; provide confident latitude and longitude.");
      const candidates = await locationGeocoder.search(cleanAddress ?? cleanName);
      if (candidates.length !== 1) {
        if (!candidates.length) throw new UserError("The place could not be geocoded. Provide a specific address or coordinates.");
        return `I found multiple possible locations; ask the user to choose one before sending a pin:\n${candidates.map((c, i) => `${i + 1}. ${c.name}${c.address ? ` — ${c.address}` : ""}`).join("\n")}`;
      }
      const candidate = candidates[0]!;
      chosen = validateCoordinates(candidate); resolvedName = candidate.name; resolvedAddress = candidate.address ?? resolvedAddress; resolvedSource = candidate.source ?? source;
    }
    const delivery = confidence === "verified" && resolvedAddress ? "venue" : "location";
    const coordinates = chosen!;
    const payload: MappedLocationPayload = { delivery, ...coordinates, name: resolvedName, ...(resolvedAddress ? { address: resolvedAddress } : {}), ...(cleanUrl ? { maps_url: cleanUrl } : {}), source: resolvedSource, confidence };
    store.enqueueLocation({ id: crypto.randomUUID(), payload });
    return delivery === "venue" ? `Queued a verified venue pin for ${resolvedName}.` : `Queued a location pin for ${resolvedName}.`;
  }));

  server.registerTool(
    "provider_balance",
    {
      description:
        "Model spending: the provider (crowbot) account balance plus what you've spent today and this month. Use this for any " +
        "question about balance, credits or cost — never go looking for API keys yourself.",
      inputSchema: {},
    },
    () =>
      guarded("provider_balance", async () => {
        const spend = `spent by this assistant: ${usd(store.spendSince(startOfLocalDay()))} today, ${usd(store.spendSince(startOfLocalMonth()))} this month (daily budget ${usd(cfg.DAILY_BUDGET_USD)})`;
        if (!cfg.CROWBOT_API_KEY) return `${spend}. The provider balance isn't available (no key configured for the gateway).`;
        return `${describeBalance(await crowbotBalance(cfg.CROWBOT_API_KEY))}; ${spend}`;
      }),
  );

  server.registerTool(
    "vault_list",
    {
      description:
        "List the credentials stored in the vault: handle, service, kind, note and when each was last used. " +
        "Values are never returned and cannot be read by you — you can only ask an action runner to use a handle. " +
        "Use this to check what logins/payment methods exist before preparing a real-world action.",
      inputSchema: {},
    },
    () =>
      guarded("vault_list", () => {
        if (!vault) return "The vault is not configured on this gateway.";
        const entries = vault.list();
        if (!entries.length) return "The vault is empty. Credentials are added by the user, never by you.";
        return entries
          .map((e) => `- ${e.handle} (${e.service}, ${e.kind})${e.note ? ` — ${e.note}` : ""}${e.last_used_at ? `; last used ${new Date(e.last_used_at).toISOString()}` : ""}`)
          .join("\n");
      }),
  );

  server.registerTool(
    "action_record",
    {
      description:
        "Record a real-world action you are preparing or taking on the user's behalf (an audit trail entry: what, why, estimated cost, " +
        "how the user consented). Always record before acting. Spending money is never silent: consent must reference an explicit user confirmation.",
      inputSchema: {
        service: z.string().min(1).max(60).describe("The service this touches, e.g. 'glovo'"),
        action: z.string().min(3).max(160).describe("Short verb phrase, e.g. 'prepared basket', 'placed order'"),
        detail: z.string().max(1500).optional().describe("What exactly: basket contents, form values, slot — no secrets"),
        rationale: z.string().max(500).optional().describe("Why the user wants this"),
        cost_estimate_usd: z.number().nonnegative().optional(),
        consent: z.enum(["none", "explicit", "task-scoped"]).describe("How the user consented; 'explicit' requires consent_ref"),
        consent_ref: z.string().max(120).optional().describe("Reference to the consent (approval request id or Telegram message)"),
        status: z.enum(["prepared", "confirmed", "cancelled", "completed", "failed"]).optional(),
        task_slug: z.string().max(80).optional(),
      },
    },
    (a) =>
      guarded("action_record", () => {
        if (a.consent === "explicit" && !a.consent_ref) throw new UserError("Explicit consent needs a consent_ref (the approval request id or message).");
        if (a.status === "completed" && a.consent === "none") throw new UserError("Completing a real-world action without recorded consent is not allowed.");
        const id = store.auditAction({ ...a, sessionID: undefined });
        return `Recorded action #${id} (${a.action}${a.service ? ` on ${a.service}` : ""}, consent: ${a.consent}).`;
      }),
  );

  server.registerTool(
    "action_list",
    {
      description: "List recently recorded real-world actions (the audit trail). Use this when the user asks what was done on their behalf.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    },
    ({ limit }) =>
      guarded("action_list", () => {
        const rows = store.recentActions(limit ?? 20);
        if (!rows.length) return "No actions recorded yet.";
        return rows
          .map(
            (r) =>
              `- #${r.id} ${new Date(r.created_at).toISOString()} [${r.status}] ${r.action}${r.service ? ` (${r.service})` : ""}` +
              `${r.cost_estimate_usd != null ? ` ~${usd(r.cost_estimate_usd)}` : ""}, consent: ${r.consent}${r.detail ? `\n  ${truncate(r.detail, 200)}` : ""}`,
          )
          .join("\n");
      }),
  );

  server.registerTool(
    "task_start",
    {
      description:
        "Start a background worker for anything that takes more than a couple of minutes or many steps (coding, research, writing, setup). " +
        "Returns immediately; you'll receive an <update> when it finishes. The worker cannot see this conversation, so the brief must be " +
        "self-contained: goal, context, constraints, where to put results, and what 'done' means.",
      inputSchema: {
        title: z.string().min(3).max(80).describe("Short human-readable name, e.g. 'Price tracker scraper'"),
        brief: z.string().min(20).describe("Complete, self-contained instructions for the worker"),
        project: z
          .string()
          .optional()
          .describe("Project folder under the projects dir to work in (existing or new). Defaults to one derived from the title."),
        model: z.string().optional().describe("provider/model override; only when the user asked for a specific model"),
      },
    },
    ({ title, brief, project, model }) =>
      guarded("task_start", async () => {
        const t = await tasks.start({ title, brief, project, model });
        return `Started task ${t.slug} in ${t.directory}. You'll get an update when it's done.`;
      }),
  );

  server.registerTool(
    "task_list",
    {
      description: "List background tasks: active ones plus those finished recently, with state, progress, cost and last activity.",
      inputSchema: { include_finished_hours: z.number().min(0).max(24 * 30).optional().describe("How far back to include finished tasks (default 24)") },
    },
    ({ include_finished_hours }) => guarded("task_list", () => tasks.list(include_finished_hours ?? 24)),
  );

  server.registerTool(
    "task_status",
    {
      description:
        "Detailed status of one task — state, todo list progress, files changed, cost, pending approvals, the worker's latest words or final report. " +
        "Use this whenever the user asks how something is going.",
      inputSchema: { task: z.string().describe("Task id, or words from its title") },
    },
    ({ task }) => guarded("task_status", () => tasks.describe(task)),
  );

  server.registerTool(
    "task_message",
    {
      description: "Send follow-up instructions or answers to a worker (also restarts a finished task with new instructions).",
      inputSchema: { task: z.string(), message: z.string().min(1) },
    },
    ({ task, message }) =>
      guarded("task_message", async () => {
        const t = await tasks.message(task, message);
        return `Sent to ${t.slug}.`;
      }),
  );

  server.registerTool(
    "task_stop",
    { description: "Stop a running task.", inputSchema: { task: z.string() } },
    ({ task }) =>
      guarded("task_stop", async () => {
        const t = await tasks.stop(task);
        return `Stopped ${t.slug}.`;
      }),
  );

  server.registerTool(
    "remind",
    {
      description:
        "Set a one-off reminder. When it fires you'll get an <update> and should tell the user. Give either `at` (absolute) or `in_minutes`.",
      inputSchema: {
        text: z.string().min(1).describe("What to remind the user about, phrased for them"),
        at: z.string().optional().describe("ISO 8601 date-time with UTC offset, e.g. 2026-10-07T10:00:00+02:00"),
        in_minutes: z.number().positive().optional(),
      },
    },
    ({ text, at, in_minutes }) =>
      guarded("remind", () => {
        if ((at === undefined) === (in_minutes === undefined)) throw new UserError("Give exactly one of `at` or `in_minutes`.");
        const due = at !== undefined ? new Date(at) : new Date(Date.now() + in_minutes! * 60_000);
        const r = scheduler.remind(due, text);
        return `Reminder #${r.id} set for ${r.due} (in ${r.in}).`;
      }),
  );

  server.registerTool("reminders", { description: "List upcoming reminders.", inputSchema: {} }, () =>
    guarded("reminders", () => scheduler.listReminders()),
  );

  server.registerTool(
    "reminder_cancel",
    { description: "Cancel an upcoming reminder by its number.", inputSchema: { id: z.number().int().positive() } },
    ({ id }) =>
      guarded("reminder_cancel", () => {
        scheduler.cancelReminder(id);
        return `Cancelled reminder #${id}.`;
      }),
  );

  server.registerTool(
    "schedule",
    {
      description:
        "Schedule a recurring job that runs as a background worker (e.g. a daily research digest). Each run costs model tokens, so it has a " +
        "minimum interval. For frequent checks (uptime, prices), use monitor_add with a script instead.",
      inputSchema: {
        name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "lowercase letters, digits and dashes").describe("Job id, e.g. 'morning-news'"),
        cron: z.string().describe("5-field cron pattern in the user's time zone, e.g. '0 7 * * 1-5'"),
        instructions: z.string().min(20).describe("Self-contained brief for each run, including where to save results"),
        model: z.string().optional(),
      },
    },
    ({ name, cron, instructions, model }) =>
      guarded("schedule", () => {
        const j = scheduler.schedule({ name, cron, instructions, model });
        return `Scheduled "${j.name}"; next run ${j.next}.`;
      }),
  );

  server.registerTool(
    "unschedule",
    { description: "Stop a recurring job.", inputSchema: { name: z.string() } },
    ({ name }) =>
      guarded("unschedule", () => {
        scheduler.unschedule(name);
        return `Unscheduled "${name}".`;
      }),
  );

  server.registerTool("jobs", { description: "List recurring jobs and their next run.", inputSchema: {} }, () =>
    guarded("jobs", () => scheduler.listJobs()),
  );

  server.registerTool(
    "monitor_add",
    {
      description:
        "Run a check script on an interval (no model tokens spent). The script should stay silent when all is well and call " +
        "scripts/notify.sh \"what happened\" (add --urgent if it can't wait) when something is wrong — ideally only when the state changes. " +
        "Test it once yourself before adding it. Re-adding a name replaces it.",
      inputSchema: {
        name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "lowercase letters, digits and dashes").describe("e.g. 'site-up'"),
        script: z.string().describe("Path relative to your home directory, e.g. scripts/monitors/site-up.sh"),
        every_minutes: z.number().int().min(1).max(24 * 60),
      },
    },
    ({ name, script, every_minutes }) =>
      guarded("monitor_add", () => {
        const m = scheduler.addMonitor({ name, script, everyMinutes: every_minutes });
        return `Monitor "${m.name}" runs ${m.script} every ${m.every} min, starting now.`;
      }),
  );

  server.registerTool(
    "monitor_remove",
    { description: "Stop a monitor.", inputSchema: { name: z.string() } },
    ({ name }) =>
      guarded("monitor_remove", () => {
        scheduler.removeMonitor(name);
        return `Removed monitor "${name}".`;
      }),
  );

  server.registerTool("monitors", { description: "List active monitors.", inputSchema: {} }, () =>
    guarded("monitors", () => scheduler.listMonitors()),
  );

  return server;
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function readJson(req: http.IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const NotifyBody = z.object({ text: z.string().min(1).max(4000), urgent: z.boolean().optional(), source: z.string().max(80).optional() });

export function startHqServer(deps: Deps): Promise<http.Server> {
  const { cfg, store, onUpdate, readiness } = deps;
  const startedAt = Date.now();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const header = req.headers["x-correlation-id"];
    const correlation = typeof header === "string" && header.length > 0 && header.length <= 128 ? header : newCorrelationId("mcp");
    res.setHeader("x-correlation-id", correlation);
    try {
      await runWithCorrelation(correlation, async () => {
        // Liveness: the process is up and the event loop is serving. Never checks dependencies.
        if (url.pathname === "/health" && req.method === "GET") return send(res, 200, { ok: true, status: "alive", uptimeMs: Date.now() - startedAt });
        // Readiness: dependency state, used by the deploy health gate.
        if (url.pathname === "/ready" && req.method === "GET") {
          const report = readiness ? await readiness() : { ready: true, checks: {} };
          return send(res, report.ready ? 200 : 503, { ok: report.ready, ready: report.ready, checks: report.checks });
        }
        // Operational counters (no payloads, no secrets).
        if (url.pathname === "/metrics" && req.method === "GET") return send(res, 200, { ok: true, metrics: store.metrics() });

        if (url.pathname === "/notify") {
          if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
          if (!bearerMatches(req.headers.authorization, cfg.HQ_NOTIFY_TOKEN)) return send(res, 401, { error: "unauthorized" });
          const body = NotifyBody.safeParse(await readJson(req));
          if (!body.success) return send(res, 400, { error: body.error.issues.map((i) => i.message).join("; ") });
          const { text, urgent, source } = body.data;
          store.enqueueUpdate("notify", `${source ? `[${source}] ` : ""}${text}`, urgent ?? false);
          log.info(`notify${urgent ? " (urgent)" : ""}: ${truncate(text, 120)}`);
          onUpdate();
          return send(res, 202, { queued: true });
        }

        if (url.pathname === "/mcp") {
          if (!bearerMatches(req.headers.authorization, cfg.HQ_MCP_TOKEN)) return send(res, 401, { error: "unauthorized" });
          if (req.method !== "POST") return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
          // Stateless: a fresh server + transport per request.
          const mcp = buildMcpServer(deps);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          res.on("close", () => {
            void transport.close();
            void mcp.close();
          });
          await mcp.connect(transport);
          await transport.handleRequest(req, res, await readJson(req));
          return;
        }

        send(res, 404, { error: "not found" });
      });
    } catch (err) {
      log.error(`${req.method} ${url.pathname} failed`, err);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.HQ_PORT, cfg.HQ_HOST, () => {
      log.info(`listening on http://${cfg.HQ_HOST}:${cfg.HQ_PORT} (/mcp, /notify, /health, /ready, /metrics)`);
      resolve(server);
    });
  });
}
