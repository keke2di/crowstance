#!/usr/bin/env bash
# Alert the user through the assistant gateway. The assistant decides how to phrase it.
# Usage: notify.sh "what happened" [--urgent] [--source name]
set -euo pipefail

ENV_FILE="${HQ_NOTIFY_ENV:-$HOME/.config/crowstance/notify.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
: "${HQ_NOTIFY_URL:=http://127.0.0.1:7801/notify}"
: "${HQ_NOTIFY_TOKEN:?HQ_NOTIFY_TOKEN is not set (expected in $ENV_FILE)}"

text="${1:?usage: notify.sh \"message\" [--urgent] [--source name]}"
shift
urgent=false
source=""
while [ $# -gt 0 ]; do
  case "$1" in
    --urgent) urgent=true ;;
    --source) source="${2:-}"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

body=$(jq -n --arg text "$text" --arg source "$source" --argjson urgent "$urgent" \
  '{text: $text, urgent: $urgent} + (if $source == "" then {} else {source: $source} end)')
curl -fsS -m 10 -X POST "$HQ_NOTIFY_URL" \
  -H "Authorization: Bearer $HQ_NOTIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$body" >/dev/null
