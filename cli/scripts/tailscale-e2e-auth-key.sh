#!/usr/bin/env bash
# Mint/revoke a short-lived VM auth key with a Tailscale OAuth client. The
# reusable bit permits bootstrap retries; ephemeral + explicit revocation keep
# the credential scoped to one CI run.
set -Eeuo pipefail
set +x

API_ROOT="${TAILSCALE_API_ROOT:-https://api.tailscale.com/api/v2}"

require_oauth() {
  : "${TS_OAUTH_CLIENT_ID:?TS_OAUTH_CLIENT_ID is required}"
  : "${TS_OAUTH_CLIENT_SECRET:?TS_OAUTH_CLIENT_SECRET is required}"
}

oauth_token() {
  require_oauth
  local response token
  response="$(curl -fsS --retry 3 --retry-all-errors \
    --user "$TS_OAUTH_CLIENT_ID:$TS_OAUTH_CLIENT_SECRET" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data 'grant_type=client_credentials' \
    "$API_ROOT/oauth/token")"
  token="$(jq -er '.access_token | select(type == "string" and length > 0)' <<<"$response")"
  printf '%s' "$token"
}

mint() {
  : "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required for mint}"
  local token payload response key_id auth_key
  token="$(oauth_token)"
  payload="$(jq -nc '{
    keyType:"auth",
    capabilities:{devices:{create:{reusable:true,ephemeral:true,preauthorized:true,tags:["tag:ci"]}}},
    expirySeconds:7200,
    description:"aideploy public CLI E2E"
  }')"
  response="$(curl -fsS --retry 3 --retry-all-errors \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' \
    --data "$payload" \
    "$API_ROOT/tailnet/-/keys")"
  key_id="$(jq -er '.id | select(type == "string" and length > 0)' <<<"$response")"
  auth_key="$(jq -er '.key | select(type == "string" and startswith("tskey-"))' <<<"$response")"

  # Export the cleanup handle before the credential so an interrupted caller
  # can still revoke a key that was successfully created.
  printf 'key_id=%s\n' "$key_id" >>"$GITHUB_OUTPUT"
  if [ -n "${TAILSCALE_KEY_ID_FILE:-}" ]; then
    umask 077
    mkdir -p "$(dirname "$TAILSCALE_KEY_ID_FILE")"
    printf '%s\n' "$key_id" >"$TAILSCALE_KEY_ID_FILE.tmp.$$"
    mv "$TAILSCALE_KEY_ID_FILE.tmp.$$" "$TAILSCALE_KEY_ID_FILE"
  fi
  printf '::add-mask::%s\n' "$auth_key"
  printf 'auth_key=%s\n' "$auth_key" >>"$GITHUB_OUTPUT"
}

revoke() {
  local key_id="${1:?usage: tailscale-e2e-auth-key.sh revoke <key-id>}"
  [[ "$key_id" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "invalid Tailscale key id" >&2; return 2; }
  local token
  token="$(oauth_token)"
  curl -fsS --retry 3 --retry-all-errors \
    -X DELETE \
    -H "Authorization: Bearer $token" \
    "$API_ROOT/tailnet/-/keys/$key_id" >/dev/null
}

case "${1:-}" in
  mint) mint ;;
  revoke) revoke "${2:-}" ;;
  *) echo "usage: tailscale-e2e-auth-key.sh <mint|revoke KEY_ID>" >&2; exit 2 ;;
esac
