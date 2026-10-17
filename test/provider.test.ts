import { describe, expect, it } from "vitest";
import { crowbotBalance, describeBalance } from "../src/provider.ts";

const fakeFetch = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("crowbotBalance", () => {
  it("reads balance and spend from /api/me", async () => {
    const b = await crowbotBalance("k", fakeFetch(200, { balance_microdollars: 59320372, spent_microdollars: 265659628, requests: 3511 }));
    expect(b).toEqual({ balanceUsd: 59.320372, spentUsd: 265.659628, requests: 3511 });
    expect(describeBalance(b)).toBe("crowbot balance: $59.32; spent on this account so far: $265.66 over 3511 requests");
  });

  it("prefers the dollar fields and fails clearly on errors", async () => {
    expect((await crowbotBalance("k", fakeFetch(200, { balance_usd: 12.5 }))).balanceUsd).toBe(12.5);
    await expect(crowbotBalance("k", fakeFetch(401, { error: "invalid_api_key" }))).rejects.toThrow(/HTTP 401/);
    await expect(crowbotBalance("k", fakeFetch(200, { hello: 1 }))).rejects.toThrow(/no balance/);
  });
});
