import type Database from "better-sqlite3";

export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, brief TEXT NOT NULL, directory TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, outcome TEXT, model TEXT, job TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER, last_activity_at INTEGER NOT NULL, last_report TEXT, stuck_notified INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, urgent INTEGER NOT NULL DEFAULT 0, delivered_at INTEGER);
      CREATE TABLE IF NOT EXISTS approvals (request_id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL, directory TEXT NOT NULL, payload TEXT NOT NULL, chat_message_ids TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, resolved_at INTEGER, resolution TEXT, nudged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY, due_at INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, fired_at INTEGER, cancelled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, cron TEXT NOT NULL, instructions TEXT NOT NULL, model TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_run_at INTEGER);
      CREATE TABLE IF NOT EXISTS monitors (name TEXT PRIMARY KEY, script TEXT NOT NULL, every_min INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_run_at INTEGER);
      CREATE TABLE IF NOT EXISTS spend (message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, cost REAL NOT NULL, completed_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS spend_completed_at ON spend (completed_at);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS inbound_messages (
        id INTEGER PRIMARY KEY, external_id TEXT, text TEXT NOT NULL, received_at INTEGER NOT NULL,
        reply_to TEXT, state TEXT NOT NULL DEFAULT 'buffered', consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS inbound_messages_state ON inbound_messages(state, id);
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, kind TEXT NOT NULL,
        urgency INTEGER NOT NULL DEFAULT 0, session_id TEXT, created_at INTEGER NOT NULL,
        started_at INTEGER, completed_at INTEGER, state TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS turns_generation ON turns(generation);
      CREATE TABLE IF NOT EXISTS outbound_events (
        id TEXT PRIMARY KEY, session_id TEXT, source_message_id TEXT, turn_id INTEGER,
        kind TEXT NOT NULL, payload TEXT NOT NULL, urgent INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
        completed_at INTEGER, failure TEXT
      );
      CREATE INDEX IF NOT EXISTS outbound_events_ready ON outbound_events(state, created_at);
      CREATE TABLE IF NOT EXISTS outbound_chunks (
        event_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', telegram_message_id INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
        failure TEXT, PRIMARY KEY(event_id, seq), FOREIGN KEY(event_id) REFERENCES outbound_events(id)
      );
      CREATE INDEX IF NOT EXISTS outbound_chunks_ready ON outbound_chunks(state, next_attempt_at);
      CREATE TABLE IF NOT EXISTS delivery_leases (
        event_id TEXT NOT NULL, seq INTEGER NOT NULL, owner TEXT NOT NULL,
        leased_until INTEGER NOT NULL, PRIMARY KEY(event_id, seq)
      );
      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id INTEGER PRIMARY KEY, event_id TEXT NOT NULL, seq INTEGER NOT NULL,
        attempt INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
        outcome TEXT NOT NULL, error TEXT
      );
      CREATE INDEX IF NOT EXISTS delivery_attempts_event ON delivery_attempts(event_id, seq, id);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE approvals ADD COLUMN presentation TEXT NOT NULL DEFAULT '{}';
      CREATE TABLE IF NOT EXISTS approval_snapshots (
        directory TEXT NOT NULL, kind TEXT NOT NULL, completed_at INTEGER NOT NULL,
        PRIMARY KEY(directory, kind)
      );
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS task_reservations (
        token TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, directory TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      ALTER TABLE tasks ADD COLUMN abort_state TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE monitors ADD COLUMN pty_id TEXT;
      ALTER TABLE monitors ADD COLUMN deadline_at INTEGER;
      ALTER TABLE monitors ADD COLUMN run_state TEXT NOT NULL DEFAULT 'idle';
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE tasks ADD COLUMN reasoning_variant TEXT NOT NULL DEFAULT 'max';
      ALTER TABLE turns ADD COLUMN reasoning_variant TEXT NOT NULL DEFAULT 'max';
      CREATE TABLE IF NOT EXISTS reasoning_usage (
        request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, scope TEXT NOT NULL,
        variant TEXT NOT NULL, estimated_cost REAL NOT NULL, actual_cost REAL,
        input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
        created_at INTEGER NOT NULL, completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS reasoning_usage_created ON reasoning_usage(created_at);
    `,
  },
  {
    // M8: correlation ids for the inbound → turn → delivery path, plus indexes
    // for queue-age metrics and bounded retention.
    version: 6,
    sql: `
      ALTER TABLE inbound_messages ADD COLUMN correlation_id TEXT;
      ALTER TABLE turns ADD COLUMN correlation_id TEXT;
      ALTER TABLE outbound_events ADD COLUMN correlation_id TEXT;
      ALTER TABLE approvals ADD COLUMN correlation_id TEXT;
      CREATE INDEX IF NOT EXISTS inbound_messages_retention ON inbound_messages(state, received_at);
      CREATE INDEX IF NOT EXISTS updates_delivered ON updates(delivered_at, id);
      CREATE INDEX IF NOT EXISTS outbound_events_retention ON outbound_events(state, completed_at);
      CREATE INDEX IF NOT EXISTS outbound_events_correlation ON outbound_events(correlation_id);
      CREATE INDEX IF NOT EXISTS approvals_resolved ON approvals(resolved_at, created_at);
      CREATE INDEX IF NOT EXISTS turns_state ON turns(state, created_at);
      CREATE INDEX IF NOT EXISTS delivery_attempts_finished ON delivery_attempts(finished_at);
    `,
  },
];

export function migrate(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set((db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map((r) => r.version));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, Date.now());
    })();
  }
}
