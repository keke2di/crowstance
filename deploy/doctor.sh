#!/usr/bin/env bash
# Run the setup checks on the server:  sudo /opt/crowstance/app/deploy/doctor.sh [--write]
set -euo pipefail
APP="${CROW_APP:-/opt/crowstance/app}"
ETC="${CROW_ETC:-/etc/crowstance}"
NODE="${CROW_NODE:-/opt/crowstance/node}/bin/node"

fail=0
check_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; fail=1; }; }
check_cmd systemctl
check_cmd rsync
check_cmd git

# --- release layout: detect a broken, mixed or interrupted deployment ---------------------------
if [ -L "$APP" ]; then
  if [ ! -e "$APP" ]; then
    echo "release: $APP is a broken symlink" >&2
    fail=1
  elif [ -f "$APP/deploy/release.sh" ]; then
    # shellcheck source=/dev/null
    . "$APP/deploy/release.sh"
    current="$(release_current_id)"
    good="$(release_known_good)"
    echo "release: active=${current:-unknown} known-good=${good:-none}"
    if release_has_pending; then
      echo "release: an update was interrupted (pending marker present); run deploy/update.sh to recover" >&2
      fail=1
    fi
    if [ -n "$good" ] && [ "$current" != "$good" ]; then
      echo "release: MIXED STATE — active release $current is not the last known-good $good" >&2
      fail=1
    fi
    if [ -n "$good" ] && [ ! -d "$(release_path "$good")" ]; then
      echo "release: known-good release $good is missing" >&2
      fail=1
    fi
  fi
else
  echo "release: $APP is not a symlink (legacy in-place tree, not atomic)" >&2
  fail=1
fi

for path in "$APP/deploy/release.sh" "$APP/deploy/health-check.sh" "$APP/deploy/netguard.sh" "$APP/deploy/backup.sh" \
  "$APP/deploy/state-backup.sh" "$APP/deploy/restore-drill.sh" \
  "$APP/deploy/install-units.sh" "$APP/deploy/setup.sh" "$APP/deploy/update.sh" "$APP/deploy/doctor.sh"; do
  [ -f "$path" ] || { echo "missing deployment artifact: $path" >&2; fail=1; continue; }
  stat -c '%U:%G %a %n' "$path"
  [ "$(stat -c '%u:%g' "$path")" = "0:0" ] || { echo "not root-owned: $path" >&2; fail=1; }
  case "$(stat -c '%a' "$path")" in 644|755) ;; *) echo "unsafe mode: $path" >&2; fail=1 ;; esac
done
for path in "$APP/opencode" "$APP/home"; do
  [ -d "$path" ] || { echo "missing deployment directory: $path" >&2; fail=1; continue; }
  find "$path" ! -user root -o ! -group root -print -quit | grep -q . && { echo "non-root artifact under: $path" >&2; fail=1; }
done
for unit in crowstance-opencode.service crowstance-netguard.service crowstance-backup.service crowstance-state-backup.service; do
  unit_path="${CROW_SYSTEMD_DIR:-/etc/systemd/system}/$unit"
  [ -f "$unit_path" ] || { echo "missing unit: $unit_path" >&2; fail=1; }
done

# --- operator secrets/config overlays must survive releases and stay private --------------------
for f in "$ETC/gateway.env" "$ETC/opencode.env"; do
  if [ -f "$f" ]; then
    [ "$(stat -c '%u:%g' "$f")" = "0:0" ] || { echo "unsafe: $f is not root-owned" >&2; fail=1; }
    case "$(stat -c '%a' "$f")" in 600|640) ;; *) echo "unsafe mode: $f" >&2; fail=1 ;; esac
  fi
done
# The state-backup passphrase must be root-only.
if [ -f "$ETC/backup.key" ]; then
  [ "$(stat -c '%u:%g' "$ETC/backup.key")" = "0:0" ] || { echo "unsafe: $ETC/backup.key is not root-owned" >&2; fail=1; }
  case "$(stat -c '%a' "$ETC/backup.key")" in 600|640) ;; *) echo "unsafe mode: $ETC/backup.key" >&2; fail=1 ;; esac
else
  echo "missing state-backup passphrase: $ETC/backup.key (run setup.sh)" >&2
  fail=1
fi

[ "$fail" -eq 0 ] || exit 1
if [ ! -x "$NODE" ]; then echo "missing dependency: $NODE" >&2; exit 1; fi

set -a
# shellcheck disable=SC1091
. "$ETC/gateway.env"
set +a
cd "$APP" # same working directory as the gateway unit, so relative paths resolve the same way
exec "$NODE" src/doctor.ts "$@"
