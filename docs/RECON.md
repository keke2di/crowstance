# Crowstance Technical Recon

Survey date: 2026-10-06. Baseline: `ea8a1e3` (`Baseline: copy of crowstance app as deployed`). Recon only: no source changes, commits, pushes, live gateway operations, authenticated provider calls, or access to secret files. References are repository-relative `file:line` locations. Findings below are static code analysis unless explicitly described as executed verification; deployed sandbox behavior has not been penetration-tested.

## Executive Assessment

The architecture is compact and understandable: a text-only Telegram gateway manages durable records while OpenCode owns agent execution. The single OpenCode adapter and fakeable chat boundary make incremental changes feasible. All 64 existing tests and typechecking pass. This is a good personal-assistant foundation, but not yet a reliable production messaging system.

**Highest-value first fix: replace mark-before-send reply delivery with a durable outbound queue and explicit delivery states.** A Telegram failure currently loses the response permanently, despite the documented exactly-once claim. Persist inbound messages too. True exactly-once sending cannot be guaranteed across an ambiguous Telegram network timeout; define retry/duplicate policy rather than claiming it.

Security priorities alongside that work are closing the unsandboxed backup execution path and ensuring privileged deployment scripts are not gateway-writable. Requested capabilities are feasible, but image delivery requires new media plumbing, and crowbot does not document an OpenAI-compatible image endpoint.

## Scope and Inventory

Read all 16 `src` TypeScript files, all eight test suites plus `test/fakes.ts`, README, package manifest, TypeScript configuration, safe environment examples, gitignore, both OpenCode prompts and its configuration, the development launcher, all eight top-level deployment scripts/examples, all seven systemd templates, and all three assistant-home seed files. No `.env`, `deploy/secrets.env`, or `/etc/crowstance/*` secrets were read. Dependency installation was inspected through its output and lockfile diff, not by treating generated dependencies as application source.

Key files:

| Area | Responsibility and entry points |
|---|---|
| Composition | `src/index.ts:29`: constructs config/store/adapter/bot/conversation/tasks/approvals/scheduler, starts HQ, waits for OpenCode, then starts SSE, scheduler, and polling |
| OpenCode boundary | `src/opencode.ts:55`: SDK v2 wrapper for sessions, prompts, status, messages, todo, permissions/questions, providers, MCP, files, PTYs, global SSE |
| Main conversation | `src/conversation.ts:47`: debounced RAM inbox, serialized operations, persisted session/delivery IDs, typing, user/update turns, rotation |
| Workers | `src/tasks.ts:48`: project resolution, limits, session creation, lifecycle/status reporting, stuck detection, reconciliation |
| Approvals | `src/approvals.ts:40`: durable requests, Telegram keyboards, answer collection, OpenCode replies, expiry and nudges |
| Scheduling | `src/scheduler.ts:34`: 20-second housekeeping, cron, reminders, PTY monitors, quiet hours, check-in, disk threshold |
| HQ | `src/mcp.ts:37`, `src/mcp.ts:252`: 15 MCP tools, authenticated notify API, health endpoint |
| Telegram | `src/telegram/bot.ts:58`: owner/private-chat filter and commands; `chat.ts:18`: API delivery; `format.ts:38`: Markdown rendering |
| Persistence | `src/db.ts:84`: SQLite KV, tasks, updates, approvals, reminders, jobs, monitors, spend; WAL and busy timeout at line 166 |
| Utilities | `src/config.ts:10`: Zod env validation; `text.ts:3`: formatting/status/time helpers; `log.ts:10`: scoped console logging; `provider.ts:9`: balance API |
| Diagnostics | `src/doctor.ts:34`: config, Telegram, OpenCode, provider, home, MCP checks; optional repo creation |
| Runtime/prompts | `opencode/opencode.json:40`: assistant and worker roles; prompts define delegation, memory, approval expectations and final report contract |
| Operations | `deploy/setup.sh:20`, `deploy/update.sh:7`, `deploy/install-units.sh:11`: installation, in-place updates, unit rendering; netguard and nightly memory backup |

## Architecture Map

```text
Owner's private Telegram chat
  -> grammY polling + owner/private-chat middleware
  -> commands / approval replies / debounced Conversation inbox
  -> OpenCode adapter -> authenticated OpenCode HTTP + global SSE
                          -> main assistant session in ASSISTANT_HOME
                          -> worker sessions in PROJECTS_DIR/<project>
                          -> model provider + filesystem/bash/web tools
                          -> hq MCP calls back into gateway
  <- idle event -> completed visible assistant text -> Telegram HTML

Gateway SQLite: session/model KV, tasks, pending updates, approvals,
                reminders, recurring jobs, monitors, completed-message spend
Scheduler -> task_start OR sandboxed OpenCode PTY monitor
Monitor -> notify.sh -> bearer-auth /notify -> durable update queue
Update queue -> main assistant -> useful reply OR NO_REPLY
```

The gateway runs as `crow-gateway`, holds the bot token, and writes `/var/lib/crowstance`; it cannot access the agent home under its service sandbox (`deploy/systemd/crowstance-gateway.service:20`). OpenCode runs as `crow-agent`, has its home bind-mounted writable, a private tmp, and a read-only system (`deploy/systemd/crowstance-opencode.service:26`). Both belong to a resource-capped slice. Shared-mode netguard restricts selected local TCP destinations and Docker bridges by UID, not by individual task (`deploy/netguard.sh:30`). All workers share that agent account and can access each other's projects and agent credentials; project directories are organizational, not security isolation.

