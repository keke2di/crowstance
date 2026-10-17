# Local smoke test

This is a dev-only harness. It starts a local OpenAI-compatible stub, OpenCode
with `opencode/opencode.dev.json`, and the real Telegram gateway. No provider
network or provider key is used.

## Setup

Create `.env` with only the disposable bot credentials:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:paste-the-token-from-BotFather
OWNER_TELEGRAM_ID=123456789
```

The launcher supplies local defaults for OpenCode, the HQ MCP endpoint, paths,
and SQLite. Existing local values for those settings are respected, but no
`CROWBOT_API_KEY` is needed.

## Run

From the repository root:

```bash
npm run dev:smoke
```

Leave the process running, then text the dev bot from the owner account. The
gateway uses the real Telegram polling path and real OpenCode session path; the
reply will be deterministic, such as `stub reply: 1` (the number increments
for each stub model request). Stub requests are logged briefly to stderr.

Stop all three processes with `Ctrl-C`. The default disposable data is in
`.dev-data/assistant.db`; inspect the durable ledger with SQLite, for example:

```bash
sqlite3 .dev-data/assistant.db \
  'select count(*) from inbound_messages; select count(*) from turns; select count(*) from outbound_events;'
sqlite3 .dev-data/assistant.db \
  'select * from outbound_chunks order by rowid desc limit 10;'
sqlite3 .dev-data/assistant.db \
  'select * from delivery_leases order by rowid desc limit 10;'
sqlite3 .dev-data/assistant.db \
  'select * from delivery_attempts order by rowid desc limit 10;'
```

The rows in `inbound_messages`, `turns`, and `outbound_events` are the durable
inbound/turn/outbound event ledger. `outbound_chunks`, `delivery_leases`, and
`delivery_attempts` show the corresponding delivery/chunk/claim history.
The actual table names/schema can be inspected with `.schema` if a local branch
has newer migrations.
