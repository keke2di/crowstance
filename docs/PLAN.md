# Crowstance Implementation Plan

Status: planning baseline for the 2026-10-06 recon. This document is self-contained and is intended to be executed in order. It describes application, deployment, test, and documentation work; it does not itself change application behavior.

## Goals

- Make Telegram messaging recoverable across process restarts, provider outages, Telegram failures, ambiguous network outcomes, and partial multi-bubble sends.
- Preserve explicit authorization for outward-facing and destructive actions while making normal clarification text-first and less button-heavy.
- Deliver trustworthy, native Telegram map locations through a hybrid coordinate/geocoding flow.
- Use `crowbot/gpt-6-astra` with maximum reasoning effort by default, automatically recognize complex work, and delegate genuinely complex work to workers without losing cost control.
- Close the highest-priority security gaps and make deployments atomic, health-gated, and rollbackable.
- Add operational visibility and tested backups so failures are detected and recovery is repeatable.
- Keep the existing compact architecture: `src/opencode.ts` remains the only OpenCode boundary, SQLite remains the gateway ledger, and Telegram remains behind a fakeable `Chat` interface.

## Non-goals

- No redesign of the assistant into a multi-user product.
- No claim of mathematically guaranteed exactly-once Telegram delivery. Telegram can acknowledge neither success nor failure after a network timeout. The implementation must define and expose its duplicate-versus-loss policy.
- No filesystem isolation claim for workers sharing the `crow-agent` account. Realpath checks, service sandboxing, and project policy are separate controls.
- No automatic approval of outward, destructive, publishing, spending, messaging, deployment, or deletion actions.
- No live deployment work as part of this plan. Production changes require an operator-run release and rollback rehearsal.

## Parked Items

- **Image generation is parked.** Later it slots in after the durable outbox, typed artifact/media records, and secure artifact transfer are production-ready; it depends on that durable outbox and is not part of the milestones below.
- Incoming Telegram photos, documents, voice transcription, and image editing are also later capabilities, not prerequisites for this plan.

## Baseline and constraints

The recon reports Node 24, pinned `@opencode-ai/sdk` 1.18.34, 64 passing tests, and a passing typecheck. Current core files are `src/db.ts`, `conversation.ts`, `tasks.ts`, `approvals.ts`, `scheduler.ts`, `mcp.ts`, `opencode.ts`, `index.ts`, and `telegram/*`. The current failure mode is mark-before-send reply delivery in `conversation.ts`; inbound buffering, turn metadata, and delivery state are also partly in RAM. The current deployment is an in-place rsync update, and the backup unit runs agent-controlled Git outside the OpenCode sandbox.

All milestones must retain `npm run typecheck` and `npm test` as gates. New schema changes must work against a fresh database and a copy of a representative existing database. Do not read `.env`, `deploy/secrets.env`, or `/etc/crowstance/*` while implementing or testing repository code.

## Workstreams

### A. Durable messaging ledger and delivery

**Touches:** `src/db.ts`, `src/conversation.ts`, `src/index.ts`, `src/telegram/chat.ts`, `src/telegram/bot.ts`, `src/scheduler.ts`, `src/tasks.ts`, `src/approvals.ts`, `src/mcp.ts`, likely new `src/delivery.ts` and `src/migrations.ts`; tests in `test/db.test.ts`, `conversation.test.ts`, `chat.test.ts`, `integration/recovery.test.ts`.

**Decisions:** Add versioned SQLite migrations, not a growing unversioned `SCHEMA` string. Persist inbound records before Telegram acknowledgement, turn records with kind/urgency/session/generation, and typed outbound records with stable logical IDs, chunk sequence, payload, attempt count, next-attempt time, and explicit states such as `pending`, `sending`, `sent`, `retryable`, `failed`, and `unknown`. A lease/claim prevents two senders from working the same row. Persist Telegram message IDs per successful chunk. Retry transient failures with bounded exponential backoff and jitter; after the terminal limit keep the row visible to operations and notify the owner through a separate recovery path.

The policy for an ambiguous timeout is: do not silently discard content; retry important content and mark the attempt `unknown`/duplicate-risk. The operator can choose occasional duplicates over silent loss. A deterministic idempotency key should be sent where Telegram supports it, but it is not treated as a guarantee. Multi-chunk text and future typed events must be independently recoverable. Delivery must not mark source assistant messages delivered until the outbound logical event is durably recorded.

