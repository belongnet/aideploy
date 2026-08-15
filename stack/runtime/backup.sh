#!/usr/bin/env bash
set -Eeuo pipefail

umask 077
BACKUP_ROOT="${AIDEPLOY_BACKUP_ROOT:-/var/backups/aideploy}"
FILESYSTEM_ROOT="${AIDEPLOY_BACKUP_FILESYSTEM_ROOT:-/}"
install -d -m 700 "$BACKUP_ROOT"

archive="$BACKUP_ROOT/runtime-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"
partial="$(mktemp "$BACKUP_ROOT/.runtime-backup.XXXXXX")"
cleanup() {
  rm -f "$partial"
}
trap cleanup EXIT

# Paths are relative to FILESYSTEM_ROOT so archives restore cleanly with
# `tar -C /`. Include only paths that exist for the selected runtime, while
# requiring at least one runtime state directory and its real workspace.
paths=()
for path in \
  var/lib/aideploy/openclaw \
  var/lib/aideploy/hermes-open-webui \
  var/lib/aideploy/workspace \
  home/aideploy/.hermes \
  home/aideploy/workspace; do
  if [ -e "$FILESYSTEM_ROOT/$path" ]; then
    paths+=("$path")
  fi
done

if [ "${#paths[@]}" -eq 0 ]; then
  echo "[aideploy] No runtime data exists to back up" >&2
  exit 1
fi
if [ -e "$FILESYSTEM_ROOT/var/lib/aideploy/openclaw" ] && \
   [ ! -e "$FILESYSTEM_ROOT/var/lib/aideploy/workspace" ]; then
  echo "[aideploy] OpenClaw workspace is missing; refusing an incomplete backup" >&2
  exit 1
fi
if [ -e "$FILESYSTEM_ROOT/home/aideploy/.hermes" ] && \
   [ ! -e "$FILESYSTEM_ROOT/home/aideploy/workspace" ]; then
  echo "[aideploy] Hermes workspace is missing; refusing an incomplete backup" >&2
  exit 1
fi

tar -C "$FILESYSTEM_ROOT" -czf "$partial" --exclude='*.log' -- "${paths[@]}"
if [ ! -s "$partial" ]; then
  echo "[aideploy] Backup archive is empty" >&2
  exit 1
fi
chmod 600 "$partial"
mv "$partial" "$archive"
trap - EXIT

find "$BACKUP_ROOT" -type f -name 'runtime-*.tar.gz' -mtime +14 -delete
printf '%s\n' "$archive"
