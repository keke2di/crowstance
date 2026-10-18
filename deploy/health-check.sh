#!/usr/bin/env bash
# Real readiness check for the crowstance services.
#
#   health-check.sh                 gateway readiness + OpenCode + systemd units
#   health-check.sh --gateway-only  just the gateway HTTP readiness endpoint
#   health-check.sh --opencode-only just the OpenCode HTTP health endpoint
#   ... add --wait to retry until CROW_HEALTH_TIMEOUT (default 30s) expires
#
# This deliberately checks the services' own readiness endpoints rather than
# merely asking systemd whether a process started. The gateway's /ready endpoint
# reports dependency state; /health is liveness only. Used by update.sh's health
# gate, by the OpenCode unit's ExecStartPost, and by release recovery.
set -euo pipefail

MODE=all
WAIT=0
for arg in "$@"; do
  case "$arg" in
    --gateway-only) MODE=gateway ;;
    --opencode-only) MODE=opencode ;;
    --wait) WAIT=1 ;;
    *) echo "usage: health-check.sh [--gateway-only|--opencode-only] [--wait]" >&2; exit 2 ;;
  esac
done

ETC="${CROW_ETC:-/etc/crowstance}"
CURL="${CROW_CURL:-curl}"
TIMEOUT="${CROW_HTTP_TIMEOUT:-5}"
SKIP_SYSTEMD="${CROW_SKIP_SYSTEMD:-0}"

# Read a value out of an env file without exporting anything else.
env_value() { # file key — empty when the file is missing or not readable by this user
  [ -r "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n1 || true
}

if [ -z "${HQ_PORT:-}" ]; then HQ_PORT="$(env_value "$ETC/gateway.env" HQ_PORT)"; fi
if [ -z "${OPENCODE_URL:-}" ] && [ -z "${OPENCODE_PORT:-}" ]; then
  OPENCODE_PORT="$(env_value "$ETC/opencode.env" OPENCODE_PORT)"
fi
OPENCODE_URL="${OPENCODE_URL:-http://127.0.0.1:${OPENCODE_PORT:-4096}}"
# OpenCode protects every endpoint, /api/info included, with its server password. As the unit's
# ExecStartPost (crow-agent) it comes from the unit environment; as root it is read from the env file.
OC_USER="${OPENCODE_SERVER_USERNAME:-$(env_value "$ETC/opencode.env" OPENCODE_SERVER_USERNAME)}"
OC_USER="${OC_USER:-opencode}"
OC_PASS="${OPENCODE_SERVER_PASSWORD:-$(env_value "$ETC/opencode.env" OPENCODE_SERVER_PASSWORD)}"

fail() { echo "health: $*" >&2; exit 1; }

gateway_ready() {
  [ -n "$HQ_PORT" ] || { echo "health: HQ_PORT is not configured" >&2; return 1; }
  "$CURL" -fsS --max-time "$TIMEOUT" "http://127.0.0.1:${HQ_PORT}/ready" | grep -q '"ok":true'
}

opencode_ready() {
  if [ -n "$OC_PASS" ]; then
    # Credentials go in on stdin (curl --config -), never on the command line where `ps` would show them.
    printf 'user = "%s:%s"\n' "$OC_USER" "$OC_PASS" \
      | "$CURL" -fsS --max-time "$TIMEOUT" --config - "${OPENCODE_URL%/}/api/info" >/dev/null
  else
    "$CURL" -fsS --max-time "$TIMEOUT" "${OPENCODE_URL%/}/api/info" >/dev/null
  fi
}

unit_active() { # unit name
  [ "$SKIP_SYSTEMD" = 1 ] && return 0
  systemctl is-active --quiet "$1"
}

run_check() { # label command...
  local label="$1"; shift
  if [ "$WAIT" != 1 ]; then
    "$@" || fail "$label"
    return 0
  fi
  local deadline=$(( $(date +%s) + ${CROW_HEALTH_TIMEOUT:-30} ))
  while :; do
    if "$@"; then return 0; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then fail "$label"; fi
    sleep 1
  done
}

case "$MODE" in
  gateway) run_check "gateway readiness endpoint http://127.0.0.1:${HQ_PORT}/ready is not ready" gateway_ready ;;
  opencode) run_check "OpenCode health endpoint ${OPENCODE_URL%/}/api/info is not ready" opencode_ready ;;
  all)
    run_check "unit crowstance-opencode.service is not active" unit_active crowstance-opencode.service
    run_check "unit crowstance-gateway.service is not active" unit_active crowstance-gateway.service
    run_check "OpenCode health endpoint ${OPENCODE_URL%/}/api/info is not ready" opencode_ready
    run_check "gateway readiness endpoint http://127.0.0.1:${HQ_PORT}/ready is not ready" gateway_ready
    ;;
esac

echo "health: $MODE ready"
