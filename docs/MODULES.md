# Modules

A short reference for what each file owns and where to look when changing behaviour. The
gateway is deliberately compact; `src/opencode.ts` is the only OpenCode boundary and
`src/telegram/chat.ts` is the only Telegram boundary, so both are easy to fake in tests.

## Runtime

### `src/index.ts`
Composition root. Loads config, constructs `Store`, `OpenCode`, `TelegramChat`, `Delivery`,
`Conversation`, `Tasks`, `Approvals`, `Scheduler`; starts the hq HTTP server before OpenCode
connects; dispatches the global SSE event stream; installs shutdown handlers. Also owns
`readiness()` (store/OpenCode/Telegram) and `pruneHistory()` (daily retention).

### `src/config.ts`
Zod-validated environment configuration (`loadConfig`). Resolves `ASSISTANT_HOME`,
`PROJECTS_DIR`, `DATA_DIR` to absolute paths and parses quiet hours. Budget, worker, disk,
monitor and `RETENTION_DAYS`/`LOG_LEVEL` settings live here. `parseModelRef` splits
`provider/model`.

### `src/log.ts`
Structured logging with correlation ids and redaction. `logger(scope)`, `newCorrelationId`,
`runWithCorrelation` / `correlationId` (AsyncLocalStorage), `redactValue` / `redactText` /
`redact`. Log lines look like
`<iso> INFO  [scope] correlation=<id> message {json}` and never contain secrets or raw
coordinates.

## Persistence

### `src/db.ts`
The `Store` class: every SQLite read/write. KV, tasks + reservations, updates, inbound
messages, turns, outbound events/chunks, leases and attempts, approvals + snapshots,
reminders, jobs, monitors, spend, reasoning usage. Also `metrics()` (queue age, retries,
spend) and `applyRetention()` (bounded terminal history; never pending work).

### `src/migrations.ts`
Versioned schema migrations (`MIGRATIONS`, `migrate`). v1 core tables; v2 durable ledger; v3
approval snapshots/presentation; v4 reservations and monitor state; v5 reasoning usage; v6
correlation ids and retention/metrics indexes; v7 vault + action audit; v8 task-scoped
permission grants; v9 per-session running cost totals, subagent runs and `tasks.model_from`.

### `src/vault.ts`
Encrypted credential store for real-world actions. AES-256-GCM values with a key file outside
the database (`loadVaultKey`, generated 0600 on first use). `Vault.put`/`remove` are
operator-only (no MCP write path); `list` returns metadata only; `use` decrypts for
gateway-side action runners and records the access.

### `src/backup.ts`
Encrypted state backup and restore (`exportState`, `restoreState`, `verifyBackup`,
`readManifest`, `inspectState`, `pruneBackups`) plus the `export|restore|verify|check|prune`
CLI. AES-256-GCM with a scrypt-derived key; an encrypted manifest of checksums.

## Conversation and delivery

### `src/conversation.ts`
The main chat session. Persists inbound messages before acknowledgement, debounces bursts,
queues while busy, prioritises user messages over background updates, records turns with a
correlation id, delegates genuinely complex requests, and enqueues assistant output into the
durable outbox before marking it observed. `composeUserTurn` / `composeUpdateTurn` format the
prompts; `watchdog` and `reconcile` recover missed idle events.

### `src/delivery.ts`
The outbound delivery worker. Claims chunks under a lease, sends text/location/venue through
the `Chat` interface, applies bounded exponential backoff with jitter, marks ambiguous
outcomes `unknown`, and records permanent failures — surfacing each failed event to the owner
once as an urgent `system` update. `backoff` is exported for tests.

### `src/reasoning.ts`
Maximum-reasoning policy and cost guard. `reserveReasoning` estimates cost and blocks a turn
that would exceed `REASONING_DAILY_BUDGET_USD`. `isComplexRequest` is the bounded complexity
classifier; `completeBrief` builds the self-contained worker brief.

## Subagents, models and caps

See `docs/SUBAGENTS.md` for the design.

### `src/subagents.ts`
Gateway-owned subagents behind `hq_delegate`. Creates a child session of the main session with
the kind's agent, model and effort, waits for it to go idle, and returns the last text it wrote.
Detaches slow delegations (their answer becomes an update), interrupts at the timeout or a cap,
recovers running delegations after a restart, and lists them for `/tasks`.

### `src/roles.ts`
The single resolver for which model and effort the chat, all subagents, each kind and the workers
run on, shaped like crowbot-cli's: a kind's call → your pick for it → its `config/kinds.json`
entry → your pick for all subagents → `every` → the chat. Refuses unusable or over-ceiling models
(never a silent fallback). Also stores `/model` picks.

### `src/catalog.ts`
crowbot's live model catalog (`/v1/models`) crossed with OpenCode's model list: prices,
capabilities, effort levels, drift detection; cached in `kv`.

### `src/kinds.ts`
Discovers subagent kinds from OpenCode's agents (retrying the empty list OpenCode returns right
after it starts), merges `config/kinds.json` (model, effort, `when`, caps) and reads each kind's
tools from its agent entry in `opencode/opencode.json`.

### `src/limits.ts`
Spend caps: env ceilings plus `/limits` overrides, preflight refusals, running-total usage
accounting priced with the catalog, and the breaches `index.ts` enforces; cached crowbot balance.

### `src/errors.ts`
`UserError` (message safe to show) and `BudgetError` (a cap refused new work).

## Workers and approvals

