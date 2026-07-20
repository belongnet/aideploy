#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE="${AIDEPLOY_SUPABASE_ENV_FILE:-/etc/aideploy/supabase.env}"
load_safe_env_exports() {
  local env_file="$1"
  [ -f "$env_file" ] || return 0

  python3 - "$env_file" <<'PY'
import re
import shlex
import sys

allowed_keys = {
    "AIDEPLOY_CLOUD_PROVIDER",
    "AIDEPLOY_DEFAULT_PROJECT",
    "AIDEPLOY_HERMES_API_HEALTH_URL",
    "AIDEPLOY_HERMES_GATEWAY_SERVICE",
    "AIDEPLOY_OPENCLAW_INTERNAL_HTTPS_URL",
    "AIDEPLOY_OPENCLAW_INTERNAL_URL",
    "AIDEPLOY_RUNTIME_CONTRACT_FILE",
    "AIDEPLOY_SUPABASE_PROJECT",
    "AIDEPLOY_SUPABASE_SERVICE_ROLE_KEY",
    "DB_PASSWORD",
    "DEPLOY_ID",
    "JWT_SECRET",
    "POSTGRES_PASSWORD",
    "REALTIME_DB_ENC_KEY",
    "SUPABASE_ANON_KEY",
    "SUPABASE_BACKUP_REGION",
    "SUPABASE_BACKUP_SERVICE_ROLE_KEY",
    "SUPABASE_BACKUP_STATE_DIR",
    "SUPABASE_BACKUP_TARGET_URL",
    "SUPABASE_PUBLIC_URL",
    "SUPABASE_RESTORE_ALLOW_PRODUCTION_OVERWRITE",
    "SUPABASE_RESTORE_DEFAULT_COMPOSE_FILE",
    "SUPABASE_RESTORE_DEFAULT_ENV_FILE",
    "SUPABASE_RESTORE_LOG_FILE",
    "SUPABASE_RESTORE_MODE",
    "SUPABASE_RESTORE_REQUEST_FILE",
    "SUPABASE_RESTORE_REQUEST_ID",
    "SUPABASE_RESTORE_RUN_ID",
    "SUPABASE_RESTORE_SUPABASE_COMPOSE_FILE",
    "SUPABASE_RESTORE_SUPABASE_ENV_FILE",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_URL",
}
aliases = {
    "ANON_KEY": "SUPABASE_ANON_KEY",
    "SERVICE_ROLE_KEY": "SUPABASE_SERVICE_ROLE_KEY",
}
key_re = re.compile(r"^[A-Z_][A-Z0-9_]*$")

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, raw_value = line.split("=", 1)
        key = aliases.get(key.strip(), key.strip())
        if key not in allowed_keys or not key_re.fullmatch(key):
            continue
        try:
            parts = shlex.split(raw_value.strip(), posix=True)
        except ValueError as exc:
            print(f"[aideploy] ERROR: Invalid shell value for {key}: {exc}", file=sys.stderr)
            sys.exit(1)
        value = " ".join(parts) if parts else ""
        print(f"export {key}={shlex.quote(value)}")
PY
}

if ! SAFE_ENV_EXPORTS="$(load_safe_env_exports "$ENV_FILE")"; then
  echo "[aideploy] ERROR: Failed to safely load $ENV_FILE" >&2
  exit 1
fi
eval "$SAFE_ENV_EXPORTS"

RUN_ID="${SUPABASE_RESTORE_RUN_ID:-${1:-}}"
MODE="${SUPABASE_RESTORE_MODE:-full}"
ALLOW_OVERWRITE="${SUPABASE_RESTORE_ALLOW_PRODUCTION_OVERWRITE:-false}"
STATE_DIR="${SUPABASE_BACKUP_STATE_DIR:-/var/lib/aideploy/backups}"
RESTORE_ID="${SUPABASE_RESTORE_REQUEST_ID:-restore-$(date -u +%Y%m%dT%H%M%SZ)}"
if [ -z "$RUN_ID" ]; then
  echo "[aideploy] ERROR: Backup run id is required" >&2
  exit 1
fi
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9._-]{1,128}$ ]]; then
  echo "[aideploy] ERROR: Backup run id contains unsafe characters" >&2
  exit 1
