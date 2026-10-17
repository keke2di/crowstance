# Architecture

crowstance is a single-owner personal assistant. One Telegram chat drives one long-lived
OpenCode session (the *main* session); anything long-running becomes a background *worker*
session in its own project directory. A small Node gateway owns all durable state and is the
only thing that talks to Telegram. OpenCode owns model execution and the filesystem tools.

```text
Owner's private Telegram chat
  → grammY polling + owner/private-chat middleware
  → commands / approval replies / debounced Conversation inbox
  → OpenCode adapter → authenticated OpenCode HTTP + global SSE
                        → main assistant session in ASSISTANT_HOME
                        → worker sessions in PROJECTS_DIR/<project>
                        → model provider + filesystem/bash/web tools
                        → hq MCP calls back into the gateway
  ← idle event → completed visible assistant text → durable outbox → Telegram
```

## Process and trust boundaries

| Process | OS user | Talks to | Cannot |
|---|---|---|---|
| Gateway (`src/index.ts`) | `crow-gateway` | Telegram Bot API, OpenCode HTTP/SSE, its SQLite DB | read the agent home (sandbox), modify deployed code |
| OpenCode server | `crow-agent` | model provider, agent home, projects | read the bot token, gain root |
| State backup | `root` (systemd timer) | gateway SQLite (read-only), memory, backup dir | reach the network (`PrivateNetwork=true`) |

Deployed code, unit templates and root-executed scripts are root-owned and read-only to the
service users. The gateway's SQLite database lives in `/var/lib/crowstance` and is the gateway
ledger. The gateway can only write there.

## The durable ledger (SQLite)

The gateway's SQLite database is the source of truth. Schema changes go through versioned
migrations in `src/migrations.ts` (`schema_migrations`); a fresh database and an existing one
both migrate forward.

Key tables:

| Table | Holds |
|---|---|
| `kv` | main session id, model overrides, watermarks, disk/retention flags |
| `tasks` | background worker lifecycle, outcomes, reasoning variant, abort state |
| `task_reservations` | admission reservations so concurrent starts cannot exceed `MAX_WORKERS` |
| `updates` | background notes waiting to be shown to the main session |
| `inbound_messages` | user messages persisted before Telegram acknowledgement |
| `turns` | one row per main-session turn (user/update/rotate) with correlation id |
| `outbound_events` / `outbound_chunks` | durable delivery ledger with per-chunk state, attempts and Telegram message ids |
| `delivery_leases` / `delivery_attempts` | single-sender leases and bounded attempt history |
| `approvals` | permission/question prompts and their presentation state |
| `approval_snapshots` | successful-snapshot watermarks so an outage never expires a real request |
| `reminders` | one-off reminders |
| `jobs` / `monitors` | cron jobs and cheap interval scripts |
| `spend` / `reasoning_usage` | model cost accounting |

### Delivery policy

Delivery is **at-least-once, duplicate-over-loss**. A chunk is claimed under a lease, sent,
and marked `sent`. Transient failures become `retryable`; ambiguous network timeouts become
`unknown` and are retried (an occasional duplicate is preferred to silent loss). After the
attempt limit a chunk becomes `failed` and stays visible to operators. Multi-chunk events are
recovered independently. Source assistant messages are only marked delivered after the
outbound event is durably recorded.

## Main message flow

1. `src/telegram/bot.ts` rejects non-owner/non-private updates and routes text to
   `Conversation.onUserMessage`.
2. `src/conversation.ts` persists the inbound row (with a correlation id) and debounces the
   burst.
3. When the session is free, the batch becomes a `turn`, `reserveReasoning` checks the daily
   reasoning budget, and the text is submitted through the single OpenCode adapter
   (`src/opencode.ts`).
4. On idle, completed assistant text is selected via a durable watermark, enqueued as an
   `outbound_event` (same correlation id), and the delivery worker sends it to Telegram.
5. `NO_REPLY` suppresses a turn's output. Errors become a visible `⚠️` message.

## Observability

- **Liveness** — `GET /health` always answers `{ok:true,status:"alive"}` while the process
  serves. It never checks dependencies, so a supervisor does not restart a gateway whose
  provider is merely slow.
- **Readiness** — `GET /ready` checks the store, OpenCode health and Telegram polling. It
  answers `200 {ok:true,ready:true}` or `503 {ok:false,ready:false,checks:{...}}`. The deploy
  health gate (`deploy/health-check.sh`) uses `/ready`.
- **Metrics** — `GET /metrics` returns queue age, retry counts and spend from
  `Store.metrics()`. No payloads or secrets are included.
- **Correlation** — every inbound message, turn and outbound event carries a correlation id.
  It is propagated in-process with `AsyncLocalStorage` (`runWithCorrelation`) and logged as
  `correlation=<id>`. MCP requests honour an incoming `X-Correlation-ID` header (and echo one).
- **Redaction** — `src/log.ts` masks token-shaped strings and values under sensitive keys
  (passwords, secrets, tokens, authorization, credentials, raw latitude/longitude) before
  logging.
- **Retention** — `Store.applyRetention` deletes only terminal rows (delivered updates,
  consumed inbound, sent outbound, resolved approvals, completed turns, finished attempts)
  older than `RETENTION_DAYS`. Pending work is never eligible.

## Backups and recovery

`src/backup.ts` exports an encrypted state backup:

```text
<backup-dir>/
  state.db.enc       consistent SQLite snapshot (AES-256-GCM)
  memory.json.enc    selected assistant memory files (path → base64)
  manifest.json.enc  encrypted manifest: names, sizes, SHA-256 checksums
```

The passphrase lives in a root-only file (`/etc/crowstance/backup.key`), is never passed on
the command line, and the key is derived with scrypt. Restore verifies every checksum before
writing. `deploy/restore-drill.sh` restores the newest backup into a clean temporary directory
and verifies sessions, tasks, reminders and memory. Off-host retention is an operator step
(see `OPERATIONS.md`).

## Deployment

`deploy/release.sh` implements an immutable release layout:

```text
/opt/crowstance/releases/<id>/   immutable, root-owned release tree
/opt/crowstance/app              atomic symlink to the active release
/opt/crowstance/state/           known-good and pending markers
/opt/crowstance/staging/         uploaded archives
```

`deploy/deploy.sh` uploads a checksummed archive; `deploy/update.sh` verifies it, builds the
release off to the side, preserves operator overlays, flips the symlink atomically, restarts,
and requires real readiness (`/ready`). A failed build or health check rolls back to the last
known-good release, which is never deleted. See `OPERATIONS.md` for the upgrade and rollback
runbooks.
