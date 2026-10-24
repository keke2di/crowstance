import path from "node:path";
import { z } from "zod";

const modelRef = z
  .string()
  .regex(/^[^/\s]+\/\S+$/, 'expected "provider/model", e.g. "anthropic/claude-opus-5-5"');

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected "HH:MM"');

const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  OWNER_TELEGRAM_ID: z.coerce.number().int().positive(),

  OPENCODE_URL: z.url().default("http://127.0.0.1:4096"),
  OPENCODE_SERVER_USERNAME: z.string().default("opencode"),
  OPENCODE_SERVER_PASSWORD: z.string().optional(),

  HQ_HOST: z.string().default("127.0.0.1"),
  HQ_PORT: z.coerce.number().int().default(7801),
  HQ_MCP_TOKEN: z.string().min(16),
  HQ_NOTIFY_TOKEN: z.string().min(16),
  /** Optional: lets the gateway report the provider balance (/cost, hq_provider_balance). */
  CROWBOT_API_KEY: z.string().optional(),
  GEOCODER_URL: z.url().optional(),
  GEOCODER_API_KEY: z.string().optional(),
  GEOCODER_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(5_000),
  GEOCODER_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(1_000),

  /** Media understanding: binaries for local OCR/STT. Empty = that media type stays unread. */
  TESSERACT_BIN: z.string().optional(), // e.g. /usr/bin/tesseract — enables photo OCR
  TESSERACT_LANG: z.string().optional(),
  WHISPER_BIN: z.string().optional(), // whisper.cpp CLI (whisper-cli) — enables voice/audio STT
  WHISPER_MODEL: z.string().optional(), // path to ggml-*.bin, required when WHISPER_BIN is set
  WHISPER_LANG: z.string().optional(),
  FFMPEG_BIN: z.string().default("ffmpeg"), // converts voice notes to wav for whisper
  MEDIA_MAX_MB: z.coerce.number().positive().default(20), // refuse bigger files from Telegram

  ASSISTANT_HOME: z.string().min(1),
  PROJECTS_DIR: z.string().min(1),
  DATA_DIR: z.string().default("./data"),
  /** File holding the 32-byte vault key (generated on first use). Default: <DATA_DIR>/vault.key */
  VAULT_KEY_FILE: z.string().optional(),

  ASSISTANT_AGENT: z.string().default("assistant"),
  WORKER_AGENT: z.string().default("worker"),
  CHAT_MODEL: modelRef.optional(),
  WORKER_MODEL: modelRef.optional(),
  REASONING_DAILY_BUDGET_USD: z.coerce.number().positive().default(5),
  REASONING_RESERVE_USD: z.coerce.number().nonnegative().default(0.25),
  REASONING_MAX_DURATION_SEC: z.coerce.number().int().positive().default(900),
  REASONING_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(128000),

  QUIET_HOURS: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/, 'expected "HH:MM-HH:MM"')
    .optional(),
  MORNING_CHECKIN: hhmm.optional(),
  DEBOUNCE_MS: z.coerce.number().int().min(0).default(2000),
  // Spend caps. These are ceilings: /limits can set a stricter value at runtime, never a looser one.
  DAILY_BUDGET_USD: z.coerce.number().positive().default(20),
  MONTHLY_BUDGET_USD: z.coerce.number().positive().default(200),
  /** Everything subagents spend in a day. */
  SUBAGENT_DAILY_BUDGET_USD: z.coerce.number().positive().default(5),
  /** One hq_delegate call; the subagent is interrupted when it gets there. */
  SUBAGENT_CALL_MAX_USD: z.coerce.number().positive().default(0.5),
  /** All delegations started from one chat turn. */
  SUBAGENT_TURN_MAX_USD: z.coerce.number().positive().default(1.5),
  /** One background task over its whole life; it is stopped when it gets there. */
  TASK_MAX_USD: z.coerce.number().positive().default(5),
  SUBAGENT_MAX_CONCURRENT: z.coerce.number().int().positive().default(3),
  SUBAGENT_MAX_PER_TURN: z.coerce.number().int().positive().default(6),
  /** A delegation is interrupted after this long. */
  SUBAGENT_TIMEOUT_SEC: z.coerce.number().int().positive().default(600),
  /** The chat waits this long for a delegation; after that its result arrives as an update. */
  SUBAGENT_SYNC_SEC: z.coerce.number().int().positive().default(120),
  /** Workers and subagents never run on a model whose blended price (0.75·input + 0.25·output, USD per 1M tokens) is higher. */
  MODEL_MAX_PRICE_PER_1M: z.coerce.number().positive().default(2),
  /** New work is refused while the crowbot balance is below this (0 = off). */
  BALANCE_FLOOR_USD: z.coerce.number().min(0).default(1),

  /** Where the gateway reads crowbot's model catalog (prices, capabilities). */
  CATALOG_URL: z.url().default("https://api.crowbot.sh/v1/models"),
  CATALOG_REFRESH_MIN: z.coerce.number().int().positive().default(60),
  /** The OpenCode provider id the catalog's models live under. */
  MODEL_PROVIDER: z.string().default("crowbot"),
  /** Subagent models, effort, jobs and caps. Default: config/kinds.json next to the app. */
  KINDS_FILE: z.string().default("config/kinds.json"),
  /** The OpenCode config the kinds' tools are read from (OpenCode enforces them from the same file). */
  OPENCODE_CONFIG_FILE: z.string().default("opencode/opencode.json"),
  MAX_WORKERS: z.coerce.number().int().positive().default(3),
  MIN_JOB_INTERVAL_MIN: z.coerce.number().int().positive().default(60),
  STUCK_AFTER_MIN: z.coerce.number().int().positive().default(120),
  /** If the main session has been busy longer than this, the watchdog re-polls its real status. */
  BUSY_WATCHDOG_SEC: z.coerce.number().int().positive().default(45),
  MONITOR_TIMEOUT_SEC: z.coerce.number().int().positive().default(120),
  DISK_CHECK_PATH: z.string().default("/"),
  DISK_MIN_FREE_GB: z.coerce.number().min(0).default(5),
  /** Bounded history: terminal rows older than this are pruned. Pending work is never pruned. */
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  /** Fresh chat session after this long (0 = never). The assistant saves memory + a handoff first. */
  ROTATE_AFTER_HOURS: z.coerce.number().min(0).default(4),
  /** ...but only once the chat has been quiet this long, so it never resets mid-conversation. */
  ROTATE_IDLE_MIN: z.coerce.number().min(0).default(15),
  /** Also rotate (when quiet) once the chat context gets this big. */
  ROTATE_CONTEXT_TOKENS: z.coerce.number().int().positive().default(150_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  return {
    ...e,
    // OpenCode reports directories with native separators; keep ours absolute and normalized.
    ASSISTANT_HOME: path.resolve(e.ASSISTANT_HOME),
    PROJECTS_DIR: path.resolve(e.PROJECTS_DIR),
    DATA_DIR: path.resolve(e.DATA_DIR),
    KINDS_FILE: path.resolve(e.KINDS_FILE),
    OPENCODE_CONFIG_FILE: path.resolve(e.OPENCODE_CONFIG_FILE),
    quietHours: e.QUIET_HOURS ? parseRange(e.QUIET_HOURS) : undefined,
  };
}

export type MinuteRange = { start: number; end: number };

function parseRange(value: string): MinuteRange {
  const [a, b] = value.split("-") as [string, string];
  return { start: toMinutes(a), end: toMinutes(b) };
}

export function toMinutes(hhmmValue: string): number {
  const [h, m] = hhmmValue.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

export function parseModelRef(ref: string): { providerID: string; modelID: string } {
  const i = ref.indexOf("/");
  return { providerID: ref.slice(0, i), modelID: ref.slice(i + 1) };
}
