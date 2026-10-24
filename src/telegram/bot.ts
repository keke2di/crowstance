import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Message } from "grammy/types";
import type { Approvals } from "../approvals.ts";
import { priceLabel, type Catalog } from "../catalog.ts";
import type { Config } from "../config.ts";
import type { Conversation } from "../conversation.ts";
import type { Store } from "../db.ts";
import { EFFORTS } from "../kinds.ts";
import { isCapName, type Limits } from "../limits.ts";
import { logger } from "../log.ts";
import type { OpenCode } from "../opencode.ts";
import { crowbotBalance } from "../provider.ts";
import type { Roles } from "../roles.ts";
import { KEY_QUIET, type Scheduler } from "../scheduler.ts";
import type { Subagents } from "../subagents.ts";
import { UserError, type Tasks } from "../tasks.ts";
import { startOfLocalDay, startOfLocalMonth, usd } from "../text.ts";
import type { MediaKind, MediaProcessor } from "../media.ts";

/** Pick the best-quality media attachment from a message, respecting the size cap. */
function pickMedia(msg: Message | undefined, maxBytes: number): { kind: MediaKind; fileId: string } | undefined {
  if (!msg) return undefined;
  if (msg.photo?.length) {
    const best = msg.photo.at(-1)!;
    if ((best.file_size ?? 0) <= maxBytes) return { kind: "photo", fileId: best.file_id };
    return undefined;
  }
  if (msg.voice && (msg.voice.file_size ?? 0) <= maxBytes) return { kind: "voice", fileId: msg.voice.file_id };
  if (msg.audio && (msg.audio.file_size ?? 0) <= maxBytes) return { kind: "audio", fileId: msg.audio.file_id };
  const doc = msg.document;
  if (doc && /^image\//.test(doc.mime_type ?? "") && (doc.file_size ?? 0) <= maxBytes) return { kind: "document-image", fileId: doc.file_id };
  return undefined;
}

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
  roles: Roles;
  limits: Limits;
  catalog: Catalog;
  subagents: Subagents;
  media?: MediaProcessor;
};

const HELP = `Just text me like you would a person: ask questions, hand me work, ask how things are going.

Long jobs run in the background and I'll tell you when they're done. Quick lookups and analysis go to subagents on cheaper or stronger models, picked for the job. When something needs your OK you'll get buttons.

/tasks: background work and subagents
/stop: interrupt me · /stop <task>: stop a task
/new: clean chat (ask me to pick up where we left off)
/model: what the chat, workers and each subagent kind run on
/limits: spending caps
/cost: spend so far
/quiet on|off|auto|today: hold non-urgent updates
/actions: recent outward-facing actions`;

/** Minimal command menu for discoverability; the chat is still just chat. */
export const COMMAND_MENU = [
  { command: "tasks", description: "Background work" },
  { command: "stop", description: "Interrupt me / stop a task" },
  { command: "new", description: "Clean chat" },
  { command: "quiet", description: "Hold non-urgent updates" },
  { command: "cost", description: "Spend so far" },
  { command: "limits", description: "Spending caps" },
  { command: "model", description: "Models per role" },
  { command: "help", description: "What I can do" },
];

export function createBot(token: string) {
  const bot = new Bot(token);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  return bot;
}

