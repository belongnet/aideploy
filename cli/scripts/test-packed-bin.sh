#!/usr/bin/env bash
set -euo pipefail

CLI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aideploy-packed-bin.XXXXXX")"
cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

cd "$CLI_ROOT"
TARBALL_NAME="$(npm pack --silent --pack-destination "$TEST_ROOT")"
mkdir -p "$TEST_ROOT/consumer"
cd "$TEST_ROOT/consumer"
npm init --yes >/dev/null 2>&1
npm install --ignore-scripts --no-audit --no-fund "$TEST_ROOT/$TARBALL_NAME" >/dev/null

HELP_OUTPUT="$(./node_modules/.bin/aideploy help)"
VERSION_OUTPUT="$(./node_modules/.bin/aideploy --version)"

grep -q '^aideploy —' <<<"$HELP_OUTPUT"
grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$' <<<"$VERSION_OUTPUT"
printf 'Packed npm bin executed successfully (%s).\n' "$VERSION_OUTPUT"