### Main Message and Reply Flow

1. `src/telegram/bot.ts:60` rejects non-owner/non-private updates. Text replies to outstanding questions are consumed first (line 147); remaining text enters `Conversation.onUserMessage` with Telegram timestamp and quoted reply context (line 151). Media is rejected at line 158.
2. `src/conversation.ts:134` buffers a burst and resets a debounce timer. `pumpLocked` prioritizes user messages over background updates (line 148). `run` serializes conversation work (line 87).
3. `ensureMainSession` retrieves/verifies or creates the long-lived session and persists its ID and since timestamp (line 93). Model precedence is persisted `/model` choice, environment override, then OpenCode agent default (lines 114 and 121).
4. `send` sets busy/turn/urgency state, starts typing for user turns, and submits `promptAsync` through `src/opencode.ts:101`. The assistant can use native tools and assistant-enabled HQ tools (`opencode/opencode.json:37`).
5. SSE dispatch handles busy/idle, approvals, errors, activity, and completed-message spend (`src/index.ts:75`). Main idle retrieves at most 40 recent messages, selects completed/unseen assistant text, records delivery IDs, suppresses a final `NO_REPLY`, then sends formatted Telegram messages (`src/conversation.ts:227`).
6. `src/telegram/chat.ts:27` splits short paragraphs into bubbles and long text into chunks; HTML failures with HTTP 400 fall back to plain Markdown (line 52). `/new` asks the old assistant to save memory before creating another session (`src/conversation.ts:269`).

### Worker Lifecycle

`hq_task_start` validates tool input (`src/mcp.ts:56`) and calls `Tasks.start`. Disk, daily-spend and active-worker checks run first; project initialization happens through OpenCode PTYs so the gateway needs no filesystem access (`src/tasks.ts:103`, `src/opencode.ts:149`). A unique slug/session row is created and a self-contained brief submitted. Status reports combine persisted rows with live status, todos, summaries, cost, recent messages and approvals (`src/tasks.ts:205`).

Busy/activity events refresh state; errors are cached until idle. Idle fetches the latest assistant report and maps `Status: needs-input` to waiting, other non-error outcomes to finished, errors to failed (`src/tasks.ts:283`). It enqueues a main-chat update. Follow-up messages can restart a finished task (line 161); stop records stopped then requests abort (line 174). Reconnect reconciles active task status by directory (line 320). Stuck detection merely alerts; it does not repair or cancel work.

### Scheduler and Notifications

Startup re-arms enabled cron jobs and immediately starts a 20-second tick (`src/scheduler.ts:63`). Tick queues due reminders as urgent, checks the morning window, flags stuck tasks, checks free disk with hysteresis, starts due monitors, nudges approvals and runs the main conversation watchdog (`src/scheduler.ts:228`, `src/index.ts:56`). Cron runs create worker tasks in a reused `job-<name>` directory (line 147); the cron callback ends once task submission completes, not once the worker finishes.

Monitor scripts execute as `bash <relative-script>` via OpenCode PTY, with an untracked timer to remove the PTY (line 186). `home/scripts/notify.sh:25` POSTs JSON with its separate notify bearer token. `/notify` validates and persists the alert before responding 202 (`src/mcp.ts:259`). Ordinary updates wait through quiet hours; urgent updates bypass the filter but still wait for the main session to be free (`src/conversation.ts:149`). Reminders are therefore model-mediated, not direct guaranteed-time notifications.

### Approvals and MCP

Permission/question events insert durable requests and display keyboards (`src/approvals.ts:59`, line 91). Permissions offer Once/Always/Deny. Each question gets option buttons, plus Send for multi-select and Dismiss; free text replies map Telegram message IDs back to questions. Callback handlers forward choices to OpenCode; resolution edits the old messages. Reconnect lists pending requests; nudges occur after 30 minutes outside quiet hours.

HQ is a Node HTTP server with separate constant-time bearer comparisons for MCP and notify, a 1 MB JSON body cap, and stateless MCP transport/server instances per request (`src/mcp.ts:228`, line 274). Tools cover provider balance, five task operations, three reminder operations, three job operations and three monitor operations. Tool errors return MCP error content. The configured default host is loopback, but configuration allows another host (`src/config.ts:18`). Worker HQ tools are hidden by OpenCode configuration; that is not a token-scoped authorization boundary, since the agent process has the MCP token.

## Executed Verification

Environment: Node `v24.21.0`, npm `11.19.0`, Linux. Commands ran in the copy of the repo, without loading `.env` or starting the application. Existing tests start an isolated ephemeral HQ HTTP server with fake credentials and fake OpenCode.

| Command | Result |
|---|---|
| `npm install` | Exit 0; added 149 packages, audited 150; 0 vulnerabilities reported; native install-script warning below |
| `npm run typecheck` | Exit 0; `tsc --noEmit`, no diagnostics |
| `npm test` | Exit 0; 8 files passed, 64 tests passed; 3.37 seconds |

Install output, including warning verbatim:

```text
added 149 packages, and audited 150 packages in 6s

47 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
npm warn install-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn install-scripts   better-sqlite3@13.0.3 (install: node-gyp rebuild)
npm warn install-scripts
npm warn install-scripts Run `npm install-scripts ls` to review, or `npm install-scripts approve <pkg>` to allow.
```

Typecheck output:

```text
> crowstance@0.1.0 typecheck
> tsc --noEmit
```

Test summary:

