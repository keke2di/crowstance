#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --env-file-if-exists=.env scripts/dev-smoke.ts
