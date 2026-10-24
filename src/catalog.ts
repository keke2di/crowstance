/**
 * The model catalog: what each model costs and can do, from crowbot's live `/v1/models`, crossed
 * with the models OpenCode can actually run (a model must be in both to be *usable*). Prices are
 * crowbot's, not opencode.json's, so spend caps hold when the config's prices go stale.
 *
 * Without a crowbot key (or before the first fetch succeeds) the catalog falls back to OpenCode's
 * own list for MODEL_PROVIDER, prices included, so a dev setup with the stub provider still works.
 */
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Store, TokenTotals } from "./db.ts";
import { logger } from "./log.ts";
import { modelCost, type ModelInfo, type OpenCode } from "./opencode.ts";

const log = logger("catalog");

const KEY_CATALOG = "catalog.crowbot";
const KEY_CATALOG_AT = "catalog.fetchedAt";

/** The shape crowbot's `GET /v1/models` returns (the same one crowbot-cli parses). */
const Listing = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      display_name: z.string().optional(),
      context_window: z.number().optional(),
      max_output_tokens: z.number().optional(),
      pricing: z.object({
        input_per_1m_usd: z.number().nonnegative(),
        cached_input_per_1m_usd: z.number().nonnegative().optional(),
        output_per_1m_usd: z.number().nonnegative(),
      }),
      capabilities: z.object({ reasoning: z.boolean().optional(), tool_calling: z.boolean().optional() }).optional(),
    }),
  ),
});
type CrowbotModel = z.infer<typeof Listing>["data"][number];

export type CatalogModel = {
  /** Model id within the provider, e.g. "kimi-k3". */
  id: string;
  /** "provider/model", what OpenCode and /model use. */
  ref: string;
  name: string;
  context: number;
  /** USD per 1M tokens. */
  price: { input: number; cached: number; output: number };
  reasoning: boolean;
  toolCalling: boolean;
  /** Effort levels OpenCode offers for it (its variants). */
  efforts: string[];
  source: "crowbot" | "opencode";
};

export type Drift = { missing: string[]; prices: { id: string; crowbot: [number, number]; opencode: [number, number] }[] };

/** One number to compare models by: mostly input, since agents read far more than they write. */
export function blendedPrice(m: Pick<CatalogModel, "price">): number {
  return 0.75 * m.price.input + 0.25 * m.price.output;
}

/** USD for a token count. Reasoning bills as output; cache writes are charged like input. */
export function costOf(m: Pick<CatalogModel, "price">, t: TokenTotals): number {
  return (t.input * m.price.input + t.cache.read * m.price.cached + t.cache.write * m.price.input + (t.output + t.reasoning) * m.price.output) / 1_000_000;
}

export function priceLabel(m: Pick<CatalogModel, "price">): string {
  const n = (v: number) => (v >= 1 ? v.toFixed(2) : v.toPrecision(2)).replace(/\.?0+$/, "");
  return `$${n(m.price.input)}/$${n(m.price.output)}`;
}

export class Catalog {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly oc: OpenCode;
  private readonly fetchImpl: typeof fetch;
  private crowbot: CrowbotModel[] = [];
  private opencode: ModelInfo[] = [];
  private usableModels: CatalogModel[] = [];
  private lastError: string | undefined;

  constructor(deps: { cfg: Config; store: Store; oc: OpenCode; fetchImpl?: typeof fetch }) {
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.oc = deps.oc;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    const cached = this.store.get(KEY_CATALOG);
    if (cached) {
      const parsed = Listing.safeParse(JSON.parse(cached));
      if (parsed.success) this.crowbot = parsed.data.data;
    }
  }

