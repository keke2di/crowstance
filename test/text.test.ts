import { describe, expect, it } from "vitest";
import { inRange, isNoReply, parseOutcome, slugify, stripNoReply } from "../src/text.ts";

describe("NO_REPLY handling", () => {
  it("recognises the bare marker with stray formatting", () => {
    for (const t of ["NO_REPLY", " no_reply ", "`NO_REPLY`", "**NO_REPLY**", "NO_REPLY."]) expect(isNoReply(t)).toBe(true);
    expect(isNoReply("No reply needed, but here's a thought")).toBe(false);
  });

  it("strips a trailing marker after real text", () => {
    expect(stripNoReply("Saved to memory.\n\nNO_REPLY")).toBe("Saved to memory.");
    expect(stripNoReply("All good")).toBe("All good");
  });
});

describe("parseOutcome", () => {
  it("reads the worker's status line", () => {
    expect(parseOutcome("What I did: x\nStatus: done")).toBe("done");
    expect(parseOutcome("Status: **blocked**\nNeed an API key")).toBe("blocked");
    expect(parseOutcome("Status: needs-input")).toBe("needs-input");
    expect(parseOutcome("status - needs input")).toBe("needs-input");
    expect(parseOutcome("I finished everything")).toBe("unknown");
  });
});

describe("slugify", () => {
  it("makes short, safe ids", () => {
    expect(slugify("Price Tracker: Café Edition!")).toBe("price-tracker-cafe-edition");
    expect(slugify("   ")).toBe("task");
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(40);
  });
});

describe("inRange", () => {
  it("handles ranges that wrap past midnight", () => {
    const quiet = { start: 23 * 60, end: 8 * 60 };
    expect(inRange(23 * 60 + 30, quiet)).toBe(true);
    expect(inRange(3 * 60, quiet)).toBe(true);
    expect(inRange(8 * 60, quiet)).toBe(false);
    expect(inRange(12 * 60, quiet)).toBe(false);
  });

  it("handles same-day ranges", () => {
    const lunch = { start: 12 * 60, end: 13 * 60 };
    expect(inRange(12 * 60 + 15, lunch)).toBe(true);
    expect(inRange(13 * 60, lunch)).toBe(false);
  });
});
