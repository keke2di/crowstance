import { describe, expect, it } from "vitest";
import { TelegramChat } from "../src/telegram/chat.ts";

describe("Telegram native location chat", () => {
  it("sends native location and venue payloads with message ids", async () => {
    const calls: unknown[][] = [];
    const api = {
      sendLocation: async (...args: unknown[]) => { calls.push(args); return { message_id: 7 }; },
      sendVenue: async (...args: unknown[]) => { calls.push(args); return { message_id: 8 }; },
    } as any;
    const chat = new TelegramChat(api, 42);
    expect(await chat.sendLocation(0, 180, { silent: true })).toEqual({ ok: true, messageId: 7 });
    expect(await chat.sendVenue(60, -180, "Place", "Address")).toEqual({ ok: true, messageId: 8 });
    expect(calls[0]).toEqual([42, 0, 180, { disable_notification: true }]);
    expect(calls[1]).toEqual([42, 60, -180, "Place", "Address", { disable_notification: undefined }]);
  });

  it("classifies Telegram failures for durable retry handling", async () => {
    const api = { sendLocation: async () => { throw new Error("503 service unavailable"); } } as any;
    const result = await new TelegramChat(api, 42).sendLocation(1, 2);
    expect(result).toMatchObject({ ok: false, kind: "ambiguous" });
  });
});
