#!/usr/bin/env bash
# Render the systemd units from deploy/systemd/ with the limits saved in /etc/crowstance/setup.env
# and install them. Called by setup.sh and update.sh (as root).
set -euo pipefail
APP="${CROW_APP:-/opt/crowstance/app}"
ETC="${CROW_ETC:-/etc/crowstance}"
SYSTEMD_DIR="${CROW_SYSTEMD_DIR:-/etc/systemd/system}"
SETUP_ENV="$ETC/setup.env"
[ -f "$SETUP_ENV" ] || { echo "missing $SETUP_ENV — run setup.sh first"; exit 1; }
# shellcheck disable=SC1090
. "$SETUP_ENV"

for tpl in "$APP"/deploy/systemd/*; do
  sed -e "s#@CPU_WEIGHT@#$CPU_WEIGHT#" -e "s#@CPU_QUOTA@#$CPU_QUOTA#" \
      -e "s#@MEMORY_MAX@#$MEMORY_MAX#" -e "s#@SWAP_MAX@#$SWAP_MAX#" \
      -e "s#@IO_WEIGHT@#$IO_WEIGHT#" -e "s#@TASKS_MAX@#$TASKS_MAX#" -e "s#@NICE@#$NICE#" \
      "$tpl" > "$SYSTEMD_DIR/$(basename "$tpl")"
  chown root:root "$SYSTEMD_DIR/$(basename "$tpl")"
  chmod 644 "$SYSTEMD_DIR/$(basename "$tpl")"
done

# Extra paths the agent must not see at all (shared servers): the other project's code, data, secrets.
dropin="$SYSTEMD_DIR/crowstance-opencode.service.d"
mkdir -p "$dropin"
chown root:root "$dropin"
chmod 755 "$dropin"
if [ -n "${CROW_HIDE_PATHS:-}" ]; then
  { echo "[Service]"; for p in $CROW_HIDE_PATHS; do echo "InaccessiblePaths=-$p"; done; } > "$dropin/hide.conf"
  chown root:root "$dropin/hide.conf"; chmod 644 "$dropin/hide.conf"
else
  rm -f "$dropin/hide.conf"
fi

systemctl daemon-reload
systemctl enable crowstance-opencode.service crowstance-gateway.service crowstance-backup.timer crowstance-state-backup.timer >/dev/null 2>&1

if [ "${SHARED:-0}" = 1 ]; then
  "$APP/deploy/netguard.sh" apply
  # Older units parked the fence as "active (exited)", which its timer can never start again. Clear
  # that once, ignoring dependencies so OpenCode (which Requires= the fence) is not stopped with it.
  if [ "$(systemctl show -p SubState --value crowstance-netguard.service 2>/dev/null)" = exited ] \
    && ! grep -q '^RemainAfterExit=yes' "$SYSTEMD_DIR/crowstance-netguard.service"; then
    systemctl stop --job-mode=ignore-dependencies crowstance-netguard.service
    systemctl restart crowstance-netguard.timer
  fi
  systemctl enable --now crowstance-netguard.timer >/dev/null 2>&1
else
  systemctl disable --now crowstance-netguard.timer >/dev/null 2>&1 || true
  "$APP/deploy/netguard.sh" remove
fi