```text
> crowstance@0.1.0 test
> vitest run

 RUN  v5.0.3 /home/crow-agent/projects/crowstance

 Test Files  8 passed (8)
      Tests  64 passed (64)
   Start at  21:15:20
   Duration  3.37s (import 42%, tests 37%, transform 19%, worker 2%)
```

No test/typecheck failures occurred, so there are no failure traces to report. SQLite-backed tests ran successfully despite the install warning. `npm install` added only `hasInstallScript: true` metadata to the tracked lockfile; that installer-only change was removed to preserve the baseline. No approval command, system-package installation or deployment script was run. An npm audit result is not proof of runtime security.

### Coverage Assessment

| Suite | Tested | Important omissions |
|---|---|---|
| `conversation.test.ts` | Turn composition/model label, debounce, queue while busy, duplicate idle, restart dedupe, NO_REPLY, quiet/urgent updates, failed prompt retry, model errors, continued processing after Telegram failure | Durable inbound recovery; failed/partial-send retry; >40 messages; idle/reconcile races; rotation failure/restart; watchdog and shutdown |
| `tasks.test.ts` | Todos/state descriptions, lexical paths, normal start/slug uniqueness, sequential limits/budget, completion/error/waiting, detailed status, stuck-once | Concurrent start/idles; resume limits; abort failure; reconcile; stale errors; missing sessions; same-directory workers |
| `approvals.test.ts` | Permission phrasing, sequential dedupe, answer elsewhere, multipart/multi-select/free-text, successful reconciliation | Failed list requests; oversize questions; partial sends; failed replies after keyboard removal; concurrent events; custom=false; nudges |
| `scheduler.test.ts` | Simple cron interval validation, reminder/cancel, quiet override, morning window, monitor invocation intervals, disk hysteresis | Actual cron worker completion/overlap; timer lifecycle; DST/irregular cron; crashes between DB writes; monitor exit codes. The monitor test title says it kills hung scripts but never advances time/asserts `killed` |
| `mcp.test.ts` | Real HTTP with fake services: both bearer checks, notify enqueue/schema rejection, MCP initialize/list, balance without key, reminder/task tools/errors | Malformed JSON/oversize bodies, slow clients/rate limits, all tool argument edge cases, shutdown, host enforcement, real OpenCode handshake |
| `format.test.ts` | Inline escaping, code, headings/lists/quotes, basic HTTP link, chunks/fences, bubbles | Nested URL parentheses, code labels in links, reference links, raw HTML, Unicode chunk boundaries, Telegram API acceptance |
| `provider.test.ts` | Microdollar/dollar parsing, HTTP error, absent balance | Timeout/network failure, malformed JSON, request headers, runtime provider integration |
| `text.test.ts` | NO_REPLY, outcomes, slug normalization, quiet ranges | Many time/currency helpers, ambiguous status snippets, DST |

No dedicated tests exist for `index.ts`, `opencode.ts`, `telegram/bot.ts`, `telegram/chat.ts`, config validation, doctor, log or deployment. Store is exercised indirectly using real in-memory SQLite, not file-backed crash recovery/migrations. `FakeOpenCode.messages` ignores directory and limit (`test/fakes.ts:90`); casts bypass adapter type fidelity (line 68). No coverage percentage was measured; passing tests should not be presented as full coverage. No live Telegram, provider model, systemd sandbox, or netguard integration checks were authorized or run.

## Issues and Risks

Severity: P1 = high-value reliability/security correction; P2 = important hardening; P3 = lower-risk correctness/maintenance. Security findings describe code-level exposure and prerequisites, not demonstrated compromise.

### P1: Reliability and Trust Boundaries

1. **Reply delivery is at-most-once attempt, not exactly once.** `src/conversation.ts:239` stores all IDs before `chat.sendText` at line 247, then only logs failure at line 249. A rejected send, connection outage or partial multi-bubble delivery permanently suppresses the missing content. The existing failure test checks progress, not recovered delivery (`test/conversation.test.ts:184`). Add a persistent chunk-level outbox, retry state, permanent-failure visibility and a documented ambiguous-timeout policy. Merely moving the marker after send introduces duplicate-on-crash risk and does not solve the contract.
2. **Inbound and turn metadata disappear on restart.** `src/conversation.ts:54` keeps buffered messages, current kind, urgent state and rotation intent in RAM. Telegram polling can advance after enqueue, before submission. Restart then loses queued user messages; interrupted rotation can never complete, and recovered urgent responses lose urgency context. Shutdown only clears timers (`src/conversation.ts:312`); `src/index.ts:144` does not drain conversation/SSE/MCP work before closing SQLite and exiting. Persist inbox and turn records, then recover/drain explicitly.
3. **Transient approval-list failures permanently expire real requests.** `src/approvals.ts:236` maps each failed API list to `[]`, then line 247 resolves absent rows as expired. Subsequent rediscovery is ignored because resolved rows short-circuit (lines 61 and 93). Track successful snapshots separately per directory/request kind and never infer disappearance from an outage.
4. **Backup service can execute agent-controlled Git hooks outside the OpenCode sandbox.** `deploy/systemd/crowstance-backup.service:6` uses the agent UID but has none of the OpenCode unit's sandbox restrictions; line 10 runs Git commit/push in an agent-writable repo. A malicious repo hook or Git config can run there with normal UID filesystem access outside `ProtectSystem`/hidden-path restrictions. This is not root escalation, but defeats the claimed sandbox for agent-controlled execution. Disable hooks, constrain Git configuration, and apply equivalent sandboxing to backup; consider a dedicated backup identity and fixed export.
5. **Root-executed deployment artifacts are gateway-owned.** `deploy/setup.sh:121` and `deploy/update.sh:15` recursively chown the app to `crow-gateway`, while `deploy/systemd/crowstance-netguard.service:7` executes a script there as root. Update/setup also execute `install-units.sh` from that tree. A gateway-UID compromise with a writable view of the tree could turn this into privileged code execution. The running gateway's read-only system sandbox mitigates direct writes, so this is conditional, not an already-proven remote exploit. Make executable code/templates root-owned and immutable to service users; restrict service-writable paths to data only.
6. **Worker admission and terminal transitions race.** `src/tasks.ts:111` checks limits before awaits at lines 117/120; concurrent MCP/cron starts can all pass the limit. Slugs are chosen before asynchronous createSession, so identical titles can collide at insert and orphan sessions (lines 119-127). `onIdle` reads running state before awaiting messages (line 288), allowing concurrent reconcile/idle calls to enqueue duplicate completion or overwrite a concurrent stop. `src/index.ts:78` launches reconciliation without serializing against dispatch. Use admission reservations and per-task transition locks/CAS; avoid holding SQLite transactions across network calls.

