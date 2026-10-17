import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Approvals } from "../approvals.ts";
import type { Config } from "../config.ts";
import { KEY_CHAT_MODEL, type Conversation } from "../conversation.ts";
import type { Store } from "../db.ts";
import { logger } from "../log.ts";
import type { OpenCode } from "../opencode.ts";
import { crowbotBalance } from "../provider.ts";
import { KEY_QUIET, type Scheduler } from "../scheduler.ts";
import { KEY_WORKER_MODEL, UserError, type Tasks } from "../tasks.ts";
import { startOfLocalDay, startOfLocalMonth, usd } from "../text.ts";

const log = logger("telegram");

export type BotDeps = {
  cfg: Config;
  store: Store;
  oc: OpenCode;
  conversation: Conversation;
  tasks: Tasks;
  approvals: Approvals;
  scheduler: Scheduler;
  labelFor: (sessionID: string) => string;
};

const HELP = `Just text me like you would a person: ask questions, hand me work, ask how things are going.

Long jobs run in the background and I'll tell you when they're done. When something needs your OK you'll get buttons.

/tasks: background work
/stop: interrupt me · /stop <task>: stop a task
/new: clean chat (ask me to pick up where we left off)
/model: switch models
/cost: spend so far
/quiet on|off|auto: hold non-urgent updates`;

export function createBot(token: string) {
  const bot = new Bot(token);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  return bot;
}

type Target = "c" | "w";
const TARGET_NAME: Record<Target, string> = { c: "chat", w: "workers" };
const targetKey = (t: Target) => (t === "c" ? KEY_CHAT_MODEL : KEY_WORKER_MODEL);

export function registerHandlers(bot: Bot, d: BotDeps) {
  // Owner-only, private chat only. Everyone else is ignored.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== d.cfg.OWNER_TELEGRAM_ID || (ctx.chat && ctx.chat.type !== "private")) {
      log.warn(`ignored update from user ${ctx.from?.id ?? "?"} in chat ${ctx.chat?.id ?? "?"}`);
      return;
    }
    await next();
  });

  bot.command("start", (ctx) => ctx.reply("Hey, I'm here. Just text me like you would a person. /help if you're curious."));
  bot.command("help", (ctx) => ctx.reply(HELP));

  bot.command("tasks", async (ctx) => {
    await ctx.reply(await d.tasks.list(72));
  });

  bot.command("stop", async (ctx) => {
    const arg = ctx.match.trim();
    if (arg) {
      const t = await d.tasks.stop(arg);
      await ctx.reply(`Stopped ${t.slug}.`);
    } else {
      await ctx.reply((await d.conversation.abortTurn()) ? "Stopped." : "I'm not doing anything right now.");
    }
  });

  bot.command("new", async (ctx) => {
    if ((await d.conversation.requestNewSession()) === "busy") await ctx.reply("I'm in the middle of something; try again in a moment (or /stop me).");
  });

  bot.command("cost", async (ctx) => {
    const today = d.store.spendSince(startOfLocalDay());
    const month = d.store.spendSince(startOfLocalMonth());
    const top = d.store
      .spendBySessionSince(startOfLocalDay())
      .slice(0, 8)
      .map((r) => `- ${d.labelFor(r.session_id)}: ${usd(r.total)}`);
    let balance: string[] = [];
    if (d.cfg.CROWBOT_API_KEY) {
      balance = await crowbotBalance(d.cfg.CROWBOT_API_KEY)
        .then((b) => [`crowbot balance: ${usd(b.balanceUsd)}`])
        .catch((err) => [`crowbot balance: unavailable (${(err as Error).message})`]);
    }
    await ctx.reply(
      [
        `Today: ${usd(today)} (budget ${usd(d.cfg.DAILY_BUDGET_USD)})`,
        `This month: ${usd(month)}`,
        ...balance,
        ...(top.length ? ["", "Today by thread:", ...top] : []),
      ].join("\n"),
    );
  });

  bot.command("quiet", async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    if (arg === "on" || arg === "off") d.store.set(KEY_QUIET, arg);
    else if (arg === "auto") d.store.delete(KEY_QUIET);
    else if (arg) return void (await ctx.reply("Use /quiet on, /quiet off or /quiet auto."));
    const mode = d.store.get(KEY_QUIET) ?? `auto (${d.cfg.QUIET_HOURS ?? "no quiet hours set"})`;
    await ctx.reply(`Quiet mode: ${mode}. ${d.scheduler.isQuiet() ? "Holding non-urgent updates right now." : "Updates go out as they happen."}`);
  });

  bot.command("model", async (ctx) => {
    const [target, ref] = ctx.match.trim().split(/\s+/);
    if (target && ref && (target === "chat" || target === "workers")) {
      const choices = await modelChoices(d);
      if (ref !== "default" && !choices.includes(ref)) return void (await ctx.reply(`Unknown model "${ref}". Try /model to pick from a list.`));
      const key = target === "chat" ? KEY_CHAT_MODEL : KEY_WORKER_MODEL;
      if (ref === "default") d.store.delete(key);
      else d.store.set(key, ref);
      return void (await ctx.reply(`${target === "chat" ? "Chat" : "Workers"} now use ${ref === "default" ? "the default model" : ref}.`));
    }
    await ctx.reply(modelSummary(d), { reply_markup: new InlineKeyboard().text("Change chat model", "mt:c").text("Change worker model", "mt:w") });
  });

  bot.on("callback_query:data", async (ctx) => {
    const [kind, ...rest] = ctx.callbackQuery.data.split(":");
    try {
      const text = await handleCallback(ctx, d, kind ?? "", rest);
      await ctx.answerCallbackQuery(text ? { text } : undefined);
    } catch (err) {
      log.error(`callback ${ctx.callbackQuery.data} failed`, err);
      await ctx.answerCallbackQuery({ text: err instanceof UserError ? err.message : "Something went wrong", show_alert: err instanceof UserError });
    }
  });

  bot.on("message:text", async (ctx) => {
    const reply = ctx.message.reply_to_message;
    if (reply && (await d.approvals.answerByReply(reply.message_id, ctx.message.text))) {
      await ctx.react("👍").catch(() => {});
      return;
    }
    d.conversation.onUserMessage({
      text: ctx.message.text,
      at: new Date(ctx.message.date * 1000),
      replyTo: reply ? (reply.text ?? reply.caption) : undefined,
    });
  });

  bot.on("message", (ctx) => ctx.reply("I can only read text for now. Files, photos and voice notes are coming soon."));

  bot.catch((err) => {
    const e = err.error;
    log.error(`update ${err.ctx.update.update_id} failed`, e);
    if (e instanceof UserError) void err.ctx.reply(e.message).catch(() => {});
  });
}