### B. Approval and lifecycle correctness

**Touches:** `src/approvals.ts`, `src/tasks.ts`, `src/index.ts`, `src/scheduler.ts`, `src/db.ts`; tests in `test/approvals.test.ts`, `test/tasks.test.ts`, `test/scheduler.test.ts`, and concurrency/recovery integration tests.

**Decisions:** Reconcile approvals using a successful snapshot watermark. A failed `permission.list` or `question.list` never means “gone”; only a successful snapshot can expire a missing request. Persist each approval presentation step and allow retry after failed Telegram sends or failed OpenCode replies. Bind replies to request ID and message ID, honor `custom: false`, cap rendered question sizes, and keep expiry explicit.

Remove the `Always` permission button. Keep `Once` and `Deny` for bounded risky choices, add a request-bound text fallback such as `allow once`/`deny`, and reject unbound casual “yes”. Keep explicit consent for outward/destructive actions. Questions are text-first; option buttons remain only for genuinely bounded choices and multi-select completion. Add CAS/transition guards for task terminal states, admission reservations, per-task locks, per-project/job overlap policy, confirmed abort outcomes, and transactional update enqueueing.

### C. Native tappable locations

**Touches:** new provider-agnostic `src/geocoder.ts` adapter and tests; `src/mcp.ts`; `src/index.ts`; `src/telegram/chat.ts`; `src/conversation.ts` or the delivery dispatcher; `src/config.ts`; `src/db.ts`; prompt files `opencode/prompts/assistant.md` and possibly `worker.md`; `.env.example` only if non-secret configuration is added; tests in `test/geocoder.test.ts`, `test/mcp.test.ts`, `test/chat.test.ts`, and integration tests.

**Tool surface:** an HQ tool such as `location_share` accepts `name`, optional `address`, optional `latitude`/`longitude`, optional `maps_url`, and `confidence` plus source/provenance. The tool creates a typed outbound location event; MCP must not call Telegram directly. Persist the event before delivery, and route it through the same outbox and explicit-action policy as text.

**Hybrid behavior:** validate finite coordinates in latitude `[-90, 90]` and longitude `[-180, 180]`; if confident coordinates are available, use them. If there is a specific address/place but no coordinates, call the injected geocoder. If geocoding yields one sufficiently confident result, present/send it according to consent policy. If results are ambiguous, return candidates and ask the user to choose before sending any pin. Never silently turn an uncertain place name into a pin. `sendLocation` is the default native delivery; use `sendVenue` only when name/address are verified and useful. A maps URL is fallback/explicitly requested, not a redundant default.

The geocoder adapter has a provider-neutral interface, bounded timeout, request rate limit, result count/size limits, validation, and no raw query logging. Provider keys live in validated configuration and are never included in model text or logs. Document the privacy trade-off: geocoding exposes a user’s search intent/location to the provider; caching is opt-in with a short retention policy. The tool remains owner-only and cannot target arbitrary chats.

### D. Maximum reasoning and bounded complexity escalation

**Touches:** `src/opencode.ts`, `src/conversation.ts`, `src/tasks.ts`, `src/db.ts` turn metadata, `opencode/prompts/assistant.md`, `opencode/prompts/worker.md`, `opencode/opencode.json`, `src/config.ts`, and tests in `test/opencode.test.ts`, `conversation.test.ts`, `tasks.test.ts`.

**Decisions:** Default every turn and worker to maximum reasoning effort. Propagate `reasoning_effort`/variant through `src/opencode.ts` only after verifying the pinned OpenCode SDK 1.18.34 and server contract, including the exact field name, supported values, and whether it belongs in `promptAsync`, model variant, or agent configuration. Add an adapter contract test that captures the outgoing request shape; do not rely on a TypeScript cast or undocumented provider behavior. Persist selected effort/variant on the turn/task so debounce, queueing, retries, and restart preserve it.

