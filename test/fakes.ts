import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import type { MessageWithParts, OpenCode, PermissionRequest, QuestionRequest, SessionStatus, Todo } from "../src/opencode.ts";
import type { Chat, SendOpts, SendResult } from "../src/telegram/chat.ts";

export function testConfig(overrides: Record<string, string> = {}): Config {
  const root = path.join(os.tmpdir(), "assistant-test");
  return loadConfig({
    TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_abcdefghijklmnop",
    OWNER_TELEGRAM_ID: "42",
    HQ_MCP_TOKEN: "mcp-token-0123456789abcdef",
    HQ_NOTIFY_TOKEN: "notify-token-0123456789abcdef",
    ASSISTANT_HOME: path.join(root, "assistant"),
    PROJECTS_DIR: path.join(root, "projects"),
    DEBOUNCE_MS: "15",
    ...overrides,
  });
}

export function memoryStore() {
  return new Store(":memory:");
}

let clock = 1_000;
export function assistantMessage(sessionID: string, text: string, extra: { error?: unknown; completed?: boolean } = {}): MessageWithParts {
  const created = Date.now() + clock++;
  const id = `msg_${created}`;
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created, ...(extra.completed === false ? {} : { completed: created + 1 }) },
      ...(extra.error ? { error: extra.error } : {}),
      parentID: "msg_parent",
      modelID: "m",
      providerID: "p",
      mode: "assistant",
      agent: "assistant",
      path: { cwd: "/", root: "/" },
      cost: 0.01,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: text ? [{ id: `prt_${created}`, sessionID, messageID: id, type: "text", text }] : [],
  } as unknown as MessageWithParts;
}

type Prompt = { sessionID: string; directory: string; text: string; agent?: string; model?: unknown; variant?: string; noReply?: boolean };

export class FakeOpenCode {
  sessions = new Map<string, { id: string; directory: string; title: string; cost: number; summary?: { files: number; additions: number; deletions: number } }>();
  prompts: Prompt[] = [];
  msgs = new Map<string, MessageWithParts[]>();
  statusMap: Record<string, SessionStatus> = {};
  todos = new Map<string, Todo[]>();
  aborted: string[] = [];
  permissionReplies: { requestID: string; reply: string }[] = [];
  questionReplies: { requestID: string; answers: string[][] }[] = [];
  rejected: string[] = [];
  pendingPerms: PermissionRequest[] = [];
  pendingQs: QuestionRequest[] = [];
  failPermissionList = false;
  failQuestionList = false;
  failPermissionReply = false;
  failQuestionReply = false;
  repos: string[] = [];
  failPrompts = false;
  createSessionDelay = 0;
  abortError: Error | undefined;
  private n = 1;

  asOpenCode() {
    return this as unknown as OpenCode;
  }

  files = new Map<string, string>();
  async readFile(_directory: string, relPath: string) {
    return this.files.get(relPath);
  }
  async getSession(id: string) {
    return this.sessions.get(id);
  }
  async agents() {
    return [
      { name: "assistant", mode: "primary", model: { providerID: "crowbot", modelID: "deepseek-v4.1-flash" } },
      { name: "worker", mode: "primary", model: { providerID: "crowbot", modelID: "gpt-6-astra" } },
    ];
  }
  async createSession(p: { directory: string; title: string }) {
    if (this.createSessionDelay) await new Promise((resolve) => setTimeout(resolve, this.createSessionDelay));
    const s = { id: `ses_${this.n++}`, directory: p.directory, title: p.title, cost: 0 };
    this.sessions.set(s.id, s);
    return s;
  }
  async prompt(p: { sessionID: string; directory: string; parts: { text?: string }[]; agent?: string; model?: unknown; variant?: string; noReply?: boolean }) {
    if (this.failPrompts) throw new Error("connection refused");
    this.prompts.push({ sessionID: p.sessionID, directory: p.directory, agent: p.agent, model: p.model, variant: p.variant, noReply: p.noReply, text: p.parts.map((x) => x.text ?? "").join("") });
  }
  async messages(sessionID: string) {
    return this.msgs.get(sessionID) ?? [];
  }
  async statuses() {
    return this.statusMap;
  }
  async todo(sessionID: string) {
    return this.todos.get(sessionID) ?? [];
  }
  async abort(sessionID: string) {
    if (this.abortError) throw this.abortError;
    this.aborted.push(sessionID);
  }
  async ensureGitRepo(dir: string) {
    this.repos.push(dir);
  }
  spawned: { id: string; cwd: string; command: string; args: string[] }[] = [];
  killed: string[] = [];
  async spawn(cwd: string, command: string, args: string[]) {
    const id = `pty_${this.n++}`;
    this.spawned.push({ id, cwd, command, args });
    return id;
  }
  async kill(ptyID: string) {
    this.killed.push(ptyID);
  }
  async listPtys() {
    return this.spawned.map((p) => ({ ...p, title: p.command, status: "exited" as const, pid: 1, exitCode: 0 }));
  }
  async replyPermission(requestID: string, _dir: string, reply: string) {
    if (this.failPermissionReply) throw new Error("OpenCode unavailable");
    this.permissionReplies.push({ requestID, reply });
  }
  async replyQuestion(requestID: string, _dir: string, answers: string[][]) {
    if (this.failQuestionReply) throw new Error("OpenCode unavailable");
    this.questionReplies.push({ requestID, answers });
  }
  async rejectQuestion(requestID: string) {
    this.rejected.push(requestID);
  }
  async pendingPermissions() {
    if (this.failPermissionList) throw new Error("OpenCode unavailable");
    return this.pendingPerms;
  }
  async pendingQuestions() {
    if (this.failQuestionList) throw new Error("OpenCode unavailable");
    return this.pendingQs;
  }

  reply(sessionID: string, text: string, extra?: { error?: unknown; completed?: boolean }) {
    const list = this.msgs.get(sessionID) ?? [];
    list.push(assistantMessage(sessionID, text, extra));
    this.msgs.set(sessionID, list);
  }
}

export class FakeChat implements Chat {
  sent: { text: string; opts?: SendOpts }[] = [];
  html: { id: number; html: string; opts?: unknown }[] = [];
  edits: { id: number; html: string }[] = [];
  typingCount = 0;
  private n = 100;
  failSendAfter: number | undefined;
  locations: { latitude: number; longitude: number; opts?: SendOpts }[] = [];
  venues: { latitude: number; longitude: number; title: string; address: string; opts?: SendOpts }[] = [];

  async sendText(markdown: string, opts?: SendOpts) {
    this.sent.push({ text: markdown, opts });
    return [this.n++];
  }
  async sendChunk(markdown: string, opts?: SendOpts): Promise<SendResult> {
    this.sent.push({ text: markdown, opts });
    return { ok: true, messageId: this.n++ };
  }
  async sendLocation(latitude: number, longitude: number, opts?: SendOpts): Promise<SendResult> {
    this.locations.push({ latitude, longitude, opts });
    return { ok: true, messageId: this.n++ };
  }
  async sendVenue(latitude: number, longitude: number, title: string, address: string, opts?: SendOpts): Promise<SendResult> {
    this.venues.push({ latitude, longitude, title, address, opts });
    return { ok: true, messageId: this.n++ };
  }
  async sendHtml(html: string, opts?: unknown) {
    if (this.failSendAfter !== undefined && this.html.length >= this.failSendAfter) throw new Error("Telegram unavailable");
    const id = this.n++;
    this.html.push({ id, html, opts });
    return id;
  }
  async editHtml(id: number, html: string) {
    this.edits.push({ id, html });
  }
  async typing() {
    this.typingCount++;
  }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
