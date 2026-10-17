#!/usr/bin/env bash
# Export an encrypted, checksummed state backup (SQLite + assistant memory).
#
# Run by the crowstance-state-backup.timer as root, or by hand:
#   sudo /opt/crowstance/app/deploy/state-backup.sh
#
# The passphrase lives in a root-only file (default /etc/crowstance/backup.key),
# never on the command line. Backups are written to a fixed local directory and
# pruned to CROW_BACKUP_KEEP; copying them off-host is an operator step.
set -euo pipefail

APP="${CROW_APP:-/opt/crowstance/app}"
NODE="${CROW_NODE:-/opt/crowstance/node}/bin/node"
DB="${CROW_DB:-/var/lib/crowstance/assistant.db}"
MEMORY="${CROW_MEMORY:-/home/crow-agent/assistant/memory}"
BACKUP_DIR="${CROW_BACKUP_DIR:-/var/lib/crowstance-backup/state}"
KEY_FILE="${CROW_BACKUP_KEY_FILE:-/etc/crowstance/backup.key}"
KEEP="${CROW_BACKUP_KEEP:-7}"

[ -r "$KEY_FILE" ] || { echo "state-backup: missing or unreadable passphrase file: $KEY_FILE" >&2; exit 1; }
[ -f "$DB" ] || { echo "state-backup: missing database: $DB" >&2; exit 1; }

install -d -m 700 "$BACKUP_DIR"
ID="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/$ID"

"$NODE" "$APP/src/backup.ts" export --db "$DB" --out "$OUT" --memory "$MEMORY" --passphrase-file "$KEY_FILE" >/dev/null
[ -s "$OUT/manifest.json.enc" ] || { echo "state-backup: export wrote nothing to $OUT" >&2; exit 1; }
"$NODE" "$APP/src/backup.ts" verify --backup "$OUT" --passphrase-file "$KEY_FILE" >/dev/null
"$NODE" "$APP/src/backup.ts" prune --dir "$BACKUP_DIR" --keep "$KEEP" >/dev/null

echo "state-backup: wrote and verified $OUT"