const roleName = (id: string) => (id === "chat" ? "Chat" : id === "workers" ? "Workers" : id === "every" ? "All subagents" : `Subagent ${id}`);
const isAuto = (v: string | undefined) => v === "auto" || v === "default";

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
    const delegations = d.subagents.list(72);
    await ctx.reply([await d.tasks.list(72), delegations].filter(Boolean).join("\n\n"));
  });

  bot.command("limits", async (ctx) => {
    const [name, raw] = ctx.match.trim().split(/\s+/).filter(Boolean);
    if (!name) return void (await ctx.reply(d.limits.describe()));
    if (!isCapName(name)) return void (await ctx.reply(`No cap called "${name}".\n\n${d.limits.describe()}`));
    if (raw === undefined) return void (await ctx.reply(`${name}: ${d.limits.get(name)} (ceiling ${d.limits.ceiling(name)})`));
    const value = raw === "default" || raw === "reset" ? undefined : Number(raw.replace(/^\$/, ""));
    if (value !== undefined && !Number.isFinite(value)) return void (await ctx.reply("Give a number, e.g. /limits daily 10, or /limits daily default."));
    const res = d.limits.set(name, value);
    await ctx.reply(`${name} is now ${res.value}${res.clamped ? " — that's its ceiling from the env; raise the env value to go higher" : ""}.`);
  });

  bot.command("actions", async (ctx) => {
    const rows = d.store.recentActions(15);
    if (!rows.length) return void (await ctx.reply("No actions recorded yet."));
    await ctx.reply(
      rows
        .map(
          (r) =>
            `#${r.id} ${new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ")} [${r.status}] ${r.action}` +
            `${r.service ? ` (${r.service})` : ""}${r.cost_estimate_usd != null ? ` ~${usd(r.cost_estimate_usd)}` : ""}, consent: ${r.consent}`,
        )
        .join("\n"),
    );
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
    const byKind = d.store.subagentSpendByKindSince(startOfLocalDay()).map((r) => `- ${r.kind}: ${usd(r.total)}`);
    await ctx.reply(
      [
        `Today: ${usd(today)} (budget ${usd(d.limits.get("daily"))})`,
        `This month: ${usd(month)} (budget ${usd(d.limits.get("monthly"))})`,
        ...balance,
        ...(top.length ? ["", "Today by thread:", ...top] : []),
        ...(byKind.length ? ["", `Subagents today (budget ${usd(d.limits.get("subagents"))}):`, ...byKind] : []),
      ].join("\n"),
    );
  });

  bot.command("quiet", async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    if (arg === "on" || arg === "off") d.store.set(KEY_QUIET, arg);
    else if (arg === "today") {
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      d.store.set(KEY_QUIET, `on-until:${midnight.getTime()}`);
    } else if (arg === "auto") d.store.delete(KEY_QUIET);
    else if (arg) return void (await ctx.reply("Use /quiet on, /quiet off, /quiet today or /quiet auto."));
    const mode = d.store.get(KEY_QUIET) ?? `auto (${d.cfg.QUIET_HOURS ?? "no quiet hours set"})`;
    const label = mode.startsWith("on-until:") ? "on for the rest of today" : mode;
    await ctx.reply(`Quiet mode: ${label}. ${d.scheduler.isQuiet() ? "Holding non-urgent updates right now." : "Updates go out as they happen."}`);
  });

  bot.command("model", async (ctx) => {
    const [role, second, third] = ctx.match.trim().split(/\s+/).filter(Boolean);
    if (role && second) {
      if (second === "effort") {
        d.roles.setEffort(role, isAuto(third) || !third ? undefined : third);
      } else {
        d.roles.setModel(role, isAuto(second) ? undefined : second);
      }
      return void (await ctx.reply(`${roleName(role)}: ${d.roles.describe(role)}`));
    }
    await ctx.reply(modelSummary(d), { reply_markup: rolesKeyboard(d) });
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

  bot.on("message", async (ctx) => {
    // Photos, voice notes, audio and image documents become text via the media pipeline
    // (local OCR/STT); everything else is still rejected politely.
    const anyMedia = ctx.message.photo?.length || ctx.message.voice || ctx.message.audio || /^image\//.test(ctx.message.document?.mime_type ?? "");
    const media = pickMedia(ctx.message, d.cfg.MEDIA_MAX_MB * 1024 * 1024);
    if (anyMedia && !media) return void (await ctx.reply(`That's too big for me to read (limit ${d.cfg.MEDIA_MAX_MB} MB).`));
    if (!media || !d.media) return void (await ctx.reply(`I can only read text for now${d.media ? `, plus ${d.media.capabilities()}` : ""}.`));
    await ctx.react("👀").catch(() => {});
    const text = await d.media.process(media.kind, media.fileId, ctx.message.caption ?? undefined);
    if (text === undefined) return void (await ctx.reply(`I can't read ${media.kind === "photo" || media.kind === "document-image" ? "images" : "voice messages"} on this setup yet — no engine configured.`));
    d.conversation.onUserMessage({ text, at: new Date(ctx.message.date * 1000), replyTo: ctx.message.reply_to_message?.text });
  });

  bot.catch((err) => {
    const e = err.error;
    log.error(`update ${err.ctx.update.update_id} failed`, e);
    if (e instanceof UserError) void err.ctx.reply(e.message).catch(() => {});
  });
}

function modelSummary(d: BotDeps) {
  return [
    ...d.roles.ids().map((id) => `${roleName(id)}: ${d.roles.describe(id)}`),
    "",
    "All subagents sets the default for every kind; a kind's own pick overrides it. Tap a role to change it, or type " +
      "/model <role> <provider/model|auto> and /model <role> effort <low|medium|high|auto> (roles: chat, every, a kind, workers).",
  ].join("\n");
}

/** One button per role; the role list is snapshotted so button indexes stay valid. */
function rolesKeyboard(d: BotDeps) {
  const ids = d.roles.ids();
  d.store.set("model.roles", JSON.stringify(ids));
  const kb = new InlineKeyboard();
  ids.forEach((id, i) => {
    kb.text(roleName(id), `mr:${i}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

function roleAt(d: BotDeps, index: string | undefined): string {
  const role = (JSON.parse(d.store.get("model.roles") ?? "[]") as string[])[Number(index)];
  if (!role || !d.roles.has(role)) throw new UserError("That list is out of date, run /model again.");
  return role;
}

async function modelChoices(d: BotDeps): Promise<string[]> {
  const { choices, defaults } = await d.oc.modelChoices(d.cfg.ASSISTANT_HOME);
  const preferred = new Set(defaults);
  return [...choices.filter((m) => preferred.has(m)), ...choices.filter((m) => !preferred.has(m)).sort()];
}

async function handleCallback(ctx: Context, d: BotDeps, kind: string, rest: string[]): Promise<string | undefined> {
  switch (kind) {
    case "p":
      return d.approvals.answerPermission(rest[0]!, rest[1] as "once" | "reject" | "task", ctx.callbackQuery?.message?.message_id);
    case "q":
      return d.approvals.tapOption(rest[0]!, rest[1]!, Number(rest[2]), ctx.callbackQuery?.message?.message_id);
    case "qd":
      return d.approvals.submitMultiple(rest[0]!, rest[1]!, ctx.callbackQuery?.message?.message_id);
    case "qx":
      return d.approvals.dismissQuestion(rest[0]!, ctx.callbackQuery?.message?.message_id);
    case "st": {
      const [action, slug] = rest as [string, string];
      const messageId = ctx.callbackQuery?.message?.message_id;
      if (action === "k") {
        if (messageId) await ctx.editMessageText(`OK, leaving ${slug} alone. I'll only mention it again if it ends or goes quiet after new activity.`);
        return "Keeping it";
      }
      if (action === "s") {
        const t = await d.tasks.stop(slug);
        if (messageId) await ctx.editMessageText(`Stopped ${t.slug}.`);
        return `Stopped ${t.slug}`;
      }
      return "Unknown button";
    }
    case "mr": {
      // A role was tapped: its model list (workers and kinds only see usable, priced models).
      const role = roleAt(d, rest[0]);
      const choices = (role === "chat" ? await modelChoices(d) : d.catalog.usable().map((m) => m.ref)).slice(0, 40);
      d.store.set("model.choices", JSON.stringify(choices));
      const kb = new InlineKeyboard();
      choices.forEach((c, i) => {
        const info = d.catalog.get(c);
        kb.text(info ? `${c} · ${priceLabel(info)}` : c, `mp:${rest[0]}:${i}`).row();
      });
      kb.text("↺ Auto", `mp:${rest[0]}:-1`).text("Effort…", `me:${rest[0]}`);
      await ctx.editMessageText(`${roleName(role)} runs on ${d.roles.describe(role)}.\nPick a model (prices per 1M tokens in/out):`, { reply_markup: kb });
      return undefined;
    }
    case "mp": {
      const role = roleAt(d, rest[0]);
      const index = Number(rest[1]);
      if (index < 0) d.roles.setModel(role, undefined);
      else {
        const choice = (JSON.parse(d.store.get("model.choices") ?? "[]") as string[])[index];
        if (!choice) throw new UserError("That list is out of date, run /model again.");
        d.roles.setModel(role, choice);
      }
      await ctx.editMessageText(modelSummary(d), { reply_markup: rolesKeyboard(d) });
      return "Saved";
    }
    case "me": {
      const role = roleAt(d, rest[0]);
      const kb = new InlineKeyboard();
      for (const e of EFFORTS) kb.text(e, `mf:${rest[0]}:${e}`);
      kb.text("↺ Auto", `mf:${rest[0]}:auto`);
      await ctx.editMessageText(`Effort for ${roleName(role)} (now ${d.roles.describe(role)}). Higher effort reasons longer and costs more:`, { reply_markup: kb });
      return undefined;
    }
    case "mf": {
      const role = roleAt(d, rest[0]);
      d.roles.setEffort(role, isAuto(rest[1]) ? undefined : rest[1]);
      await ctx.editMessageText(modelSummary(d), { reply_markup: rolesKeyboard(d) });
      return "Saved";
    }
    default:
      return "Unknown button";
  }
}
