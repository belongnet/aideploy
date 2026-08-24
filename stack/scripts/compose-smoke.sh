#!/usr/bin/env bash
# Backward-compatible entry point. The live self-host assets moved under the
# CLI because the repository-level Python compose stack is reference-only.
set -Eeuo pipefail

RUNTIME="${1:?usage: compose-smoke.sh <openclaw|hermes>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -x "$REPO_ROOT/cli/scripts/runtime-smoke.sh" ]; then
  exec "$REPO_ROOT/cli/scripts/runtime-smoke.sh" "$RUNTIME"
fi
if [ -x "$REPO_ROOT/oss/cli/scripts/runtime-smoke.sh" ]; then
  exec "$REPO_ROOT/oss/cli/scripts/runtime-smoke.sh" "$RUNTIME"
fi

echo "Could not find cli/scripts/runtime-smoke.sh; assemble or clone the public repository first." >&2
exit 2
