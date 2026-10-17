# Operations runbook

Everything here is run on the server. The active tree is `/opt/crowstance/app` (an atomic
symlink); operator config and secrets live in `/etc/crowstance`. Never edit the active release
in place — ship a new one.

## 1. Health at a glance

```bash
sudo /opt/crowstance/app/deploy/doctor.sh
sudo /opt/crowstance/app/deploy/health-check.sh
sudo systemctl status crowstance-gateway.service crowstance-opencode.service
curl -fsS http://127.0.0.1:7801/health
curl -fsS http://127.0.0.1:7801/ready
curl -fsS http://127.0.0.1:7801/metrics
```

- `/health` is **liveness**: it answers whenever the gateway process is serving. It does not
  check dependencies, so a restart loop is not triggered by a slow provider.
- `/ready` is **readiness**: it checks the store, OpenCode health and Telegram polling.
  `503` means at least one dependency is down. The deploy gate uses this endpoint.
- `/metrics` reports queue age, retries and spend.

## 2. Logs and correlation

```bash
journalctl -u crowstance-gateway -u crowstance-opencode -f
journalctl -u crowstance-gateway --since "30 min ago" | grep 'correlation='
journalctl -u crowstance-gateway -p warning --since today
```

Every line is structured: `<iso> LEVEL [scope] correlation=<id> message {json}`. One inbound
message, its turn, the OpenCode request and the Telegram delivery all share one
`correlation=<id>`, so `grep` finds the whole path. Tokens, passwords, authorization headers
and raw coordinates are redacted before logging. MCP requests also honour an incoming
`X-Correlation-ID` header and echo one back.

## 3. Metrics

```bash
curl -fsS http://127.0.0.1:7801/metrics | python3 -m json.tool
```

Watch for:

- `updates.pending` growing, or `updates.oldestAgeMs` climbing — the main session is not
  draining background notes.
- `outbound.retryable` / `outbound.unknown` growing, or `outbound.retries` climbing — Telegram
  delivery is degraded. `outbound.failed` is a permanent failure that needs attention.
- `approvals.open` with a large `oldestAgeMs` — a request is waiting on the owner.
- `spend.today` approaching `DAILY_BUDGET_USD` / `REASONING_DAILY_BUDGET_USD`.

## 4. Upgrade

From the operator machine:

```bash
deploy/deploy.sh USER@HOST
```

That uploads a checksummed archive, verifies it, builds a new immutable release off to the
side, preserves `/etc` overlays and the operator `.env`/`deploy/secrets.env`, flips the symlink
atomically, restarts the gateway, and waits for `/ready`. If the release does not become
ready, it rolls back automatically to the last known-good release, which is kept.

When prompts or `opencode/opencode.json` change, the update is refused unless you pass:

```bash
deploy/deploy.sh USER@HOST --restart-opencode
```

Restarting OpenCode interrupts running tasks, so do it when workers are idle.

## 5. Rollback

An automatic rollback already happened if the health gate failed. To roll back by hand:

```bash
sudo bash /opt/crowstance/app/deploy/release.sh known-good
sudo bash /opt/crowstance/app/deploy/release.sh previous-id
sudo bash /opt/crowstance/app/deploy/release.sh activate RELEASE_ID
sudo systemctl restart crowstance-gateway.service
sudo /opt/crowstance/app/deploy/health-check.sh --wait
```

`release.sh recover` makes an interrupted update consistent: it adopts a healthy pending
release or rolls back to known-good. `deploy/doctor.sh` reports `MIXED STATE` if the active
release is not the last known-good one. Releases are never deleted by a rollback.

## 6. Incident response

1. **Check readiness first** and identify the failing dependency:
   `curl -fsS http://127.0.0.1:7801/ready`.
2. **Look at the last errors** with a correlation id:
   `journalctl -u crowstance-gateway --since "30 min ago" | grep -i error`.
3. **Messages not arriving?** Check `outbound.retryable`/`failed` in `/metrics` and the
   delivery logs. A permanent failure stays in the ledger for inspection; retryable chunks
   retry with bounded backoff. The policy is duplicate-over-loss: never assume a timeout means
   the message was not delivered.
4. **Provider or budget problem?** Check `/cost` in Telegram or `hq_provider_balance`.
   `REASONING_DAILY_BUDGET_USD` blocks new reasoning work; `DAILY_BUDGET_USD` blocks new tasks.
5. **Disk low?** New tasks pause automatically below `DISK_MIN_FREE_GB` and the owner is told.
6. **Interrupted deploy?** Run `sudo bash /opt/crowstance/app/deploy/release.sh recover`.
7. **Suspect credential exposure?** Rotate the affected secret, restart the service, and follow
   section 9. Do not paste secrets into chat or tickets.

## 7. Backups and recovery

Two independent backups run nightly:

- **Memory** (`crowstance-backup.timer`, 03:30) — sandboxed export of
  `assistant/memory` as `crow-backup`, committed locally with hooks and global Git config
  disabled. It has no network access.
- **State** (`crowstance-state-backup.timer`, 03:00) — encrypted SQLite snapshot plus memory,
  written under `/var/lib/crowstance-backup/state/<UTC timestamp>/` and pruned to
  `CROW_BACKUP_KEEP` (default 7).

```bash
sudo /opt/crowstance/app/deploy/state-backup.sh
sudo /opt/crowstance/app/deploy/restore-drill.sh
sudo /opt/crowstance/app/deploy/restore-drill.sh /var/lib/crowstance-backup/state/20260101T030000Z
```

The restore drill restores the newest backup into a clean temporary directory, verifies the
encrypted manifest and checksums, and confirms sessions, tasks, reminders and memory are
present. It never touches live state. To recover for real, restore to a new path first and
only then swap it into place during a maintenance window.

The passphrase is `/etc/crowstance/backup.key` (root-only, generated by `setup.sh`). Keep a
copy in your password manager: without it the backup is unrecoverable. **Off-host copies are an
operator step** — the backup service has no network access, so copy the encrypted directory
with your own tooling:

```bash
sudo rclone copy /var/lib/crowstance-backup/state remote:crowstance-state
```

## 8. Retention

`RETENTION_DAYS` (default 30) bounds terminal history. Once a day the gateway prunes delivered
updates, consumed inbound messages, sent outbound events, resolved approvals, completed turns
and finished delivery attempts older than the cutoff. Pending updates, buffered inbound,
unsent outbound chunks, unresolved approvals, unfired reminders and running tasks are never
eligible, however old.

## 9. Privacy and secrets

- Logs redact tokens, passwords, authorization headers, credentials and raw coordinates.
  Model text, tool output and notification contents can still appear in logs — treat
  `journalctl` output as sensitive.
- Backups are encrypted with AES-256-GCM and an encrypted manifest. The memory bundle can
  contain personal notes, so protect `/etc/crowstance/backup.key` and any off-host copy.
- The model provider sees everything the agent reads and writes. The geocoder (if configured)
  sees place queries. Do not put high-value secrets on the box.
- The agent process can reach the provider key because OpenCode needs it; the assistant is told
  never to reveal credentials, and `hq_provider_balance` exists for balance questions.
- Never write secrets into memory files, the repository, or documentation. Reference
  `/etc/crowstance/*.env` instead.

## 10. Settings and secrets

```bash
sudo systemctl restart crowstance-gateway.service
sudo systemctl restart crowstance-opencode.service
sudo bash /opt/crowstance/app/deploy/setup.sh
```

Put operator overrides in `/etc/crowstance/gateway.env.local` and re-run `setup.sh`; manual
settings in `setup.env` are remembered across runs. Provider keys live in
`/etc/crowstance/opencode.env`.
