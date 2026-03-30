#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${AIDEPLOY_SUPABASE_ENV_FILE:-/etc/aideploy/supabase.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

TARGET_URL="${SUPABASE_BACKUP_TARGET_URL:-${SUPABASE_URL:-${SUPABASE_PUBLIC_URL:-http://127.0.0.1:8000}}}"
SERVICE_ROLE_KEY="${SUPABASE_BACKUP_SERVICE_ROLE_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-}}"
BUCKET="${SUPABASE_BACKUP_BUCKET:-aideploy-runtime-backups}"
PREFIX="${SUPABASE_BACKUP_PREFIX:-${DEPLOY_ID:-local-dev}}"
INCLUDE_STORAGE="${SUPABASE_BACKUP_INCLUDE_STORAGE:-auto}"
LOCAL_URL="${SUPABASE_URL:-http://127.0.0.1:8000}"
LOCAL_PUBLIC_URL="${SUPABASE_PUBLIC_URL:-}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_ROOT="${PREFIX}/${TIMESTAMP}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "[aideploy] POSTGRES_PASSWORD is required for backups" >&2
  exit 1
fi

if [ -z "$SERVICE_ROLE_KEY" ]; then
  echo "[aideploy] SUPABASE_SERVICE_ROLE_KEY or SUPABASE_BACKUP_SERVICE_ROLE_KEY is required" >&2
  exit 1
fi

if [ "$INCLUDE_STORAGE" = "auto" ]; then
  if [ "$TARGET_URL" = "$LOCAL_URL" ] || { [ -n "$LOCAL_PUBLIC_URL" ] && [ "$TARGET_URL" = "$LOCAL_PUBLIC_URL" ]; }; then
    INCLUDE_STORAGE="false"
  else
    INCLUDE_STORAGE="true"
  fi
fi

auth_args=(
  -H "Authorization: Bearer $SERVICE_ROLE_KEY"
  -H "apikey: $SERVICE_ROLE_KEY"
)

create_bucket() {
  local response_file="$TMP_DIR/create-bucket-response.json"
  local status
  status="$(
    curl -sS -o "$response_file" -w '%{http_code}' \
      "${auth_args[@]}" \
      -H "Content-Type: application/json" \
      -X POST \
      "$TARGET_URL/storage/v1/bucket" \
      -d "{\"id\":\"$BUCKET\",\"name\":\"$BUCKET\",\"public\":false}"
  )"
  case "$status" in
    200|201|409)
      return 0
      ;;
  esac
  echo "[aideploy] Failed to ensure backup bucket $BUCKET (status $status)" >&2
  cat "$response_file" >&2 || true
  exit 1
}

upload_object() {
  local remote_path="$1"
  local file_path="$2"
  local content_type="$3"
  curl -fsS \
    "${auth_args[@]}" \
    -H "x-upsert: true" \
    -H "Content-Type: $content_type" \
    --data-binary "@$file_path" \
    -X POST \
    "$TARGET_URL/storage/v1/object/$BUCKET/$remote_path" >/dev/null
}

echo "[aideploy] Creating Supabase backup in bucket $BUCKET at $TARGET_URL"
create_bucket

DB_DUMP="$TMP_DIR/database.sql.gz"
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db \
  pg_dump -U postgres -d postgres --clean --if-exists --no-owner --no-privileges \
  | gzip -c > "$DB_DUMP"
upload_object "$ARCHIVE_ROOT/database.sql.gz" "$DB_DUMP" "application/gzip"

METADATA="$TMP_DIR/metadata.json"
cat > "$METADATA" <<EOF
{
  "deploy_id": "${DEPLOY_ID:-}",
  "timestamp": "$TIMESTAMP",
  "target_url": "$TARGET_URL",
  "bucket": "$BUCKET",
  "include_storage": "$INCLUDE_STORAGE",
  "hostname": "$(hostname)"
}
EOF
upload_object "$ARCHIVE_ROOT/metadata.json" "$METADATA" "application/json"

if [ "$INCLUDE_STORAGE" = "true" ]; then
  STORAGE_ROOT="$TMP_DIR/storage-root"
  STORAGE_ARCHIVE="$TMP_DIR/storage.tar.gz"
  mkdir -p "$STORAGE_ROOT"
  docker cp supabase-storage:/var/lib/storage/. "$STORAGE_ROOT/"
  tar -czf "$STORAGE_ARCHIVE" -C "$STORAGE_ROOT" .
  upload_object "$ARCHIVE_ROOT/storage.tar.gz" "$STORAGE_ARCHIVE" "application/gzip"
else
  echo "[aideploy] Skipping storage volume archive (target matches local runtime or storage disabled)"
fi

echo "[aideploy] Backup uploaded to $BUCKET/$ARCHIVE_ROOT"