function modelSummary(d: BotDeps) {
  const chat = d.store.get(KEY_CHAT_MODEL) ?? d.cfg.CHAT_MODEL ?? "the assistant agent's default (opencode.json)";
  const worker = d.store.get(KEY_WORKER_MODEL) ?? d.cfg.WORKER_MODEL ?? "the worker agent's default (opencode.json)";
  return `Chat: ${chat}\nWorkers: ${worker}\n\nTip: /model chat provider/model sets one directly; "default" resets.`;
}

async function modelChoices(d: BotDeps): Promise<string[]> {
  const { providers, default: defaults } = await d.oc.providers(d.cfg.ASSISTANT_HOME);
  const preferred = new Set(Object.entries(defaults).map(([p, m]) => `${p}/${m}`));
  const all = providers.flatMap((p) => Object.values(p.models).map((m) => `${p.id}/${m.id}`));
  return [...all.filter((m) => preferred.has(m)), ...all.filter((m) => !preferred.has(m)).sort()];
}

async function handleCallback(ctx: Context, d: BotDeps, kind: string, rest: string[]): Promise<string | undefined> {
  switch (kind) {
    case "p":
      return d.approvals.answerPermission(rest[0]!, rest[1] as "once" | "reject", ctx.callbackQuery?.message?.message_id);
    case "q":
      return d.approvals.tapOption(rest[0]!, Number(rest[1]), Number(rest[2]), ctx.callbackQuery?.message?.message_id);
    case "qd":
      return d.approvals.submitMultiple(rest[0]!, Number(rest[1]), ctx.callbackQuery?.message?.message_id);
    case "qx":
      return d.approvals.dismissQuestion(rest[0]!, ctx.callbackQuery?.message?.message_id);
    case "mt": {
      const target = rest[0] as Target;
      const choices = (await modelChoices(d)).slice(0, 40);
      d.store.set("model.choices", JSON.stringify(choices));
      const kb = new InlineKeyboard();
      choices.forEach((c, i) => kb.text(c, `ms:${target}:${i}`).row());
      kb.text("↺ Default", `ms:${target}:-1`);
      await ctx.editMessageText(`Pick the ${TARGET_NAME[target]} model:`, { reply_markup: kb });
      return undefined;
    }
    case "ms": {
      const target = rest[0] as Target;
      const index = Number(rest[1]);
      if (index < 0) d.store.delete(targetKey(target));
      else {
        const choice = (JSON.parse(d.store.get("model.choices") ?? "[]") as string[])[index];
        if (!choice) throw new UserError("That list is out of date, run /model again.");
        d.store.set(targetKey(target), choice);
      }
      await ctx.editMessageText(modelSummary(d));
      return "Saved";
    }
    default:
      return "Unknown button";
  }
}
