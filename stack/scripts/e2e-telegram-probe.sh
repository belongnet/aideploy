#!/usr/bin/env bash
# e2e-telegram-probe.sh <deploy-id> — end-to-end "did the agent answer?"
# Sends a message to the deployed bot's E2E chat and polls for a reply.
# Requires: E2E_TG_TOKEN (bot token), E2E_TG_CHAT_ID (a chat the bot is in).
set -euo pipefail
DEPLOY_ID="${1:?usage: e2e-telegram-probe.sh <deploy-id>}"
: "${E2E_TG_TOKEN:?E2E_TG_TOKEN required}"
: "${E2E_TG_CHAT_ID:?E2E_TG_CHAT_ID required}"
API="https://api.telegram.org/bot${E2E_TG_TOKEN}"

ME=$(curl -fsS "$API/getMe" | jq -r '.result.username')
echo "probing bot @$ME for deploy $DEPLOY_ID"
NONCE="e2e-$DEPLOY_ID-$(date +%s)"
BASE_UPDATE=$(curl -fsS "$API/getUpdates?offset=-1" | jq -r '.result[-1].update_id // 0')
curl -fsS -X POST "$API/sendMessage" \
  -d chat_id="$E2E_TG_CHAT_ID" -d text="ping $NONCE — reply with the word pong" >/dev/null

for i in $(seq 1 24); do # up to 4 minutes
  sleep 10
  REPLY=$(curl -fsS "$API/getUpdates?offset=$((BASE_UPDATE + 1))" \
    | jq -r --arg chat "$E2E_TG_CHAT_ID" \
        '.result[] | select(.message.chat.id == ($chat|tonumber)) | .message.text // empty' \
    | tail -5)
  if printf '%s' "$REPLY" | grep -qi 'pong'; then
    echo "agent replied after ~$((i * 10))s"
    exit 0
  fi
done
echo "no agent reply within 4 minutes" >&2
exit 1
