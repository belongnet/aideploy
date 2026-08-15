#!/usr/bin/env bash
# Vendors the CLI-owned deployment contract into the npm package. The old
# legacy repository-level modules remain reference code; the public
# terraform/self-host-digitalocean + stack/runtime trees are the live source.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
if [ -d "$REPO_ROOT/stack/runtime" ] && [ -d "$REPO_ROOT/terraform/self-host-digitalocean" ]; then
  SOURCE_ROOT="$REPO_ROOT"
elif [ -d "$REPO_ROOT/public-root/stack/runtime" ] && [ -d "$REPO_ROOT/public-root/terraform/self-host-digitalocean" ]; then
  # Private split-staging layout. The assembled public repo uses the branch above.
  SOURCE_ROOT="$REPO_ROOT/public-root"
else
  echo "Could not find the public self-host runtime sources" >&2
  exit 1
fi
rm -rf "$HERE/assets/terraform" "$HERE/assets/stack"
mkdir -p "$HERE/assets/terraform" "$HERE/assets/stack"
cp -R "$SOURCE_ROOT/terraform/self-host-digitalocean" "$HERE/assets/terraform/digitalocean"
cp -R "$SOURCE_ROOT/stack/runtime" "$HERE/assets/stack/runtime"

test -f "$HERE/assets/terraform/digitalocean/main.tf"
test -x "$HERE/assets/stack/runtime/bootstrap.sh"
test -f "$HERE/assets/stack/runtime/openclaw/docker-compose.yml"
test -f "$HERE/assets/stack/runtime/hermes/manifest.json"
echo "Vendored: $(find "$HERE/assets" -type f | wc -l | tr -d ' ') files"
