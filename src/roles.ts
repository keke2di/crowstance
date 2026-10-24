/**
 * Which model and effort each role runs on: the chat, every subagent kind (one by one or all at
 * once), and the background workers. One resolver for every launch, so what /model shows is what
 * is sent. The same shape as crowbot-cli's roles:
 *
 *   a kind:  the call's model → your pick for the kind → config/kinds.json for the kind
 *            → your pick for all subagents → config/kinds.json `every` → the chat's model
 *   every:   your pick for all subagents → config/kinds.json `every` → the chat's model
 *   workers: the call's model → your pick → WORKER_MODEL → config/kinds.json → the worker agent's model → the chat's
 *   chat:    your pick → CHAT_MODEL → the assistant agent's model in opencode.json
 *
 * Effort inherits separately along the same chain and is dropped for a model that doesn't reason.
 * A model that isn't usable, can't call tools, or is priced over MODEL_MAX_PRICE_PER_1M is refused
 * for subagents and workers; it never falls back silently. (The chat is yours to pick: no ceiling.)
 */
import type { Config } from "./config.ts";
import { parseModelRef } from "./config.ts";
import { blendedPrice, priceLabel, type Catalog, type CatalogModel } from "./catalog.ts";
import type { Store } from "./db.ts";
import { UserError } from "./errors.ts";
import { EFFORTS, RESERVED_ROLES, type Effort, type Kinds } from "./kinds.ts";
import type { ModelRef } from "./opencode.ts";

export const KEY_CHAT_MODEL = "model.chat";
export const KEY_WORKER_MODEL = "model.worker";

export type Source = "call" | "pin" | "env" | "policy" | "every-pin" | "every-policy" | "agent" | "chat" | "default";

export type Resolved = {
  /** "provider/model", or undefined when OpenCode's own default applies. */
  ref?: string;
  model?: ModelRef;
  effort?: Effort;
  source: Source;
  /** Human-readable origin, e.g. "your pick for all subagents". */
  from: string;
  info?: CatalogModel;
};

type Pick = { value: string; source: Source; from: string };

export class Roles {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly catalog: Catalog;
  private readonly kinds: Kinds;
  private readonly maxPrice: () => number;

  constructor(deps: { cfg: Config; store: Store; catalog: Catalog; kinds: Kinds; maxPrice?: () => number }) {
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.catalog = deps.catalog;
    this.kinds = deps.kinds;
    this.maxPrice = deps.maxPrice ?? (() => deps.cfg.MODEL_MAX_PRICE_PER_1M);
  }

  /** The chat, all subagents, each kind, then the workers: the order /model shows. */
  ids(): string[] {
    return ["chat", "every", ...this.kinds.list().map((k) => k.id), "workers"];
  }

  has(role: string): boolean {
    return role === "chat" || role === "every" || role === "workers" || this.kinds.get(role) !== undefined;
  }

  private modelKey(role: string) {
    return role === "chat" ? KEY_CHAT_MODEL : role === "workers" ? KEY_WORKER_MODEL : role === "every" ? "model.every" : `model.kind.${role}`;
  }

  private effortKey(role: string) {
    return `effort.${role === "chat" || role === "workers" || role === "every" ? role : `kind.${role}`}`;
  }

  private first(...picks: (Pick | undefined | false)[]): Pick | undefined {
    return picks.find((p): p is Pick => !!p && !!p.value);
  }

  resolve(role: string, asked?: string): Resolved {
    if (role === "chat") return this.resolveChat();
    if (role === "workers") return this.resolveWorkers(asked);
    if (role === "every") return this.resolveKind(undefined, asked);
    const kind = this.kinds.get(role);
    if (!kind) throw new UserError(`No subagent kind "${role}". Kinds: ${this.kinds.list().map((k) => k.id).join(", ") || "none"}.`);
    return this.resolveKind(role, asked);
  }

  /** A kind (or, with no kind, the `every` default). */
  private resolveKind(kind: string | undefined, asked?: string): Resolved {
    const every = this.kinds.every();
    const policy = kind ? this.kinds.get(kind) : undefined;
    const pin = (key: string) => this.store.get(key);
    const model = this.first(
      asked !== undefined && { value: asked, source: "call", from: "asked for in the call" },
      kind !== undefined && { value: pin(this.modelKey(kind)) ?? "", source: "pin", from: "your pick" },
      policy?.model !== undefined && { value: policy.model, source: "policy", from: "config/kinds.json" },
      { value: pin("model.every") ?? "", source: "every-pin", from: "your pick for all subagents" },
      every.model !== undefined && { value: every.model, source: "every-policy", from: "config/kinds.json (all subagents)" },
    );
    const effort = this.first(
      kind !== undefined && { value: pin(this.effortKey(kind)) ?? "", source: "pin", from: "" },
      policy?.effort !== undefined && { value: policy.effort, source: "policy", from: "" },
      { value: pin("effort.every") ?? "", source: "every-pin", from: "" },
      every.effort !== undefined && { value: every.effort, source: "every-policy", from: "" },
    );
    const picked = model ? this.checked(model.value, model.source, model.from) : this.asChat();
    return this.withEffort(picked, effort?.value as Effort | undefined);
  }