fi
if [[ ! "$RESTORE_ID" =~ ^[A-Za-z0-9._-]{1,128}$ ]]; then
  echo "[aideploy] ERROR: Restore request id contains unsafe characters" >&2
  exit 1
fi
RESTORE_RECORD="${SUPABASE_RESTORE_REQUEST_FILE:-$STATE_DIR/restore-runs/${RESTORE_ID}.json}"
RESTORE_LOG="${SUPABASE_RESTORE_LOG_FILE:-$STATE_DIR/restore-runs/${RESTORE_ID}.log}"
RUN_RECORD="$STATE_DIR/runs/${RUN_ID}.json"
MANIFEST_FILE="$STATE_DIR/runs/${RUN_ID}-manifest.json"
SUPABASE_COMPOSE_FILE="${SUPABASE_RESTORE_SUPABASE_COMPOSE_FILE:-/home/aideploy/runtime/supabase/docker-compose.yml}"
SUPABASE_COMPOSE_ENV_FILE="${SUPABASE_RESTORE_SUPABASE_ENV_FILE:-/home/aideploy/runtime/supabase/.env}"
SUPABASE_PROJECT="${AIDEPLOY_SUPABASE_PROJECT:-aideploy-supabase}"
DEFAULT_COMPOSE_FILE="${SUPABASE_RESTORE_DEFAULT_COMPOSE_FILE:-/home/aideploy/runtime/default/docker-compose.yml}"
DEFAULT_COMPOSE_ENV_FILE="${SUPABASE_RESTORE_DEFAULT_ENV_FILE:-/etc/aideploy/runtime-default.env}"
DEFAULT_PROJECT="${AIDEPLOY_DEFAULT_PROJECT:-openclaw-gateway}"
# Runtime gateway endpoints. OpenClaw runs the gateway as a Docker service that
# the dashboard reaches over the runtime network, so the defaults are overridden
# by the dashboard env (e.g. http://openclaw-gateway:18789). Hermes runs its
# gateway as a host systemd service bound to loopback.
OPENCLAW_INTERNAL_URL="${AIDEPLOY_OPENCLAW_INTERNAL_URL:-http://127.0.0.1:18789}"
OPENCLAW_INTERNAL_HTTPS_URL="${AIDEPLOY_OPENCLAW_INTERNAL_HTTPS_URL:-https://127.0.0.1:18790}"
HERMES_GATEWAY_SERVICE="${AIDEPLOY_HERMES_GATEWAY_SERVICE:-hermes-gateway}"
HERMES_GATEWAY_UNIT="/etc/systemd/system/${HERMES_GATEWAY_SERVICE}.service"
HERMES_API_HEALTH_URL="${AIDEPLOY_HERMES_API_HEALTH_URL:-http://127.0.0.1:8642/health}"
TARGET_URL="${SUPABASE_BACKUP_TARGET_URL:-${SUPABASE_URL:-${SUPABASE_PUBLIC_URL:-http://127.0.0.1:8000}}}"
SERVICE_ROLE_KEY="${SUPABASE_BACKUP_SERVICE_ROLE_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-${AIDEPLOY_SUPABASE_SERVICE_ROLE_KEY:-}}}"
BACKUP_REGION="${SUPABASE_BACKUP_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
TMP_DIR="$(mktemp -d)"
ARTIFACT_DIR="$TMP_DIR/artifacts"
LOCK_DIR="$STATE_DIR/restore.lock"
LOCK_ACQUIRED="false"
ENV_SNAPSHOT="$TMP_DIR/supabase.env.snapshot"
RUNTIME_CONTRACT_FILE="${AIDEPLOY_RUNTIME_CONTRACT_FILE:-/etc/aideploy/runtime.json}"
mkdir -p "$ARTIFACT_DIR" "$STATE_DIR/restore-runs"

