import type { Config } from "./config.ts";
import { startOfLocalDay } from "./text.ts";
import type { Store } from "./db.ts";

export function reasoningVariant(_cfg: Config): string { return "default"; }

export function estimatedReasoningCost(cfg: Config, text: string): number {
  const output = Math.min(cfg.REASONING_MAX_OUTPUT_TOKENS, Math.max(256, Math.ceil(text.length / 3) * 4));
  return output / 1_000_000 * 1.5;
}

export function reserveReasoning(store: Store, cfg: Config, requestID: string, sessionID: string, scope: string, text: string) {
  const estimate = estimatedReasoningCost(cfg, text);
  const spent = store.reasoningSpendSince(startOfLocalDay());
  if (spent + estimate > cfg.REASONING_DAILY_BUDGET_USD) {
    throw new Error(`Reasoning budget would be exceeded (${spent.toFixed(2)} + ${estimate.toFixed(2)} of ${cfg.REASONING_DAILY_BUDGET_USD.toFixed(2)} USD)`);
  }
  store.reserveReasoning(requestID, sessionID, scope, reasoningVariant(cfg), estimate);
  return estimate;
}

// Only *clearly* big build work is handed off automatically; everything else is the assistant's call.
const WORK_VERBS = /\b(build|implement|refactor|migrate|develop|deploy|set ?up|configure|integrate|scaffold|automate|port)\b/gi;
const FIX = /\bfix\b/i;
const TECH_OBJECT =
  /\b(app|application|service|api|bot|script|scraper|website|site|web ?app|database|db|server|repo(sitory)?|code ?base|codebase|feature|pipeline|backend|frontend|cli|tests?|integration|dashboard|module|deployment)\b/i;
const NOT_WORK = /\b(remind|reminder|alarm|schedule|every (day|morning|evening|week|hour)|tomorrow at|tonight at|in \d+ ?(min|minutes?|hours?))\b/i;
const QUESTION = /^(what|how|why|when|where|who|which|is|are|can|could|should|do|does|did|will|would)\b/i;

/**
 * True for requests that are unmistakably multi-step build work: a build-type verb, a technical object,
 * and either several work verbs, several steps or a long spec. Reminders, questions and chat stay with
 * the assistant, which still sees every message either way.
 */
export function isClearlyBigRequest(text: string): boolean {
  const t = text.trim();
  if (!t || NOT_WORK.test(t)) return false;
  if (QUESTION.test(t) && t.length < 300) return false;
  if (!TECH_OBJECT.test(t)) return false;
  const verbs = new Set((t.match(WORK_VERBS) ?? []).map((v) => v.toLowerCase().replace(/\s+/g, "")));
  if (verbs.size === 0 && !FIX.test(t)) return false;
  const steps = (t.match(/[;\n]|\b(and then|then|after that|afterwards|also|finally)\b/gi) ?? []).length;
  return t.length >= 220 || verbs.size >= 2 || steps >= 2;
}

export function completeBrief(text: string, model?: string) {
  return [
    `User request: ${text.trim()}`,
    "Context: This task was automatically delegated by the assistant because it is multi-step or spans code/research/setup work.",
    "Constraints: Work autonomously in the assigned project; do not expose private reasoning traces; preserve secrets; ask before risky outward-facing or destructive actions.",
    "Deliverable: Make the requested change, verify it with focused tests/checks, and report decisions, assumptions, checks, and concise rationale.",
    model ? `Requested model: ${model}` : "",
  ].filter(Boolean).join("\n\n");
}
