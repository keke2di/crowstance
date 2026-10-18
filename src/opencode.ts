/**
 * The only module that talks to the OpenCode server (v2 HTTP API under /api/*).
 * Everything else goes through this class, so a future server bump is contained here.
 *
 * Notes on the v2 surface (verified against 2.0.32):
 * - Endpoints are JSON under /api/*; directory scoping is the ?directory= query param.
 * - The event stream is SSE at /api/event with `{type, location?, data}` objects.
 * - Messages are whole objects (no separate parts); assistant text lives in content[].
 * - There is no todo or session-status endpoint; busy/idle comes from events + inbox.
 */
import path from "node:path";
import { logger } from "./log.ts";

// ---- wire types (subset of the v2 OpenAPI surface we actually use) ----

export type ServerInfo = { version: string; pid: number; urls: string[]; paths: { tmp: string }; capabilities?: { persistentPty?: boolean | null } | null };

export type LocationRef = { directory?: string | null };

export type Session = {
  id: string;
  projectID: string;
  parentID?: string;
  agent?: string;
  model?: ModelRefFull;
  cost: number;
  tokens: TokenUsage;
  outcome?: "succeeded" | "failed" | "interrupted";
  time: { created: number; updated: number; idle?: number; viewed?: number; archived?: number };
  title?: string;
  subpath?: string;
  metadata?: Record<string, unknown>;
  location: LocationRef;
};

export type TokenUsage = { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
export type ModelRefFull = { id: string; providerID: string; variant?: string };
export type ModelRef = { providerID: string; modelID: string };

export type StructuredError = { type: string; message: string; status?: number; response?: { body: string } };

export type AssistantContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; name?: string; [k: string]: unknown };

export type Message =
  | { id: string; time: { created: number }; type: "user"; text: string; metadata?: Record<string, unknown> }
  | {
      id: string;
      time: { created: number; streamed?: number; completed?: number };
      type: "assistant";
      agent: string;
      model: ModelRefFull;
      content: AssistantContent[];
      cost?: number;
      tokens?: TokenUsage;
      error?: StructuredError;
      finish?: string;
      metadata?: Record<string, unknown>;
      sessionID?: string;
    }
  | { id: string; time: { created: number }; type: "idle"; outcome?: string; metadata?: Record<string, unknown> }
  | { id: string; time: { created: number }; type: string; metadata?: Record<string, unknown> };

export type SessionMessagesResponse = { data: Message[]; cursor: { previous: string | null; next: string | null } };

export type AgentInfo = { id: string; name: string; model?: ModelRefFull; mode: "subagent" | "primary" | "all"; hidden: boolean; description?: string };
export type ModelInfo = { id: string; modelID: string; providerID: string; name?: string; variants?: { id: string }[] };
export type ProviderInfo = { id: string; name?: string };

export type PermissionRequest = {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: "tool"; messageID: string; id: string };
  message?: string;
};

export type FormFieldOption = { value: string; label: string; description?: string };
export type FormField = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external";
  options?: FormFieldOption[];
  custom?: boolean;
  url?: string;
};
export type FormState = { status: "pending" } | { status: "answered"; answer: Record<string, unknown> } | { status: "rejected" } | { status: "cancelled" };
export type FormRequest = { id: string; sessionID: string; title?: string; metadata?: Record<string, unknown>; fields: FormField[]; state?: FormState };

export type Pty = { id: string; title: string; command: string; args: string[]; cwd: string; status: "running" | "exited"; pid: number; exitCode?: number };
export type FileEntry = { path: string; type: "file" | "directory"; name?: string };
export type McpServer = { name: string; status: { state?: string; error?: string } | string; integrationID?: string };

export type InboxItem = { id: string; sessionID: string; type: string; payload?: unknown; delivery?: string };

/** One event from the global SSE stream at /api/event. */
export type GlobalEvent = {
  id: string;
  created?: number;
  type: string;
  location?: { directory?: string };
  data: Record<string, unknown>;
};

const log = logger("opencode");

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number | undefined {
  if (err instanceof HttpError) return err.status;
  return undefined;
}

