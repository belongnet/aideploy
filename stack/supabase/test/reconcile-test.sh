#!/usr/bin/env bash
# Self-contained unit test for reconcile_supabase_env in restore-from-storage.sh.
# Validates that deploy-specific env keys are pulled from the host snapshot
# while auth secrets remain whatever the backup tar restored.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESTORE_SCRIPT="${SCRIPT_DIR}/../restore-from-storage.sh"

if [ ! -f "$RESTORE_SCRIPT" ]; then
  echo "[reconcile-test] cannot find $RESTORE_SCRIPT" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
FUNCTION_LIB="${WORK_DIR}/functions.sh"
trap 'rm -rf "$WORK_DIR"' EXIT

# Extract just the snapshot/reconcile function bodies so we can source them
# without triggering the script's top-level execution.
awk '
/^snapshot_supabase_env\(\) \{$/,/^\}$/ { print; next }
/^reconcile_supabase_env\(\) \{$/,/^\}$/ { print; next }
' "$RESTORE_SCRIPT" > "$FUNCTION_LIB"

if ! grep -q "^reconcile_supabase_env() {" "$FUNCTION_LIB"; then
  echo "[reconcile-test] failed to extract reconcile_supabase_env" >&2
  exit 1
fi

# shellcheck source=/dev/null
. "$FUNCTION_LIB"

ENV_FILE="${WORK_DIR}/supabase.env"
ENV_SNAPSHOT="${WORK_DIR}/supabase.env.snapshot"

# Step 1: lay down the *current* host's env (what cloud-init wrote on the new VM).
cat > "$ENV_FILE" <<EOF
POSTGRES_PASSWORD=current-password
JWT_SECRET=current-jwt
SUPABASE_PUBLIC_URL=https://10.0.0.99:8443
DEPLOY_ID=current-deploy-9999
SUPABASE_BACKUP_NATIVE_BUCKET=current-bucket
SUPABASE_BACKUP_NATIVE_PREFIX=current-deploy-9999
SUPABASE_BACKUP_REGION=us-west-2
AIDEPLOY_CLOUD_PROVIDER=aws
EOF

snapshot_supabase_env

if [ ! -f "$ENV_SNAPSHOT" ]; then
  echo "[reconcile-test] expected snapshot to exist at $ENV_SNAPSHOT" >&2
  exit 1
fi

# Step 2: simulate restore_runtime_files overwriting ENV_FILE with the
# old VM's env that was inside runtime-files.tar.gz.
cat > "$ENV_FILE" <<EOF
POSTGRES_PASSWORD=backup-password
JWT_SECRET=backup-jwt
SUPABASE_PUBLIC_URL=https://10.0.0.42:8443
DEPLOY_ID=old-deploy-1111
SUPABASE_BACKUP_NATIVE_BUCKET=old-bucket
SUPABASE_BACKUP_NATIVE_PREFIX=old-deploy-1111
SUPABASE_BACKUP_REGION=us-east-1
AIDEPLOY_CLOUD_PROVIDER=aws
EOF

# Step 3: reconcile.
reconcile_supabase_env

fail_test() {
  echo "[reconcile-test] FAIL: $1" >&2
  echo "--- $ENV_FILE ---" >&2
  cat "$ENV_FILE" >&2
  exit 1
}

assert_contains() {
  if ! grep -qF "$1" "$ENV_FILE"; then
    fail_test "expected env file to contain '$1'"
  fi
}

assert_not_contains() {
  if grep -qF "$1" "$ENV_FILE"; then
    fail_test "expected env file NOT to contain '$1'"
  fi
}

# Auth secrets came from the backup and must stay as-is — they're load-bearing
# for decrypting restored oauth_tokens / api_keys columns.
assert_contains "POSTGRES_PASSWORD=backup-password"
assert_contains "JWT_SECRET=backup-jwt"

# Deploy-specific keys must be the *current* host's values.
assert_contains "SUPABASE_PUBLIC_URL=https://10.0.0.99:8443"
assert_contains "DEPLOY_ID=current-deploy-9999"
assert_contains "SUPABASE_BACKUP_NATIVE_BUCKET=current-bucket"
assert_contains "SUPABASE_BACKUP_NATIVE_PREFIX=current-deploy-9999"
assert_contains "SUPABASE_BACKUP_REGION=us-west-2"

# Old deploy values must be gone.
assert_not_contains "old-deploy-1111"
assert_not_contains "old-bucket"
assert_not_contains "us-east-1"
assert_not_contains "10.0.0.42"

echo "[reconcile-test] PASS"
