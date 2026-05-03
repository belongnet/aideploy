#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${AIDEPLOY_SUPABASE_ENV_FILE:-/etc/aideploy/supabase.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

MODE="${SUPABASE_BACKUP_MODE:-${1:-full}}"
case "$MODE" in
  full|incremental) ;;
  *) echo "[aideploy] SUPABASE_BACKUP_MODE must be full or incremental" >&2; exit 1 ;;
esac

TARGET_URL="${SUPABASE_BACKUP_TARGET_URL:-${SUPABASE_URL:-${SUPABASE_PUBLIC_URL:-http://127.0.0.1:8000}}}"
SERVICE_ROLE_KEY="${SUPABASE_BACKUP_SERVICE_ROLE_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-}}"
BUCKET="${SUPABASE_BACKUP_BUCKET:-aideploy-runtime-backups}"
PREFIX="${SUPABASE_BACKUP_PREFIX:-${DEPLOY_ID:-local-dev}}"
INCLUDE_STORAGE="${SUPABASE_BACKUP_INCLUDE_STORAGE:-auto}"
LOCAL_URL="${SUPABASE_URL:-http://127.0.0.1:8000}"
LOCAL_PUBLIC_URL="${SUPABASE_PUBLIC_URL:-}"
CLOUD_PROVIDER="${AIDEPLOY_CLOUD_PROVIDER:-${SUPABASE_BACKUP_CLOUD_PROVIDER:-}}"
BACKUP_PROVIDER="${SUPABASE_BACKUP_PROVIDER:-supabase-storage}"
BACKUP_REGION="${SUPABASE_BACKUP_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
NATIVE_PROVIDER="$BACKUP_PROVIDER"
if [ "$BACKUP_PROVIDER" = "cloud-native" ] || [ "$BACKUP_PROVIDER" = "native" ]; then
  NATIVE_PROVIDER="$CLOUD_PROVIDER"
fi
if { [ "$BACKUP_PROVIDER" = "cloud-native" ] || [ "$BACKUP_PROVIDER" = "native" ]; } && [ -z "$NATIVE_PROVIDER" ]; then
  echo "[aideploy] SUPABASE_BACKUP_PROVIDER=$BACKUP_PROVIDER requires AIDEPLOY_CLOUD_PROVIDER or SUPABASE_BACKUP_CLOUD_PROVIDER" >&2
  exit 1
fi
NATIVE_BUCKET="${SUPABASE_BACKUP_NATIVE_BUCKET:-$BUCKET}"
NATIVE_PREFIX="${SUPABASE_BACKUP_NATIVE_PREFIX:-$PREFIX}"
STATE_DIR="${SUPABASE_BACKUP_STATE_DIR:-/var/lib/aideploy/backups}"
if [ -n "$BACKUP_REGION" ]; then
  export AWS_REGION="$BACKUP_REGION"
  export AWS_DEFAULT_REGION="$BACKUP_REGION"
fi
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_ID="${SUPABASE_BACKUP_RUN_ID:-${MODE}-${TIMESTAMP}}"
ARCHIVE_ROOT="${NATIVE_PREFIX}/${MODE}/${TIMESTAMP}"
TMP_DIR="$(mktemp -d)"
ARTIFACT_DIR="$TMP_DIR/artifacts"
RUN_RECORD="$STATE_DIR/runs/${RUN_ID}.json"
mkdir -p "$ARTIFACT_DIR" "$STATE_DIR/runs"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_run_record() {
  local status="$1"
  local error="${2:-}"
  local completed_at=""
  if [ "$status" != "running" ]; then
    completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  cat > "$RUN_RECORD" <<EOF
{
  "id": "$(json_escape "$RUN_ID")",
  "mode": "$(json_escape "$MODE")",
  "status": "$(json_escape "$status")",
  "provider": "$(json_escape "$BACKUP_PROVIDER")",
  "nativeProvider": "$(json_escape "$NATIVE_PROVIDER")",
  "bucket": "$(json_escape "$NATIVE_BUCKET")",
  "prefix": "$(json_escape "$NATIVE_PREFIX")",
  "archiveRoot": "$(json_escape "$ARCHIVE_ROOT")",
  "startedAt": "$STARTED_AT",
  "completedAt": "$(json_escape "$completed_at")",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "error": "$(json_escape "$error")"
}
EOF
}

fail() {
  local message="$1"
  echo "[aideploy] $message" >&2
  write_run_record "failed" "$message"
  exit 1
}

cleanup() {
  rm -rf "$TMP_DIR"
}

on_error() {
  local exit_code=$?
  write_run_record "failed" "backup exited with code $exit_code"
  exit "$exit_code"
}

