/**
 * Subagent kinds: every OpenCode agent that isn't a primary one (mode "subagent" or "all") is a
 * kind the chat can delegate to. OpenCode owns a kind's prompt, tools and permissions (its agent
 * entry in opencode/opencode.json); config/kinds.json adds what OpenCode has no field for: the
 * model and effort a kind runs on, the jobs it's for, and its caps. `every` there is the default
 * for all kinds. A kind without an entry uses `every`; an entry without an agent is ignored
 * (doctor lists it).
 */
import fs from "node:fs";
import { z } from "zod";
import type { Config } from "./config.ts";
import { logger } from "./log.ts";
import { sleep, type AgentInfo, type OpenCode } from "./opencode.ts";

const log = logger("kinds");

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Role ids the gateway uses itself; a kind can't take one of these names. */
export const RESERVED_ROLES = new Set(["chat", "workers", "every", "default", "auto"]);

/** The tools an OpenCode 2 agent gets unless its config turns them off (`bash` is the old name of `shell`). */
const BASE_TOOLS = ["read", "glob", "grep", "webfetch", "websearch", "edit", "write", "shell", "execute"];
const TOOL_ALIASES: Record<string, string> = { bash: "shell" };

const modelRef = z.string().regex(/^[^/\s]+\/\S+$/, 'expected "provider/model"');

const RolePolicy = z.object({ model: modelRef.optional(), effort: z.enum(EFFORTS).optional() }).strict();

const KindPolicy = RolePolicy.extend({
  enabled: z.boolean().optional(),
  /** The jobs to pick this kind for, shown to the chat next to OpenCode's description. */
  when: z.string().max(400).optional(),
  max_call_usd: z.number().positive().optional(),
  timeout_sec: z.number().int().positive().optional(),
}).strict();

export const PolicyFile = z
  .object({
    $comment: z.string().optional(),
    /** The default model and effort for every subagent kind. */
    every: RolePolicy.optional(),
    workers: RolePolicy.optional(),
    kinds: z.record(z.string(), KindPolicy).optional(),
  })
  .strict();
export type PolicyFile = z.infer<typeof PolicyFile>;

export type RolePolicy = { model?: string; effort?: Effort };
export type Kind = RolePolicy & {
  id: string;
  description: string;
  when?: string;
  /** What the kind can use, from its agent entry in opencode.json (undefined for OpenCode's built-ins). */
  tools?: string[];
  maxCallUsd?: number;
  timeoutSec?: number;
};

function rolePolicy(p: z.infer<typeof RolePolicy> | undefined): RolePolicy {
  return { ...(p?.model ? { model: p.model } : {}), ...(p?.effort ? { effort: p.effort } : {}) };
}