Complexity detection is a bounded policy, not raw private chain-of-thought: signals can include multi-step wording, code/research/setup scope, explicit planning, multiple files/systems, or a likely worker task. For genuinely complex work, the assistant uses `hq_task_start` and a self-contained brief; it does not attempt an unbounded inline turn. The prompt asks for decisions, assumptions, checks, and concise rationale, never private reasoning traces. Worker prompts explicitly require planning, verification, and a final report.

Cost control is mandatory: Astra is `$0.30/M` input and `$1.50/M` output in the current configuration, and reasoning tokens bill as output. Add per-turn estimated/actual usage, a daily reasoning budget/reserve, max duration/output guardrails, and a warning/approval path before exceeding budget. Cover chat, resumed workers, scheduled jobs, and reasoning tokens in one accounting view. A budget guard can downgrade/stop new complex work, but must not claim a hard provider ceiling without provider-side limits.

### E. Security and deployment safety

**Touches:** `deploy/systemd/crowstance-backup.service`, `deploy/systemd/crowstance-opencode.service`, `deploy/systemd/crowstance-gateway.service`, `deploy/systemd/crowstance-netguard.service`, `deploy/netguard.sh`, `deploy/setup.sh`, `deploy/update.sh`, `deploy/install-units.sh`, `deploy/doctor.sh`, `deploy/deploy.sh`, and deployment tests under `test/deploy/` or shell-test tooling.

**Decisions:** First sandbox the backup path, disable Git hooks/config injection, constrain the export and network permissions, and preferably use a dedicated backup identity/fixed export. Make deployed code, unit templates, and root-executed scripts root-owned and non-writable by `crow-gateway`; service-writable locations contain data only. Make netguard startup ordering fail closed, or narrow the documented guarantee if the platform cannot enforce it; test TCP/UDP/IPv6/UNIX-socket boundaries in an isolated environment.

Replace in-place update with immutable release directories, verified archive/checksum, dependency install into the release, preserved secrets/config overlays, atomic symlink/current-pointer switch, service health/readiness gate, and automatic rollback to the previous release on failed health. Never delete the last known-good release. Validate effective systemd/SSH configuration before reload. This work is operator-tested and must not touch `/opt/crowstance` from this repository task.

### F. Observability, backup, and operations

**Touches:** `src/log.ts`, `src/index.ts`, `src/mcp.ts`, `src/db.ts`, `src/conversation.ts`, `src/tasks.ts`, `src/scheduler.ts`, `src/provider.ts`, deployment health/backup scripts, and new docs `docs/ARCHITECTURE.md`, `docs/MODULES.md`, `docs/OPERATIONS.md`, `docs/CONTRIBUTING.md` in a later documentation milestone.

**Decisions:** Add structured correlation IDs for inbound update, turn, OpenCode request, MCP call, approval, and outbound delivery. Redact tokens, raw coordinates, provider queries, and sensitive tool payloads. Expose readiness separately from liveness, including OpenCode/Telegram/dependency state. Track queue depth/age, retries, ambiguous sends, approval age, turn latency, worker transitions, monitor runs, provider errors, and spend. Bound history, update queues, activity/error maps, and media/artifact retention; add measured indexes.

Back up SQLite, OpenCode session state, projects, and selected assistant memory with encryption, retention, privacy screening, and an off-host destination. A restore drill is part of acceptance; a local Git commit is not a backup proof.

## Sequenced milestones

Each milestone is independently shippable after its exit criteria and tests pass. Parallel implementation is possible inside a milestone, but the release order below is intentional.

### M1. Durable ledger and recoverable text delivery (recommended first)

**Why first:** it fixes the highest-value silent-loss defect and becomes the transport for locations, approval presentation recovery, reminder reliability, and future image/media delivery.

**File-level changes:**

- `src/db.ts` plus new `src/migrations.ts`: schema versioning; inbound, turn, outbound event, outbound chunk, lease, and delivery-attempt records; indexes and transactional claim/update methods.
- `src/conversation.ts`: persist inbound before processing, persist turn generation/kind/urgency, use watermarks/pagination instead of the 40-message assumption, and enqueue typed text/error events before marking assistant output observed.
- `src/delivery.ts` (new): claim, retry, backoff, ambiguous outcome, permanent failure, and drain logic.
- `src/telegram/chat.ts`: expose a low-level typed send result and preserve per-chunk IDs; keep the fakeable interface.
- `src/index.ts`: start delivery worker, recover leases, drain on shutdown, and avoid closing SQLite before delivery work is settled.
- `src/scheduler.ts`/`src/tasks.ts`: make update enqueue and source transitions transactional where possible.
- `test/fakes.ts` and new `test/db.test.ts`, `test/delivery.test.ts`, `test/recovery.test.ts`.

