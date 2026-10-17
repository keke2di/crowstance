/**
 * The only module that talks to the OpenCode server (1.18.x HTTP API via the
 * pinned @opencode-ai/sdk/v2 client). Everything else goes through this class,
 * so a future move to OpenCode 2.x is contained here.
 */
import path from "node:path";
import {
  createOpencodeClient,
  type FilePartInput,
  type GlobalEvent,
  type Message,
  type OpencodeClient,
  type Part,
  type PermissionRequest,
  type Provider,
  type QuestionRequest,
  type Session,
  type SessionStatus,
  type TextPartInput,
  type Todo,
} from "@opencode-ai/sdk/v2";
import { logger } from "./log.ts";

export type {
  AssistantMessage,
  GlobalEvent,
  Message,
  Part,
  PermissionRequest,
  QuestionInfo,
  QuestionRequest,
  Session,
  SessionStatus,
  TextPart,
  Todo,
} from "@opencode-ai/sdk/v2";

export type MessageWithParts = { info: Message; parts: Part[] };
export type PromptPart = TextPartInput | FilePartInput;
export type ModelRef = { providerID: string; modelID: string };
export type ReasoningEffort = "max";

export function validateReasoningEffort(value: string): ReasoningEffort {
  if (value !== "max") throw new Error(`Unsupported OpenCode reasoning variant "${value}"; supported variant is "max"`);
  return value;
}

const log = logger("opencode");

/** The client throws on HTTP errors, so a missing body means the server sent nothing useful. */
function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`OpenCode returned no data for ${what}`);
  return res.data;
}

export function statusOf(err: unknown): number | undefined {
  const cause = (err as { cause?: { status?: number } } | undefined)?.cause;
  return typeof cause?.status === "number" ? cause.status : undefined;
}

export class OpenCode {
  readonly client: OpencodeClient;
  readonly url: string;

  constructor(opts: { url: string; username: string; password?: string }) {
    this.url = opts.url;
    const headers: Record<string, string> = {};
    if (opts.password) {
      headers.Authorization = `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString("base64")}`;
    }
    this.client = createOpencodeClient({ baseUrl: opts.url, headers, throwOnError: true });
  }

  async health() {
    return unwrap(await this.client.global.health(), "health");
  }

  async waitUntilHealthy(signal?: AbortSignal) {
    for (let attempt = 1; ; attempt++) {
      try {
        const h = await this.health();
        log.info(`connected to OpenCode ${h.version} at ${this.url}`);
        return h;
      } catch (err) {
        if (signal?.aborted) throw err;
        const wait = Math.min(30_000, 1000 * attempt);
        log.warn(`OpenCode not reachable (${(err as Error).message}); retrying in ${wait / 1000}s`);
        await sleep(wait, signal);
      }
    }
  }

  async createSession(p: { directory: string; title: string; agent?: string; metadata?: Record<string, unknown> }) {
    return unwrap(await this.client.session.create(p), "session.create");
  }

  async getSession(sessionID: string, directory: string): Promise<Session | undefined> {
    try {
      return unwrap(await this.client.session.get({ sessionID, directory }), "session.get");
    } catch (err) {
      if (statusOf(err) === 404) return undefined;
      throw err;
    }
  }

  /** Queue a user message; returns immediately (the session runs in the background). */
  async prompt(p: { sessionID: string; directory: string; parts: PromptPart[]; agent?: string; model?: ModelRef; noReply?: boolean; variant?: string }) {
    const variant = validateReasoningEffort(p.variant ?? "max");
    log.debug(`prompt → session ${p.sessionID}`, { agent: p.agent, variant });
    await this.client.session.promptAsync({ ...p, variant });
  }

  async statuses(directory: string): Promise<Record<string, SessionStatus>> {
    return unwrap(await this.client.session.status({ directory }), "session.status");
  }

  async messages(sessionID: string, directory: string, limit?: number): Promise<MessageWithParts[]> {
    return unwrap(await this.client.session.messages({ sessionID, directory, limit }), "session.messages") as MessageWithParts[];
  }

  async todo(sessionID: string, directory: string): Promise<Todo[]> {
    return unwrap(await this.client.session.todo({ sessionID, directory }), "session.todo");
  }

  async abort(sessionID: string, directory: string) {
    await this.client.session.abort({ sessionID, directory });
  }

  async replyPermission(requestID: string, directory: string, reply: "once" | "always" | "reject", message?: string) {
    await this.client.permission.reply({ requestID, directory, reply, message });
  }

  async replyQuestion(requestID: string, directory: string, answers: string[][]) {
    await this.client.question.reply({ requestID, directory, answers });
  }

  async rejectQuestion(requestID: string, directory: string) {
    await this.client.question.reject({ requestID, directory });
  }

  async pendingPermissions(directory: string): Promise<PermissionRequest[]> {
    return unwrap(await this.client.permission.list({ directory }), "permission.list");
  }