### `src/tasks.ts`
Background worker lifecycle: project resolution, admission reservations, worker limit, disk
and budget guards, session creation, prompt submission, status/list/describe composition,
stop/abort, stuck detection and reconcile. `UserError` marks messages safe to show the user.
Tracks activity/error maps in memory.

### `src/approvals.ts`
Permission and question prompts. Persists each request and presentation step, sends Telegram
keyboards, binds taps and text replies to the request/message id, answers OpenCode, and
reconciles using successful-snapshot watermarks so an outage never expires a real request.
Nudges unanswered requests. Permissions offer Once / Task / Deny: "Task" records a
session-scoped grant (`permission_grants`) and later matching requests are auto-answered once.
There is no global "always".

### `src/scheduler.ts`
Time-based work: reminders, recurring cron jobs (with a minimum interval), monitor scripts
via OpenCode PTYs (with deadlines and recovery), quiet hours, morning check-in, the disk
watchdog, and a 20-second housekeeping tick. Guards against overlapping ticks.

## Boundaries

### `src/opencode.ts`
The only module that talks to the OpenCode server (v2 HTTP API under `/api/*`, server 2.0.x,
plain fetch — no SDK): sessions, prompts (with agent/model switching), inbox, messages,
permissions/forms (v2's questions), agents/models, MCP status, files, PTYs, and the
reconnecting global event stream (`/api/event` SSE).

### `src/telegram/chat.ts`
The fakeable `Chat` interface and its grammY implementation: `sendText`, `sendChunk`,
`sendLocation`, `sendVenue`, `sendHtml`, `editHtml`, `typing`. Classifies send failures as
`transient`/`permanent`/`ambiguous` for the delivery ledger.

### `src/telegram/bot.ts`
grammY bot, owner/private-chat middleware, typed commands (`/tasks`, `/actions`, `/stop`,
`/new`, `/model`, `/cost`, `/quiet on|off|today|auto`), a minimal published command menu,
callback routing for approvals, stuck-task buttons and model pickers, and text-reply routing.

### `src/telegram/format.ts`
Markdown → Telegram HTML rendering, escaping, chunking and bubble splitting.

### `src/mcp.ts`
The hq HTTP server: `/mcp` (assistant tools), `/notify` (monitor scripts), `/health`
(liveness), `/ready` (readiness), `/metrics`. Bearer authentication with constant-time
comparison, body-size limit, and per-request correlation ids. Also `buildMcpServer` with the
`hq_*` tools (locations, tasks, reminders, jobs, monitors, provider balance, vault listing,
action audit).

### `src/provider.ts`
crowbot balance lookup and formatting for `hq_provider_balance` / `/cost`.

### `src/geocoder.ts`
Provider-neutral geocoder adapter with timeout, rate limit, validation and result
disambiguation; coordinate/text/URL validators used by the location tool and delivery.

### `src/media.ts`
Media understanding pipeline. Photos, voice notes, audio and image documents arrive from
Telegram, are downloaded to a temp file, and become annotated text for the (text-only) model
via pluggable `OcrEngine`/`SttEngine` interfaces. Defaults are local CLI engines
(`TesseractOcr`, `WhisperCppStt` + ffmpeg wav conversion) so nothing leaves the server;
cloud engines slot in behind the same interfaces. Missing engines fall back to a polite
"I can't read that yet" reply, oversized files are refused at `MEDIA_MAX_MB`, and temp files
are always deleted.

### `src/text.ts`
Formatting and parsing helpers: slugs, truncation, durations, `usd`, `stamp`, `NO_REPLY`
handling, outcome parsing, day/month boundaries, quiet-hour ranges.

### `src/doctor.ts`
`npm run doctor`: end-to-end setup checks (config, Telegram, OpenCode, provider, home, hq) with
no model calls.

## Scripts and deployment

### `scripts/`
`dev-opencode.ts` (local OpenCode launcher), `dev-smoke.sh` / `dev-smoke.ts` (stub-model smoke
harness), `dev-stub-model.ts` (local OpenAI-compatible stub), `vault-add.ts` (operator CLI to
store vault credentials; reads the value from stdin), `models-sync.ts` (`npm run models:sync`:
rewrite the crowbot models in `opencode/opencode.json` from the live catalog; `--check` for CI).

### `config/kinds.json`
What subagents run on: `every` (the default model and effort for all kinds), `workers`, and per
kind `model`, `effort`, `when`, `max_call_usd`, `timeout_sec` and `enabled`. Only needs a gateway
restart.

### `deploy/`
- `deploy.sh` — operator side: audit, setup, or upload a checksummed update.
- `release.sh` — shared release helpers (verify, build, overlays, activate, recover).
- `update.sh` — server side: build off to the side, atomic switch, readiness gate, rollback.
- `setup.sh` — first install: users, immutable release, units, secrets, backup key, and (opt-in,
  `MEDIA_ENGINES=1`, asked interactively) local media engines: tesseract + ffmpeg via apt,
  whisper.cpp binary and model under `/opt/crowstance/bin`, written into the gateway env.
- `install-units.sh` — render and install systemd units from `deploy/systemd/`.
- `health-check.sh` — gateway `/ready`, OpenCode health, systemd unit state.
- `doctor.sh` — release-state and ownership checks.
- `netguard.sh` — shared-mode local network fence (M6).
- `backup.sh` — sandboxed nightly memory export (M6).
- `state-backup.sh` — encrypted state backup (SQLite + memory).
- `restore-drill.sh` — restore a state backup into a temp dir and verify it.
- `ssh-guard.sh`, `audit.sh` — SSH lockout guard and read-only server audit.