trap cleanup EXIT
trap on_error ERR

write_run_record "running"

if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  fail "POSTGRES_PASSWORD is required for backups"
fi

if [ "$INCLUDE_STORAGE" = "auto" ]; then
  if [ "$NATIVE_PROVIDER" != "supabase-storage" ] && [ -n "$NATIVE_PROVIDER" ]; then
    INCLUDE_STORAGE="true"
  elif [ "$TARGET_URL" = "$LOCAL_URL" ] || { [ -n "$LOCAL_PUBLIC_URL" ] && [ "$TARGET_URL" = "$LOCAL_PUBLIC_URL" ]; }; then
    INCLUDE_STORAGE="false"
  else
    INCLUDE_STORAGE="true"
  fi
fi

auth_args=(
  -H "Authorization: Bearer $SERVICE_ROLE_KEY"
  -H "apikey: $SERVICE_ROLE_KEY"
)

create_supabase_bucket() {
  if [ -z "$SERVICE_ROLE_KEY" ]; then
    fail "SUPABASE_SERVICE_ROLE_KEY or SUPABASE_BACKUP_SERVICE_ROLE_KEY is required for Supabase Storage backups"
  fi
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
    400)
      if grep -q '"statusCode":"409"' "$response_file" 2>/dev/null || grep -q 'The resource already exists' "$response_file" 2>/dev/null; then
        return 0
      fi
      ;;
  esac
  echo "[aideploy] Failed to ensure backup bucket $BUCKET (status $status)" >&2
  cat "$response_file" >&2 || true
  fail "Failed to ensure backup bucket $BUCKET (status $status)"
}

upload_supabase_object() {
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

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    fail "$command_name is required for $NATIVE_PROVIDER backups. $install_hint"
  fi
}

ensure_azure_login() {
  if [ -n "${SUPABASE_BACKUP_AZURE_SUBSCRIPTION_ID:-}" ]; then
    az account set --subscription "$SUPABASE_BACKUP_AZURE_SUBSCRIPTION_ID" --only-show-errors >/dev/null 2>&1 || true
  fi
  if az account show --only-show-errors >/dev/null 2>&1; then
    return 0
  fi
  az login --identity --only-show-errors >/dev/null
  if [ -n "${SUPABASE_BACKUP_AZURE_SUBSCRIPTION_ID:-}" ]; then
    az account set --subscription "$SUPABASE_BACKUP_AZURE_SUBSCRIPTION_ID" --only-show-errors >/dev/null
  fi
}

native_remote_path() {
  local relative_path="$1"
  printf '%s/%s/%s' "$NATIVE_PREFIX" "$MODE" "$relative_path"
}

ensure_native_bucket() {
  case "$NATIVE_PROVIDER" in
    azure)
      require_command az "Install Azure CLI or configure SUPABASE_BACKUP_PROVIDER=supabase-storage for local development."
      if [ -z "${SUPABASE_BACKUP_AZURE_ACCOUNT:-${AZURE_STORAGE_ACCOUNT:-}}" ]; then
        fail "Azure native backups require SUPABASE_BACKUP_AZURE_ACCOUNT or AZURE_STORAGE_ACCOUNT"
      fi
      ensure_azure_login
      az storage container create \
        --account-name "${SUPABASE_BACKUP_AZURE_ACCOUNT:-$AZURE_STORAGE_ACCOUNT}" \
        --name "$NATIVE_BUCKET" \
        --auth-mode login \
        --only-show-errors >/dev/null
      ;;
    aws)
      require_command aws "Install AWS CLI or provide it in the runtime image."
      aws s3 mb "s3://$NATIVE_BUCKET" >/dev/null 2>&1 || true
      ;;
    gcp)
      if command -v gcloud >/dev/null 2>&1; then
        gcloud storage buckets create "gs://$NATIVE_BUCKET" --quiet >/dev/null 2>&1 || true
      elif command -v gsutil >/dev/null 2>&1; then
        gsutil mb "gs://$NATIVE_BUCKET" >/dev/null 2>&1 || true
      else
        fail "gcloud or gsutil is required for GCP native backups"
      fi
      ;;
    digitalocean|scaleway)
      require_command aws "DigitalOcean Spaces and Scaleway Object Storage use the S3 API; install AWS CLI."
      if [ -z "${SUPABASE_BACKUP_S3_ENDPOINT:-}" ]; then
        fail "$NATIVE_PROVIDER backups require SUPABASE_BACKUP_S3_ENDPOINT"
      fi
      aws --endpoint-url "$SUPABASE_BACKUP_S3_ENDPOINT" s3 mb "s3://$NATIVE_BUCKET" >/dev/null 2>&1 || true
      ;;
    supabase-storage|"")
      create_supabase_bucket
      ;;
    *)
      fail "Unsupported SUPABASE_BACKUP_PROVIDER/native provider: $NATIVE_PROVIDER"
      ;;
  esac
}

