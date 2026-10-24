# Subagents, model routing and spend caps

The chat hands focused jobs to *subagents*. Each kind of subagent has its own job and its own
tools, and its own model and effort (or the default for all subagents). The chat only picks
which kind fits; the gateway runs it on that kind's model, within caps you set. Long, multi-step
work still goes to background workers. This is the same shape as crowbot-cli's subagents.

| | Chat | Subagent (`hq_delegate`) | Worker (`hq_task_start`) |
|---|---|---|---|
| Lives | for hours | one job, minutes | until the task is done |
| Answers | you | the chat, in the same turn | an update when it finishes |
| Can change files | yes | no (read, search, web) | yes, in its project |
| Model | your pick | its kind's, else all subagents' | the workers' |

## How a delegation runs

1. The chat calls `hq_delegate` (in OpenCode 2's Code Mode: `tools.hq.delegate({kind, prompt})`).
   Several can run at once with `Promise.allSettled` in one `execute`.
2. `Subagents.delegate` checks the kind exists, resolves its model and effort (`Roles`), and runs
   the cap preflight (`Limits`). The concurrency and per-turn limits are checked too.
3. The gateway creates a child session of the main session (`parentID`) with the kind's agent,
   model and effort *at creation* (OpenCode 2 ignores an agent's configured model), records a
   `subagent_runs` row, and sends the prompt.
4. When the session goes idle, the answer (the last assistant message with text) goes back as the
   tool result. After `SUBAGENT_SYNC_SEC` the call returns early and the answer arrives later as
   an update. After its timeout, or at its cost cap, the subagent is interrupted and whatever it
   had is returned.

OpenCode's own `subagent` tool is turned off (`"tools": {"task": false}`), and Code Mode can't
create sessions, so every subagent goes through the gateway: visible, capped and attributed.

## Kinds

A kind is defined in two places:

- **`opencode/opencode.json`:** an agent with `"mode": "subagent"`, its prompt (what it does and
  how it reports) and its tools. OpenCode enforces these.
- **`config/kinds.json`:** what the gateway adds. `when` is the jobs to send it (shown to the
  chat); `model` and `effort` say what it runs on (left out, it uses `every`, the default for all
  subagents); `max_call_usd` and `timeout_sec` are its caps.

The gateway lists the kinds from `/api/agent` at start and on every reconnect. Right after it
starts, OpenCode answers with an empty list, then with only its built-ins, so the gateway retries
until our own agents are there. Three ship:

| Kind | Model | Effort | Good for | Tools |
|---|---|---|---|---|
| `explore` | all subagents' (`deepseek-v4.1-flash`) | low | find something in files or on the web and report it | read, glob, grep, webfetch, websearch |
| `research` | `gpt-6.1-sol` | medium | compare several sources, cited summary | same |
| `analyst` | `kimi-k3` | high | think hard about one question, plan or piece of code | same |

OpenCode's built-in `general` is switched off in `config/kinds.json` (it can edit files).

`hq_delegate`'s description lists each kind with its job (`when`) and its tools (read from its
agent entry), so the chat picks by the job. OpenCode lists an MCP server's tools once, when it
connects, and keeps that list; `hq_delegate` (and its list of kinds) only exists once the kinds
are known, so the gateway reconnects `hq` whenever the kinds change. For the same reason the
description leaves out models and caps, which `/model` and `/limits` change any time; the model
that ran and what it cost come back in each result.

To add a kind: add a `"mode": "subagent"` agent with a prompt and read-only tools to
`opencode/opencode.json`, give it `when` (and a model and effort, if `every`'s don't fit) in
`config/kinds.json`, and deploy with `--restart-opencode`. The names `chat`, `workers`, `every`,
`default` and `auto` are reserved.

## Model choice (`src/roles.ts`)

One resolver for every launch, so what `/model` shows is what is sent (as in crowbot-cli):

- **a kind:** the call's `model` → your `/model` pick for the kind → its entry in `config/kinds.json`
  → your pick for all subagents → `every` in `config/kinds.json` → the chat's model
- **all subagents (`every`):** your pick → `every` in `config/kinds.json` → the chat's model
- **workers:** the call's `model` → your pick → `WORKER_MODEL` → `workers` in `config/kinds.json` → the worker agent's model → the chat's
- **chat:** your pick → `CHAT_MODEL` → the assistant agent's model in `opencode.json`

Effort inherits separately along the same chain and is dropped for a model that doesn't reason.
A model for a subagent or worker must be *usable* (crowbot serves it and OpenCode knows it), call
tools, and be under `MODEL_MAX_PRICE_PER_1M` (blended price, 0.75·input + 0.25·output per 1M
tokens). One that isn't is an error, never a silent fallback to another model; `/model` shows
it as ⚠️. The chat itself has no price ceiling.

## The catalog (`src/catalog.ts`)

Prices and capabilities come from crowbot's `GET /v1/models` (refreshed every
`CATALOG_REFRESH_MIN`, cached in the database, kept when a fetch fails). Usable models are
crowbot's list crossed with OpenCode's. Without a key the catalog uses OpenCode's own list and
prices. When the two drift apart, the gateway logs it, `npm run doctor` shows it, and the
assistant gets one quiet update. Fix it with:

