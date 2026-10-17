import { describe, expect, it } from "vitest";
import { Approvals, describePermission } from "../src/approvals.ts";
import type { PermissionRequest, QuestionRequest } from "../src/opencode.ts";
import { FakeChat, FakeOpenCode, memoryStore } from "./fakes.ts";

function setup() {
  const store = memoryStore();
  const oc = new FakeOpenCode();
  const chat = new FakeChat();
  const approvals = new Approvals({ store, oc: oc.asOpenCode(), chat, labelFor: () => "task scraper", isQuiet: () => false });
  return { store, oc, chat, approvals };
}

const perm: PermissionRequest = {
  id: "per_1",
  sessionID: "ses_w",
  permission: "bash",
  patterns: ["git push origin main"],
  metadata: {},
  always: ["git push *"],
};

const question: QuestionRequest = {
  id: "que_1",
  sessionID: "ses_w",
  questions: [
    { question: "Which database?", header: "DB", options: [{ label: "SQLite", description: "simple" }, { label: "Postgres", description: "scales" }] },
    { question: "Which features?", header: "Features", multiple: true, options: [{ label: "auth", description: "" }, { label: "billing", description: "" }] },
  ],
};

describe("describePermission", () => {
  it("phrases common permission kinds", () => {
    expect(describePermission(perm)).toEqual({ verb: "wants to run", detail: "git push origin main" });
    expect(describePermission({ permission: "external_directory", patterns: ["/etc/*"], metadata: {} }).verb).toMatch(/outside its project/);
  });
});