### P2: Recoverability, Scheduling and Security

7. **Spend and capacity controls are advisory/incomplete.** `src/tasks.ts:161` resumes tasks without the start path's disk/budget/worker checks. Main-chat calls are not capped; running workers are not stopped at budget. Spend is recorded only on live completed-message events (`src/index.ts:107`), with no reconnect backfill. An SSE gap undercounts costs indefinitely. Preserve the useful start guard but label it accurately, backfill usage, and enforce limits on all admission paths. Use provider-side caps for a true hard ceiling.
8. **Background updates/reminders are acknowledged too early and depend on model availability.** `src/conversation.ts:163` marks updates delivered immediately after prompt submission, not user notification. A model failure/NO_REPLY can consume a reminder. Main busy blocks urgent reminders too (line 149). Reminder enqueue and fired marker are separate writes (`src/scheduler.ts:230`), permitting duplication after a crash between them; task state and completion-update insertion likewise are separate (`src/tasks.ts:295`). Make transitions transactional and give important reminders a deterministic direct delivery/fallback path.
9. **Finite history window can omit unseen assistant output.** `src/conversation.ts:233` fetches only 40 messages. Long tool-heavy turns or downtime can push unseen messages outside that window. Main busy/idle events are not generation-correlated; a stale/duplicate idle can clear busy for a newer turn (`src/conversation.ts:200`), and reconcile fetches statuses outside the serialized operation (line 217). Introduce turn/message watermarks, pagination and generation-aware reconciliation. Current fake messages ignore the limit, hiding the first issue.
10. **Question answer UI can become unusable after a transient reply failure.** `src/approvals.ts:167` saves answers and removes the current keyboard via edit before submitting to OpenCode (line 174). Non-404 failure leaves an open request with no button to retry the last answer. Rendering has no length cap (line 102), and multipart message IDs/state are stored only after all sends (line 99), so one failed send can strand earlier messages or duplicate them on replay. Persist each delivery step and expose retry; honor `custom: false`, which `answerByReply` currently ignores (line 151).
11. **Scheduled jobs may overlap in the same working tree.** `src/scheduler.ts:143` uses Cron protect only around the async task-start callback. Once submission returns, the next run can create another worker in the same `job-<name>` directory (line 153). User-started workers can also share a directory (`src/tasks.ts:116`). Add per-job active-run policy and project locking/worktrees. Sampling six cron occurrences (`src/scheduler.ts:26`) is not a general proof of minimum interval; validate policy over relevant calendar boundaries or enforce the interval at dispatch.
12. **Monitor lifecycle is not supervised.** `src/scheduler.ts:189` records run before spawn, no exit/output is checked, timers are not tracked/cancelled on stop, and gateway restart loses kill timers while PTYs live in OpenCode. `src/opencode.ts:174` swallows every kill error. Tick itself has no overlap guard (`src/scheduler.ts:65`), so slow calls can accumulate concurrent housekeeping. Track PTY IDs/deadlines, exit status, errors and active tick; recover at startup.
13. **Network fence is partial and not ordered before OpenCode startup.** `deploy/netguard.sh:20` discovers TCP listeners only; rules at line 41 reject those ports on loopback plus named Docker bridges. Other UDP services, accessible UNIX sockets, alternate bridges and newly opened ports before refresh are outside that guarantee. The timer waits 30 seconds after boot (`deploy/systemd/crowstance-netguard.timer:5`) while the OpenCode unit has no fence dependency (`crowstance-opencode.service:3`). No deny-by-default local boundary is established. Tighten the documented claim, order startup fail-closed, and test TCP/UDP/IPv6/UNIX-socket behavior in an isolated deployment.
14. **Deployment is in-place with no tested rollback.** `deploy/update.sh:14` rsyncs over the active app before npm ci/unit installation and restart. Failure can leave mixed code/dependencies; neither tests nor a health gate/rollback run. `--restart-opencode` only takes effect if the config fingerprint changed (line 25). `deploy/setup.sh:200` regenerates provider env retaining only explicitly handled keys, so manually added providers can disappear on rerun. Release directories, atomic switch, preserved secrets overrides and health-checked rollback are needed.
15. **Dedicated SSH hardening can lock out an existing admin account.** `deploy/setup.sh:257` installs authorized keys only when creating the admin user, but disables root login regardless at line 263. If that account exists without the expected key/sudo access, the advertised path is not established. Also validate effective sshd settings/config before reload rather than assuming a late drop-in overrides earlier values.
16. **No complete recovery backup.** `deploy/systemd/crowstance-backup.service:10` commits/pushes only assistant memory. Gateway SQLite, projects and OpenCode session state are not covered; no restoration test or retention policy exists. A local Git commit alone is not off-host backup. Auto-pushing all memory also needs explicit privacy/secret-screening policy.