**Tests:** crash after inbound persistence; restart with buffered inbound; crash before/after outbound claim; Telegram transient failure and retry; timeout marked ambiguous; partial multi-chunk success; duplicate idle; pagination beyond 40 messages; quiet/urgent delivery; no loss on SQLite file-backed restart; graceful shutdown/drain. Test the documented duplicate policy rather than asserting impossible exactly-once behavior.

**Exit:** a failed Telegram send remains pending/retryable and is eventually retried; every inbound and turn is recoverable from the DB; no source output is permanently suppressed solely because a send failed; `npm test` and typecheck pass.

### M2. Failure-aware approvals and explicit consent UX

**File-level changes:** `src/approvals.ts`, `src/db.ts` approval snapshot/delivery fields, `src/telegram/bot.ts` text reply routing, `src/opencode.ts` reply helpers if needed, `opencode/prompts/assistant.md`, and approval/concurrency tests.

**Tests:** list failure does not expire requests; successful snapshot does expire absent requests; keyboard send partial failure retries; OpenCode reply failure leaves a retryable request; bound `allow once`/`deny` text works; unbound “yes” does not authorize; `custom: false` rejects free text; oversized/multipart questions recover; concurrent tap/text answers are single-shot.

**Exit:** no `Always` button; ordinary clarification is text-first; option buttons exist only for bounded choices; outward/destructive approvals remain explicit and recoverable.

### M3. Task, reminder, and scheduler state correctness

**File-level changes:** `src/tasks.ts`, `src/scheduler.ts`, `src/db.ts`, `src/index.ts`, possibly new lock/transition helper; tests in `tasks.test.ts` and `scheduler.test.ts`.

**Tests:** concurrent starts cannot exceed worker limit; slug/session collisions do not orphan sessions; CAS prevents duplicate idle completion and stop overwrite; resume path enforces budget/capacity; confirmed versus failed abort is represented correctly; reminder fire and enqueue are crash-safe/idempotent; scheduled jobs cannot overlap a shared project; monitor PTY deadline/exit/restart recovery works; housekeeping tick cannot overlap.

**Exit:** task and reminder state reflects confirmed outcomes, not merely attempted network calls; each important update is transactionally queued and delivered through M1.

### M4. Native tappable map locations

**File-level changes:** new `src/geocoder.ts`; `src/mcp.ts` location tool; `src/telegram/chat.ts` `sendLocation`/`sendVenue`; typed delivery payload handling in `src/delivery.ts` and `src/index.ts`; `src/config.ts` provider timeout/rate-limit/key settings; prompt guidance in `opencode/prompts/assistant.md`; DB event schema extension if not completed in M1.

**Tests:** coordinate range/finite validation including antimeridian; confident-coordinate `sendLocation`; verified name/address `sendVenue`; provider timeout/rate-limit; one candidate versus ambiguous candidates; user choice required before pin; key absence and provider error; privacy-safe logs; retry/duplicate behavior; quiet-hour behavior; Telegram API failure and native payload assertions; owner/session authorization.

**Exit:** a valid location arrives as a Telegram-native tappable pin, not merely a text address; ambiguous geocoding cannot send a pin without user choice; all sends use the durable outbox and explicit outward-action rule.

### M5. Max reasoning and complexity delegation

**File-level changes:** `src/opencode.ts` request contract; `src/conversation.ts` and `src/tasks.ts` turn/task effort metadata; `src/db.ts` usage/budget fields; `src/config.ts`; `opencode/prompts/assistant.md`, `worker.md`, and `opencode.json` only as needed; new `test/opencode.test.ts`.

**Tests:** pinned SDK/server contract fixture verifies `max` propagation; unsupported variant fails clearly or uses a documented fallback; restart preserves effort; complex request delegates once with a complete brief; simple request does not spawn a worker; reasoning usage is accounted as output; daily budget blocks/asks at the configured threshold across chat, workers, resumes, and scheduled jobs; no raw reasoning trace is delivered.

