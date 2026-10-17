/**
 * Structured, correlated, redacted logging.
 *
 * Every line carries an optional correlation id. Correlation ids are attached to
 * durable rows (inbound → turn → outbound) and propagated in-process through an
 * AsyncLocalStorage context, so a single inbound message can be followed all the
 * way to Telegram delivery. Secrets, PII-ish fields and raw coordinates are
 * redacted before anything reaches the log.
 */
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

const context = new AsyncLocalStorage<{ correlationId?: string }>();

export function setLogLevel(level: Level) {
  threshold = LEVELS[level];
}

export function newCorrelationId(prefix = "cor"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** The correlation id of the current async execution, if any. */
export function correlationId(): string | undefined {
  return context.getStore()?.correlationId;
}

/** Run `fn` (and everything it awaits) under a correlation id. */
export function runWithCorrelation<T>(id: string | undefined, fn: () => T): T {
  if (!id) return fn();
  return context.run({ correlationId: id }, fn);
}

export type LogContext = { correlationId?: string; [key: string]: unknown };

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  /** A logger with additional structured context (e.g. a correlation id). */
  with(more: LogContext): Logger;
}

export const REDACTED = "[redacted]";

/** Keys whose values must never be logged verbatim. */
const SENSITIVE_KEY =
  /pass(word|phrase)?|secret|token|api[_-]?key|apikey|authorization|cookie|credential|private[_-]?key|latitude|longitude|(^|_)lat($|_)|(^|_)lon(g|gitude)?($|_)|coordinate/i;

const TOKEN_PATTERNS: [RegExp, string][] = [
  // Telegram bot token, e.g. 123456789:AA...
  [/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]"],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g, "[redacted-jwt]"],
];

/** Scrub token-like substrings from free text. */
export function redactText(input: string): string {
  let text = input;
  for (const [pattern, replacement] of TOKEN_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

/** Recursively redact a value before it is logged. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), stack: value.stack ? redactText(value.stack) : undefined };
  }
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

export const redact = redactValue;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Error) && !Buffer.isBuffer(value);
}

function emit(level: Level, scope: string, msg: string, extra: unknown, ctx: LogContext) {
  if (LEVELS[level] < threshold) return;
  const explicit = ctx.correlationId ?? (isRecord(extra) && typeof extra.correlationId === "string" ? extra.correlationId : undefined);
  const corr = explicit ?? correlationId();
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}]${corr ? ` correlation=${corr}` : ""} ${redactText(msg)}`;
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) {
    out(line);
    return;
  }
  if (extra instanceof Error) {
    out(line, redactText(extra.stack ?? extra.message));
    return;
  }
  out(line, redactValue(extra));
}

export function logger(scope: string, base: LogContext = {}): Logger {
  const make = (ctx: LogContext): Logger => ({
    debug: (msg, extra) => emit("debug", scope, msg, extra, ctx),
    info: (msg, extra) => emit("info", scope, msg, extra, ctx),
    warn: (msg, extra) => emit("warn", scope, msg, extra, ctx),
    error: (msg, extra) => emit("error", scope, msg, extra, ctx),
    with: (more) => make({ ...ctx, ...more }),
  });
  return make(base);
}