  async pendingQuestions(directory: string): Promise<QuestionRequest[]> {
    return unwrap(await this.client.question.list({ directory }), "question.list");
  }

  async providers(directory: string): Promise<{ providers: Provider[]; default: Record<string, string> }> {
    return unwrap(await this.client.config.providers({ directory }), "config.providers");
  }

  /**
   * Create `dir` and `git init` it *as the OpenCode server's OS user* (via the PTY API),
   * so the gateway never needs write access to the agent's home. Idempotent.
   */
  async ensureGitRepo(dir: string, parent: string) {
    // Inspect through the parent's instance: OpenCode caches per-directory instances, and touching
    // `dir` before it's a repo with a commit would pin it as a project without history.
    const rel = path.relative(parent, dir);
    if (await this.hasEntry(parent, rel, ".git")) return; // existing repo: leave it alone

    await this.runGit(parent, ["init", "-q", "-b", "main", dir]);
    if (!(await this.waitFor(() => this.hasEntry(parent, rel, ".git")))) throw new Error(`could not initialise a git repository at ${dir}`);

    // An initial commit gives OpenCode a stable project id (it's derived from the root commit).
    await this.runGit(parent, ["-C", dir, "-c", "user.name=Assistant", "-c", "user.email=assistant@localhost", "commit", "--allow-empty", "-q", "-m", "Start project"]);
    if (!(await this.waitFor(() => this.hasEntry(parent, path.join(rel, ".git", "refs", "heads"), "main")))) {
      log.warn(`initial commit in ${dir} did not show up; continuing without it`);
    }
    await this.client.instance.dispose({ directory: dir }).catch(() => {});
  }

  /**
   * Start a command as the OpenCode server's OS user, inside its sandbox (via a PTY). Returns the PTY id;
   * the PTY disappears on its own when the command exits.
   */
  async spawn(cwd: string, command: string, args: string[], title: string): Promise<string> {
    return unwrap(await this.client.pty.create({ directory: cwd, cwd, command, args, title }), "pty.create").id;
  }

  async kill(ptyID: string, directory: string) {
    await this.client.pty.remove({ ptyID, directory }).catch(() => {}); // already exited is fine
  }
  async listPtys(directory: string) {
    return unwrap(await this.client.pty.list({ directory }), "pty.list");
  }

  /** A text file as the OpenCode server's user sees it (undefined if missing/unreadable). */
  async readFile(directory: string, relPath: string): Promise<string | undefined> {
    try {
      const res = unwrap(await this.client.file.read({ directory, path: relPath }), "file.read");
      return res.type === "text" ? res.content : undefined;
    } catch {
      return undefined;
    }
  }

  private async runGit(cwd: string, args: string[]) {
    await this.spawn(cwd, "git", args, "hq: git");
  }

  private async hasEntry(parent: string, rel: string, name: string) {
    try {
      return (await this.listDir(parent, rel)).some((e) => e.name === name);
    } catch {
      return false; // the directory doesn't exist (yet)
    }
  }

  private async waitFor(check: () => Promise<boolean>, timeoutMs = 10_000) {
    for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
      await sleep(400);
      if (await check()) return true;
    }
    return false;
  }

  async mcpStatus(directory: string) {
    return unwrap(await this.client.mcp.status({ directory }), "mcp.status") as Record<string, { status: string; error?: string }>;
  }

  async agents(directory: string) {
    return unwrap(await this.client.app.agents({ directory }), "app.agents");
  }

  /** Directory listing as seen by the OpenCode server's OS user. */
  async listDir(directory: string, relPath = ".") {
    return unwrap(await this.client.file.list({ directory, path: relPath }), "file.list");
  }

  async mcpConnect(name: string, directory: string) {
    await this.client.mcp.connect({ name, directory });
  }

  /** Global event stream across all project directories. Reconnects forever until `signal` aborts. */
  async *events(signal: AbortSignal): AsyncGenerator<GlobalEvent> {
    for (let attempt = 0; !signal.aborted; attempt++) {
      try {
        const sse = await this.client.global.event({ signal, sseMaxRetryAttempts: 1 });
        for await (const ev of sse.stream) {
          attempt = 0;
          yield ev as GlobalEvent;
        }
      } catch (err) {
        if (signal.aborted) return;
        log.warn(`event stream dropped: ${(err as Error).message}`);
      }
      if (!signal.aborted) await sleep(Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4)), signal).catch(() => {});
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

// ---- helpers over OpenCode data ----

export function isAssistant(m: Message): m is Extract<Message, { role: "assistant" }> {
  return m.role === "assistant";
}

/** Visible text of a message: non-synthetic, non-ignored text parts joined in order. */
export function messageText(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && !p.synthetic && !p.ignored)
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function errorText(m: Message): string | undefined {
  if (!isAssistant(m) || !m.error) return undefined;
  const e = m.error as { name?: string; data?: { message?: string } };
  return `${e.name ?? "Error"}${e.data?.message ? `: ${e.data.message}` : ""}`;
}