**Exit:** maximum reasoning is the default, complex work escalates automatically and boundedly, Astra spend is visible and guarded, and no design relies on an unverified SDK field.

### M6. Security boundary corrections

**File-level changes:** backup systemd unit and export script; service sandbox units; root ownership/mode enforcement in `setup.sh`, `update.sh`, `install-units.sh`; netguard ordering/config; doctor checks; deployment test fixtures.

**Tests:** backup cannot execute hooks or access outside its allowlisted export; gateway user cannot modify root-executed code/templates; unit hardening is rendered and validated; netguard behavior is tested in an isolated namespace for supported protocol families; doctor detects wrong ownership/modes and missing dependencies.

**Exit:** the backup no longer provides an unsandboxed agent-controlled execution path; privileged deployment artifacts are not gateway-writable; documented isolation claims match tested enforcement.

### M7. Atomic deploy, health gate, and rollback

**File-level changes:** `deploy/update.sh`, `deploy/setup.sh`, `deploy/deploy.sh`, `deploy/install-units.sh`, `deploy/doctor.sh`, systemd readiness dependencies, and release helper scripts.

**Tests:** upload checksum/manifest rejection; dependency failure leaves current release untouched; atomic pointer switch; gateway/OpenCode readiness gate; failed restart rolls back; secrets/config overlays survive; old release remains available; interrupted update is recoverable; SSH validation refuses unsafe lockout configuration.

**Exit:** an upgrade cannot leave a mixed active tree, and a failed health check returns the service to the last known-good release without deleting it.

### M8. Observability, backups, and operational documentation

**File-level changes:** structured logging/metrics and readiness in `src/log.ts`, `src/index.ts`, `src/mcp.ts`, `src/delivery.ts`, `src/tasks.ts`, `src/scheduler.ts`; retention/index migrations; backup/export tooling; new `docs/ARCHITECTURE.md`, `docs/MODULES.md`, `docs/OPERATIONS.md`, `docs/CONTRIBUTING.md`; focused README corrections.

**Tests:** correlation IDs survive a full inbound-to-delivery path; redaction tests; readiness reports dependency failure while liveness remains meaningful; queue age/retry/spend metrics; retention does not delete pending work; encrypted backup manifest; restore into a clean temporary environment and verify sessions/tasks/reminders/memory; runbook commands are syntax-checked.

**Exit:** operators can see degradation before silent loss, restore a representative state backup, and follow documented upgrade, rollback, incident, privacy, and recovery procedures.

### M9. Gateway-owned subagents, model routing and hard spend caps

**Goal:** the chat hands focused jobs to subagent *kinds* through `hq_delegate`; each kind has its own job, tools, model and effort, with a default for all subagents (the crowbot-cli shape: call → your pick for the kind → its config → your pick for all → `every` → the chat). The gateway checks every model against crowbot's live catalog, enforces hard spend caps, and discovers the kinds from OpenCode. Only the main chat delegates; subagents can't nest. See `docs/SUBAGENTS.md`. (A first version picked models by price tiers; it was replaced because tiers hid what each kind actually ran on.)

**File-level changes:** new `src/catalog.ts`, `src/kinds.ts`, `src/roles.ts`, `src/limits.ts`, `src/subagents.ts`, `src/errors.ts`, `config/kinds.json`, `scripts/models-sync.ts`, `opencode/prompts/subagents/*.md`; migration v9 (`session_costs`, `subagent_runs`, `tasks.model_from`); `hq_delegate` in `src/mcp.ts`; `/model` roles card and `/limits` in `src/telegram/bot.ts`; event wiring and cap enforcement in `src/index.ts`; `subagent` agents, `"task": false` and a 150 s `hq` timeout in `opencode/opencode.json`; doctor checks.

**Verified against OpenCode 2.0.32 first (2026-10-24):** an agent's configured `model` is ignored (sessions use the global model unless one is set at creation or via `/model`); `session.usage.updated` carries running totals; `limit` with `order=asc` returns the *oldest* messages; MCP tools are called through Code Mode (`execute`) and the `hq` timeout is enforced; the built-in task tool is `subagent` and `"task": false` removes it; right after a restart `/api/agent` is empty, then lists only built-in agents; OpenCode caches an MCP server's tool list from when it connected (reconnect to refresh); `/api/model` returns `cost` as a list of price tiers.