upload_native_object() {
  local remote_path="$1"
  local file_path="$2"
  case "$NATIVE_PROVIDER" in
    azure)
      az storage blob upload \
        --account-name "${SUPABASE_BACKUP_AZURE_ACCOUNT:-$AZURE_STORAGE_ACCOUNT}" \
        --container-name "$NATIVE_BUCKET" \
        --name "$remote_path" \
        --file "$file_path" \
        --auth-mode login \
        --overwrite true \
        --only-show-errors >/dev/null
      ;;
    aws)
      aws s3 cp "$file_path" "s3://$NATIVE_BUCKET/$remote_path" >/dev/null
      ;;
    gcp)
      if command -v gcloud >/dev/null 2>&1; then
        gcloud storage cp "$file_path" "gs://$NATIVE_BUCKET/$remote_path" --quiet >/dev/null
      else
        gsutil cp "$file_path" "gs://$NATIVE_BUCKET/$remote_path" >/dev/null
      fi
      ;;
    digitalocean|scaleway)
      aws --endpoint-url "$SUPABASE_BACKUP_S3_ENDPOINT" s3 cp "$file_path" "s3://$NATIVE_BUCKET/$remote_path" >/dev/null
      ;;
    supabase-storage|"")
      upload_supabase_object "$remote_path" "$file_path" "application/octet-stream"
      ;;
  esac
}

upload_run_record() {
  local remote_path
  remote_path="$(native_remote_path "$TIMESTAMP/run.json")"
  if [ "$NATIVE_PROVIDER" = "supabase-storage" ] || [ -z "$NATIVE_PROVIDER" ]; then
    upload_supabase_object "$remote_path" "$RUN_RECORD" "application/json"
  else
    upload_native_object "$remote_path" "$RUN_RECORD"
  fi
}

artifact_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

artifact_size() {
  wc -c < "$1" | tr -d ' '
}

add_manifest_entry() {
  local name="$1"
  local path="$2"
  local type="$3"
  local comma=""
  if [ -s "$MANIFEST_ENTRIES" ]; then
    comma=","
  fi
  cat >> "$MANIFEST_ENTRIES" <<EOF
$comma
    {
      "name": "$(json_escape "$name")",
      "type": "$(json_escape "$type")",
      "sha256": "$(artifact_sha256 "$path")",
      "bytes": $(artifact_size "$path"),
      "remotePath": "$(json_escape "$(native_remote_path "$TIMESTAMP/$name")")"
    }
EOF
}

dump_database_full() {
  local out="$ARTIFACT_DIR/database.sql.gz"
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db \
    pg_dump -U postgres -d postgres --clean --if-exists --no-owner --no-privileges \
    | gzip -c > "$out"
  add_manifest_entry "database.sql.gz" "$out" "database-full"
}

dump_database_incremental() {
  local out="$ARTIFACT_DIR/protected-state.sql.gz"
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db \
    pg_dump -U postgres -d postgres --data-only --column-inserts --no-owner --no-privileges \
      --table=public.agents \
      --table=public.deploy_info \
      --table='*.agent_config' \
      --table='*.tasks' \
      --table='*.channels' \
      --table='*.setup_prompt_state' \
      --table='*.oauth_tokens' \
      --table='*.api_keys' \
      --table='*.conversations' \
      --table='*.messages' \
      --table='*.memory_items' \
      --table='*.memory_embeddings' \
    | gzip -c > "$out"
  add_manifest_entry "protected-state.sql.gz" "$out" "database-protected-state"
}