/** Read and validate a policy file; throws with a readable message. */
export function readPolicy(file: string): PolicyFile {
  const parsed = PolicyFile.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** Each agent's `tools` switches from an OpenCode config file. */
export function readAgentTools(file: string): Record<string, Record<string, boolean>> {
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as { tools?: Record<string, boolean>; agent?: Record<string, { tools?: Record<string, boolean> }> };
  const global = config.tools ?? {};
  return Object.fromEntries(Object.entries(config.agent ?? {}).map(([id, a]) => [id, { ...global, ...(a.tools ?? {}) }]));
}

/** The tools left on, given an agent's switches. */
export function enabledTools(switches: Record<string, boolean>): string[] {
  const off = new Set(Object.entries(switches).filter(([, on]) => on === false).map(([name]) => TOOL_ALIASES[name] ?? name));
  return BASE_TOOLS.filter((t) => !off.has(t));
}

export class Kinds {
  private readonly cfg: Config;
  private readonly oc: OpenCode;
  private readonly file: string | undefined;
  private readonly toolsFile: string | undefined;
  private readonly retryDelaysMs: number[];
  private policyFile: PolicyFile = {};
  private agentTools: Record<string, Record<string, boolean>> = {};
  private agents: AgentInfo[] = [];
  private discovered = false;

  constructor(deps: { cfg: Config; oc: OpenCode; policy?: PolicyFile; agentTools?: Record<string, Record<string, boolean>>; retryDelaysMs?: number[] }) {
    this.cfg = deps.cfg;
    this.oc = deps.oc;
    this.retryDelaysMs = deps.retryDelaysMs ?? [500, 1000, 2000, 4000, 8000];
    if (deps.policy) this.policyFile = deps.policy;
    else this.file = deps.cfg.KINDS_FILE;
    if (deps.agentTools) this.agentTools = deps.agentTools;
    else if (!deps.policy) this.toolsFile = deps.cfg.OPENCODE_CONFIG_FILE;
    this.reloadPolicy();
  }

  /** Re-read config/kinds.json (and the agents' tools); a broken file keeps the last good copy. */
  reloadPolicy(): string | undefined {
    if (this.toolsFile && fs.existsSync(this.toolsFile)) {
      try {
        this.agentTools = readAgentTools(this.toolsFile);
      } catch (err) {
        log.warn(`could not read agent tools from ${this.toolsFile}: ${(err as Error).message}`);
      }
    }
    if (!this.file) return undefined;
    if (!fs.existsSync(this.file)) {
      log.warn(`no kind policy at ${this.file}; every kind runs on the chat's model`);
      return undefined;
    }
    try {
      this.policyFile = readPolicy(this.file);
      return undefined;
    } catch (err) {
      const message = (err as Error).message;
      log.error(`kind policy not loaded, keeping the previous one: ${message}`);
      return message;
    }
  }

  /**
   * Ask OpenCode which agents exist. Right after it starts, OpenCode answers with an empty list,
   * then with only its built-in agents, before its config is loaded. So a list without our own
   * assistant agent is retried, and an empty one never replaces a list we already have.
   * Returns whether the list is complete.
   */
  async refresh(): Promise<boolean> {
    this.reloadPolicy();
    let partial: AgentInfo[] | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const agents = await this.oc.agents(this.cfg.ASSISTANT_HOME);
        if (agents.some((a) => a.id === this.cfg.ASSISTANT_AGENT || a.name === this.cfg.ASSISTANT_AGENT)) {
          this.agents = agents;
          this.discovered = true;
          return true;
        }
        if (agents.length) partial = agents;
      } catch (err) {
        log.warn(`could not list agents: ${(err as Error).message}`);
      }
      const wait = this.retryDelaysMs[attempt];
      if (wait === undefined) {
        if (!this.discovered && partial) this.agents = partial;
        log.warn(`OpenCode's agent list has no "${this.cfg.ASSISTANT_AGENT}" agent yet (is opencode.json loaded?); subagent kinds may be incomplete`);
        return false;
      }
      await sleep(wait);
    }
  }

  private isKind(a: AgentInfo): boolean {
    if (a.mode === "primary" || a.hidden) return false;
    if (RESERVED_ROLES.has(a.id) || a.id === this.cfg.ASSISTANT_AGENT || a.id === this.cfg.WORKER_AGENT) return false;
    return this.policyFile.kinds?.[a.id]?.enabled !== false;
  }

  /** The kinds the chat can delegate to right now. */
  list(): Kind[] {
    return this.agents.filter((a) => this.isKind(a)).map((a) => this.toKind(a));
  }

  get(id: string): Kind | undefined {
    const agent = this.agents.find((a) => a.id === id);
    return agent && this.isKind(agent) ? this.toKind(agent) : undefined;
  }

  private toKind(a: AgentInfo): Kind {
    const p = this.policyFile.kinds?.[a.id];
    const switches = this.agentTools[a.id];
    return {
      id: a.id,
      description: a.description ?? a.name,
      ...rolePolicy(p),
      ...(p?.when ? { when: p.when } : {}),
      ...(switches ? { tools: enabledTools(switches) } : {}),
      ...(p?.max_call_usd !== undefined ? { maxCallUsd: p.max_call_usd } : {}),
      ...(p?.timeout_sec !== undefined ? { timeoutSec: p.timeout_sec } : {}),
    };
  }

  /** "provider/model" configured on an agent in opencode.json (OpenCode itself ignores it; the gateway sends it). */
  agentModel(id: string): string | undefined {
    const m = this.agents.find((a) => a.id === id || a.name === id)?.model;
    return m ? `${m.providerID}/${m.id}` : undefined;
  }

  /** The default for every subagent kind. */
  every(): RolePolicy {
    return rolePolicy(this.policyFile.every);
  }

  workers(): RolePolicy {
    return rolePolicy(this.policyFile.workers);
  }

  /** Policy entries naming agents OpenCode doesn't have (doctor shows them). */
  orphanPolicies(): string[] {
    const ids = new Set(this.agents.map((a) => a.id));
    return Object.keys(this.policyFile.kinds ?? {}).filter((k) => !ids.has(k) && this.policyFile.kinds?.[k]?.enabled !== false);
  }

  /** Agents that look like kinds but are hidden behind a reserved name. */
  reservedClashes(): string[] {
    return this.agents.filter((a) => a.mode !== "primary" && RESERVED_ROLES.has(a.id)).map((a) => a.id);
  }

  discoveredAgents(): boolean {
    return this.discovered;
  }
}
