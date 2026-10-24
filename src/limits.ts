/**
 * Spending caps. The env sets each cap's ceiling; /limits can make a cap stricter at runtime and
 * relax it back, never past the ceiling (for the balance floor, "stricter" means higher).
 *
 * Two kinds of enforcement:
 * - preflight: new work (a chat turn, a worker, a delegation) is refused when a cap is already
 *   reached, or when a delegation's own cap wouldn't fit in what is left;
 * - live: every usage event from OpenCode records the session's cost increase and reports the
 *   caps it broke, and the gateway interrupts what broke them (see index.ts).
 */
import type { Config } from "./config.ts";
import { costOf, type Catalog } from "./catalog.ts";
import type { Store, TokenTotals } from "./db.ts";
import { BudgetError, UserError } from "./errors.ts";
import type { Kinds } from "./kinds.ts";
import { logger } from "./log.ts";
import { startOfLocalDay, startOfLocalMonth, usd } from "./text.ts";

const log = logger("limits");

type Unit = "usd" | "count" | "usd/1M";
type CapSpec = { env: keyof Config; unit: Unit; label: string; floor?: true };

export const CAPS = {
  daily: { env: "DAILY_BUDGET_USD", unit: "usd", label: "all spend per day" },
  monthly: { env: "MONTHLY_BUDGET_USD", unit: "usd", label: "all spend per month" },
  subagents: { env: "SUBAGENT_DAILY_BUDGET_USD", unit: "usd", label: "subagents per day" },
  call: { env: "SUBAGENT_CALL_MAX_USD", unit: "usd", label: "one delegation" },
  turn: { env: "SUBAGENT_TURN_MAX_USD", unit: "usd", label: "delegations in one chat turn" },
  task: { env: "TASK_MAX_USD", unit: "usd", label: "one background task" },
  price: { env: "MODEL_MAX_PRICE_PER_1M", unit: "usd/1M", label: "priciest model for workers and subagents (blended)" },
  floor: { env: "BALANCE_FLOOR_USD", unit: "usd", label: "crowbot balance below which new work stops", floor: true },
  concurrent: { env: "SUBAGENT_MAX_CONCURRENT", unit: "count", label: "subagents running at once" },
  "per-turn": { env: "SUBAGENT_MAX_PER_TURN", unit: "count", label: "delegations per chat turn" },
} as const satisfies Record<string, CapSpec>;
export type CapName = keyof typeof CAPS;

export function isCapName(name: string): name is CapName {
  return Object.hasOwn(CAPS, name);
}

/** A cap that live usage just broke; index.ts decides what to interrupt. */
export type Breach =
  | { cap: "task"; sessionID: string; spent: number; limit: number }
  | { cap: "call"; sessionID: string; runID: number; spent: number; limit: number }
  | { cap: "turn"; turnID: number; spent: number; limit: number }
  | { cap: "subagents" | "daily" | "monthly"; spent: number; limit: number };

const KEY_BALANCE = "balance.usd";
const KEY_BALANCE_AT = "balance.at";

export class Limits {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly catalog?: Catalog;
  private readonly kinds?: Kinds;
  private readonly balanceSource?: () => Promise<number>;
  /** "provider/model" a session is currently running on, for pricing its tokens. */
  private readonly modelFor: (sessionID: string) => string | undefined;

  constructor(deps: { cfg: Config; store: Store; catalog?: Catalog; kinds?: Kinds; balance?: () => Promise<number>; modelFor?: (sessionID: string) => string | undefined }) {
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.catalog = deps.catalog;
    this.kinds = deps.kinds;
    this.balanceSource = deps.balance;
    this.modelFor = deps.modelFor ?? (() => undefined);
  }

  ceiling(name: CapName): number {
    return this.cfg[CAPS[name].env] as number;
  }

