#!/usr/bin/env bash
set -Eeuo pipefail

repo="$(git rev-parse --show-toplevel)"
readonly FILTERED_ROOT="0697fa72c9a565f4e68da0b3715d4a49fc28587d"
readonly AUDITED_HISTORY_TIP="a145c13270f268cbeff5f17f9ec7b346d56a4966"
readonly CLEAN_LAUNCH_ROOT="0fcfd36acc9db98cac16f1375eef30db1bd4eb73"
readonly AUDITED_HISTORY_COMMITS=166

require_commit() {
  local commit="$1"
  local label="$2"
  if ! git -C "$repo" cat-file -e "${commit}^{commit}" 2>/dev/null; then
    echo "public history contract: missing $label commit $commit" >&2
    exit 1
  fi
}

require_ancestor() {
  local commit="$1"
  local label="$2"
  if ! git -C "$repo" merge-base --is-ancestor "$commit" HEAD; then
    echo "public history contract: $label $commit is not reachable from HEAD" >&2
    exit 1
  fi
}

require_commit "$FILTERED_ROOT" "filtered root"
require_commit "$AUDITED_HISTORY_TIP" "audited history tip"
require_commit "$CLEAN_LAUNCH_ROOT" "clean launch root"
require_ancestor "$AUDITED_HISTORY_TIP" "audited history tip"
require_ancestor "$CLEAN_LAUNCH_ROOT" "clean launch root"

filtered_roots="$(git -C "$repo" rev-list --max-parents=0 "$AUDITED_HISTORY_TIP")"
if [ "$filtered_roots" != "$FILTERED_ROOT" ]; then
  echo "public history contract: audited lineage has an unexpected root" >&2
  exit 1
fi

audited_count="$(git -C "$repo" rev-list --count "$AUDITED_HISTORY_TIP")"
if [ "$audited_count" -ne "$AUDITED_HISTORY_COMMITS" ]; then
  echo "public history contract: audited lineage contains $audited_count commits, expected $AUDITED_HISTORY_COMMITS" >&2
  exit 1
fi

echo "Public history contract: PASS ($audited_count audited commits plus clean launch history)"