exec > >(tee -a "$RESTORE_LOG") 2>&1

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_restore_status() {
  local status="$1"
  local message="${2:-}"
  RESTORE_RECORD="$RESTORE_RECORD" RESTORE_ID="$RESTORE_ID" RUN_ID="$RUN_ID" \
    STATUS_VALUE="$status" STATUS_MESSAGE="$message" RESTORE_LOG="$RESTORE_LOG" \
    python3 - <<'PY'
import json
import os
from datetime import datetime, timezone

path = os.environ["RESTORE_RECORD"]
now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
record = {}
try:
    with open(path, "r", encoding="utf-8") as fh:
        loaded = json.load(fh)
        if isinstance(loaded, dict):
            record = loaded
except Exception:
    record = {}

status = os.environ["STATUS_VALUE"]
message = os.environ.get("STATUS_MESSAGE", "")
record.update(
    {
        "id": record.get("id") or os.environ["RESTORE_ID"],
        "backupRunId": record.get("backupRunId") or os.environ["RUN_ID"],
        "status": status,
        "mode": "full",
        "productionOverwrite": True,
        "executor": "aideploy-supabase-restore",
        "logPath": os.environ["RESTORE_LOG"],
        "updatedAt": now,
    }
)
if status == "running" and not record.get("startedAt"):
    record["startedAt"] = now
if status in {"completed", "failed"}:
    record["completedAt"] = now
if message:
    if status == "failed":
        record["error"] = message
    else:
        record["message"] = message

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w", encoding="utf-8") as fh:
    json.dump(record, fh, indent=2)
    fh.write("\n")
PY
}

cleanup() {
  rm -rf "$TMP_DIR"
  if [ "$LOCK_ACQUIRED" = "true" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}

fail() {
  local message="$1"
  echo "[aideploy] ERROR: $message" >&2
  write_restore_status "failed" "$message" || true
  exit 1
}

trap cleanup EXIT
trap 'fail "restore exited with code $?"' ERR

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    fail "$command_name is required. $install_hint"
  fi
}

manifest_field() {
  local key="$1"
  python3 - "$MANIFEST_FILE" "$key" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    value = json.load(fh)
for part in sys.argv[2].split("."):
    if isinstance(value, dict):
        value = value.get(part, "")
    else:
        value = ""
print("" if value is None else str(value))
PY
}

run_status() {
  python3 - "$RUN_RECORD" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        data = json.load(fh)
    print(str(data.get("status") or ""))
except Exception:
    print("")
PY
}

list_manifest_artifacts() {
  python3 - "$MANIFEST_FILE" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    manifest = json.load(fh)
for artifact in manifest.get("artifacts") or []:
    if not isinstance(artifact, dict):
        continue
    print(
        "\t".join(
            [
                str(artifact.get("name") or ""),
                str(artifact.get("type") or ""),
                str(artifact.get("sha256") or ""),
                str(artifact.get("bytes") or "0"),
                str(artifact.get("remotePath") or ""),
            ]
        )
    )
PY
}

urlencode_path() {
  python3 - "$1" <<'PY'
import urllib.parse
import sys

print("/".join(urllib.parse.quote(part, safe="") for part in sys.argv[1].split("/")))
PY
}

urlencode_object() {
  python3 - "$1" <<'PY'
import urllib.parse
import sys

print(urllib.parse.quote(sys.argv[1], safe=""))
PY
}

artifact_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

validate_artifact_name() {
  local name="$1"
  if [[ ! "$name" =~ ^[A-Za-z0-9._-]{1,128}$ ]]; then
    fail "Backup artifact contains unsafe name: $name"
  fi
}

runtime_path_allowed() {
  local name="$1"
  local root
  for root in \
    home/aideploy/.openclaw \
    home/aideploy/.hermes \
    home/aideploy/runtime-secrets \
    home/aideploy/runtime/default \
    home/aideploy/runtime/plugins \
    home/aideploy/runtime/open-webui/data \
    home/aideploy/workspace; do
    if [ "$name" = "$root" ] || [[ "$name" == "$root/"* ]]; then
      return 0
    fi
  done
  [ "$name" = "etc/aideploy/supabase.env" ]
}

validate_tar_archive() {
  local archive="$1"
  local purpose="$2"
  local name
  tar -tvzf "$archive" | awk '$1 !~ /^[-d]/ { exit 1 }' || fail "$purpose archive contains unsupported special entry"
  while IFS= read -r name; do
    name="${name#./}"
    case "$name" in
      ""|".")
        if [ "$purpose" = "storage" ]; then
          continue
        fi
        fail "$purpose archive contains empty path"
        ;;
      /*|*\\*|".."|../*|*/../*|*/..) fail "$purpose archive contains unsafe path: $name" ;;
    esac
    if [ "$purpose" = "runtime" ] && ! runtime_path_allowed "$name"; then
      fail "runtime archive contains unsupported path: $name"
    fi
  done < <(tar -tzf "$archive")
}

