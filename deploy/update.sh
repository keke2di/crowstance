#!/usr/bin/env bash
# Server side of deploy.sh: install a release atomically, health-gate it and
# roll back automatically if it does not come up.
#
#   update.sh --id <release-id> --archive <file> --manifest <file.sha256> [--restart-opencode]
#   update.sh --id <release-id> --upload <staged dir>                    [--restart-opencode]
#
# The active tree is only ever changed by atomically replacing the release
# symlink. A build, checksum or dependency failure happens entirely off to the
# side and leaves the current release untouched.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=release.sh
. "$SRC_DIR/release.sh"

usage() {
  cat >&2 <<'EOF'
usage: update.sh --id <release-id> (--archive <file> --manifest <file.sha256> | --upload <dir>) [--restart-opencode]
EOF
  exit 2
}

ID=""
UPLOAD=""
ARCHIVE=""
MANIFEST=""
RESTART_OC=0
while [ $# -gt 0 ]; do
  case "$1" in
    --id) ID="${2:?}"; shift 2 ;;
    --upload) UPLOAD="${2:?}"; shift 2 ;;
    --archive) ARCHIVE="${2:?}"; shift 2 ;;
    --manifest) MANIFEST="${2:?}"; shift 2 ;;
    --restart-opencode) RESTART_OC=1; shift ;;
    -h|--help) usage ;;
    --) shift; if [ $# -gt 0 ]; then UPLOAD="$1"; fi; break ;;
    -*)
      # Backwards-compatible positional form: update.sh <uploaded dir> [--restart-opencode]
      if [ -z "$UPLOAD" ] && [ -d "$1" ]; then UPLOAD="$1"; shift; else usage; fi
      ;;
    *) if [ -z "$UPLOAD" ] && [ -d "$1" ]; then UPLOAD="$1"; shift; else usage; fi ;;
  esac
done

ETC="${CROW_ETC:-/etc/crowstance}"
SYSTEMD_DIR="${CROW_SYSTEMD_DIR:-/etc/systemd/system}"
export PATH="${CROW_BIN:-/opt/crowstance/bin}:${CROW_NODE:-/opt/crowstance/node}/bin:$PATH"

ID="${ID:-$(date -u +%Y%m%d%H%M%S)}"
if [ -z "$ARCHIVE" ] && [ -z "$UPLOAD" ]; then usage; fi
if [ -n "$ARCHIVE" ] && [ -z "$MANIFEST" ]; then usage; fi

RELEASES="$(crow_releases)"
STAGING="$(crow_staging)"
mkdir -p "$RELEASES" "$STAGING" "$(crow_state)"

# A previously interrupted update must be made consistent before we start.
release_recover

# --- 1. obtain a verified staging tree -----------------------------------------------------------
if [ -n "$ARCHIVE" ]; then
  release_verify "$ARCHIVE" "$MANIFEST"          # reject bad/missing checksum first
  UPLOAD="$STAGING/$ID"
  rm -rf "$UPLOAD"
  mkdir -p "$UPLOAD"
  tar -xzf "$ARCHIVE" -C "$UPLOAD"
fi
[ -d "$UPLOAD" ] || die "staged upload not found: $UPLOAD"

# --- 2. build the new release off to the side (live tree untouched) ------------------------------
NEW_DIR="$(release_path "$ID")"
SWITCHED=0
# Remove a half-built release on any early exit, but never touch the live tree
# and never delete a release we already switched to (rollback keeps it).
trap 'if [ "${SWITCHED:-0}" != 1 ]; then rm -rf "$NEW_DIR"; fi' EXIT
release_build "$UPLOAD" "$ID"
release_preserve_overlays "$ID"
release_install_deps "$ID"

# --- 3. refuse to create a mixed tree when OpenCode config/prompts changed -----------------------
PREV="$(release_current_id)"
OC_CHANGED=0
if [ -n "$PREV" ] && [ -d "$(release_path "$PREV")/opencode" ] && [ -d "$NEW_DIR/opencode" ]; then
  if ! diff -rq "$(release_path "$PREV")/opencode" "$NEW_DIR/opencode" >/dev/null 2>&1; then OC_CHANGED=1; fi
fi
if [ "$OC_CHANGED" = 1 ] && [ "$RESTART_OC" != 1 ]; then
  echo "update: OpenCode config/prompts changed; re-run with --restart-opencode (nothing was switched)" >&2
  rm -rf "$NEW_DIR"
  exit 1
fi

# --- 4. render units from the new release (still off to the side) --------------------------------
if [ -x "$NEW_DIR/deploy/install-units.sh" ]; then
  env CROW_APP="$NEW_DIR" CROW_ETC="$ETC" CROW_SYSTEMD_DIR="$SYSTEMD_DIR" "$NEW_DIR/deploy/install-units.sh"
fi

# --- 5. record the rollback target, then flip the atomic pointer ---------------------------------
release_pending_write "$ID" "$PREV"
release_activate "$ID"
SWITCHED=1

# --- 6. restart, then require real readiness -----------------------------------------------------
restart_services() {
  if [ "$OC_CHANGED" = 1 ]; then
    systemctl restart crowstance-opencode
    sleep "${CROW_OC_SETTLE:-3}"
  fi
  systemctl restart crowstance-gateway
}

rollback() {
  local reason="$1" prev
  echo "update: $reason; rolling back" >&2
  prev="$(release_pending_field previous)"
  if [ -n "$prev" ] && [ -d "$(release_path "$prev")" ]; then
    release_activate "$prev"
    release_render_units
    if [ "$OC_CHANGED" = 1 ]; then systemctl restart crowstance-opencode >/dev/null 2>&1 || true; fi
    systemctl restart crowstance-gateway >/dev/null 2>&1 || true
    if release_wait_healthy; then
      echo "update: rolled back to $prev (the failed release $ID was kept for inspection)" >&2
    else
      echo "update: WARNING previous release $prev also failed its health check" >&2
    fi
  else
    echo "update: no previous release available to roll back to" >&2
  fi
  release_pending_clear
}

if ! restart_services; then
  rollback "service restart failed"
  exit 1
fi
if ! release_wait_healthy; then
  rollback "health gate failed"
  exit 1
fi

release_mark_good "$ID"
release_pending_clear
rm -rf "$UPLOAD"
if [ -n "$ARCHIVE" ]; then rm -f "$ARCHIVE" "$MANIFEST"; fi
release_prune
echo "update: release $ID is active and healthy"