  /** The cap in force: the /limits value clamped to the env ceiling. */
  get(name: CapName): number {
    const ceiling = this.ceiling(name);
    const raw = this.store.get(`limit.${name}`);
    if (raw === undefined) return ceiling;
    const value = Number(raw);
    if (!Number.isFinite(value)) return ceiling;
    return "floor" in CAPS[name] ? Math.max(value, ceiling) : Math.min(value, ceiling);
  }

  /** Set a runtime value (undefined resets to the ceiling). Returns the value in force and whether it was clamped. */
  set(name: CapName, value: number | undefined): { value: number; clamped: boolean } {
    if (value === undefined) {
      this.store.delete(`limit.${name}`);
      return { value: this.ceiling(name), clamped: false };
    }
    if (!Number.isFinite(value) || value < 0) throw new UserError("A cap is a number ≥ 0.");
    if (CAPS[name].unit === "count" && (!Number.isInteger(value) || value < 1)) throw new UserError("That cap is a whole number ≥ 1.");
    const ceiling = this.ceiling(name);
    const isFloor = "floor" in CAPS[name];
    const clamped = isFloor ? value < ceiling : value > ceiling;
    const applied = clamped ? ceiling : value;
    if (applied === ceiling) this.store.delete(`limit.${name}`);
    else this.store.set(`limit.${name}`, String(applied));
    return { value: applied, clamped };
  }

  private fmt(name: CapName, v: number) {
    const unit = CAPS[name].unit;
    return unit === "count" ? String(v) : unit === "usd/1M" ? `$${v}/1M` : usd(v);
  }

  /** What /limits shows. */
  describe(now = new Date()): string {
    const day = startOfLocalDay(now);
    const used: Partial<Record<CapName, string>> = {
      daily: usd(this.store.spendSince(day)),
      monthly: usd(this.store.spendSince(startOfLocalMonth(now))),
      subagents: usd(this.store.subagentSpendSince(day)),
      concurrent: String(this.store.runningSubagents().length),
      floor: this.balance() === undefined ? "balance unknown" : `balance ${usd(this.balance()!)}`,
    };
    const lines = (Object.keys(CAPS) as CapName[]).map((name) => {
      const value = this.get(name);
      const ceiling = this.ceiling(name);
      const limit = value === ceiling ? this.fmt(name, value) : `${this.fmt(name, value)} (ceiling ${this.fmt(name, ceiling)})`;
      return `${name}: ${limit} — ${CAPS[name].label}${used[name] ? ` · now ${used[name]}` : ""}`;
    });
    return [...lines, "", "/limits <cap> <value> sets one (up to its ceiling from the env); /limits <cap> default resets it."].join("\n");
  }

  // ---- crowbot balance (cached; refreshed from housekeeping) ----

  async refreshBalance(now = Date.now()): Promise<void> {
    if (!this.balanceSource) return;
    if (now - Number(this.store.get(KEY_BALANCE_AT) ?? 0) < 5 * 60_000) return;
    try {
      const balance = await this.balanceSource();
      this.store.set(KEY_BALANCE, String(balance));
      this.store.set(KEY_BALANCE_AT, String(now));
    } catch (err) {
      log.warn(`balance check failed: ${(err as Error).message}`);
    }
  }

  balance(): number | undefined {
    const raw = this.store.get(KEY_BALANCE);
    return raw === undefined ? undefined : Number(raw);
  }

  /** The most one delegation of `kind` may spend. */
  callCap(kind?: string): number {
    const kindCap = kind ? this.kinds?.get(kind)?.maxCallUsd : undefined;
    return Math.min(this.get("call"), kindCap ?? Infinity);
  }

  // ---- preflight ----

