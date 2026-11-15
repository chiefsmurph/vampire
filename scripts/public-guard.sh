#!/usr/bin/env bash
# Pre-push / CI guard for the PUBLIC repo. Usage: scripts/public-guard.sh   (install the hook: scripts/install-hooks.sh)
set -euo pipefail
exec node "$(dirname "$0")/guard.mjs" "$@"
