import type { TaskOutcome } from "./db.ts";

export function slugify(input: string, max = 40): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "task";
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + "…";
}

/** Keep the end of a long text (reports usually put the conclusion last). */
export function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return "…" + s.slice(s.length - n + 1).trimStart();
}

export function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "under a minute";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${h}h ${m}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function ago(at: number, now = Date.now()): string {
  const d = now - at;
  if (d < 60_000) return "just now";
  return `${duration(d)} ago`;
}

export function usd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** "Tue 6 Oct 2026, 14:32" in the process time zone (set TZ). */
export function stamp(d: Date = new Date()): string {
  const weekday = d.toLocaleDateString("en-GB", { weekday: "short" });
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${weekday} ${date}, ${time}`;
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The assistant answers exactly NO_REPLY when an update isn't worth a message. */
export function isNoReply(text: string): boolean {
  const t = text.trim().replace(/^[`*_"']+|[`*_"'.!]+$/g, "");
  return t.toUpperCase() === "NO_REPLY";
}

/** Drop a trailing NO_REPLY marker the model sometimes appends after real text. */
export function stripNoReply(text: string): string {
  return text.replace(/\s*[`*_]*NO_REPLY[`*_.]*\s*$/i, "").trim();
}

/** Workers end with "Status: done | blocked | needs-input". */
export function parseOutcome(report: string): TaskOutcome {
  const m = /status\s*[:\-]\s*\**\s*(done|complete[d]?|finished|blocked|needs[\s-]?input|waiting)/i.exec(report);
  if (!m) return "unknown";
  const v = m[1]!.toLowerCase();
  if (v.startsWith("block")) return "blocked";
  if (v.startsWith("need") || v === "waiting") return "needs-input";
  return "done";
}

export function startOfLocalDay(now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfLocalMonth(now = new Date()): number {
  const d = new Date(now.getFullYear(), now.getMonth(), 1);
  return d.getTime();
}

export function minutesOfDay(d = new Date()): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** Inclusive start, exclusive end; handles ranges that wrap midnight (23:00-08:00). */
export function inRange(minute: number, range: { start: number; end: number }): boolean {
  if (range.start === range.end) return false;
  return range.start < range.end ? minute >= range.start && minute < range.end : minute >= range.start || minute < range.end;
}
