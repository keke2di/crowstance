/**
 * Account info from the model provider (crowbot). The gateway holds the key, so the assistant can
 * check the balance through a tool instead of going looking for credentials.
 */
import { usd } from "./text.ts";

export type Balance = { balanceUsd: number; spentUsd?: number; requests?: number };

export async function crowbotBalance(key: string, fetchImpl: typeof fetch = fetch): Promise<Balance> {
  const res = await fetchImpl("https://api.crowbot.sh/api/me", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`crowbot answered HTTP ${res.status}`);
  const me = (await res.json()) as Record<string, unknown>;
  const num = (k: string) => (typeof me[k] === "number" ? (me[k] as number) : undefined);
  const balance = num("balance_usd") ?? (num("balance_microdollars") !== undefined ? num("balance_microdollars")! / 1e6 : undefined);
  if (balance === undefined) throw new Error("crowbot's reply had no balance");
  const spent = num("spent_usd") ?? (num("spent_microdollars") !== undefined ? num("spent_microdollars")! / 1e6 : undefined);
  return { balanceUsd: balance, spentUsd: spent, requests: num("requests") };
}

export function describeBalance(b: Balance): string {
  const bits = [`crowbot balance: ${usd(b.balanceUsd)}`];
  if (b.spentUsd !== undefined) bits.push(`spent on this account so far: ${usd(b.spentUsd)}${b.requests !== undefined ? ` over ${b.requests} requests` : ""}`);
  return bits.join("; ");
}
