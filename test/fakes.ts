import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import type { AgentInfo, FormRequest, Message, ModelInfo, ModelRef, OpenCode, PermissionRequest, Session } from "../src/opencode.ts";
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
export function assistantMessage(sessionID: string, text: string, extra: { error?: unknown; completed?: boolean } = {}): Message {
  const created = Date.now() + clock++;
  const id = `msg_${created}`;
  return {
    id,
    sessionID,
    type: "assistant",
    agent: "assistant",
    model: { id: "m", providerID: "p" },
    time: { created, ...(extra.completed === false ? {} : { completed: created + 1 }) },
    content: text ? [{ type: "text", text }] : [],
    ...(extra.error ? { error: extra.error as never } : {}),
    cost: 0.01,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  } as Message;
}

/** v2 permission request, with the v1 field names accepted for convenience in tests. */
export function permRequest(p: { id?: string; sessionID?: string; action?: string; permission?: string; resources?: string[]; patterns?: string[]; metadata?: Record<string, unknown> }): PermissionRequest {
  return {
    id: p.id ?? "perm_1",
    sessionID: p.sessionID ?? "ses_1",
    action: p.action ?? p.permission ?? "bash",
    resources: p.resources ?? p.patterns ?? [],
    metadata: p.metadata ?? {},
  };
}

/** v2 form (the question replacement) built from v1-style question fields. */
export function formRequest(p: { id?: string; sessionID?: string; questions?: { question: string; options?: { label: string; value?: string }[]; multiple?: boolean; custom?: boolean }[] }): FormRequest {
  return {
    id: p.id ?? "form_1",
    sessionID: p.sessionID ?? "ses_1",
    fields: (p.questions ?? []).map((q, i) => ({
      key: `q${i}`,
      title: q.question,
      type: q.options ? "multiselect" : "string",
      options: q.options?.map((o) => ({ value: o.value ?? o.label, label: o.label })),
      custom: q.custom,
    })),
  };
}

export function fakeModel(providerID: string, id: string, input: number, output: number, reasoning = true): ModelInfo {
  // The shape OpenCode 2.0.32 sends: cost is a list of price tiers, capabilities say `tools`, effort levels are variants.
  return { id, modelID: id, providerID, name: id, cost: [{ input, output, cache: { read: input / 10, write: 0 } }], capabilities: { tools: true }, variants: reasoning ? [{ id: "low" }, { id: "medium" }, { id: "high" }] : [], limit: { context: 1_000_000 } };
}

/** A crowbot `/v1/models` listing for the catalog. */
export function crowbotListing(models: { id: string; input: number; output: number; reasoning?: boolean; tools?: boolean; context?: number }[]) {
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      display_name: m.id.toUpperCase(),
      context_window: m.context ?? 1_048_576,
      max_output_tokens: 32_768,
      pricing: { input_per_1m_usd: m.input, cached_input_per_1m_usd: m.input / 10, output_per_1m_usd: m.output },
      capabilities: { reasoning: m.reasoning ?? true, tool_calling: m.tools ?? true },
    })),
  };
}

/** A fetch that answers with `body` (or an HTTP error status). */
export function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

type Prompt = { sessionID: string; directory: string; text: string; agent?: string; model?: unknown; variant?: string; noReply?: boolean };

export class FakeOpenCode {
  sessions = new Map<string, Session & { directory: string; title: string; cost: number }>();
  prompts: Prompt[] = [];
  msgs = new Map<string, Message[]>();
  statusMap: Record<string, { type: "busy" | "idle" }> = {};
  aborted: string[] = [];
  permissionReplies: { requestID: string; reply: string }[] = [];
  formReplies: { formID: string; answer: Record<string, unknown> }[] = [];
  rejected: string[] = [];
  pendingPerms: PermissionRequest[] = [];
  pendingFs: FormRequest[] = [];
  failPermissionList = false;
  failFormList = false;
  failPermissionReply = false;
  failFormReply = false;
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
  agentList: AgentInfo[] = [
    { id: "assistant", name: "assistant", mode: "primary", hidden: false, model: { providerID: "crowbot", id: "deepseek-v4.1-flash" } },
    { id: "worker", name: "worker", mode: "primary", hidden: false, model: { providerID: "crowbot", id: "gpt-6-astra" } },
    { id: "explore", name: "explore", mode: "subagent", hidden: false, description: "Finds things and reports them" },
    { id: "analyst", name: "analyst", mode: "subagent", hidden: false, description: "Thinks hard about one question" },
    { id: "title", name: "title", mode: "primary", hidden: true },
  ];
  async agents() {
    return this.agentList;
  }
  /** What OpenCode can run; prices are opencode.json's (USD per 1M). */
  modelList: ModelInfo[] = [
    fakeModel("crowbot", "deepseek-v4.1-flash", 0.045, 0.18),
    fakeModel("crowbot", "gpt-6.1-sol", 0.18, 0.9),
    fakeModel("crowbot", "kimi-k3", 0.27, 1.35),
    fakeModel("crowbot", "crow-2", 5, 5),
    fakeModel("anthropic", "claude-opus-5-5", 5, 25),
  ];
  async models() {
    return this.modelList;
  }
  created: { id: string; directory: string; title: string; agent?: string; parentID?: string; model?: ModelRef; metadata?: Record<string, unknown> }[] = [];
  async createSession(p: { directory: string; title: string; agent?: string; parentID?: string; model?: ModelRef; metadata?: Record<string, unknown> }) {
    if (this.createSessionDelay) await new Promise((resolve) => setTimeout(resolve, this.createSessionDelay));
    const s = { id: `ses_${this.n++}`, directory: p.directory, title: p.title, cost: 0, projectID: "p", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now(), updated: Date.now() }, location: { directory: p.directory } };
    this.sessions.set(s.id, s);
    this.created.push({ id: s.id, ...p });
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
    return this.spawned.map((p) => ({ id: p.id, title: p.command, command: p.command, args: p.args, cwd: p.cwd, status: "exited" as const, pid: 1, exitCode: 0 }));
  }
  async replyPermission(sessionID: string, requestID: string, reply: string) {
    if (this.failPermissionReply) throw new Error("OpenCode unavailable");
    this.permissionReplies.push({ requestID, reply });
  }
  async replyForm(sessionID: string, formID: string, answer: Record<string, unknown>) {
    if (this.failFormReply) throw new Error("OpenCode unavailable");
    this.formReplies.push({ formID, answer });
  }
  async pendingPermissions() {
    if (this.failPermissionList) throw new Error("OpenCode unavailable");
    return this.pendingPerms;
  }
  async pendingForms() {
    if (this.failFormList) throw new Error("OpenCode unavailable");
    return this.pendingFs;
  }
  async formsIn() {
    if (this.failFormList) throw new Error("OpenCode unavailable");
    return this.pendingFs;
  }
  /** Busy/idle of one session, from statusMap (undefined = no such session). */
  async sessionStatus(sessionID: string) {
    return this.statusMap[sessionID];
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