**Fixed on the way:** spend was overcounted (running totals summed); worker reports and chat replies read the first page of long sessions; the configured assistant/worker models were never sent; a worker whose last step was tool calls reported nothing; most requests ignored their directory (v2 reads `location[directory]`), which broke worker repo creation; permission and question prompts never reached Telegram (v2 sends `permission.asked` and `form.created`), so a turn could block forever; single-choice answers were sent as lists and rejected; the watchdog called a session idle mid-run (the inbox empties on delivery); `/stop` showed an error.

**Tests:** catalog intersection, drift, cache-on-failure and fallback; resolver order (kind → all subagents → chat), effort inheritance, price ceiling, no silent fallback, effort dropping; kind tools from opencode.json; cap clamping, floor, preflight, running-total accounting, catalog-priced increase, task/call/turn/daily breaches; delegation happy path, last-text answer, detach-to-update, limits, cap stop with partial answer, failure, restart recovery; `hq_delegate` description; adapter wire format (desc+reverse, child session model/variant).

**Exit:** a delegation runs on its kind's model with its effort, is refused or interrupted at every cap, and its cost shows per kind; `/model` shows and changes the model of the chat, all subagents, each kind and the workers.

**Ceilings:** a model new to crowbot is usable only after `npm run models:sync` and a deploy with `--restart-opencode`; a kind's tools are read from `opencode/opencode.json`, so an agent defined elsewhere (a built-in, an agent file) is listed without them; caps act on usage events, so one model step can overshoot a cap before the interrupt lands.

## Risk register

| Risk | Impact | Detection / mitigation |
|---|---|---|
| Telegram timeout after server accepted a message | Duplicate or missing user-visible content | Explicit `unknown` state, retry policy, delivery metrics, operator-visible permanent failures, integration tests with ambiguous fake responses |
| Crash between source observation and outbox commit | Lost reply/update | Single SQLite transaction or durable event first; file-backed crash/restart tests |
| Crash during multi-chunk delivery | Duplicate/missing chunk | Chunk-level state and IDs; partial-send tests |
| SQLite migration or lock bug | Startup failure or corrupted queue | Versioned migrations, backup before migration, fresh/upgrade fixtures, busy/locking tests |
| Failed approval list mistaken for disappearance | Agent remains blocked or request is falsely expired | Successful-snapshot watermark and outage tests |
| Concurrent task/idle/stop transitions | Duplicate work, orphan sessions, wrong terminal state | Admission reservations, CAS/locks, concurrency tests and transition audit logs |
| Wrong geocoded place | User is sent to a harmful/wrong destination | Coordinate provenance/confidence, candidate choice for ambiguity, no silent low-confidence pin, location-specific tests |
| Geocoder privacy/key exposure | Sensitive location intent leaks | Provider abstraction, bounded retention, redacted logs, config validation, no key in prompts |
| OpenCode SDK ignores reasoning effort | Cost/quality behavior differs from plan | Pin and inspect contract, outgoing request fixture, provider integration gate, clear fallback |
| Max reasoning exhausts daily budget | Unexpected provider spend or blocked work | Output-token accounting, per-turn reserve, daily cap/warning, budget tests and provider-side cap |
| Fewer buttons become accidental authorization | Outward/destructive action occurs without consent | Request-bound text commands, explicit prompt/tool wording, negative authorization tests |
| Backup Git hook or config executes agent-controlled code | Security boundary bypass | Hook-disabled fixed environment, service sandbox, dedicated identity, deployment tests |
| Root-running release script is modified by gateway | Privilege escalation | Root-owned immutable artifacts, doctor ownership checks, release tests |
| Atomic deploy health check is too weak | Bad release stays active | Readiness endpoint checks dependencies and queue health; forced-failure rollback test |
| Backup is private, incomplete, or unrestorable | Permanent data loss or unintended disclosure | Encryption/retention policy, manifest, restore drill, privacy screening |
| Observability logs sensitive payloads | Privacy/security incident | Structured redaction tests and raw-payload prohibition |

