#!/usr/bin/env bash
# Export the allowlisted assistant memory tree into the backup account's fixed repository.
# This deliberately does not read or execute anything from the source repository.
set -euo pipefail

SOURCE_DIR="${BACKUP_SOURCE_DIR:-/home/crow-agent/assistant}"
EXPORT_DIR="${BACKUP_EXPORT_DIR:-/var/lib/crowstance-backup/export}"
HOOKS_DIR="${BACKUP_HOOKS_DIR:-/var/empty/crowstance-backup-hooks}"

[[ -d "$SOURCE_DIR/memory" ]] || { echo "missing allowlisted memory source: $SOURCE_DIR/memory" >&2; exit 1; }
install -d -m 700 "$EXPORT_DIR" "$HOOKS_DIR"
# --safe-links prevents an agent-created symlink from escaping the exported tree.
install -d -m 700 "$EXPORT_DIR/memory"
rsync -a --delete --safe-links "$SOURCE_DIR/memory/" "$EXPORT_DIR/memory/"

if [[ ! -d "$EXPORT_DIR/.git" ]]; then
  GIT_CONFIG_NOSYSTEM=1 HOME=/var/lib/crowstance-backup \
    git -c core.hooksPath="$HOOKS_DIR" -c init.defaultBranch=main -C "$EXPORT_DIR" init -q
fi
GIT_CONFIG_NOSYSTEM=1 HOME=/var/lib/crowstance-backup \
  git -c core.hooksPath="$HOOKS_DIR" -c safe.directory="$EXPORT_DIR" -C "$EXPORT_DIR" add --all
if ! GIT_CONFIG_NOSYSTEM=1 HOME=/var/lib/crowstance-backup \
  git -c core.hooksPath="$HOOKS_DIR" -c safe.directory="$EXPORT_DIR" -C "$EXPORT_DIR" diff --cached --quiet; then
  GIT_CONFIG_NOSYSTEM=1 HOME=/var/lib/crowstance-backup \
    git -c core.hooksPath="$HOOKS_DIR" -c safe.directory="$EXPORT_DIR" \
      -c user.name=crowstance-backup -c user.email=backup@localhost \
      -C "$EXPORT_DIR" commit -q -m "memory $(date -I)"
fi