validate_remote_path() {
  local remote_path="$1"
  case "$remote_path" in
    ""|/*|*\\*|".."|../*|*/../*|*/..) fail "Backup artifact contains unsafe remotePath: $remote_path" ;;
  esac
  case "$remote_path" in
    "$ARCHIVE_ROOT"/*) ;;
    *) fail "Backup artifact remotePath escapes archive root: $remote_path" ;;
  esac
}

download_supabase_object() {
  local bucket="$1"
  local remote_path="$2"
  local output_path="$3"
  if [ -z "$SERVICE_ROLE_KEY" ]; then
    fail "Supabase Storage restore requires SUPABASE_SERVICE_ROLE_KEY or SUPABASE_BACKUP_SERVICE_ROLE_KEY"
  fi
  curl -fsS \
    -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    -H "apikey: $SERVICE_ROLE_KEY" \
    "$TARGET_URL/storage/v1/object/$bucket/$(urlencode_path "$remote_path")" \
    -o "$output_path"
}

azure_token() {
  local token=""
  token="$(
    curl -fsS -H Metadata:true \
      "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F" \
      2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || true
  )"
  if [ -z "$token" ] && command -v az >/dev/null 2>&1; then
    token="$(az account get-access-token --resource https://storage.azure.com/ --query accessToken -o tsv 2>/dev/null || true)"
  fi
  printf '%s' "$token"
}

download_azure_object() {
  local bucket="$1"
  local remote_path="$2"
  local output_path="$3"
  local account="${SUPABASE_BACKUP_AZURE_ACCOUNT:-${AZURE_STORAGE_ACCOUNT:-}}"
  if [ -z "$account" ]; then
    fail "Azure restore requires SUPABASE_BACKUP_AZURE_ACCOUNT or AZURE_STORAGE_ACCOUNT"
  fi
  local token
  token="$(azure_token)"
  if [ -z "$token" ]; then
    fail "Could not acquire Azure managed identity token for restore"
  fi
  curl -fsS \
    -H "Authorization: Bearer $token" \
    -H "x-ms-version: 2021-12-02" \
    "https://${account}.blob.core.windows.net/${bucket}/$(urlencode_path "$remote_path")" \
    -o "$output_path"
}

gcp_token() {
  local token=""
  token="$(
    curl -fsS -H "Metadata-Flavor: Google" \
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
      2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || true
  )"
  if [ -z "$token" ] && command -v gcloud >/dev/null 2>&1; then
    token="$(gcloud auth print-access-token 2>/dev/null || true)"
  fi
  printf '%s' "$token"
}

download_gcp_object() {
  local bucket="$1"
  local remote_path="$2"
  local output_path="$3"
  local token
  token="$(gcp_token)"
  if [ -z "$token" ]; then
    fail "Could not acquire GCP instance service account token for restore"
  fi
  curl -fsS \
    -H "Authorization: Bearer $token" \
    "https://storage.googleapis.com/storage/v1/b/${bucket}/o/$(urlencode_object "$remote_path")?alt=media" \
    -o "$output_path"
}

download_object() {
  local provider="$1"
  local bucket="$2"
  local remote_path="$3"
  local output_path="$4"
  case "$provider" in
    azure)
      download_azure_object "$bucket" "$remote_path" "$output_path"
      ;;
    aws)
      require_command aws "Install AWS CLI or run from the dashboard restore image."
      aws s3 cp "s3://$bucket/$remote_path" "$output_path" >/dev/null
      ;;
    gcp)
      download_gcp_object "$bucket" "$remote_path" "$output_path"
      ;;
    digitalocean|scaleway)
      require_command aws "$provider object storage uses the S3 API; install AWS CLI."
      if [ -z "${SUPABASE_BACKUP_S3_ENDPOINT:-}" ]; then
        fail "$provider restore requires SUPABASE_BACKUP_S3_ENDPOINT"
      fi
      aws --endpoint-url "$SUPABASE_BACKUP_S3_ENDPOINT" s3 cp "s3://$bucket/$remote_path" "$output_path" >/dev/null
      ;;
    supabase-storage|"")
      download_supabase_object "$bucket" "$remote_path" "$output_path"
      ;;
    *)
      fail "Unsupported restore provider: $provider"
      ;;
  esac
}

supabase_compose() {
  docker compose -f "$SUPABASE_COMPOSE_FILE" --project-name "$SUPABASE_PROJECT" --env-file "$SUPABASE_COMPOSE_ENV_FILE" "$@"
}

default_compose() {
  docker compose -f "$DEFAULT_COMPOSE_FILE" --project-name "$DEFAULT_PROJECT" --env-file "$DEFAULT_COMPOSE_ENV_FILE" "$@"
}

snapshot_supabase_env() {
  if [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "$ENV_SNAPSHOT"
    chmod 600 "$ENV_SNAPSHOT" 2>/dev/null || true
  fi
}

reconcile_supabase_env() {
  if [ ! -f "$ENV_SNAPSHOT" ] || [ ! -f "$ENV_FILE" ]; then
    return 0
  fi
  echo "[aideploy] Reconciling deploy-specific keys in $ENV_FILE"
  local keys=(
    AIDEPLOY_CLOUD_PROVIDER
    AIDEPLOY_DOCKER_NETWORK
    DEPLOY_ID
    SUPABASE_PUBLIC_URL
    SUPABASE_BACKUP_PROVIDER
    SUPABASE_BACKUP_CLOUD_PROVIDER
    SUPABASE_BACKUP_NATIVE_BUCKET
    SUPABASE_BACKUP_NATIVE_PREFIX
    SUPABASE_BACKUP_PREFIX
    SUPABASE_BACKUP_REGION
    SUPABASE_BACKUP_S3_ENDPOINT
    SUPABASE_BACKUP_AZURE_ACCOUNT
    SUPABASE_BACKUP_AZURE_SUBSCRIPTION_ID
    SUPABASE_BACKUP_GCP_PROJECT_ID
    SUPABASE_BACKUP_SCALEWAY_PROJECT_ID
  )
  local key
  for key in "${keys[@]}"; do
    local current
    current=$(grep -E "^${key}=" "$ENV_SNAPSHOT" | tail -n 1 || true)
    if [ -z "$current" ]; then
      continue
    fi
    local tmp="${ENV_FILE}.tmp"
    awk -v k="^${key}=" '$0 !~ k' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
    printf '%s\n' "$current" >> "$ENV_FILE"
  done
  chmod 600 "$ENV_FILE" 2>/dev/null || true
}

reconcile_deploy_info() {
  local current_ip=""
  if [ -f "$RUNTIME_CONTRACT_FILE" ]; then
    current_ip=$(python3 -c "import json,sys
try:
    with open(sys.argv[1]) as fh:
        data=json.load(fh)
    print(data.get('tailscaleIp') or data.get('tailscale_ip') or '')
except Exception:
    print('')" "$RUNTIME_CONTRACT_FILE" 2>/dev/null || true)
  fi
  local current_deploy_id="${DEPLOY_ID:-}"
  if [ -z "$current_deploy_id" ] && [ -f "$ENV_SNAPSHOT" ]; then
    current_deploy_id=$(grep -E "^(DEPLOY_ID|SUPABASE_BACKUP_PREFIX)=" "$ENV_SNAPSHOT" | head -n 1 | cut -d= -f2- || true)
  fi
  current_ip=$(printf '%s' "$current_ip" | tr -dc '0-9.')
  current_deploy_id=$(printf '%s' "$current_deploy_id" | tr -dc 'A-Za-z0-9._-')
  if [ -z "$current_ip" ] && [ -z "$current_deploy_id" ]; then
    return 0
  fi
  echo "[aideploy] Reconciling public.deploy_info (tailscale_ip=$current_ip, deploy_id=$current_deploy_id)"
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db \
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<SQL >/dev/null || true
UPDATE public.deploy_info
SET tailscale_ip = COALESCE(NULLIF('${current_ip}',''), tailscale_ip),
    deploy_id    = COALESCE(NULLIF('${current_deploy_id}',''), deploy_id);
SQL
}

restore_database() {
  local database_file="$1"
  echo "[aideploy] Restoring production Postgres from $database_file"
  supabase_compose up -d supabase-db >/dev/null
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db \
    psql -U postgres -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'postgres' AND pid <> pg_backend_pid();" >/dev/null || true
  gzip -dc "$database_file" | docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db \
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres
}

restore_storage_volume() {
  local storage_file="$1"
  local storage_root="$TMP_DIR/storage-root"
  echo "[aideploy] Overwriting Supabase Storage volume from $storage_file"
  mkdir -p "$storage_root"
  validate_tar_archive "$storage_file" "storage"
  tar -xzf "$storage_file" -C "$storage_root"
  supabase_compose up -d supabase-storage >/dev/null
  docker exec supabase-storage sh -c 'find /var/lib/storage -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
  docker cp "$storage_root/." supabase-storage:/var/lib/storage/
}

restore_runtime_files() {
  local runtime_file="$1"
  echo "[aideploy] Overwriting runtime files from $runtime_file"
  validate_tar_archive "$runtime_file" "runtime"
  tar -xzf "$runtime_file" -C /
}

restart_runtime_services() {
  echo "[aideploy] Restarting Supabase services"
  supabase_compose up -d supabase-db supabase-auth supabase-rest supabase-realtime supabase-storage supabase-kong >/dev/null
  supabase_compose restart supabase-kong >/dev/null || true

  if [ -f "$DEFAULT_COMPOSE_FILE" ] && [ -f "$DEFAULT_COMPOSE_ENV_FILE" ]; then
    echo "[aideploy] Restarting OpenClaw runtime services"
    default_compose up -d --remove-orphans openclaw anthropic-billing-proxy >/dev/null || true
    default_compose restart openclaw anthropic-billing-proxy >/dev/null || true
  fi

  # Hermes runs its gateway as a host systemd service; restart it so it
  # reconnects to the freshly restored Supabase database.
  if [ -f "$HERMES_GATEWAY_UNIT" ] && command -v systemctl >/dev/null 2>&1; then
    echo "[aideploy] Restarting Hermes gateway service"
    systemctl restart "$HERMES_GATEWAY_SERVICE" >/dev/null 2>&1 || true
  fi
}

https_probe_allows_insecure() {
  case "$1" in
    https://localhost:*|https://127.*|https://100.6[4-9].*|https://100.[7-9][0-9].*|https://100.1[0-1][0-9].*|https://100.12[0-7].*) return 0 ;;
    *) return 1 ;;
  esac
}

curl_openclaw_https_health() {
  local probe_url="$1"
  if https_probe_allows_insecure "$probe_url"; then
    curl -kfsS --max-time 3 "$probe_url"
  else
    curl -fsS --max-time 3 "$probe_url"
  fi
}

verify_openclaw_health() {
  if [ ! -f "$DEFAULT_COMPOSE_FILE" ] || [ ! -f "$DEFAULT_COMPOSE_ENV_FILE" ]; then
    echo "[aideploy] OpenClaw runtime compose/env not present; skipping OpenClaw health verification"
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    fail "curl is required to verify OpenClaw health after restore"
  fi
  echo "[aideploy] Verifying OpenClaw runtime health"
  for _ in {1..30}; do
    if curl -fsS --max-time 3 "$OPENCLAW_INTERNAL_URL" >/dev/null 2>&1; then
      return 0
    fi
    if curl_openclaw_https_health "${OPENCLAW_INTERNAL_HTTPS_URL%/}/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  default_compose ps openclaw || true
  fail "OpenClaw runtime did not become healthy after restore"
}

verify_hermes_health() {
  if [ ! -f "$HERMES_GATEWAY_UNIT" ]; then
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    fail "curl is required to verify Hermes gateway health after restore"
  fi
  echo "[aideploy] Verifying Hermes gateway health"
  for _ in {1..30}; do
    if curl -fsS --max-time 3 "$HERMES_API_HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  if command -v journalctl >/dev/null 2>&1; then
    journalctl -u "$HERMES_GATEWAY_SERVICE" --no-pager -n 120 || true
  fi
  fail "Hermes gateway did not become healthy after restore"
}

if [ "$MODE" != "full" ]; then
  fail "Dashboard production overwrite restore only supports full backups"
fi
if [ "$ALLOW_OVERWRITE" != "true" ]; then
  fail "Set SUPABASE_RESTORE_ALLOW_PRODUCTION_OVERWRITE=true to overwrite production data"
fi
if [ -z "${POSTGRES_PASSWORD:-${DB_PASSWORD:-}}" ]; then
  fail "POSTGRES_PASSWORD or DB_PASSWORD is required for restore"
fi
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$DB_PASSWORD}"
if [ ! -f "$RUN_RECORD" ]; then
  fail "Backup run record not found: $RUN_RECORD"
fi
if [ ! -f "$MANIFEST_FILE" ]; then
  fail "Backup manifest not found: $MANIFEST_FILE"
fi
if [ "$(run_status)" != "completed" ]; then
  fail "Only completed backup runs can be restored"
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  fail "Another restore is already running"
fi
LOCK_ACQUIRED="true"

snapshot_supabase_env

write_restore_status "running" "Full production overwrite restore started."

MANIFEST_MODE="$(manifest_field mode)"
if [ "$MANIFEST_MODE" != "full" ]; then
  fail "Full production overwrite restore requires a full backup manifest"
fi
MANIFEST_PREFIX="$(manifest_field prefix)"
MANIFEST_TIMESTAMP="$(manifest_field timestamp)"
if [ -z "$MANIFEST_PREFIX" ] || [ -z "$MANIFEST_TIMESTAMP" ]; then
  fail "Backup manifest is missing prefix or timestamp"
fi
ARCHIVE_ROOT="${MANIFEST_PREFIX}/${MANIFEST_MODE}/${MANIFEST_TIMESTAMP}"
NATIVE_PROVIDER="$(manifest_field nativeProvider)"
if [ -z "$NATIVE_PROVIDER" ] || [ "$NATIVE_PROVIDER" = "cloud-native" ] || [ "$NATIVE_PROVIDER" = "native" ]; then
  NATIVE_PROVIDER="$(manifest_field provider)"
fi
NATIVE_BUCKET="$(manifest_field bucket)"
if [ -z "$NATIVE_BUCKET" ]; then
  fail "Backup manifest is missing bucket"
fi
if [ -n "$BACKUP_REGION" ]; then
  export AWS_REGION="$BACKUP_REGION"
  export AWS_DEFAULT_REGION="$BACKUP_REGION"
fi

database_file=""
storage_file=""
runtime_file=""

echo "[aideploy] Downloading restore artifacts for $RUN_ID from $NATIVE_PROVIDER/$NATIVE_BUCKET"
while IFS=$'\t' read -r name type sha256 _bytes remote_path; do
  [ -n "$name" ] || continue
  validate_artifact_name "$name"
  [ -n "$remote_path" ] || fail "Artifact $name is missing remotePath"
  validate_remote_path "$remote_path"
  output_path="$ARTIFACT_DIR/$name"
  download_object "$NATIVE_PROVIDER" "$NATIVE_BUCKET" "$remote_path" "$output_path"
  actual_sha256="$(artifact_sha256 "$output_path")"
  if [ "$actual_sha256" != "$sha256" ]; then
    fail "Checksum mismatch for $name"
  fi
  case "$type:$name" in
    database-full:database.sql.gz|*:database.sql.gz)
      database_file="$output_path"
      ;;
    supabase-storage-full:storage.tar.gz|*:storage.tar.gz)
      storage_file="$output_path"
      ;;
    runtime-files:runtime-files.tar.gz|*:runtime-files.tar.gz)
      runtime_file="$output_path"
      ;;
  esac
done < <(list_manifest_artifacts)

if [ -z "$database_file" ]; then
  fail "Full restore requires database.sql.gz"
fi
if [ ! -f "$SUPABASE_COMPOSE_FILE" ]; then
  fail "Supabase compose file not found: $SUPABASE_COMPOSE_FILE"
fi
if [ ! -f "$SUPABASE_COMPOSE_ENV_FILE" ]; then
  fail "Supabase compose env file not found: $SUPABASE_COMPOSE_ENV_FILE"
fi

echo "[aideploy] Stopping Supabase API services before overwrite"
supabase_compose stop supabase-auth supabase-rest supabase-realtime supabase-kong >/dev/null || true

restore_database "$database_file"
if [ -n "$storage_file" ]; then
  restore_storage_volume "$storage_file"
fi
if [ -n "$runtime_file" ]; then
  restore_runtime_files "$runtime_file"
fi
reconcile_supabase_env
reconcile_deploy_info
restart_runtime_services

echo "[aideploy] Verifying restored database health"
supabase_compose exec -T supabase-db pg_isready -h 127.0.0.1 -U postgres >/dev/null
verify_openclaw_health
verify_hermes_health

write_restore_status "completed" "Full production overwrite restore completed."
echo "[aideploy] Full production overwrite restore completed for $RUN_ID"