## Test strategy

### Unit tests

Keep pure validation and formatting tests close to their modules: migration/version decisions, delivery state transitions/backoff, coordinate validation, geocoder candidate ranking, model/effort parsing, complexity classification, budget arithmetic, approval binding, scheduler intervals, task transition guards, redaction, and readiness state mapping. Use deterministic clocks and injected network/Telegram/OpenCode fakes.

### Integration tests

Use a real temporary file-backed SQLite database, not only `:memory:`. Exercise the gateway composition with fake OpenCode, fake Telegram API, and fake geocoder. Cover restart by closing and reopening the store, crash points by stopping between durable steps, SSE disconnect/reconcile, partial Telegram sends, approval outages, task races, scheduler ticks, native Telegram payloads, and delivery retries. Add an OpenCode adapter contract test against the pinned SDK types and a captured fake HTTP server; any live provider verification is an explicit operator/integration environment step and must not require repository secrets.

### Deployment tests

Render systemd units and inspect ownership/mode/ordering. Run update scripts against temporary release roots with fake `systemctl`, `npm`, and health endpoints. Test failed package install, failed health, interrupted switch, preserved config overlay, rollback, backup sandbox, and netguard behavior in an isolated namespace where available. Do not run these against `/opt/crowstance` as part of repository development.

### Required gates by milestone

Before M1: existing 64 tests plus ledger/restart/partial-send tests. Before M2: M1 plus failed approval snapshot/reply and consent tests. Before M3: M2 plus concurrency, reminder transaction, overlap, and monitor recovery tests. Before M4: M3 plus geocoder and native Telegram integration tests. Before M5: M4 plus adapter contract and cost-budget tests. Before M6: M5 plus deployment sandbox/ownership tests. Before M7: M6 plus forced rollback and readiness tests. Before M8: M7 plus restore drill, redaction, readiness, metrics, and runbook checks.

## Open questions for the user

1. For an ambiguous Telegram outcome, confirm the recommended policy: retry important content and surface duplicate risk, preferring an occasional duplicate to silent loss.
2. What should count as “genuinely complex” for automatic worker delegation beyond the proposed multi-step/code/research/multi-file signals?
3. Should the reasoning budget be a fraction of `DAILY_BUDGET_USD`, a separate `DAILY_REASONING_BUDGET_USD`, or both? Should exceeding it ask for consent or stop/downgrade automatically?
4. Which geocoder provider is acceptable, and may location queries be sent to a third party? How long, if at all, may candidate/location data be retained for retries?
5. Confirm that `sendLocation` is the default and `sendVenue` is only for verified named places. Should every pin require an explicit “send it” confirmation, or may a user’s direct request count as consent?
6. Should worker tasks in one project queue, use independent worktrees, or be rejected while another task is active?
7. What are acceptable recovery-point and recovery-time objectives for SQLite, OpenCode state, projects, and memory, and where may encrypted off-host backups live?
8. Is the production host dedicated or shared, and which neighboring paths/services must the tested security policy protect?
9. Is the daily budget a strict total cap including chat, resumed tasks, scheduled jobs, and reasoning, or only a new-worker admission warning?
10. Should approval events from OpenCode sessions not created by this gateway be ignored, or is the server exclusively owned by crowstance?

## Future workstream (not scheduled): Acting on the user's behalf

Direction (user, 2026-10-06): the assistant eventually performs real-world actions *as the user*, starting with things like food ordering. Agreed mode is **prepare-and-confirm**: the agent does everything up to payment — builds the basket, fills the forms, picks the slot — and the user taps once to confirm. Never silent spending.

This is built on the same rails as M1/M2 (durable delivery + explicit consent), so it lands after them.

Design constraints:
- Payment via a virtual/single-use card with hard per-order and monthly caps; never the user's real card.
- Official APIs/partners preferred; browser automation only where there is no alternative, running in its own sandbox with its own network identity.
- Credentials in a vault the agent can *use* but not read back, scoped per service.
- Full audit log of actions and rationale.
- Start with one low-stakes service.

Known risks: prompt injection combined with live credentials; delivery-app ToS ban automation (account-ban risk); VPN/datacenter IPs trigger fraud checks and card declines — a VPN is not a solution to those.
