/**
 * `npm run models:sync`: rewrite the crowbot models in opencode/opencode.json from crowbot's live
 * catalog (ids, names, limits, prices, tool/reasoning support), so OpenCode can run every model
 * crowbot serves and prices the same way. Effort levels need nothing here: OpenCode gives every
 * model low/medium/high variants itself.
 *
 *   npm run models:sync            rewrite the file (other providers and fields are left alone)
 *   npm run models:sync -- --check exit 1 if the file is out of date, change nothing
 *
 * Needs CROWBOT_API_KEY (from the environment or .env). The deployed config is root-owned, so run
 * this in your checkout and ship the result with deploy.sh (it needs --restart-opencode).
 */
import fs from "node:fs";
import path from "node:path";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const key = process.env.CROWBOT_API_KEY;
const url = process.env.CATALOG_URL ?? "https://api.crowbot.sh/v1/models";
const file = path.resolve(process.argv.find((a) => a.endsWith(".json")) ?? "opencode/opencode.json");
const check = process.argv.includes("--check");
const provider = process.env.MODEL_PROVIDER ?? "crowbot";

async function main(): Promise<number> {
  if (!key) {
    console.error("CROWBOT_API_KEY is not set (environment or .env).");
    return 2;
  }

  type Remote = {
    id: string;
    display_name?: string;
    context_window?: number;
    max_output_tokens?: number;
    pricing: { input_per_1m_usd: number; cached_input_per_1m_usd?: number; output_per_1m_usd: number };
    capabilities?: { reasoning?: boolean; tool_calling?: boolean };
  };

  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    console.error(`crowbot answered HTTP ${res.status}`);
    return 2;
  }
  const remote = ((await res.json()) as { data?: Remote[] }).data ?? [];
  if (!remote.length) {
    console.error("crowbot returned an empty model list; leaving the config alone.");
    return 2;
  }

  const text = fs.readFileSync(file, "utf8");
  const config = JSON.parse(text) as { provider?: Record<string, { models?: Record<string, Record<string, unknown>> }> };
  const current = config.provider?.[provider]?.models ?? {};

  const next: Record<string, Record<string, unknown>> = {};
  for (const m of [...remote].sort((a, b) => a.id.localeCompare(b.id))) {
    const old = current[m.id] ?? {};
    next[m.id] = {
      ...old,
      name: m.display_name || m.id,
      limit: { context: m.context_window ?? 1_000_000, output: m.max_output_tokens ?? 32_768 },
      cost: { input: m.pricing.input_per_1m_usd, output: m.pricing.output_per_1m_usd, cache_read: m.pricing.cached_input_per_1m_usd ?? m.pricing.input_per_1m_usd },
      tool_call: m.capabilities?.tool_calling ?? true,
      reasoning: m.capabilities?.reasoning ?? false,
      ...(m.capabilities?.reasoning ? { interleaved: old.interleaved ?? "reasoning_content" } : {}),
      temperature: old.temperature ?? true,
      attachment: old.attachment ?? false,
    };
  }

  const added = Object.keys(next).filter((id) => !(id in current));
  const removed = Object.keys(current).filter((id) => !(id in next));
  const changed = Object.keys(next).filter((id) => id in current && JSON.stringify(current[id]) !== JSON.stringify(next[id]));
  console.log(`crowbot serves ${remote.length} models.`);
  if (added.length) console.log(`  new:     ${added.join(", ")}`);
  if (removed.length) console.log(`  gone:    ${removed.join(", ")}`);
  if (changed.length) console.log(`  updated: ${changed.join(", ")}`);
  if (!added.length && !removed.length && !changed.length) {
    console.log(`${path.relative(process.cwd(), file)} is up to date.`);
    return 0;
  }
  if (check) {
    console.log(`${path.relative(process.cwd(), file)} is out of date; run npm run models:sync.`);
    return 1;
  }

  // Replace just the models block, one model per line like the rest of the file.
  const providerAt = text.indexOf(`"${provider}"`, text.indexOf('"provider"'));
  const modelsAt = text.indexOf('"models"', providerAt);
  const open = text.indexOf("{", modelsAt);
  let depth = 0;
  let close = open;
  for (; close < text.length; close++) {
    if (text[close] === "{") depth++;
    else if (text[close] === "}" && --depth === 0) break;
  }
  const lineStart = text.lastIndexOf("\n", modelsAt) + 1;
  const indent = text.slice(lineStart, modelsAt);
  const body = Object.entries(next)
    .map(([id, m]) => `${indent}  ${JSON.stringify(id)}: ${JSON.stringify(m)}`)
    .join(",\n");
  const out = `${text.slice(0, open)}{\n${body}\n${indent}}${text.slice(close + 1)}`;
  JSON.parse(out); // never write a broken config
  fs.writeFileSync(file, out);
  console.log(`Wrote ${path.relative(process.cwd(), file)}. Deploy it with --restart-opencode.`);
  return 0;
}

// Set the exit code instead of process.exit(): exiting while fetch's socket closes crashes Node on Windows.
process.exitCode = await main();