prune_remote_backups() {
  local retention_days="${SUPABASE_BACKUP_RETENTION_DAYS:-0}"
  case "$retention_days" in
    ''|*[!0-9]*) return 0 ;;
  esac
  if [ "$retention_days" -le 0 ]; then
    return 0
  fi
  local dry_run="${SUPABASE_BACKUP_PRUNE_DRY_RUN:-false}"
  local action_word="pruning"
  if [ "$dry_run" = "true" ]; then
    action_word="[dry-run] would prune"
  fi
  local cutoff
  cutoff=$(python3 -c "from datetime import datetime,timezone,timedelta;import sys;print((datetime.now(timezone.utc)-timedelta(days=int(sys.argv[1]))).strftime('%Y%m%dT%H%M%SZ'))" "$retention_days" 2>/dev/null || true)
  if [ -z "$cutoff" ]; then
    echo "[aideploy] WARNING: could not compute retention cutoff; skipping prune" >&2
    return 0
  fi
  echo "[aideploy] Pruning backups older than $retention_days days (cutoff $cutoff) on $NATIVE_PROVIDER/$NATIVE_BUCKET${dry_run:+ [dry-run=$dry_run]}"
  local mode_name
  for mode_name in full incremental; do
    local mode_prefix="${NATIVE_PREFIX}/${mode_name}/"
    case "$NATIVE_PROVIDER" in
      aws)
        aws s3 ls "s3://${NATIVE_BUCKET}/${mode_prefix}" 2>/dev/null \
          | awk '/PRE/{print $2}' | sed 's:/$::' \
          | while read -r ts; do
              [[ -n "$ts" && "$ts" < "$cutoff" ]] || continue
              echo "[aideploy]   ${action_word} s3://${NATIVE_BUCKET}/${mode_prefix}${ts}/"
              [ "$dry_run" = "true" ] && continue
              aws s3 rm "s3://${NATIVE_BUCKET}/${mode_prefix}${ts}/" --recursive >/dev/null || true
            done
        ;;
      digitalocean|scaleway)
        aws --endpoint-url "$SUPABASE_BACKUP_S3_ENDPOINT" s3 ls "s3://${NATIVE_BUCKET}/${mode_prefix}" 2>/dev/null \
          | awk '/PRE/{print $2}' | sed 's:/$::' \
          | while read -r ts; do
              [[ -n "$ts" && "$ts" < "$cutoff" ]] || continue
              echo "[aideploy]   ${action_word} s3://${NATIVE_BUCKET}/${mode_prefix}${ts}/"
              [ "$dry_run" = "true" ] && continue
              aws --endpoint-url "$SUPABASE_BACKUP_S3_ENDPOINT" s3 rm "s3://${NATIVE_BUCKET}/${mode_prefix}${ts}/" --recursive >/dev/null || true
            done
        ;;
      gcp)
        if command -v gcloud >/dev/null 2>&1; then
          gcloud storage ls "gs://${NATIVE_BUCKET}/${mode_prefix}" 2>/dev/null \
            | awk -F/ '{print $(NF-1)}' \
            | while read -r ts; do
                [[ -n "$ts" && "$ts" < "$cutoff" ]] || continue
                echo "[aideploy]   ${action_word} gs://${NATIVE_BUCKET}/${mode_prefix}${ts}/"
                [ "$dry_run" = "true" ] && continue
                gcloud storage rm --recursive "gs://${NATIVE_BUCKET}/${mode_prefix}${ts}/" --quiet >/dev/null || true
              done
        elif command -v gsutil >/dev/null 2>&1; then
          gsutil ls "gs://${NATIVE_BUCKET}/${mode_prefix}" 2>/dev/null \
            | awk -F/ '{print $(NF-1)}' \
            | while read -r ts; do
                [[ -n "$ts" && "$ts" < "$cutoff" ]] || continue
                echo "[aideploy]   ${action_word} gs://${NATIVE_BUCKET}/${mode_prefix}${ts}/"
                [ "$dry_run" = "true" ] && continue
                gsutil -m rm -r "gs://${NATIVE_BUCKET}/${mode_prefix}${ts}/" >/dev/null 2>&1 || true
              done
        fi
        ;;
      azure)
        local account="${SUPABASE_BACKUP_AZURE_ACCOUNT:-${AZURE_STORAGE_ACCOUNT:-}}"
        if [ -z "$account" ]; then
          continue
        fi
        az storage blob list \
          --account-name "$account" \
          --container-name "$NATIVE_BUCKET" \
          --prefix "$mode_prefix" \
          --auth-mode login \
          --query "[].name" -o tsv 2>/dev/null \
          | awk -v p="$mode_prefix" 'index($0,p)==1 { rest=substr($0,length(p)+1); idx=index(rest,"/"); if (idx>0) print substr(rest,1,idx-1); else print rest }' | sort -u \
          | while read -r ts; do
              [[ -n "$ts" && "$ts" < "$cutoff" ]] || continue
              echo "[aideploy]   ${action_word} azure://${NATIVE_BUCKET}/${mode_prefix}${ts}/"
              [ "$dry_run" = "true" ] && continue
              az storage blob delete-batch \
                --account-name "$account" \
                --source "$NATIVE_BUCKET" \
                --pattern "${mode_prefix}${ts}/*" \
                --auth-mode login \
                --only-show-errors >/dev/null 2>&1 || true
            done
        ;;
      supabase-storage|"")
        : # local-mode backups don't auto-prune; configure bucket lifecycle if needed
        ;;
    esac
  done
}