export class OpenCode {
  readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(opts: { url: string; username: string; password?: string }) {
    this.url = opts.url.replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (opts.password) {
      this.headers.Authorization = `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString("base64")}`;
    }
  }

  private async request<T>(method: string, route: string, opts: { directory?: string; query?: Record<string, string | undefined>; body?: unknown; raw?: boolean } = {}): Promise<T> {
    const url = new URL(`/api${route}`, this.url);
    if (opts.directory) url.searchParams.set("directory", opts.directory);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: this.headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = text;
      try {
        const parsed = JSON.parse(text) as { message?: string; _tag?: string };
        if (parsed?.message) message = `${parsed._tag ?? "Error"}: ${parsed.message}`;
      } catch { /* keep raw text */ }
      throw new HttpError(res.status, `${method} ${route} → HTTP ${res.status} ${message}`.slice(0, 500));
    }
    if (res.status === 204) return undefined as T;
    if (opts.raw) return (await res.text()) as T;
    return (await res.json()) as T;
  }

  private get<T>(route: string, opts?: { directory?: string; query?: Record<string, string | undefined>; raw?: boolean }) {
    return this.request<T>("GET", route, opts);
  }
  private post<T>(route: string, opts?: { directory?: string; query?: Record<string, string | undefined>; body?: unknown }) {
    return this.request<T>("POST", route, opts);
  }

  async health(): Promise<ServerInfo> {
    return this.get<ServerInfo>("/info");
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

  // ---- sessions ----

  async createSession(p: { directory: string; title: string; agent?: string; metadata?: Record<string, unknown> }): Promise<Session> {
    const res = await this.post<{ data: Session }>("/session", {
      body: { title: p.title, agent: p.agent, metadata: p.metadata, location: { directory: p.directory } },
    });
    return res.data;
  }

  async getSession(sessionID: string, directory?: string): Promise<Session | undefined> {
    try {
      const res = await this.get<{ data: Session }>(`/session/${sessionID}`, { directory });
      return res.data;
    } catch (err) {
      if (statusOf(err) === 404) return undefined;
      throw err;
    }
  }

  /** Queue a user message; returns the inbox id once accepted (the session runs in the background). */
  async prompt(p: { sessionID: string; directory: string; parts: { type: string; text?: string }[]; agent?: string; model?: ModelRef; noReply?: boolean; variant?: string }) {
    const text = p.parts.map((part) => part.text ?? "").join("");
    log.debug(`prompt → session ${p.sessionID}`, { agent: p.agent });
    if (p.agent) await this.post(`/session/${p.sessionID}/agent`, { directory: p.directory, body: { agent: p.agent } });
    if (p.model) await this.switchModel(p.sessionID, p.model);
    const body: Record<string, unknown> = { text };
    // `synthetic` marks system/context-only inserts (rotation handoffs etc.).
    if (p.noReply) body.metadata = { hq: { noReply: true } };
    const res = await this.post<{ data: InboxItem }>(`/session/${p.sessionID}/prompt`, { directory: p.directory, body });
    return res.data;
  }

  async switchModel(sessionID: string, model: ModelRef) {
    await this.post(`/session/${sessionID}/model`, { body: { model: { id: model.modelID, providerID: model.providerID } } });
  }

  async interrupt(sessionID: string, directory: string) {
    await this.post(`/session/${sessionID}/interrupt`, { directory });
  }

  /** Alias kept for the gateway's vocabulary: abort a running turn. */
  async abort(sessionID: string, directory: string) {
    await this.interrupt(sessionID, directory);
  }

  async messages(sessionID: string, directory: string, limit?: number): Promise<Message[]> {
    const res = await this.get<SessionMessagesResponse>(`/session/${sessionID}/message`, {
      directory,
      query: { limit: limit === undefined ? undefined : String(limit), order: "asc" },
    });
    return res.data;
  }

  /** Pending (undelivered) inbox items: non-empty means the session is busy. */
  async inbox(sessionID: string, directory: string): Promise<InboxItem[]> {
    try {
      const res = await this.get<{ data: InboxItem[] }>(`/session/${sessionID}/inbox`, { directory });
      return res.data;
    } catch (err) {
      if (statusOf(err) === 404) return [];
      throw err;
    }
  }

  /** sessionID → busy, for every active session in `directory` (inbox non-empty = busy). */
  async statuses(directory: string): Promise<Record<string, { type: "busy" | "idle" }>> {
    const sessions = await this.listSessions(directory);
    const out: Record<string, { type: "busy" | "idle" }> = {};
    await Promise.all(
      sessions.map(async (s) => {
        const pending = await this.inbox(s.id, directory).catch(() => [] as InboxItem[]);
        out[s.id] = { type: pending.length > 0 ? "busy" : "idle" };
      }),
    );
    return out;
  }

  async listSessions(directory: string, limit = 100): Promise<Session[]> {
    const res = await this.get<{ data: Session[] }>("/session", { query: { directory, limit: String(limit) } });
    return res.data;
  }

  // ---- agents / models ----

  async agents(directory: string): Promise<AgentInfo[]> {
    const res = await this.get<{ data: AgentInfo[] }>("/agent", { directory });
    return res.data;
  }

  async models(directory: string): Promise<ModelInfo[]> {
    const res = await this.get<{ data: ModelInfo[] }>("/model", { directory });
    return res.data;
  }

  /** All models as "provider/model" choices, defaults first (provider order as returned by the server). */
  async modelChoices(directory: string): Promise<{ providers: ProviderInfo[]; choices: string[]; defaults: string[] }> {
    const [providersRes, modelsRes] = await Promise.all([
      this.get<{ data: ProviderInfo[] }>("/provider", { directory }),
      this.models(directory),
    ]);
    const choices = modelsRes.map((m) => `${m.providerID}/${m.id}`);
    // The config does not expose per-provider defaults in v2; treat the first model per provider as its default.
    const seen = new Set<string>();
    const defaults: string[] = [];
    for (const m of modelsRes) {
      if (!seen.has(m.providerID)) {
        seen.add(m.providerID);
        defaults.push(`${m.providerID}/${m.id}`);
      }
    }
    return { providers: providersRes.data, choices, defaults };
  }

  // ---- permissions / forms ----

  async pendingPermissions(directory?: string): Promise<PermissionRequest[]> {
    const res = await this.get<{ data: PermissionRequest[] }>("/permission/request", { directory });
    return res.data;
  }

  async replyPermission(sessionID: string, requestID: string, reply: "once" | "always" | "reject", message?: string) {
    await this.post(`/session/${sessionID}/permission/${requestID}/reply`, { body: { decision: reply, message } });
  }

  /** Pending forms (v2's replacement for questions): one per unanswered question prompt. */
  async pendingForms(sessionID: string, directory?: string): Promise<FormRequest[]> {
    try {
      const res = await this.get<{ data: FormRequest[] }>(`/session/${sessionID}/form`, { directory });
      return res.data.filter((f) => !f.state || f.state.status === "pending");
    } catch (err) {
      if (statusOf(err) === 404) return [];
      throw err;
    }
  }

  async replyForm(sessionID: string, formID: string, answer: Record<string, unknown>) {
    await this.post(`/session/${sessionID}/form/${formID}/reply`, { body: { answer } });
  }

  // ---- filesystem (as the OpenCode server user) ----

  async listDir(directory: string, relPath = "."): Promise<FileEntry[]> {
    const res = await this.get<{ data: FileEntry[] }>("/fs/list", { directory, query: { path: relPath } });
    return res.data;
  }

  /** A text file as the OpenCode server's user sees it (undefined if missing/unreadable). */
  async readFile(directory: string, relPath: string): Promise<string | undefined> {
    try {
      const res = await fetch(new URL(`/api/fs/read/${relPath.split("/").map(encodeURIComponent).join("/")}?directory=${encodeURIComponent(directory)}`, this.url), {
        headers: this.headers,
      });
      if (!res.ok) return undefined;
      return await res.text();
    } catch {
      return undefined;
    }
  }

  // ---- pty (run commands as the OpenCode server user) ----

  async spawn(cwd: string, command: string, args: string[], title: string): Promise<string> {
    const res = await this.post<{ data: Pty }>("/pty", { directory: cwd, body: { command, args, cwd, title } });
    return res.data.id;
  }

  async kill(ptyID: string, directory: string) {
    await this.request("DELETE", `/pty/${ptyID}`, { directory }).catch(() => {}); // already exited is fine
  }

  async listPtys(directory: string): Promise<Pty[]> {
    const res = await this.get<{ data: Pty[] }>("/pty", { directory });
    return res.data;
  }

  /**
   * Create `dir` and `git init` it *as the OpenCode server's OS user* (via the PTY API),
   * so the gateway never needs write access to the agent's home. Idempotent.
   */
  async ensureGitRepo(dir: string, parent: string) {
    const rel = path.relative(parent, dir);
    if (await this.hasEntry(parent, rel, ".git")) return; // existing repo: leave it alone

    await this.runGit(parent, ["init", "-q", "-b", "main", dir]);
    if (!(await this.waitFor(() => this.hasEntry(parent, rel, ".git")))) throw new Error(`could not initialise a git repository at ${dir}`);

    // An initial commit gives OpenCode a stable project id (it's derived from the root commit).
    await this.runGit(parent, ["-C", dir, "-c", "user.name=Assistant", "-c", "user.email=assistant@localhost", "commit", "--allow-empty", "-q", "-m", "Start project"]);
    if (!(await this.waitFor(() => this.hasEntry(parent, path.join(rel, ".git", "refs", "heads"), "main")))) {
      log.warn(`initial commit in ${dir} did not show up; continuing without it`);
    }
  }

  private async runGit(cwd: string, args: string[]) {
    await this.spawn(cwd, "git", args, "hq: git");
  }

  private async hasEntry(parent: string, rel: string, name: string) {
    try {
      return (await this.listDir(parent, rel)).some((e) => (e.name ?? e.path.split(/[\\/]/).pop()) === name);
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

  // ---- mcp ----

  async mcpStatus(directory: string): Promise<Record<string, { status: string; error?: string }>> {
    const res = await this.get<{ data: McpServer[] }>("/mcp", { directory });
    const out: Record<string, { status: string; error?: string }> = {};
    for (const s of res.data) {
      const raw = s.status;
      const status = typeof raw === "string" ? raw : ((raw as { status?: string; state?: string }).status ?? (raw as { state?: string }).state ?? "unknown");
      const error = typeof raw === "object" ? (raw as { error?: string }).error : undefined;
      out[s.name] = { status, ...(error ? { error } : {}) };
    }
    return out;
  }

  async mcpConnect(name: string, directory: string) {
    await this.post(`/experimental/mcp/${name}/connect`, { directory });
  }

  // ---- events ----

  /** Global event stream across all project directories. Reconnects forever until `signal` aborts. */
  async *events(signal: AbortSignal): AsyncGenerator<GlobalEvent> {
    for (let attempt = 0; !signal.aborted; attempt++) {
      try {
        const res = await fetch(new URL("/api/event", this.url), {
          headers: { ...this.headers, Accept: "text/event-stream" },
          signal,
        });
        if (!res.ok || !res.body) throw new HttpError(res.status, `event stream → HTTP ${res.status}`);
        let buf = "";
        const dec = new TextDecoder();
        for await (const chunk of res.body) {
          attempt = 0;
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue; // heartbeats are comments
            try {
              yield JSON.parse(dataLine.slice(5).trim()) as GlobalEvent;
            } catch {
              log.debug(`unparsable event frame: ${raw.slice(0, 200)}`);
            }
          }
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

export function isAssistant(m: Message): m is Extract<Message, { type: "assistant" }> {
  return m.type === "assistant";
}

/** Visible text of an assistant message: its text content joined in order. */
export function messageText(m: Message | AssistantContent[]): string {
  const content = Array.isArray(m) ? m : isAssistant(m) ? m.content : [];
  return content
    .filter((p): p is Extract<AssistantContent, { type: "text" }> => p.type === "text")
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function errorText(m: Message): string | undefined {
  if (!isAssistant(m) || !m.error) return undefined;
  const e = m.error as StructuredError & { name?: string; data?: { message?: string } };
  const label = e.type ?? e.name ?? "Error";
  const detail = e.message ?? e.data?.message;
  return `${label}${detail ? `: ${detail}` : ""}`;
}
