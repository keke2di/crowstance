#!/usr/bin/env bash
# Restore a state backup into a clean temporary directory and verify that
# sessions, tasks, reminders and memory survived. Never touches live state.
#
#   sudo /opt/crowstance/app/deploy/restore-drill.sh [backup-dir]
#
# With no argument it drills the newest backup under CROW_BACKUP_DIR.
set -euo pipefail

APP="${CROW_APP:-/opt/crowstance/app}"
NODE="${CROW_NODE:-/opt/crowstance/node}/bin/node"
BACKUP_DIR="${CROW_BACKUP_DIR:-/var/lib/crowstance-backup/state}"
KEY_FILE="${CROW_BACKUP_KEY_FILE:-/etc/crowstance/backup.key}"

BACKUP="${1:-}"
if [ -z "$BACKUP" ]; then
  BACKUP="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n1)"
fi
[ -n "$BACKUP" ] && [ -d "$BACKUP" ] || { echo "restore-drill: no state backup found (looked in $BACKUP_DIR)" >&2; exit 1; }
[ -r "$KEY_FILE" ] || { echo "restore-drill: missing or unreadable passphrase file: $KEY_FILE" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

"$NODE" "$APP/src/backup.ts" verify --backup "$BACKUP" --passphrase-file "$KEY_FILE" >/dev/null
"$NODE" "$APP/src/backup.ts" restore --backup "$BACKUP" --db "$TMP/assistant.db" --memory "$TMP/memory" --passphrase-file "$KEY_FILE" >/dev/null
[ -s "$TMP/assistant.db" ] || { echo "restore-drill: restore produced no database" >&2; exit 1; }
"$NODE" "$APP/src/backup.ts" check --db "$TMP/assistant.db" --memory "$TMP/memory" --require-data

echo "restore-drill: OK — $BACKUP restored into $TMP and verified"