  /**
   * Refuse new work when a cap is reached. `reserve` is what the new work may spend (a
   * delegation reserves its full call cap), so it can't start unless that fits.
   */
  preflight(scope: "chat" | "worker" | "subagent", reserve = 0, now = new Date()) {
    const day = startOfLocalDay(now);
    const today = this.store.spendSince(day);
    const daily = this.get("daily");
    if (today >= daily || (reserve > 0 && today + reserve > daily)) {
      throw new BudgetError(`Daily budget reached (${usd(today)} of ${usd(daily)}). Ask the user before starting more work; /limits daily shows it, DAILY_BUDGET_USD is the ceiling.`);
    }
    const month = this.store.spendSince(startOfLocalMonth(now));
    const monthly = this.get("monthly");
    if (month >= monthly || (reserve > 0 && month + reserve > monthly)) {
      throw new BudgetError(`Monthly budget reached (${usd(month)} of ${usd(monthly)}). MONTHLY_BUDGET_USD is the ceiling.`);
    }
    if (scope === "subagent") {
      const sub = this.store.subagentSpendSince(day);
      const cap = this.get("subagents");
      if (sub + reserve > cap) throw new BudgetError(`Subagent budget for today reached (${usd(sub)} of ${usd(cap)}${reserve ? `; this call reserves ${usd(reserve)}` : ""}). Do it yourself or ask the user.`);
    }
    const floor = this.get("floor");
    const balance = this.balance();
    if (scope !== "chat" && floor > 0 && balance !== undefined && balance < floor) {
      throw new BudgetError(`The crowbot balance is ${usd(balance)}, below the ${usd(floor)} floor; no new background work until it's topped up.`);
    }
  }

  /** Delegations of one chat turn so far: count and spend. */
  turnUsage(turnID: number) {
    const runs = this.store.subagentsInTurn(turnID);
    return { count: runs.length, spent: runs.reduce((sum, r) => sum + (r.session_id ? this.store.sessionSpend(r.session_id) : 0), 0) };
  }

  // ---- live usage ----

  /** Record a usage event (running totals) and return the caps it broke. */
  recordUsage(sessionID: string, ocTotal: number, tokens: TokenTotals, at = Date.now()): { increase: number; breaches: Breach[] } {
    const ref = this.modelFor(sessionID);
    const model = ref ? this.catalog?.get(ref) : undefined;
    const { increase } = this.store.recordSessionUsage(sessionID, ocTotal, tokens, at, model ? (d) => costOf(model, d) : undefined);
    if (increase <= 0) return { increase, breaches: [] };
    return { increase, breaches: this.breaches(sessionID, new Date(at)) };
  }

  private breaches(sessionID: string, now: Date): Breach[] {
    const out: Breach[] = [];
    const spent = this.store.sessionSpend(sessionID);
    const task = this.store.taskBySession(sessionID);
    if (task && (task.state === "running" || task.state === "waiting") && spent >= this.get("task")) {
      out.push({ cap: "task", sessionID, spent, limit: this.get("task") });
    }
    const run = this.store.subagentRunBySession(sessionID);
    if (run && run.state === "running") {
      const cap = this.callCap(run.kind);
      if (spent >= cap) out.push({ cap: "call", sessionID, runID: run.id, spent, limit: cap });
      if (run.turn_id !== null) {
        const turn = this.turnUsage(run.turn_id).spent;
        if (turn >= this.get("turn")) out.push({ cap: "turn", turnID: run.turn_id, spent: turn, limit: this.get("turn") });
      }
      const sub = this.store.subagentSpendSince(startOfLocalDay(now));
      if (sub >= this.get("subagents")) out.push({ cap: "subagents", spent: sub, limit: this.get("subagents") });
    }
    const today = this.store.spendSince(startOfLocalDay(now));
    if (today >= this.get("daily")) out.push({ cap: "daily", spent: today, limit: this.get("daily") });
    const month = this.store.spendSince(startOfLocalMonth(now));
    if (month >= this.get("monthly")) out.push({ cap: "monthly", spent: month, limit: this.get("monthly") });
    return out;
  }

  /** True the first time a period cap trips on a given day, so the owner is told once. */
  firstTrip(cap: string, now = new Date()): boolean {
    const key = `limits.tripped.${cap}`;
    const day = String(startOfLocalDay(now));
    if (this.store.get(key) === day) return false;
    this.store.set(key, day);
    return true;
  }
}