archive_runtime_files() {
  local list_file="$TMP_DIR/runtime-file-list.txt"
  : > "$list_file"
  for path in \
    /home/aideploy/.openclaw \
    /home/aideploy/.hermes \
    /home/aideploy/runtime-secrets \
    /home/aideploy/runtime/plugins \
    /home/aideploy/runtime/open-webui/data \
    /home/aideploy/workspace \
    /etc/aideploy/supabase.env; do
    if [ -e "$path" ]; then
      printf '%s\n' "$path" >> "$list_file"
    fi
  done
  if [ ! -s "$list_file" ]; then
    return 0
  fi
  local out="$ARTIFACT_DIR/runtime-files.tar.gz"
  tar -czf "$out" --ignore-failed-read --files-from "$list_file"
  add_manifest_entry "runtime-files.tar.gz" "$out" "runtime-files"
}

archive_storage_volume() {
  if [ "$INCLUDE_STORAGE" != "true" ]; then
    echo "[aideploy] Skipping storage volume archive (target matches local runtime or storage disabled)"
    return 0
  fi
  local storage_root="$TMP_DIR/storage-root"
  local out="$ARTIFACT_DIR/storage.tar.gz"
  mkdir -p "$storage_root"
  docker cp supabase-storage:/var/lib/storage/. "$storage_root/"
  tar -czf "$out" -C "$storage_root" .
  add_manifest_entry "storage.tar.gz" "$out" "supabase-storage-full"
}

write_storage_manifest() {
  if [ "$INCLUDE_STORAGE" != "true" ]; then
    echo "[aideploy] Skipping Supabase Storage manifest (target matches local runtime or storage disabled)"
    return 0
  fi
  local out="$ARTIFACT_DIR/storage-manifest.txt"
  if docker exec supabase-storage sh -c 'cd /var/lib/storage 2>/dev/null && find . -type f -exec sha256sum {} \;' > "$out" 2>/dev/null; then
    add_manifest_entry "storage-manifest.txt" "$out" "supabase-storage-manifest"
  else
    echo "[aideploy] WARNING: could not collect Supabase Storage manifest" >&2
    rm -f "$out"
  fi
}

MANIFEST_ENTRIES="$TMP_DIR/manifest-entries.json"
: > "$MANIFEST_ENTRIES"

echo "[aideploy] Creating $MODE Supabase backup run $RUN_ID"
if [ "$MODE" = "full" ]; then
  dump_database_full
  archive_storage_volume
else
  dump_database_incremental
  write_storage_manifest
fi
archive_runtime_files

MANIFEST="$ARTIFACT_DIR/manifest.json"
cat > "$MANIFEST" <<EOF
{
  "version": 1,
  "runId": "$(json_escape "$RUN_ID")",
  "mode": "$(json_escape "$MODE")",
  "deployId": "$(json_escape "${DEPLOY_ID:-}")",
  "timestamp": "$TIMESTAMP",
  "targetUrl": "$(json_escape "$TARGET_URL")",
  "provider": "$(json_escape "$BACKUP_PROVIDER")",
  "nativeProvider": "$(json_escape "$NATIVE_PROVIDER")",
  "bucket": "$(json_escape "$NATIVE_BUCKET")",
  "prefix": "$(json_escape "$NATIVE_PREFIX")",
  "includeStorage": "$(json_escape "$INCLUDE_STORAGE")",
  "hostname": "$(json_escape "$(hostname)")",
  "artifacts": [
$(cat "$MANIFEST_ENTRIES")
  ]
}
EOF
add_manifest_entry "manifest.json" "$MANIFEST" "manifest"

ensure_native_bucket

for artifact in "$ARTIFACT_DIR"/*; do
  [ -f "$artifact" ] || continue
  name="$(basename "$artifact")"
  remote_path="$(native_remote_path "$TIMESTAMP/$name")"
  if [ "$NATIVE_PROVIDER" = "supabase-storage" ] || [ -z "$NATIVE_PROVIDER" ]; then
    upload_supabase_object "$remote_path" "$artifact" "application/octet-stream"
  else
    upload_native_object "$remote_path" "$artifact"
  fi
done

cp "$MANIFEST" "$STATE_DIR/runs/${RUN_ID}-manifest.json"
prune_remote_backups
write_run_record "completed"
upload_run_record || echo "[aideploy] WARNING: could not upload remote run status marker" >&2
echo "[aideploy] Backup uploaded to $BACKUP_PROVIDER/$NATIVE_BUCKET/$(native_remote_path "$TIMESTAMP")"
