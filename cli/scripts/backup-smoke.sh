#!/usr/bin/env bash
set -Eeuo pipefail

CLI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$CLI_ROOT/.." && pwd)"
if [ -f "$REPO_ROOT/public-root/stack/runtime/backup.sh" ]; then
  BACKUP_SCRIPT="$REPO_ROOT/public-root/stack/runtime/backup.sh"
else
  BACKUP_SCRIPT="$REPO_ROOT/stack/runtime/backup.sh"
fi

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aideploy-backup-smoke.XXXXXX")"
cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

assert_archive_contains() {
  local archive="$1"
  shift
  local listing
  listing="$(tar -tzf "$archive")"
  local expected
  for expected in "$@"; do
    grep -Fq "$expected" <<<"$listing" || {
      echo "Backup archive is missing $expected" >&2
      return 1
    }
  done
}

mkdir -p \
  "$TEST_ROOT/openclaw-root/var/lib/aideploy/openclaw" \
  "$TEST_ROOT/openclaw-root/var/lib/aideploy/workspace" \
  "$TEST_ROOT/openclaw-archives"
printf 'state\n' >"$TEST_ROOT/openclaw-root/var/lib/aideploy/openclaw/openclaw.json"
printf 'work\n' >"$TEST_ROOT/openclaw-root/var/lib/aideploy/workspace/README.md"
openclaw_archive="$(
  AIDEPLOY_BACKUP_FILESYSTEM_ROOT="$TEST_ROOT/openclaw-root" \
  AIDEPLOY_BACKUP_ROOT="$TEST_ROOT/openclaw-archives" \
    "$BACKUP_SCRIPT"
)"
assert_archive_contains "$openclaw_archive" \
  var/lib/aideploy/openclaw/openclaw.json \
  var/lib/aideploy/workspace/README.md

mkdir -p \
  "$TEST_ROOT/hermes-root/var/lib/aideploy/hermes-open-webui" \
  "$TEST_ROOT/hermes-root/home/aideploy/.hermes" \
  "$TEST_ROOT/hermes-root/home/aideploy/workspace" \
  "$TEST_ROOT/hermes-archives"
printf 'ui\n' >"$TEST_ROOT/hermes-root/var/lib/aideploy/hermes-open-webui/webui.db"
printf 'env\n' >"$TEST_ROOT/hermes-root/home/aideploy/.hermes/.env"
printf 'work\n' >"$TEST_ROOT/hermes-root/home/aideploy/workspace/README.md"
hermes_archive="$(
  AIDEPLOY_BACKUP_FILESYSTEM_ROOT="$TEST_ROOT/hermes-root" \
  AIDEPLOY_BACKUP_ROOT="$TEST_ROOT/hermes-archives" \
    "$BACKUP_SCRIPT"
)"
assert_archive_contains "$hermes_archive" \
  var/lib/aideploy/hermes-open-webui/webui.db \
  home/aideploy/.hermes/.env \
  home/aideploy/workspace/README.md

mkdir -p "$TEST_ROOT/incomplete-root/var/lib/aideploy/openclaw" "$TEST_ROOT/incomplete-archives"
if AIDEPLOY_BACKUP_FILESYSTEM_ROOT="$TEST_ROOT/incomplete-root" \
   AIDEPLOY_BACKUP_ROOT="$TEST_ROOT/incomplete-archives" \
   "$BACKUP_SCRIPT" >/dev/null 2>&1; then
  echo "Incomplete OpenClaw backup unexpectedly succeeded" >&2
  exit 1
fi
test -z "$(find "$TEST_ROOT/incomplete-archives" -type f -name 'runtime-*.tar.gz' -print -quit)"

echo "OpenClaw and Hermes backup archives: PASS"
