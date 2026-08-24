#!/usr/bin/env bash
set -Eeuo pipefail
DEPLOY_ID="${1:?usage: e2e-telegram-probe.sh <deploy-id>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Bots cannot create a valid inbound update by messaging themselves. This
# probe uses a dedicated Telegram user session for the sender side.
exec python3 "$HERE/e2e-telegram-probe.py" "$DEPLOY_ID"