describe("Approvals", () => {
  it("shows a permission once, relays the tap, and closes the message", async () => {
    const { oc, chat, approvals } = setup();
    await approvals.onPermissionAsked(perm, "/p");
    await approvals.onPermissionAsked(perm, "/p"); // duplicate event (e.g. after reconnect)
    expect(chat.html).toHaveLength(1);
    expect(chat.html[0]!.html).toContain("git push origin main");

    expect(await approvals.answerPermission("per_1", "once")).toBe("✅ Allowed once");
    expect(oc.permissionReplies).toEqual([{ requestID: "per_1", reply: "once" }]);
    expect(chat.edits.at(-1)!.html).toContain("Allowed once");

    await approvals.onReplied("per_1"); // our own reply echoing back
    expect(chat.edits).toHaveLength(1);
    expect(await approvals.answerPermission("per_1", "reject")).toBe("Already handled");
  });

  it("notes when a request was answered elsewhere", async () => {
    const { chat, approvals } = setup();
    await approvals.onPermissionAsked(perm, "/p");
    await approvals.onReplied("per_1");
    expect(chat.edits.at(-1)!.html).toContain("Answered elsewhere");
  });

  it("collects answers to multi-part questions before replying", async () => {
    const { oc, chat, approvals } = setup();
    await approvals.onQuestionAsked(question, "/p");
    expect(chat.html).toHaveLength(2);

    expect(await approvals.tapOption("que_1", 0, 1)).toBe("Got it");
    expect(oc.questionReplies).toHaveLength(0);

    expect(await approvals.tapOption("que_1", 1, 0)).toBe("Toggled");
    expect(await approvals.tapOption("que_1", 1, 1)).toBe("Toggled");
    expect(await approvals.submitMultiple("que_1", 1)).toBe("Sent");
    expect(oc.questionReplies).toEqual([{ requestID: "que_1", answers: [["Postgres"], ["auth", "billing"]] }]);
  });

  it("accepts a free-form answer as a reply to the question message", async () => {
    const { oc, chat, approvals } = setup();
    await approvals.onQuestionAsked({ ...question, id: "que_2", questions: [question.questions[0]!] }, "/p");
    const messageId = chat.html[0]!.id;
    expect(await approvals.answerByReply(messageId, "MySQL, actually")).toBe(true);
    expect(oc.questionReplies).toEqual([{ requestID: "que_2", answers: [["MySQL, actually"]] }]);
    expect(await approvals.answerByReply(9999, "unrelated")).toBe(false);
  });

  it("does not accept free text when custom is false", async () => {
    const { oc, chat, approvals } = setup();
    const req = { ...question, id: "que_fixed", questions: [{ ...question.questions[0]!, custom: false }] };
    await approvals.onQuestionAsked(req, "/p");
    expect(await approvals.answerByReply(chat.html[0]!.id, "MySQL")).toBe(false);
    expect(oc.questionReplies).toHaveLength(0);
  });

  it("binds permission text to the exact Telegram prompt and rejects casual yes", async () => {
    const { oc, chat, approvals } = setup();
    await approvals.onPermissionAsked(perm, "/p");
    expect(await approvals.answerByReply(chat.html[0]!.id, "yes")).toBe(false);
    expect(oc.permissionReplies).toHaveLength(0);
    expect(await approvals.answerByReply(chat.html[0]!.id, "allow once")).toBe(true);
    expect(oc.permissionReplies).toEqual([{ requestID: "per_1", reply: "once" }]);
  });

  it("retries a partial question presentation without duplicating sent messages", async () => {
    const { chat, approvals, store } = setup();
    chat.failSendAfter = 1;
    await expect(approvals.onQuestionAsked(question, "/p")).rejects.toThrow("Telegram unavailable");
    expect(chat.html).toHaveLength(1);
    chat.failSendAfter = undefined;
    await approvals.onQuestionAsked(question, "/p");
    expect(chat.html).toHaveLength(2);
    expect(JSON.parse(store.approval("que_1")!.chat_message_ids)).toHaveLength(2);
  });

  it("keeps a failed OpenCode question reply open and retryable", async () => {
    const { oc, chat, approvals, store } = setup();
    const req = { ...question, id: "que_retry", questions: [question.questions[0]!] };
    await approvals.onQuestionAsked(req, "/p");
    oc.failQuestionReply = true;
    await expect(approvals.answerByReply(chat.html[0]!.id, "MySQL")).rejects.toThrow("OpenCode unavailable");
    expect(store.approval("que_retry")!.resolved_at).toBeNull();
    oc.failQuestionReply = false;
    expect(await approvals.answerByReply(chat.html[0]!.id, "MySQL")).toBe(true);
    expect(oc.questionReplies).toEqual([{ requestID: "que_retry", answers: [["MySQL"]] }]);
  });

  it("reconciles: shows missed requests and expires vanished ones", async () => {
    const { oc, chat, approvals, store } = setup();
    await approvals.onPermissionAsked({ ...perm, id: "per_old" }, "/p");
    oc.pendingPerms = [perm];
    await approvals.reconcile(["/p"]);
    expect(chat.html.map((h) => h.html).join()).toContain("git push origin main");
    expect(store.approval("per_old")!.resolution).toBe("expired");
    expect(store.approval("per_1")!.resolved_at).toBeNull();
  });

  it("does not expire requests when either list fails", async () => {
    const { oc, approvals, store } = setup();
    await approvals.onPermissionAsked({ ...perm, id: "per_outage" }, "/p");
    oc.failPermissionList = true;
    await approvals.reconcile(["/p"]);
    expect(store.approval("per_outage")!.resolved_at).toBeNull();
  });

  it("expires a request absent from a successful snapshot", async () => {
    const { oc, approvals, store } = setup();
    await approvals.onPermissionAsked({ ...perm, id: "per_missing" }, "/p");
    oc.pendingPerms = [];
    await approvals.reconcile(["/p"]);
    expect(store.approval("per_missing")!.resolution).toBe("expired");
  });

  it("answers a question only once when tap and text race", async () => {
    const { oc, chat, approvals } = setup();
    const req = { ...question, id: "que_race", questions: [question.questions[0]!] };
    await approvals.onQuestionAsked(req, "/p");
    await Promise.all([approvals.tapOption("que_race", 0, 0), approvals.answerByReply(chat.html[0]!.id, "Postgres")]);
    expect(oc.questionReplies).toHaveLength(1);
  });
});
