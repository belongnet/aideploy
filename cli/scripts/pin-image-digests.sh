#!/usr/bin/env bash
# Rewrites the vendored OpenClaw wrapper reference to the exact digest produced
# by this release. vendor-assets.sh MUST run first so the source template is
# never mistaken for a publishable package asset.
set -euo pipefail
DIGESTS="${1:?usage: pin-image-digests.sh <digests-dir>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$HERE/assets/stack/runtime/openclaw/docker-compose.yml"
[ -f "$COMPOSE" ] || { echo "run vendor-assets.sh first ($COMPOSE missing)" >&2; exit 1; }
OWNER="${GITHUB_REPOSITORY_OWNER:?GITHUB_REPOSITORY_OWNER required}"
DIGEST_FILE="$DIGESTS/openclaw-runtime"
[ -f "$DIGEST_FILE" ] || { echo "missing release digest: $DIGEST_FILE" >&2; exit 1; }
digest=$(tr -d '[:space:]' <"$DIGEST_FILE")
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "invalid OpenClaw release digest" >&2; exit 1; }

tmp="$(mktemp "${TMPDIR:-/tmp}/aideploy-compose.XXXXXX")"
sed -E \
  "s|ghcr\.io/AIDEPLOY_OWNER/aideploy-openclaw-runtime:RELEASE_TAG|ghcr.io/$OWNER/aideploy-openclaw-runtime@$digest|g" \
  "$COMPOSE" >"$tmp"
mv "$tmp" "$COMPOSE"

if grep -Eq '^[[:space:]]*image:.*(AIDEPLOY_OWNER|RELEASE_TAG)' "$COMPOSE" || ! grep -Fq "@$digest" "$COMPOSE"; then
  echo "failed to pin the vendored OpenClaw image" >&2
  exit 1
fi
echo "pinned openclaw-runtime -> ${digest:0:19}…"