### P3: Boundedness and Maintenance

17. `src/opencode.ts:233` adds an abort listener on every sleep and never removes it on normal completion; repeated SSE reconnects retain listeners until shutdown. `src/tasks.ts:53` has unbounded activity/error maps without task cleanup. Store tables have no retention and most queue/state queries lack targeted indexes (`src/db.ts:84`, line 240). Add bounded retention, listener cleanup and indexes based on measured workload.
18. OpenCode HTTP calls have no application-level deadlines (`src/opencode.ts:65`); a hung request can block serialized conversation work or event dispatch. Startup health wait has no supplied abort signal (`src/index.ts:64`); shutdown handlers are only registered after initialization (line 152). Add bounded calls, startup/shutdown deadlines and explicit health/readiness distinction. `/health` always says OK even if OpenCode/Telegram are unavailable (`src/mcp.ts:257`).
19. `/notify` and MCP have no authenticated rate limits/backlog bound; all pending updates can become one large prompt (`src/conversation.ts:161`). Invalid JSON/oversize bodies map to generic HTTP 500 (`src/mcp.ts:234`, line 287), not 400/413. `new URL` is outside the handler try block (line 255). Add bounded queues/batching, controlled client errors, and explicit request timeout policy.
20. Project/monitor containment is lexical, not realpath/symlink-aware (`src/tasks.ts:21`, `src/scheduler.ts:167`); it should not be described as filesystem isolation. `bash` monitor arguments also lack `--` before a potentially dash-prefixed relative path (line 191). Validate through the agent-side filesystem and pass unambiguous paths.
21. Model override tool fields are unconstrained strings (`src/mcp.ts:70`, line 167), while `parseModelRef` blindly splits (config line 81). The Telegram picker stores one global choice list and indexes old keyboards into it (`src/telegram/bot.ts:193`, line 205), potentially selecting a different model after refresh. Bind choices to message/version and validate model refs consistently.
22. `src/tasks.ts:280` retains the last non-abort error until idle even if later retries succeed, potentially classifying successful recovery as failure. `stop` records stopped even when abort fails (line 176), letting accounting and reality diverge. Terminal state should come from a confirmed turn outcome with retry/abort status recorded separately.
23. Prompt injection remains a material risk by design: bash defaults allow, outward-action guardrails cover selected command patterns only (`opencode/opencode.json:69`). Provider/MCP credentials are available to the agent process; user-facing text/logs can contain tool errors and notification contents (`src/mcp.ts:32`, line 266). Keep credentials scoped, redact diagnostics, and never mistake fewer UI prompts for stronger authorization.
24. Documentation drift: `.env.example:2` names `/etc/assistant` rather than crowstance; line 14 says gateway ignores provider keys though `provider.ts:9` uses them. README memory paths differ from the actual seeded `memory/notes`/`memory/journal` (`README.md:21`, `home/AGENTS.md:5`); README's categorical GPT cache statement conflicts with configured rates (`README.md:147`, `opencode/opencode.json:20`). Reconcile documented guarantees and provider pricing with measured behavior.

## Requested Capabilities

**Design/architecture work should use `crowbot/gpt-6-astra`, as requested.** This is already the configured worker default (`opencode/opencode.json:54`); explicit design-task model selection is supported by `src/tasks.ts:63`. Model names and provider claims here reflect repository/public-provider documentation, not independent model-identity verification.

### 1. Image Generation and Telegram Delivery

**Feasibility: feasible, M for a first end-to-end provider integration; L for durable media jobs, storage and production safety.**

Public-source investigation on 2026-10-06:

- [Crowbot homepage](https://crowbot.sh/) advertises `gpt-image-2.5`, $0.005/image, specifically "in the chat". Treat price/availability as a point-in-time provider claim.
- [Crowbot API reference](https://crowbot.sh/docs/api.md) and [llms.txt](https://crowbot.sh/llms.txt) explicitly list `POST https://chat.crowbot.sh/api/tools/generate_image`, requiring key plus `X-Pow`, and say it is **not offered on `/v1`**. There is no documented `/v1/images/generations` endpoint. Do not assume OpenAI compatibility includes image APIs or that adding an image model to OpenCode config will work.
- No image generation call was made. Payload/response format, supported automation, quotas, proof-of-work lifecycle and image retention still need confirmation before integrating that chat-specific endpoint. Prefer a supported API contract; an external image provider with a documented images API is a viable alternative, subject to user approval for credentials/costs.

Existing plumbing and missing pieces:

| Hook | Current state | Proposed addition |
|---|---|---|
| `src/telegram/chat.ts:10` | Chat only exposes text/HTML/edit/typing; grammY API is available internally | Add fakeable `sendPhoto` and `sendDocument` methods using bytes/validated uploads, with captions and durable delivery IDs |
| `src/telegram/bot.ts:158` | All incoming media rejected | Optional later image input/editing workflow; not required for text-to-image output |
| `src/opencode.ts:39` | Prompt parts include `FilePartInput`; `messages` returns all Part types | Existing type support is input plumbing only. `messageText` at line 255 and conversation delivery discard non-text parts; add a deliberate artifact contract rather than guessing paths from prose |
| `src/mcp.ts:37` | HQ tool registration centralized, results currently text-only | Register an image-generation/job tool with prompt/size/count constraints and a durable result/artifact ID; wire media delivery dependency through `src/index.ts:63` |
| `src/provider.ts:9`, `src/config.ts:10` | Provider balance only; no image provider config | Separate image-provider adapter with timeout/retry/cost accounting and validated response schema; keep credentials out of model text |
| `src/db.ts:84` | No artifacts/media jobs table | Persist generation state, costs, bounded storage, media metadata and delivery state for recovery |

Use `sendPhoto` for a convenient image preview and `sendDocument` for the original file/full fidelity; expose original delivery via text command or an explicit request, not an automatic extra keyboard. Enforce Telegram's applicable size/dimension/caption limits and verify against current Bot API docs during implementation. The gateway's `ProtectHome=true` means it cannot simply read a worker-created image from `/home/crow-agent` (`deploy/systemd/crowstance-gateway.service:22`): generate/download into a gateway-owned artifact area, or design a tightly scoped artifact-transfer endpoint. Do not relax all home isolation. Validate MIME/bytes, cap downloads, prevent SSRF/arbitrary local-file exfiltration, avoid public uploads by default, and count image spend separately from OpenCode message cost.

### 2. Tappable Map Locations

**Feasibility: M for a model-supplied coordinate/location tool; M-L if geocoding and venue enrichment are required.**

The desired result is a Telegram-native location the user can tap in their maps app, not just a formatted address. Telegram's Bot API offers three useful delivery choices:

| Method | Use | Tradeoff |
|---|---|---|
| `sendLocation` | Latitude/longitude pin; Telegram makes it tappable | Best default, simple and provider-independent; only has a short caption and no rich venue metadata |
| `sendVenue` | Latitude/longitude plus title/address and optional foursquare ID | Better for a named place/address; requires trustworthy name/address/coordinates and venue metadata is still not a full maps database record |
| Text/HTML maps URL | Google Maps/Apple Maps/OpenStreetMap URL with encoded coordinates/place | Good fallback and preserves a named destination; depends on URL scheme/app behavior and is less native than a location message |

Recommended behavior: send `sendLocation` whenever the assistant has confidence in coordinates; optionally follow with a concise caption or `sendVenue` when a verified name/address is available. Include a maps URL only as a fallback or an explicitly requested alternative. Do not emit multiple redundant pins/links by default.

There is currently no location capability. `src/telegram/chat.ts:10` exposes only text, HTML, edit and typing; `TelegramChat` would need fakeable `sendLocation(latitude, longitude, opts)` and probably `sendVenue(latitude, longitude, title, address, opts)` methods backed by grammY's API. `src/telegram/bot.ts:145` only consumes incoming text and `line 158` rejects incoming media; output delivery is independent of that input limitation. The assistant reply path (`src/conversation.ts:242`) extracts only text parts, so a model cannot cause a native location merely by mentioning a place unless a tool call/result is introduced.

The cleanest tool surface is an HQ tool registered beside the other assistant tools in `src/mcp.ts:37`, for example `location_share` with `name`, optional `address`, `latitude`, `longitude`, optional `maps_url`, and a confidence/source field. The tool should return a stable result to the model and enqueue a typed outbound media/location event rather than trying to call Telegram from MCP directly. `src/mcp.ts:22` currently has no Chat dependency, while `src/index.ts:41` is the wiring point that owns both `Conversation` and Telegram `Chat`; pass a location-delivery callback/event sink into the main gateway and persist the operation in SQLite before sending. For a simpler first version, the tool can return a location marker to the active main turn and let the conversation deliver it, but a durable typed outbox is the production-safe design (see P1 delivery finding above).

Geocoding options:

1. **Model supplies coordinates:** cheapest and quickest, but language models can hallucinate or confuse similarly named places. Accept only when the model cites a reliable source or the user supplied coordinates; validate numeric ranges and require a confidence/source field. Never silently convert an uncertain name into a potentially wrong pin.
2. **Dedicated geocoder:** add a small provider adapter, called by the HQ tool, that resolves a place name/address to coordinates. It belongs outside `telegram/*` and should be injected into the MCP/tool service, with timeout, rate limit, result disambiguation and provider-specific key/config. Return candidates to the assistant/user when ambiguous rather than auto-selecting. Nominatim/OpenStreetMap may have usage-policy/rate-limit requirements; commercial geocoders add cost and location-data exposure.
3. **Hybrid:** if coordinates are present, validate and use them; otherwise geocode only a sufficiently specific address/place query. For a place search, ask the user to choose among candidates before sending a pin. Cache only with an explicit retention policy because searches reveal user intent/location.

Privacy and abuse considerations: a location can reveal the user's home/work or a third party's whereabouts. Require owner authorization already supplied by the Telegram middleware, do not expose a public location endpoint, log only coarse operation IDs rather than raw coordinates, and avoid persisting coordinates longer than the outbound retry window. Validate finite latitude/longitude (`-90..90`, `-180..180`), cap name/address lengths, reject malformed URLs, and prevent the model from using the tool to spam arbitrary chats. A location tool must not bypass the assistant's outward-action rule (`opencode/prompts/assistant.md:20`); sending a place to the owner is an outward Telegram action and should be explicit in the tool description/prompt. Test Telegram API failures, retries/duplicates, ambiguous geocoding, antimeridian coordinates and quiet-hour behavior.

**Minor clickable-link note:** ordinary Markdown links already work: `src/telegram/format.ts:22` recognizes `[label](http(s)://...)`, `tg:` and `mailto:` and emits escaped `<a href>` at line 33; `test/format.test.ts:28` verifies a normal HTTP link. Bare web URLs are normally auto-detected by Telegram. Preview suppression (`src/telegram/chat.ts:45`, line 65, line 74) hides previews, not clickability. Raw HTML is escaped, relative/local paths are not reachable from a phone, reference links are unsupported, the URL regex has edge cases around `)`, split chunks can break links, and HTML rejection falls back to literal Markdown (`chat.ts:52`). Those are separate from native map-location support.

### 3. Better Reasoning

**Feasibility: S for design-task model preference; M for per-turn think mode and verified reasoning-effort propagation.**

`/model chat provider/model` already changes chat choice without buttons (`src/telegram/bot.ts:121`); workers have independent model choice and per-task overrides (`src/tasks.ts:63`). `opencode/opencode.json:19` through line 22 declare four reasoning-capable models, including `gpt-6-astra` and `crow-2`, using `reasoning_content`. Crowbot's public API docs say `reasoning_effort` accepts low/medium/high/max (bounded by model support) and reasoning tokens are charged as output. That is a documented provider feature, not a verified gateway setting.

`src/opencode.ts:101` currently accepts model but no variant/effort/provider options, and `src/conversation.ts:17` inbound records have no per-turn model metadata. A "think harder" command or natural-language intent can attach a one-turn model/effort choice without changing the session default. Extend the adapter only after checking the pinned OpenCode SDK/server contract for supported variant/agent options and testing the actual provider payload. Preserve this choice through debounce, queue and restart; do not route reasoning directly around the OpenCode adapter.

For design briefs, prefer `crowbot/gpt-6-astra`; add a concise planning/alternatives/verification instruction in worker briefs or prompt (`opencode/prompts/worker.md:4`). A bounded review step can improve quality on high-risk work, but adds latency/cost and should not run on every casual message. Evaluate against representative architecture/coding tasks and record outcome/cost/latency. Do not expose raw private reasoning traces; return decisions, assumptions, checks and concise rationale. `crow-2` being described as uncensored does not demonstrate superior reasoning and is materially more expensive in current configuration.

### 4. Fewer Unnecessary Buttons

**Feasibility: S for text-first questions/model selection and removing Always; M for persisted preference and robust text permission replies.**

Current button sources are specific, not every reply: permission Once/Always/Deny (`src/approvals.ts:64`), one keyboard per question (`line 110`), and the `/model` target/model pickers (`src/telegram/bot.ts:131`, line 194). Standard chat output has no keyboards. All permission requests are forwarded regardless of known session ownership (`src/index.ts:96`), so global-server sessions can add noise too.

Questions already support replying to the message with text (`src/approvals.ts:151`, `src/telegram/bot.ts:147`). Make ordinary clarification text-first, reserve option buttons for genuine bounded selections, and only ask when a choice materially affects the result (`opencode/prompts/assistant.md:8`). Permissions currently have no text-reply fallback: add an explicit owner reply to the exact request, e.g. allow once/deny, with request binding and expiry. Never treat a casual unbound "yes" as authorization. Default risky requests to Allow once/Deny; hide Always or require an explicit advanced action because it broadens future authorization. Retain explicit approvals for outward/destructive actions; reducing buttons must not silently auto-approve requests or leave OpenCode waiting without a way to answer. Put durable presentation preferences in KV/config, and filter events to managed sessions where appropriate.

## Prioritized Enhancement Opportunities

Effort: S = roughly up to 1-2 engineering days; M = several days; L = multi-week work including integration and recovery tests. Estimates are relative, not delivery commitments. Order within each group is recommended priority.

### A. Quick Wins

| Priority | Enhancement | Why it matters | Effort | Impact |
|---|---|---|---|---|
| P1 | Make approval reconciliation failure-aware (`approvals.ts:236`) | Stops outages permanently stranding approval requests | S | High reliability |
| P1 | Correct exactly-once/budget/security claims in docs | Aligns user expectations with actual failure guarantees | S | High trust |
| P2 | Text-first questions, smaller risk keyboards, direct model commands | Addresses reported button overload without weakening consent | S | High UX |
| P2 | Native tappable location tool and Telegram `sendLocation`/`sendVenue` adapter | Lets the user open mentioned places directly in a maps app | M | High UX |
| P3 | Map-link renderer edge-case tests | Keeps ordinary clickable web links usable as a fallback | S | Medium UX |
| P2 | Explicit Astra preference for design briefs | Matches requested design model using existing worker override | S | High quality, task-dependent |
| P2 | Fix abort-listener cleanup, HTTP 400/413 and input model validation | Removes bounded, well-localized reliability defects | S | Medium |
| P2 | Add regression tests for send failure, failed approval snapshots, concurrent starts | Protects the most valuable behavioral fixes | S-M | High |

### B. Meaningful Features

| Priority | Enhancement | Why it matters | Effort | Impact |
|---|---|---|---|---|
| P1 | Reliable direct reminders/urgent fallback with snooze/cancel | Time-sensitive notices should not depend on an idle healthy LLM | M | High |
| P2 | Image generation tool + preview/original delivery | Implements requested image workflow across provider/media boundaries | M-L | High |
| P2 | Per-turn think mode with effort/cost guardrails | Stronger reasoning without slowing every conversation | M | High |
| P2 | Secure artifact delivery/downloads | Reports/images become usable from Telegram, not just server paths | M | High |
| P2 | Monitor health and run history, failure alerts | Distinguishes a healthy silent check from a broken silent script | M | High operational |
| P3 | Voice transcription and incoming photos/documents | Removes current text-only input limitation | M-L | Medium-high |

### C. Hardening and Refactors

| Priority | Enhancement | Why it matters | Effort | Impact |
|---|---|---|---|---|
| P1 | Durable inbox/outbox/turn ledger and delivery retries | Prevents silent message loss; foundation for media delivery | M-L | Very high |
| P1 | Sandbox backup and root-own deployed executables | Closes secondary execution paths around service boundaries | M | Very high security |
| P1 | Task reservations + serialized/CAS lifecycle transitions | Enforces concurrency and prevents duplicate/orphan state | M | High |
| P1 | Atomic release/health gate/rollback deployment | Failed upgrades become recoverable without mixed versions | M-L | High |
| P2 | SQLite migrations, transactional events, indexes/retention | Makes schema evolution and long-running queues safe | M | High |
| P2 | Readiness, structured correlation IDs and queue/latency metrics | Detects degraded service before messages disappear | M | High |
| P2 | Off-host encrypted state backups and restore drill | Recovers tasks, reminders, sessions and projects, not just memory | M | High |
| P2 | Event-gap reconciliation, spend backfill and request deadlines | Restores correct state after provider/network disruption | M | High |
| P2 | CI on Node 24 plus adapter, Telegram and deploy integration tests | Covers untested seams without spending model tokens | M | High |
| P2 | Fence boot ordering and explicit tested isolation policy | Replaces incomplete isolation assumptions with enforceable rules | M-L | High security |

Recommended delivery sequence: durable messaging and approval recovery; security/deploy corrections in parallel; links/buttons/Astra preference; then images and richer artifacts on top of the outbox.

## Production Readiness Checklist

| Rank | Area | Present | Gap / exit criterion |
|---|---|---|---|
| P1 | Reliability | SQLite records, main queue, SSE reconnect, watchdog | Durable inbound/outbound delivery; restart/partial-send tests; explicit duplicate policy |
| P1 | Error handling | Tool errors, logs, Telegram auto-retry, prompt buffering | Deadlines, failure-aware approvals, confirmed abort, graceful drain, recoverable terminal states |
| P1 | Security | Owner/private filter, two OS users, service sandbox, tokens, partial fence | Root-owned artifacts; sandbox backup; fail-closed fence startup; scoped credentials and documented residual access |
| P1 | Deploy/upgrade safety | Pinned OpenCode SDK/server, dependency lock, systemd restart | Tested release artifact, atomic switch, health gate, rollback, schema versioning; no unreviewed env loss |
| P1 | Backups | Nightly memory Git commit/optional push | Encrypted off-host SQLite/OpenCode/project backup, retention and verified restore |
| P2 | Observability | Scoped timestamped logs, doctor, liveness | Readiness/dependency state, queue age/count, delivery failures, worker/monitor run metrics, request correlation and redaction |
| P2 | Resource limits | Slice CPU/RAM/IO/tasks caps, gateway cap, disk admission pause | Atomic worker limits, bounded queues/history/media, monitor supervision, real spend ceiling; memory caps cannot guarantee only a child and never OpenCode is killed |
| P2 | Tests/CI | 64 tests and strict TS pass | Adapter contracts, Telegram authorization/API failure tests, file-backed recovery, concurrency, deployment sandbox tests; automated CI |
| P2 | Docs/runbooks | Useful README architecture/setup/security narrative | Accurate guarantees, incident/recovery/upgrade steps, privacy/media retention, restore instructions, config drift fixes |

## Open Questions

1. When a Telegram send outcome is ambiguous, is an occasional duplicate preferable to a missing message? Recommended default: retry important content, surface uncertainty, never silently discard it.
2. Does "link maps as openable" mean geographic map links, a named list of useful links, or opening generated project/report files? The first two are quick wins; private file access needs delivery infrastructure.
3. For images, is an external provider acceptable, or must crowbot be used? What per-image/day budget, preview/original preference, and retention/privacy requirements apply? Crowbot chat-tool automation needs a confirmed supported contract before implementation.
4. Should think mode be one-turn explicit, automatically selected for complex tasks, or both? Astra is the intended design model; what latency/cost cap should apply?
5. Which question types still benefit from buttons? Should Always permission approval be removed entirely? Which outward actions must always require explicit owner consent?
6. Is this production deployment dedicated or shared, and what neighboring services/data must be isolated? Effective systemd/netguard settings were deliberately not inspected here.
7. Should simultaneous tasks in one project queue or use independent Git worktrees? Should waiting-for-input tasks consume worker capacity?
8. What recovery-point/recovery-time targets are acceptable, and where should encrypted off-host backups live? Has the existing memory backup ever been restored?
9. Is the daily budget intended as a warning/new-task guard or a strict total cap including chat, resumed tasks and images? How should urgent reminders behave when the model is unavailable or budget is exhausted?
10. Should approval/events from unrelated OpenCode sessions be ignored? Is the server exclusively owned by this gateway?

## Verification Boundaries

The report is source-grounded, with actual install/typecheck/unit-test results and read-only public documentation research. It does not certify real Telegram delivery, model identity/reasoning quality, crowbot image-tool automation, deployed filesystem ownership, effective systemd/SSH/firewall configuration, or backup restorability. Those require explicitly scoped integration tests or operator checks. No source fixes were made as part of recon.