  /** Fetch crowbot's catalog and OpenCode's model list; a failure keeps the last good copy of either. */
  async refresh(): Promise<{ ok: boolean; error?: string }> {
    let error: string | undefined;
    if (this.cfg.CROWBOT_API_KEY) {
      try {
        const res = await this.fetchImpl(this.cfg.CATALOG_URL, { headers: { Authorization: `Bearer ${this.cfg.CROWBOT_API_KEY}` }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`crowbot answered HTTP ${res.status}`);
        const parsed = Listing.safeParse(await res.json());
        if (!parsed.success) throw new Error(`unexpected catalog shape: ${parsed.error.issues[0]?.message ?? "?"}`);
        if (parsed.data.data.length === 0) throw new Error("crowbot returned an empty model list");
        this.crowbot = parsed.data.data;
        this.store.set(KEY_CATALOG, JSON.stringify({ data: this.crowbot }));
        this.store.set(KEY_CATALOG_AT, String(Date.now()));
      } catch (err) {
        error = `catalog: ${(err as Error).message}`;
      }
    }
    try {
      const models = await this.oc.models(this.cfg.ASSISTANT_HOME);
      if (models.length) this.opencode = models;
    } catch (err) {
      error = [error, `OpenCode models: ${(err as Error).message}`].filter(Boolean).join("; ");
    }
    this.rebuild();
    if (error && error !== this.lastError) log.warn(`model catalog refresh incomplete (${error}); keeping the last good list`);
    this.lastError = error;
    return error ? { ok: false, error } : { ok: true };
  }

  private rebuild() {
    const provider = this.cfg.MODEL_PROVIDER;
    const ocModels = this.opencode.filter((m) => m.providerID === provider);
    const efforts = (m: ModelInfo | undefined) => (m?.variants ?? []).map((v) => v.id);
    if (this.crowbot.length) {
      const byId = new Map(ocModels.map((m) => [m.id, m]));
      this.usableModels = this.crowbot
        .filter((c) => byId.has(c.id))
        .map((c) => ({
          id: c.id,
          ref: `${provider}/${c.id}`,
          name: c.display_name || c.id,
          context: c.context_window ?? byId.get(c.id)?.limit?.context ?? 0,
          price: { input: c.pricing.input_per_1m_usd, cached: c.pricing.cached_input_per_1m_usd ?? c.pricing.input_per_1m_usd, output: c.pricing.output_per_1m_usd },
          reasoning: c.capabilities?.reasoning ?? false,
          toolCalling: c.capabilities?.tool_calling ?? true,
          efforts: efforts(byId.get(c.id)),
          source: "crowbot" as const,
        }));
    } else {
      this.usableModels = ocModels.map((m) => {
        const cost = modelCost(m);
        return {
          id: m.id,
          ref: `${provider}/${m.id}`,
          name: m.name ?? m.id,
          context: m.limit?.context ?? 0,
          price: { input: cost?.input ?? 0, cached: cost?.cache?.read ?? cost?.input ?? 0, output: cost?.output ?? 0 },
          // OpenCode 2 doesn't say whether a model reasons; it offers effort variants to those it thinks do.
          reasoning: m.capabilities?.reasoning ?? efforts(m).length > 0,
          toolCalling: (m.capabilities?.tools ?? m.capabilities?.toolcall ?? m.capabilities?.tool_call ?? true) !== false,
          efforts: efforts(m),
          source: "opencode" as const,
        };
      });
    }
  }

  /** Models a role may run on, cheapest first. */
  usable(): CatalogModel[] {
    return [...this.usableModels].sort((a, b) => blendedPrice(a) - blendedPrice(b));
  }

  /** A usable model by "provider/model" or bare id. */
  get(ref: string): CatalogModel | undefined {
    const id = ref.includes("/") ? ref : `${this.cfg.MODEL_PROVIDER}/${ref}`;
    return this.usableModels.find((m) => m.ref === id);
  }

  /** Every "provider/model" OpenCode can run, whether or not crowbot prices it (e.g. a second provider for the chat). */
  runnable(): string[] {
    return this.opencode.map((m) => `${m.providerID}/${m.id}`);
  }

  /** crowbot models OpenCode can't run yet, and models whose opencode.json price disagrees with crowbot's. */
  drift(): Drift {
    const provider = this.cfg.MODEL_PROVIDER;
    const ocModels = new Map(this.opencode.filter((m) => m.providerID === provider).map((m) => [m.id, m]));
    const missing = this.crowbot.filter((c) => !ocModels.has(c.id)).map((c) => c.id);
    const prices: Drift["prices"] = [];
    for (const c of this.crowbot) {
      const known = ocModels.get(c.id);
      const o = known ? modelCost(known) : undefined;
      if (o?.input === undefined || o.output === undefined) continue;
      const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, 0.005 * Math.max(a, b));
      if (!close(o.input, c.pricing.input_per_1m_usd) || !close(o.output, c.pricing.output_per_1m_usd)) {
        prices.push({ id: c.id, crowbot: [c.pricing.input_per_1m_usd, c.pricing.output_per_1m_usd], opencode: [o.input, o.output] });
      }
    }
    return { missing, prices };
  }

  /** True once there is crowbot data (live or cached); otherwise prices come from OpenCode. */
  hasCrowbot(): boolean {
    return this.crowbot.length > 0;
  }

  fetchedAt(): number | undefined {
    const at = this.store.get(KEY_CATALOG_AT);
    return at ? Number(at) : undefined;
  }
}
