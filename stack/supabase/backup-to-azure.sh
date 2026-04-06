#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# AiDeploy — Supabase backup to Azure Blob Storage
# Runs alongside the local Supabase Storage backup as an
# off-cluster safety net. Supports Managed Identity (Azure VMs)
# and SAS token auth (all other cloud providers).
# ──────────────────────────────────────────────────────────────
set -euo pipefail

ENV_FILE="${AIDEPLOY_SUPABASE_ENV_FILE:-/etc/aideploy/supabase.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# ── Required configuration ────────────────────────────────────
: "${AZURE_BACKUP_STORAGE_ACCOUNT:?AZURE_BACKUP_STORAGE_ACCOUNT is required}"
: "${AZURE_BACKUP_CONTAINER:?AZURE_BACKUP_CONTAINER is required}"

DEPLOY_ID="${DEPLOY_ID:-local-dev}"
INCLUDE_STORAGE="${SUPABASE_BACKUP_INCLUDE_STORAGE:-auto}"
LOCAL_URL="${SUPABASE_URL:-http://127.0.0.1:8000}"
LOCAL_PUBLIC_URL="${SUPABASE_PUBLIC_URL:-}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_ROOT="${DEPLOY_ID}/${TIMESTAMP}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "[aideploy] POSTGRES_PASSWORD is required for backups" >&2
  exit 1
fi

# ── Auth mode detection ───────────────────────────────────────
# Azure VMs expose IMDS; all other providers use a SAS token.
AZURE_AUTH_MODE="${AZURE_BACKUP_AUTH_MODE:-auto}"
if [ "$AZURE_AUTH_MODE" = "auto" ]; then
  if curl -fsS -H "Metadata: true" --connect-timeout 2 --max-time 3 \
    "http://169.254.169.254/metadata/instance?api-version=2021-02-01" >/dev/null 2>&1; then
    AZURE_AUTH_MODE="managed_identity"
  else
    AZURE_AUTH_MODE="sas_token"
  fi
fi

BLOB_BASE="https://${AZURE_BACKUP_STORAGE_ACCOUNT}.blob.core.windows.net/${AZURE_BACKUP_CONTAINER}"
SAS_SUFFIX=""

if [ "$AZURE_AUTH_MODE" = "managed_identity" ]; then
  export AZCOPY_AUTO_LOGIN_TYPE="MSI"
  if [ -n "${AZURE_BACKUP_MANAGED_IDENTITY_CLIENT_ID:-}" ]; then
    export AZCOPY_MSI_CLIENT_ID="$AZURE_BACKUP_MANAGED_IDENTITY_CLIENT_ID"
  fi
  echo "[aideploy] Azure backup using Managed Identity"
elif [ "$AZURE_AUTH_MODE" = "sas_token" ]; then
  : "${AZURE_BACKUP_SAS_TOKEN:?SAS token required for non-Azure VMs}"
  SAS_SUFFIX="?${AZURE_BACKUP_SAS_TOKEN}"
  echo "[aideploy] Azure backup using SAS token"
else
  echo "[aideploy] Unknown auth mode: $AZURE_AUTH_MODE" >&2
  exit 1
fi

# ── Storage inclusion auto-detection ──────────────────────────
if [ "$INCLUDE_STORAGE" = "auto" ]; then
  INCLUDE_STORAGE="true"
fi

# ── Upload helper ─────────────────────────────────────────────
upload_to_azure() {
  local local_path="$1"
  local remote_name="$2"
  local dest="${BLOB_BASE}/${ARCHIVE_ROOT}/${remote_name}${SAS_SUFFIX}"

  local attempt
  for attempt in 1 2 3; do
    if azcopy copy "$local_path" "$dest" --overwrite=true 2>&1; then
      return 0
    fi
    echo "[aideploy] Azure upload attempt $attempt failed for $remote_name, retrying..." >&2
    sleep 5
  done
  echo "[aideploy] ERROR: Azure upload failed for $remote_name after 3 attempts" >&2
  return 1
}

echo "[aideploy] Creating Azure backup at ${BLOB_BASE}/${ARCHIVE_ROOT}"

# ── Database dump ─────────────────────────────────────────────
DB_DUMP="$TMP_DIR/database.sql.gz"
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db \
  pg_dump -U postgres -d postgres --clean --if-exists --no-owner --no-privileges \
  | gzip -c > "$DB_DUMP"
upload_to_azure "$DB_DUMP" "database.sql.gz"

DB_DUMP_BYTES=$(stat -c%s "$DB_DUMP" 2>/dev/null || stat -f%z "$DB_DUMP" 2>/dev/null || echo 0)

# ── Metadata ──────────────────────────────────────────────────
METADATA="$TMP_DIR/metadata.json"
cat > "$METADATA" <<EOF
{
  "deploy_id": "${DEPLOY_ID}",
  "timestamp": "$TIMESTAMP",
  "storage_account": "$AZURE_BACKUP_STORAGE_ACCOUNT",
  "container": "$AZURE_BACKUP_CONTAINER",
  "auth_mode": "$AZURE_AUTH_MODE",
  "include_storage": "$INCLUDE_STORAGE",
  "hostname": "$(hostname)",
  "db_dump_bytes": $DB_DUMP_BYTES
}
EOF
upload_to_azure "$METADATA" "metadata.json"

# ── Optional storage volume archive ──────────────────────────
if [ "$INCLUDE_STORAGE" = "true" ]; then
  STORAGE_ROOT="$TMP_DIR/storage-root"
  STORAGE_ARCHIVE="$TMP_DIR/storage.tar.gz"
  mkdir -p "$STORAGE_ROOT"
  if docker cp supabase-storage:/var/lib/storage/. "$STORAGE_ROOT/" 2>/dev/null; then
    tar -czf "$STORAGE_ARCHIVE" -C "$STORAGE_ROOT" .
    upload_to_azure "$STORAGE_ARCHIVE" "storage.tar.gz"
  else
    echo "[aideploy] Skipping storage archive (container not accessible)" >&2
  fi
else
  echo "[aideploy] Skipping storage volume archive (disabled)"
fi

echo "[aideploy] Azure backup uploaded to ${AZURE_BACKUP_STORAGE_ACCOUNT}/${AZURE_BACKUP_CONTAINER}/${ARCHIVE_ROOT}"
