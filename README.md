# crowstance

A personal AI assistant you text on Telegram. It lives on your VPS, works around the clock, and runs on
[OpenCode](https://opencode.ai) with your own model credentials.

```
You (Telegram) ──► gateway (this repo, Node 24) ──► opencode serve (1.18.x) ──► crowbot (DeepSeek, GPT, …) / any provider
                     │  allowlist, debounce, typing, buttons        ├─ main session  (agent "assistant", ~/assistant)
                     │  tasks, reminders, jobs, monitors (SQLite)   └─ worker sessions (agent "worker", ~/projects/<task>)
                     └─ 127.0.0.1:7801  /mcp (hq_* tools) · /notify (monitor scripts)
```

- **One conversation, many workers.** You always talk to one long-lived session. It does quick things itself and hands
  anything long to background worker sessions, so the chat never blocks.
- **"Where are we with X?"** comes from real data: the worker's todo list, files changed, cost, pending approvals, and its
  latest words or final report.
- **Proactive.** Finished tasks, reminders, monitor alerts and a morning check-in arrive as `<update>` notes. The
  assistant decides whether they're worth a message (it replies `NO_REPLY` when they're not). Non-urgent updates wait out
  your quiet hours.
- **Approvals.** Risky commands (`git push`, `sudo`, `ssh`, publishing…) and agent questions show up as buttons.
- **Memory is plain files** in `~/assistant` (`memory/profile.md`, `memory/notes/`, `memory/journal/`), backed up nightly with git. State backups (SQLite + memory) are encrypted and restorable.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | wiring, event dispatch |
| `src/opencode.ts` | the only module that talks to OpenCode (swap point for OpenCode 2.x) |
| `src/conversation.ts` | main chat: debounce, queue-while-busy, typing, durable retrying delivery, `NO_REPLY` |
| `src/delivery.ts` | durable outbound worker: leases, retries, duplicate-over-loss policy |
| `src/tasks.ts` | background workers and status reports |
| `src/approvals.ts` | permission and question buttons |
| `src/scheduler.ts` | reminders, cron jobs, monitors, morning check-in, quiet hours, disk watchdog |
| `src/mcp.ts` | `hq` MCP tools for the assistant, `/notify`, `/health`, `/ready`, `/metrics` |
| `src/log.ts` | structured logs with correlation ids and secret/PII redaction |
| `src/backup.ts` | encrypted state backup/restore tooling |
| `src/telegram/*` | bot, commands, markdown → Telegram HTML |
| `src/doctor.ts` | `npm run doctor`: end-to-end setup check (no model calls) |
| `opencode/` | OpenCode config plus the `assistant` and `worker` prompts |
| `home/` | seed for the assistant's home/memory directory |
| `deploy/` | server audit, setup, atomic update, backup/restore, systemd unit templates, network fence |
| `docs/` | architecture, modules, operations runbook, contributing guide |

## Local development (Windows or anything with Node 24)

1. Create a **dev bot** with @BotFather and get your user id from @userinfobot.
2. `cp .env.example .env`, then fill in:
   - the dev bot token, your user id and your crowbot account number (`CROWBOT_API_KEY`)
   - three long random strings for `OPENCODE_SERVER_PASSWORD`, `HQ_MCP_TOKEN` and `HQ_NOTIFY_TOKEN`
3. `npm install`
4. Terminal 1: `npm run opencode`. This starts OpenCode with this repo's config and the values from `.env`, and seeds
   `ASSISTANT_HOME` the first time.
5. Terminal 2: `npm run doctor` (shows your crowbot balance too), then `npm run dev`. Text your dev bot.

`npm test` runs the unit tests and `npm run typecheck` checks types. No build step: Node 24 runs the TypeScript directly.

> Locally, the agent runs commands on your own machine and your personal `~/.config/opencode` config is merged in.
> On the server it runs sandboxed with only this repo's config.

## Going live

