import { GrammyError, type Api, type InlineKeyboard } from "grammy";
import { logger } from "../log.ts";
import { markdownToTelegramHtml, splitMarkdown, toBubbles } from "./format.ts";

const log = logger("chat");

export type SendOpts = { silent?: boolean; replyTo?: number; bubbles?: boolean };
export type SendResult = { ok: true; messageId: number } | { ok: false; kind: "transient" | "permanent" | "ambiguous"; error: Error };

/** Everything the rest of the gateway needs from the chat side (fakeable in tests). */
export interface Chat {
  /** Send model-written markdown; returns Telegram message ids. */
  sendText(markdown: string, opts?: SendOpts): Promise<number[]>;
  sendChunk(markdown: string, opts?: SendOpts): Promise<SendResult>;
  sendLocation(latitude: number, longitude: number, opts?: SendOpts): Promise<SendResult>;
  sendVenue(latitude: number, longitude: number, title: string, address: string, opts?: SendOpts): Promise<SendResult>;
  sendHtml(html: string, opts?: { silent?: boolean; keyboard?: InlineKeyboard; replyTo?: number }): Promise<number>;
  editHtml(messageId: number, html: string, keyboard?: InlineKeyboard): Promise<void>;
  typing(): Promise<void>;
}

export class TelegramChat implements Chat {
  private readonly api: Api;
  private readonly chatId: number;

  constructor(api: Api, chatId: number) {
    this.api = api;
    this.chatId = chatId;
  }

  async sendText(markdown: string, opts: SendOpts = {}): Promise<number[]> {
    const ids: number[] = [];
    const bubbles = opts.bubbles === false ? [markdown.trim()] : toBubbles(markdown);
    for (const [i, bubble] of bubbles.entries()) {
      if (i > 0) {
        await this.typing();
        await new Promise((r) => setTimeout(r, Math.min(1500, 400 + bubble.length * 8)));
      }
      for (const chunk of splitMarkdown(bubble)) {
        const result = await this.sendChunk(chunk, { silent: opts.silent, replyTo: i === 0 ? opts.replyTo : undefined });
        if (!result.ok) throw result.error;
        ids.push(result.messageId);
      }
    }
    return ids;
  }

  async sendChunk(markdown: string, opts: SendOpts = {}): Promise<SendResult> {
    const common = {
      disable_notification: opts.silent,
      link_preview_options: { is_disabled: true },
      ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
    };
    try {
      const m = await this.api.sendMessage(this.chatId, markdownToTelegramHtml(markdown), { ...common, parse_mode: "HTML" });
      return { ok: true, messageId: m.message_id };
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 400) {
        log.warn(`HTML rejected (${err.description}); sending as plain text`);
        const m = await this.api.sendMessage(this.chatId, markdown, common);
        return { ok: true, messageId: m.message_id };
      }
      const error = err instanceof Error ? err : new Error(String(err));
      const text = error.message.toLowerCase();
      return { ok: false, kind: /timeout|timed out|network|fetch|econn|socket|429|5\d\d/.test(text) ? "ambiguous" : "permanent", error };
    }
  }

  async sendLocation(latitude: number, longitude: number, opts: SendOpts = {}): Promise<SendResult> {
    try {
      const m = await this.api.sendLocation(this.chatId, latitude, longitude, { disable_notification: opts.silent, ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}) });
      return { ok: true, messageId: m.message_id };
    } catch (err) { return telegramResult(err); }
  }

  async sendVenue(latitude: number, longitude: number, title: string, address: string, opts: SendOpts = {}): Promise<SendResult> {
    try {
      const m = await this.api.sendVenue(this.chatId, latitude, longitude, title, address, { disable_notification: opts.silent, ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}) });
      return { ok: true, messageId: m.message_id };
    } catch (err) { return telegramResult(err); }
  }

  async sendHtml(html: string, opts: { silent?: boolean; keyboard?: InlineKeyboard; replyTo?: number } = {}) {
    const m = await this.api.sendMessage(this.chatId, html, {
      parse_mode: "HTML",
      disable_notification: opts.silent,
      link_preview_options: { is_disabled: true },
      reply_markup: opts.keyboard,
      ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
    });
    return m.message_id;
  }

  async editHtml(messageId: number, html: string, keyboard?: InlineKeyboard) {
    try {
      await this.api.editMessageText(this.chatId, messageId, html, { parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } });
    } catch (err) {
      if (err instanceof GrammyError && /message is not modified|message to edit not found/i.test(err.description)) return;
      throw err;
    }
  }

  async typing() {
    try {
      await this.api.sendChatAction(this.chatId, "typing");
    } catch (err) {
      log.debug(`typing failed: ${(err as Error).message}`);
    }
  }
}

function telegramResult(err: unknown): SendResult {
  if (err instanceof GrammyError && err.error_code === 400) return { ok: false, kind: "permanent", error: new Error(err.description) };
  const error = err instanceof Error ? err : new Error(String(err));
  return { ok: false, kind: /timeout|timed out|network|fetch|econn|socket|429|5\d\d/.test(error.message.toLowerCase()) ? "ambiguous" : "permanent", error };
}