```bash
npm run models:sync            # rewrite the crowbot models in opencode/opencode.json
npm run models:sync -- --check # exit 1 if it's out of date
```

then deploy with `--restart-opencode`.

## Spend caps (`src/limits.ts`)

Each cap's env value is a ceiling; `/limits <cap> <value>` makes it stricter at runtime and
`/limits <cap> default` resets it. (For `floor`, stricter means higher.)

| Cap | Env (ceiling) | Default | What happens |
|---|---|---|---|
| `daily` | `DAILY_BUDGET_USD` | 20 | new chat turns, workers and delegations refused; running workers and subagents stopped; you're told once |
| `monthly` | `MONTHLY_BUDGET_USD` | 200 | same as daily |
| `subagents` | `SUBAGENT_DAILY_BUDGET_USD` | 5 | delegations refused; running ones stopped |
| `call` | `SUBAGENT_CALL_MAX_USD` | 0.50 | one delegation is interrupted at it (a kind's `max_call_usd` can be stricter) |
| `turn` | `SUBAGENT_TURN_MAX_USD` | 1.50 | the turn's delegations are interrupted |
| `task` | `TASK_MAX_USD` | 5 | the worker is stopped and the assistant told |
| `price` | `MODEL_MAX_PRICE_PER_1M` | 2 | priciest model workers and subagents may use |
| `floor` | `BALANCE_FLOOR_USD` | 1 | no new background work while the crowbot balance is below it |
| `concurrent` | `SUBAGENT_MAX_CONCURRENT` | 3 | delegations running at once |
| `per-turn` | `SUBAGENT_MAX_PER_TURN` | 6 | delegations per chat turn |

A delegation can only start if its whole call cap fits in what's left of the daily and subagent
budgets. OpenCode reports usage as running totals per session; the gateway stores the last total
(`session_costs`) and records only the increase, priced at the higher of OpenCode's figure and
crowbot's catalog price, so a stale `opencode.json` price never undercounts. Caps act on usage
events, so one model step can go slightly past a cap before the interrupt lands.

## Telegram

- `/model` shows every role (chat, all subagents, each kind, workers) with its model, effort and
  where that came from. Tap one to pick a model (with prices) or an effort, or `↺ Auto` to go back
  to what `config/kinds.json` says. Typed: `/model every crowbot/gemini-3.8-flash`,
  `/model analyst effort high`, `/model explore auto`.
- `/limits` shows each cap, its ceiling and what's used.
- `/tasks` lists running and recent delegations; `/cost` breaks today's subagent spend down by kind.
- `/stop` also stops the turn's delegations; `/new` stops all of them.