  private resolveWorkers(asked?: string): Resolved {
    const policy = this.kinds.workers();
    const model = this.first(
      asked !== undefined && { value: asked, source: "call", from: "asked for in the call" },
      { value: this.store.get(KEY_WORKER_MODEL) ?? "", source: "pin", from: "your pick" },
      { value: this.cfg.WORKER_MODEL ?? "", source: "env", from: "WORKER_MODEL" },
      policy.model !== undefined && { value: policy.model, source: "policy", from: "config/kinds.json" },
      { value: this.kinds.agentModel(this.cfg.WORKER_AGENT) ?? "", source: "agent", from: "the worker agent in opencode.json" },
    );
    const effort = (this.store.get(this.effortKey("workers")) as Effort | undefined) ?? policy.effort;
    const picked = model ? this.checked(model.value, model.source, model.from) : this.asChat();
    return this.withEffort(picked, effort);
  }

  private resolveChat(): Resolved {
    const pin = this.store.get(KEY_CHAT_MODEL);
    const ref = pin ?? this.cfg.CHAT_MODEL ?? this.kinds.agentModel(this.cfg.ASSISTANT_AGENT);
    const source: Source = pin ? "pin" : this.cfg.CHAT_MODEL ? "env" : ref ? "agent" : "default";
    const from = { pin: "your pick", env: "CHAT_MODEL", agent: "the assistant agent in opencode.json", default: "OpenCode's default model" }[source as "pin"];
    if (!ref) return { source, from };
    const info = this.catalog.get(ref);
    const picked: Resolved = { ref, model: parseModelRef(ref), source, from, ...(info ? { info } : {}) };
    return this.withEffort(picked, this.store.get(this.effortKey("chat")) as Effort | undefined);
  }

  /** The chat's model, checked like any subagent model. */
  private asChat(): Resolved {
    const chat = this.resolveChat();
    if (!chat.ref) return { source: "chat", from: "the chat's model" };
    return this.checked(chat.ref, "chat", "same as the chat");
  }

  /** A model for a subagent or worker: usable, calls tools, under the price ceiling. */
  private checked(ref: string, source: Source, from: string): Resolved {
    if (!/^[^/\s]+\/\S+$/.test(ref)) throw new UserError(`"${ref}" isn't a model reference; use provider/model, e.g. ${this.cfg.MODEL_PROVIDER}/kimi-k3.`);
    const info = this.catalog.get(ref);
    const usable = this.catalog.usable();
    if (!info) {
      // No catalog at all (nothing fetched yet, no OpenCode list): accept what OpenCode can run.
      const runnable = this.catalog.runnable();
      if (usable.length === 0 && (runnable.length === 0 || runnable.includes(ref))) return { ref, model: parseModelRef(ref), source, from };
      throw new UserError(`${ref} (${from}) isn't usable: crowbot must serve it and OpenCode must know it. Usable: ${usable.map((m) => m.ref).join(", ") || "none"}.`);
    }
    if (!info.toolCalling) throw new UserError(`${ref} (${from}) can't call tools, which subagents and workers need.`);
    const ceiling = this.maxPrice();
    if (blendedPrice(info) > ceiling) {
      throw new UserError(`${ref} (${from}) costs ${priceLabel(info)} per 1M tokens, over the $${ceiling}/1M ceiling for subagents and workers (/limits price), so pick a cheaper one with /model.`);
    }
    return { ref, model: parseModelRef(ref), source, from, info };
  }

  /** Effort only goes to a model that reasons and offers that level (as an OpenCode variant). */
  private withEffort(picked: Resolved, effort: Effort | undefined): Resolved {
    const info = picked.info;
    if (!effort || !picked.model || !info || !info.reasoning || (info.efforts.length > 0 && !info.efforts.includes(effort))) return picked;
    return { ...picked, effort, model: { ...picked.model, variant: effort } };
  }

  /** /model <role> <ref|auto>. Validates before saving. */
  setModel(role: string, ref: string | undefined) {
    if (!this.has(role)) throw new UserError(`No role "${role}". Roles: ${this.ids().join(", ")}.`);
    if (ref === undefined) return void this.store.delete(this.modelKey(role));
    if (role === "chat") {
      const runnable = this.catalog.runnable();
      if (runnable.length && !runnable.includes(ref)) throw new UserError(`Unknown model "${ref}". Try /model to pick from a list.`);
    } else {
      this.checked(ref, "pin", "your pick");
    }
    this.store.set(this.modelKey(role), ref);
  }

  setEffort(role: string, effort: string | undefined) {
    if (!this.has(role)) throw new UserError(`No role "${role}". Roles: ${this.ids().join(", ")}.`);
    if (effort === undefined) return void this.store.delete(this.effortKey(role));
    if (!(EFFORTS as readonly string[]).includes(effort)) throw new UserError(`Effort is one of ${EFFORTS.join(", ")} (or auto).`);
    this.store.set(this.effortKey(role), effort);
  }

  pinnedModel(role: string): string | undefined {
    return this.store.get(this.modelKey(role));
  }

  /** "kimi-k3 ($0.27/$1.35), effort high · config/kinds.json" */
  describe(role: string): string {
    try {
      const r = this.resolve(role);
      const model = r.ref ? `${r.ref}${r.info ? ` (${priceLabel(r.info)})` : ""}` : "OpenCode's default";
      return `${model}${r.effort ? `, effort ${r.effort}` : ""} · ${r.from}`;
    } catch (err) {
      return `⚠️ ${(err as Error).message}`;
    }
  }

  static isReserved(id: string) {
    return RESERVED_ROLES.has(id);
  }
}
