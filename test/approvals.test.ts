import { describe, expect, it } from "vitest";
import { Approvals, describePermission } from "../src/approvals.ts";
import type { FormRequest, PermissionRequest } from "../src/opencode.ts";
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
  action: "bash",
  resources: ["git push origin main"],
  metadata: {},
  save: ["git push *"],
};

const form: FormRequest = {
  id: "que_1",
  sessionID: "ses_w",
  fields: [
    { key: "db", title: "Which database?", type: "string", options: [{ value: "SQLite", label: "SQLite", description: "simple" }, { value: "Postgres", label: "Postgres", description: "scales" }] },
    { key: "features", title: "Which features?", type: "multiselect", options: [{ value: "auth", label: "auth" }, { value: "billing", label: "billing" }] },
  ],
};

describe("describePermission", () => {
  it("phrases common permission kinds", () => {
    expect(describePermission(perm)).toEqual({ verb: "wants to run", detail: "git push origin main" });
    expect(describePermission({ action: "external_directory", resources: ["/etc/*"], metadata: {} }).verb).toMatch(/outside its project/);
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

  it("'allow for this task' auto-answers later matching requests for the same session", async () => {
    const { oc, chat, approvals } = setup();
    await approvals.onPermissionAsked(perm, "/p");
    expect(await approvals.answerPermission("per_1", "task")).toBe("✅ Allowed for this task");
    expect(oc.permissionReplies).toEqual([{ requestID: "per_1", reply: "once" }]);

    // A later request with the same patterns in the same session is answered without a new prompt.
    const second = { ...perm, id: "per_2" };
    await approvals.onPermissionAsked(second, "/p");
    expect(oc.permissionReplies).toEqual([
      { requestID: "per_1", reply: "once" },
      { requestID: "per_2", reply: "once" },
    ]);
    expect(chat.html).toHaveLength(1); // no new prompt

    // ...but a different command, or a different session, still asks.
    await approvals.onPermissionAsked({ ...perm, id: "per_3", resources: ["rm -rf build"] }, "/p");
    await approvals.onPermissionAsked({ ...perm, id: "per_4", sessionID: "ses_other" }, "/p");
    expect(chat.html).toHaveLength(3);
  });

  it("collects answers to multi-field forms before replying", async () => {
    const { oc, chat, approvals } = setup();
    await approvals.onFormRequested(form, "/p");
    expect(chat.html).toHaveLength(2);

    expect(await approvals.tapOption("que_1", "db", 1)).toBe("Got it"); // single-choice is recorded, but the form waits for the multiselect
    expect(oc.formReplies).toHaveLength(0);

    expect(await approvals.tapOption("que_1", "features", 0)).toBe("Toggled");
    expect(await approvals.tapOption("que_1", "features", 1)).toBe("Toggled");
    expect(await approvals.submitMultiple("que_1", "features")).toBe("Sent");
    expect(oc.formReplies).toEqual([{ formID: "que_1", answer: { db: ["Postgres"], features: ["auth", "billing"] } }]);
  });

  it("accepts a free-form answer as a reply to the form message", async () => {
    const { oc, chat, approvals } = setup();
    await approvals.onFormRequested({ ...form, id: "que_2", fields: [form.fields[0]!] }, "/p");
    const messageId = chat.html[0]!.id;
    expect(await approvals.answerByReply(messageId, "MySQL, actually")).toBe(true);
    expect(oc.formReplies).toEqual([{ formID: "que_2", answer: { db: "MySQL, actually" } }]);
    expect(await approvals.answerByReply(9999, "unrelated")).toBe(false);
  });

  it("does not accept free text when custom is false", async () => {
    const { oc, chat, approvals } = setup();
    const req: FormRequest = { ...form, id: "que_fixed", fields: [{ ...form.fields[0]!, custom: false }] };
    await approvals.onFormRequested(req, "/p");
    expect(await approvals.answerByReply(chat.html[0]!.id, "MySQL")).toBe(false);
    expect(oc.formReplies).toHaveLength(0);
  });

  it("binds permission text to the exact Telegram prompt and rejects casual yes", async () => {
    const { oc, chat, approvals } = setup();
    await approvals.onPermissionAsked(perm, "/p");
    expect(await approvals.answerByReply(chat.html[0]!.id, "yes")).toBe(false);
    expect(oc.permissionReplies).toHaveLength(0);
    expect(await approvals.answerByReply(chat.html[0]!.id, "allow once")).toBe(true);
    expect(oc.permissionReplies).toEqual([{ requestID: "per_1", reply: "once" }]);
  });

  it("retries a partial form presentation without duplicating sent messages", async () => {
    const { chat, approvals, store } = setup();
    chat.failSendAfter = 1;
    await expect(approvals.onFormRequested(form, "/p")).rejects.toThrow("Telegram unavailable");
    expect(chat.html).toHaveLength(1);
    chat.failSendAfter = undefined;
    await approvals.onFormRequested(form, "/p");
    expect(chat.html).toHaveLength(2);
    expect(JSON.parse(store.approval("que_1")!.chat_message_ids)).toHaveLength(2);
  });

  it("keeps a failed OpenCode form reply open and retryable", async () => {
    const { oc, chat, approvals, store } = setup();
    const req: FormRequest = { ...form, id: "que_retry", fields: [form.fields[0]!] };
    await approvals.onFormRequested(req, "/p");
    oc.failFormReply = true;
    await expect(approvals.answerByReply(chat.html[0]!.id, "MySQL")).rejects.toThrow("OpenCode unavailable");
    expect(store.approval("que_retry")!.resolved_at).toBeNull();
    oc.failFormReply = false;
    expect(await approvals.answerByReply(chat.html[0]!.id, "MySQL")).toBe(true);
    expect(oc.formReplies).toEqual([{ formID: "que_retry", answer: { db: "MySQL" } }]);
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
    oc.failFormList = true;
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

  it("answers a form only once when tap and text race", async () => {
    const { oc, chat, approvals } = setup();
    const req: FormRequest = { ...form, id: "que_race", fields: [form.fields[0]!] };
    await approvals.onFormRequested(req, "/p");
    await Promise.all([approvals.tapOption("que_race", "db", 0), approvals.answerByReply(chat.html[0]!.id, "Postgres")]);
    expect(oc.formReplies).toHaveLength(1);
  });
});
