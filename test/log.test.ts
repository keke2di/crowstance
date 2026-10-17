import { afterEach, describe, expect, it, vi } from "vitest";
import { correlationId, logger, newCorrelationId, redact, redactText, runWithCorrelation, setLogLevel } from "../src/log.ts";

function capture() {
  const lines: string[] = [];
  const render = (args: unknown[]) => args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
  const out = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(render(args)));
  const err = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(render(args)));
  return { lines, restore: () => { out.mockRestore(); err.mockRestore(); } };
}

const captures: (() => void)[] = [];
afterEach(() => {
  for (const restore of captures.splice(0)) restore();
  setLogLevel("info");
});

describe("redaction", () => {
  it("masks secrets by key and token-shaped text", () => {
    expect(redact({ password: "hunter2", nested: { apiKey: "abc", note: "ok" } })).toEqual({
      password: "[redacted]",
      nested: { apiKey: "[redacted]", note: "ok" },
    });
    expect(redactText("token 123456789:AAFakeTokenFakeTokenFakeTokenFake done")).toContain("[redacted-token]");
    expect(redactText("Authorization: Bearer abcdefghijklmnop")).toContain("Bearer [redacted]");
  });

  it("masks raw coordinates", () => {
    expect(redact({ latitude: 1.5, longitude: 2.5, name: "Cafe" })).toEqual({
      latitude: "[redacted]",
      longitude: "[redacted]",
      name: "Cafe",
    });
    expect(redact({ location: { lat: 1.5, lon: 2.5 } })).toEqual({ location: { lat: "[redacted]", lon: "[redacted]" } });
  });
});

describe("structured correlation", () => {
  it("carries a correlation id from an async context into the log line", async () => {
    const { lines, restore } = capture();
    captures.push(restore);
    const corr = newCorrelationId("test");
    await runWithCorrelation(corr, async () => {
      expect(correlationId()).toBe(corr);
      await Promise.resolve();
      logger("unit").info("hello", { detail: "x" });
    });
    expect(lines.join("\n")).toContain(`correlation=${corr}`);
    expect(lines.join("\n")).toContain("hello");
  });

  it("accepts an explicit correlation id and never logs a secret", () => {
    const { lines, restore } = capture();
    captures.push(restore);
    logger("unit").info("sending", { correlationId: "cor-explicit", token: "super-secret-token-value" });
    const joined = lines.join("\n");
    expect(joined).toContain("correlation=cor-explicit");
    expect(joined).not.toContain("super-secret-token-value");
    expect(joined).toContain("[redacted]");
  });
});
