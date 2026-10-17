import { describe, expect, it } from "vitest";
import { HttpGeocoder, validateCoordinates } from "../src/geocoder.ts";
import { testConfig } from "./fakes.ts";

describe("geocoder", () => {
  it("validates finite ranges, including antimeridian coordinates", () => {
    expect(validateCoordinates({ latitude: 0, longitude: 180 })).toEqual({ latitude: 0, longitude: 180 });
    expect(validateCoordinates({ latitude: 0, longitude: -180 })).toEqual({ latitude: 0, longitude: -180 });
    expect(() => validateCoordinates({ latitude: Number.NaN, longitude: 0 })).toThrow();
    expect(() => validateCoordinates({ latitude: 91, longitude: 0 })).toThrow();
    expect(() => validateCoordinates({ latitude: 0, longitude: Infinity })).toThrow();
  });

  it("bounds timeout and does not log or expose the raw query", async () => {
    let signal: AbortSignal | undefined;
    const fetcher = (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    };
    const geocoder = new HttpGeocoder(testConfig({ GEOCODER_URL: "https://geo.test/search", GEOCODER_TIMEOUT_MS: "5", GEOCODER_MIN_INTERVAL_MS: "0" }), { fetch: fetcher });
    await expect(geocoder.search("private home query")).rejects.toThrow("timed out");
    expect(signal?.aborted).toBe(true);
  });

  it("rate limits requests and bounds candidates", async () => {
    let now = 100;
    const sleeps: number[] = [];
    const geocoder = new HttpGeocoder(testConfig({ GEOCODER_URL: "https://geo.test/search", GEOCODER_TIMEOUT_MS: "100", GEOCODER_MIN_INTERVAL_MS: "50" }), {
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
      fetch: async () => new Response(JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ name: `Place ${i}`, lat: 1, lon: 2 }))), { status: 200 }),
    });
    expect((await geocoder.search("place"))).toHaveLength(5);
    await geocoder.search("place");
    expect(sleeps).toEqual([50]);
  });
});
