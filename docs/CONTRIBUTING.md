# Contributing

crowstance is a small, single-owner codebase. Keep changes focused, tested and easy to
reverse. The running production tree is `/opt/crowstance/app` — never develop against it.

## Setup

```bash
cp .env.example .env
npm install
npm run typecheck
npm test
```

Node 24 runs the TypeScript directly; there is no build step. For an interactive local run,
start OpenCode in one terminal and the gateway in another:

```bash
npm run opencode
npm run doctor
npm run dev
```

`npm run dev:smoke` runs the stub-model smoke harness without touching a real provider.

## Required gates

Before every commit:

```bash
npm run typecheck
npm test
bash -n deploy/*.sh
git diff --check
```

`npm test` must pass in full. The suites in `test/deploy/` run the real deploy scripts (bash,
symlinks, file modes) and are skipped on Windows; if you develop on Windows and touch `deploy/`,
run the full suite in WSL or on Linux before committing.

New behaviour needs a test in the existing isolated-fixture style: temporary directories,
file-backed SQLite where recovery matters, and fakes for OpenCode, Telegram and the geocoder.
Tests must not use the network, root, real systemd, real Telegram, or any secret file.

## Style

- Match the surrounding code. Short imperative comments only where the reason is not obvious.
- Prefer small functions and explicit types over casts. `src/opencode.ts` is the only OpenCode
  boundary; `src/telegram/chat.ts` is the only Telegram boundary. Do not add a second path.
- Keep durable state in `Store` methods and schema changes in a new numbered migration. Never
  edit an applied migration.
- Log through `src/log.ts`. Include a correlation id where a path crosses modules, and never
  log secrets or raw coordinates.
- Schema changes must work on both a fresh database and a copy of a representative existing
  database.

## Commits and branches

- One milestone per branch, each branched off the previous milestone's tip.
- Short imperative commit messages, e.g. `Make deployments atomic with a health gate and
  rollback`.
- Local commits only. Do not push, and never deploy from a development task.
- Do not read or write `.env`, `deploy/secrets.env`, or `/etc/crowstance/*`. Never commit
  secrets.

## Documentation

User- and operator-facing behaviour belongs in `README.md`; deeper material belongs in
`docs/`:

- `docs/ARCHITECTURE.md` — system design, data flow, trust boundaries.
- `docs/MODULES.md` — per-file responsibilities.
- `docs/OPERATIONS.md` — runbooks (health, upgrade, rollback, incident, privacy, recovery).
- `docs/SUBAGENTS.md` — subagents, model choice, the model catalog and spend caps.
- `docs/CONTRIBUTING.md` — this file.

Runbook bash blocks are syntax-checked by the test suite, so keep commands real and valid.
When you document a command, verify it exists and matches the current script.
