#!/usr/bin/env bash
# Approve authenticated OpenClaw device requests that already crossed the
# private Tailscale boundary and supplied the gateway token.
set -u

container="${AIDEPLOY_OPENCLAW_CONTAINER:-aideploy-openclaw}"

approve_pending() {
  local devices_json request_ids request_id pending_count approved_count failed_count
  if ! devices_json="$(docker exec "$container" node /app/openclaw.mjs devices list --json 2>/dev/null)"; then
    echo "[aideploy-autopair] Device list is temporarily unavailable; retrying." >&2
    return 0
  fi
  if ! request_ids="$(
    jq -r '
      (.pending // [])
      | map(select(type == "object" and (.requestId | type == "string") and (.requestId | length > 0)))
      | sort_by(.ts // 0)
      | reverse
      | .[].requestId
    ' <<<"$devices_json" 2>/dev/null
  )"; then
    echo "[aideploy-autopair] Device list returned invalid JSON; retrying." >&2
    return 0
  fi
  pending_count=0
  approved_count=0
  failed_count=0
  while IFS= read -r request_id; do
    [ -n "$request_id" ] || continue
    pending_count=$((pending_count + 1))
    if docker exec "$container" node /app/openclaw.mjs devices approve "$request_id" >/dev/null 2>&1; then
      approved_count=$((approved_count + 1))
    else
      failed_count=$((failed_count + 1))
    fi
  done <<<"$request_ids"
  if [ "$pending_count" -gt 0 ]; then
    echo "[aideploy-autopair] Processed $pending_count pending device request(s): $approved_count approved, $failed_count retrying." >&2
  fi
}

while true; do
  approve_pending
  [ "${AIDEPLOY_AUTOPAIR_ONCE:-0}" = "1" ] && exit 0
  sleep 2
done