Put the real bot token, your user id and your crowbot account number in `deploy/secrets.env` (copy
`deploy/secrets.env.example`; it's git-ignored). The server needs Ubuntu 22.04 or 24.04 and your SSH key on root.

**1. Look first (changes nothing):**

```bash
deploy/deploy.sh root@<ip> --audit
```

This prints the OS, CPU/RAM/disk, running services, listening ports, Docker, the firewall, and directories that could hold
other projects' data.

**2. Install:**

```bash
deploy/deploy.sh root@<ip> --setup            # a server just for this
deploy/deploy.sh root@<ip> --setup --shared   # a server that also runs other things
```

Both modes:

- install a private Node 24, OpenCode 1.18.34 and gh under `/opt/crowstance`; the system's own Node is never touched
- install code as an immutable release under `/opt/crowstance/releases` and point `/opt/crowstance/app` at it atomically;
  the live tree is never edited in place
- create three users: **`crow-agent`** runs OpenCode and does the work, with no sudo; **`crow-gateway`** talks to Telegram
  and holds the bot token, which the agent can't read; **`crow-backup`** receives only the allowlisted memory export
- seed `/home/crow-agent/assistant` and write the secrets to `/etc/crowstance/*.env`
- install the `crowstance-*` systemd services in their own resource slice, plus the nightly memory backup
- sandbox OpenCode and everything the agent runs: it can write only to its own home, can't see other users' homes, and
  can't gain privileges

**Dedicated mode** also:
- upgrades packages and turns on automatic security updates
- adds swap and sets the timezone
- enables ufw (SSH only) and fail2ban
- creates an **`admin`** sudo user with your key and turns off root and password SSH logins

**Shared mode** (`--shared`, or `SHARED=1` in `secrets.env`) changes nothing server-wide:
- **Server untouched:** packages are only added, with automatic service restarts suppressed. Nothing is upgraded, and
  there are no firewall, SSH, timezone or swap changes. If 4096/7801 are taken, it picks other ports.
- **Resource caps:** crowstance is capped at half the CPU cores and 40% of RAM, at low CPU and disk priority. If it runs
  out of memory, the kernel kills the agent's process, not your other services.
- **Network fence:** OpenCode starts only after the netguard oneshot succeeds. The enforced fence covers discovered TCP
  listeners on IPv4/IPv6 loopback and named Docker bridge egress. It does not cover UDP listeners, UNIX sockets,
  arbitrary interfaces, or ports opened after a refresh. The internet stays reachable. Refreshed every 2 minutes; check it with
  `sudo /opt/crowstance/app/deploy/netguard.sh status`.
- **Hidden paths:** list extra directories the agent must never see in `CROW_HIDE_PATHS`, e.g. `"/var/www /srv/app"`
  (take them from the audit).
- **Disk watchdog:** if free space drops below `DISK_MIN_FREE_GB` (default 5), new tasks pause and you get a message.

**3. Check it:**

```bash
ssh root@<ip>                                   # or admin@<ip> on a dedicated server
sudo /opt/crowstance/app/deploy/doctor.sh       # every line should be ✅
sudo /opt/crowstance/app/deploy/health-check.sh # readiness of gateway + OpenCode
curl -fsS http://127.0.0.1:7801/ready           # dependency readiness
curl -fsS http://127.0.0.1:7801/metrics         # queue age, retries, spend
journalctl -u crowstance-gateway -u crowstance-opencode -f
```

Text your bot. To update later: `deploy/deploy.sh <user>@<ip>`. The update is uploaded as a checksummed archive, built
as a new release, then health-gated after an atomic symlink switch; if the gateway or OpenCode never becomes ready it
rolls back to the previous release, which is always kept. Add `--restart-opencode` when you changed the prompts or the
OpenCode config; restarting OpenCode interrupts running tasks, so updates that change those files are refused without it.

Every release is a commit: `deploy.sh` refuses uncommitted changes (`--allow-dirty` overrides) and ships a `VERSION`
file plus `source.bundle`, the git history of that commit. On the server, `/opt/crowstance/app/VERSION` says what's
running, and the assistant's copy in `~/projects/crowstance` fetches it with `git fetch live`.

### Watching it work

```bash
ssh -L 4096:127.0.0.1:4096 root@<ip>                  # keep this open
opencode attach http://localhost:4096 -p <password>   # full TUI over the main chat and every worker
```

The password is `OPENCODE_SERVER_PASSWORD` in `/etc/crowstance/opencode.env`. If setup picked a different port, it's
`OPENCODE_PORT` in the same file.

### Settings on the server

- **Gateway settings** (`QUIET_HOURS`, `MORNING_CHECKIN`, `DAILY_BUDGET_USD`, `MAX_WORKERS`, `CHAT_MODEL`,
  `WORKER_MODEL`, `DISK_MIN_FREE_GB`): add them to `/etc/crowstance/gateway.env.local` and re-run
  `sudo bash /opt/crowstance/app/deploy/setup.sh`. Mode, caps and hidden paths are remembered in
  `/etc/crowstance/setup.env`.
- **Backups:**
  - the nightly memory service exports only `assistant/memory` into `/var/lib/crowstance-backup/export` as `crow-backup`; the export is committed locally with Git hooks and system/global Git configuration disabled, and has no network access
  - the nightly state service writes an encrypted SQLite snapshot plus memory under `/var/lib/crowstance-backup/state/<timestamp>/` (AES-256-GCM, encrypted manifest with checksums), pruned to the last few
  - `sudo /opt/crowstance/app/deploy/restore-drill.sh` restores the newest backup into a temp directory and verifies sessions, tasks, reminders and memory. Keep the passphrase in `/etc/crowstance/backup.key` safe; copying backups off-host is an operator step. See `docs/OPERATIONS.md`.
- **GitHub for the agent:** `sudo -u crow-agent -H /opt/crowstance/bin/gh auth login --with-token < token.txt`, using a
  fine-grained token limited to the repos it should touch.

## Models and providers

Models come through [crowbot](https://crowbot.sh), an OpenAI-compatible gateway. Your 16-digit account number is
the API key (`CROWBOT_API_KEY`). The defaults in `opencode/opencode.json`:

| Role | Model | $/M tokens in / out |
|---|---|---|
| Chat (the `assistant` agent) | `crowbot/deepseek-v4.1-flash` | 0.045 / 0.18 (cached input 0.0009) |
| Background workers (`worker` agent) | `crowbot/deepseek-v4.1-flash` | 0.045 / 0.18 (cached input 0.0009) |
| Also selectable | `crowbot/kimi-k3` (coding), `crowbot/crow-2` (GLM 5.3, uncensored build) | 0.27 / 1.35 · 5.00 / 5.00 |

- **Switch at runtime:** `/model` in Telegram. Chat and workers can use different models.
- **New provider:** the `provider` block in `opencode/opencode.json` is only the default crowbot setup. Replace it with any OpenCode-compatible provider and list the models you want there.
  1. Add its key to `/etc/crowstance/opencode.env`, e.g. `OPENROUTER_API_KEY=…`.
  2. Run `sudo systemctl restart crowstance-opencode`.
  3. Pick the model with `/model`.
- **No Claude Pro/Max subscriptions:** Anthropic's terms limit them to Claude Code and claude.ai. Use an API key with a
  monthly spend cap instead.

`DAILY_BUDGET_USD` (default 20) stops new tasks once the day's spend reaches it. `/cost` shows today and this month.

## Telegram commands

| Command | |
|---|---|
| `/tasks` | background work (no model call) |
| `/stop` · `/stop <task>` | interrupt the assistant, or stop a task |
| `/new` | clean chat; the assistant saves memory and where you left off first, and picks it up only when asked |
| `/model` | show or switch models |
| `/cost` | spend today and this month |
| `/quiet on\|off\|auto` | hold non-urgent updates |

Everything else is just conversation. Reply to a question message to give a free-form answer.

## Monitoring pattern

For "tell me if X goes down", the assistant writes a small script in `~/assistant/scripts/monitors/` and registers it
with `hq_monitor_add`. The gateway then runs it on its interval inside the agent's sandbox, which costs no tokens. The
script calls `scripts/notify.sh "what happened" [--urgent]` only when the state changes.

LLM jobs (`hq_schedule`) are for things that need judgement, like a daily digest. They have a minimum interval
(`MIN_JOB_INTERVAL_MIN`, default 60).

## Security notes

- **Access:** only `OWNER_TELEGRAM_ID` can talk to the bot. OpenCode and hq listen on 127.0.0.1 only, behind a password
  and bearer tokens.
- **Prompt injection:** the agent reads the web and runs shell commands, so assume prompt injection is possible.
  - keep high-value secrets off the box
  - use scoped tokens and a provider spend cap
  - outward actions need your approval
- **What actually protects you:**
  - the OS users: `crow-agent` has no sudo and can't read the gateway's bot token
  - the service sandbox
  - the network fence, in shared mode
  - the scoped credentials you give it

  The bash approval patterns in `opencode.json` are guardrails against mistakes, not a security boundary.
- **The provider key is reachable by the agent:** OpenCode needs the key and runs as the same user as the agent's
  commands, so the agent could find it. The assistant is told never to look for or reveal credentials, and it gets
  `hq_provider_balance` for balance questions. Keep the provider balance modest.
- **Your provider sees everything:** whoever runs the model provider sees everything the agent reads and writes, and
  controls its replies.
