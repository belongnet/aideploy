#!/usr/bin/env bash
set -Eeuo pipefail

repo="$(git rev-parse --show-toplevel)"
readonly CLEAN_LINEAGE_TIP="555d7d37784dd4e839026aa0611949be526544c5"
readonly FILTERED_ROOT="0697fa72c9a565f4e68da0b3715d4a49fc28587d"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/aideploy-history-contract.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT

# Recreate the public graph GitHub showed before the restoration. Fetching the
# immutable beta.5 tip transfers only its six-commit clean-launch ancestry.
git -C "$tmp" init -q
git -C "$tmp" fetch -q --no-tags "file://$repo" "$CLEAN_LINEAGE_TIP"
git -C "$tmp" checkout -q --detach FETCH_HEAD

set +e
failure="$(cd "$tmp" && "$repo/scripts/verify-public-history.sh" 2>&1)"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "public history contract fixture: ancestry-free graph unexpectedly passed" >&2
  exit 1
fi
expected="public history contract: missing filtered root commit $FILTERED_ROOT"
if [ "$failure" != "$expected" ]; then
  printf 'public history contract fixture: unexpected failure:\n%s\n' "$failure" >&2
  exit 1
fi

"$repo/scripts/verify-public-history.sh"
echo "Public history contract regression: PASS (dropped ancestry fails closed)"
