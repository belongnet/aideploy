#!/usr/bin/env bash
# Credential-free checks against the two assets the CLI really deploys.
# SMOKE_UP=1 starts the OpenClaw gateway and boots the exact checksum-pinned
# Hermes source archive behind its API health endpoint. The default mode stays
# useful on laptops without Docker.
set -Eeuo pipefail

RUNTIME="${1:?usage: runtime-smoke.sh <openclaw|hermes>}"
HERMES_SMOKE_INSTALLER=""
HERMES_SMOKE_ARCHIVE=""
OPENCLAW_SMOKE_TEMP=""
OPENCLAW_SMOKE_COMPOSE=""
OPENCLAW_SMOKE_PROJECT=""
OPENCLAW_SMOKE_IMAGE="aideploy-openclaw-smoke:local"
CLI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$CLI_ROOT/.." && pwd)"
if [ -d "$REPO_ROOT/stack/runtime" ]; then
  RUNTIME_ROOT="$REPO_ROOT/stack/runtime"
elif [ -d "$REPO_ROOT/public-root/stack/runtime" ]; then
  RUNTIME_ROOT="$REPO_ROOT/public-root/stack/runtime"
else
  echo "Could not find stack/runtime" >&2
  exit 2
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

cleanup_hermes_smoke() {
  if [ -n "$HERMES_SMOKE_INSTALLER" ]; then
    rm -f "$HERMES_SMOKE_INSTALLER"
  fi
  if [ -n "$HERMES_SMOKE_ARCHIVE" ]; then
    rm -f "$HERMES_SMOKE_ARCHIVE"
  fi
}

cleanup_openclaw_smoke() {
  local cleanup_status=0
  local smoke_temp="$OPENCLAW_SMOKE_TEMP"
  local compose_stopped=1
  local owned_temp=0

  # Prevent a cleanup failure from re-entering this trap after function-local
  # state has unwound.
  trap - EXIT
  if [ -n "$OPENCLAW_SMOKE_COMPOSE" ] && [ -n "$OPENCLAW_SMOKE_PROJECT" ]; then
    if ! AIDEPLOY_OPENCLAW_IMAGE="$OPENCLAW_SMOKE_IMAGE" \
      AIDEPLOY_OPENCLAW_STATE="$smoke_temp/state" \
      AIDEPLOY_WORKSPACE="$smoke_temp/workspace" \
      OPENCLAW_GATEWAY_TOKEN=smoke-token \
        docker compose -f "$OPENCLAW_SMOKE_COMPOSE" \
          --project-name "$OPENCLAW_SMOKE_PROJECT" down -v --remove-orphans \
          >/dev/null 2>&1; then
      echo "OpenClaw smoke cleanup could not stop its compose project" >&2
      cleanup_status=1
      compose_stopped=0
    fi
  fi

  if [ -n "$smoke_temp" ] && [ "$compose_stopped" -eq 1 ]; then
    case "${smoke_temp##*/}" in aideploy-openclaw-smoke.*) owned_temp=1 ;; esac
    if [ "$owned_temp" -ne 1 ] || [ ! -f "$smoke_temp/.aideploy-smoke-owner" ]; then
      echo "OpenClaw smoke cleanup refused an unowned temp path: $smoke_temp" >&2
      cleanup_status=1
    elif ! rm -rf -- "$smoke_temp" 2>/dev/null; then
      # Linux bind mounts can contain state created by the root-run runtime.
      # Use the already-built local image to remove only the two owned mounts,
      # then let the host user remove the empty fixture directory.
      docker run --rm --user 0:0 --entrypoint sh \
        -v "$smoke_temp:/cleanup" "$OPENCLAW_SMOKE_IMAGE" \
        -c 'rm -rf /cleanup/state /cleanup/workspace' >/dev/null 2>&1 || true
      if ! rm -rf -- "$smoke_temp"; then
        echo "OpenClaw smoke cleanup could not remove $smoke_temp" >&2
        cleanup_status=1
      fi
    fi
  fi

  OPENCLAW_SMOKE_TEMP=""
  OPENCLAW_SMOKE_COMPOSE=""
  OPENCLAW_SMOKE_PROJECT=""
  return "$cleanup_status"
}

download_file() {
  local url="$1"
  local destination="$2"
  curl --fail --silent --show-error --location \
    --connect-timeout 10 --max-time 300 \
    --continue-at - \
    --retry 4 --retry-delay 2 --retry-all-errors \
    "$url" -o "$destination"
}

smoke_openclaw() {
  local root="$RUNTIME_ROOT/openclaw"
  local compose="$root/docker-compose.yml"
  grep -Eq '^FROM ghcr\.io/openclaw/openclaw:[^ ]+@sha256:[a-f0-9]{64}$' "$root/Dockerfile"
  OPENCLAW_GATEWAY_TOKEN=smoke-token docker compose -f "$compose" config >/dev/null
  echo "OpenClaw compose contract: PASS"

  local autopair_temp
  autopair_temp="$(mktemp -d "${TMPDIR:-/tmp}/aideploy-autopair-smoke.XXXXXX")"
  install -d "$autopair_temp/bin"
  cat >"$autopair_temp/bin/docker" <<'DOCKERSTUBEOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [ "${6:-}" = "list" ]; then
  printf '%s\n' '{"pending":[{"requestId":"older","ts":1},{"requestId":"newer","ts":2},{"ts":3}]}'
  exit 0
fi
if [ "${6:-}" = "approve" ]; then
  printf '%s\n' "${7:?request id missing}" >>"${AIDEPLOY_APPROVAL_LOG:?approval log missing}"
  exit 0
fi
exit 2
DOCKERSTUBEOF
  chmod 755 "$autopair_temp/bin/docker"
  AIDEPLOY_AUTOPAIR_ONCE=1 \
  AIDEPLOY_APPROVAL_LOG="$autopair_temp/approvals" \
  PATH="$autopair_temp/bin:$PATH" \
    "$root/autopair.sh"
  printf 'newer\nolder\n' >"$autopair_temp/expected"
  cmp "$autopair_temp/expected" "$autopair_temp/approvals"
  rm -rf "$autopair_temp"
  echo "OpenClaw device approval contract: PASS"

  [ "${SMOKE_UP:-0}" = "1" ] || return 0
  local temp project
  temp="$(mktemp -d "${TMPDIR:-/tmp}/aideploy-openclaw-smoke.XXXXXX")"
  project="aideploy-smoke-$$"
  install -d "$temp/state" "$temp/workspace"
  : >"$temp/.aideploy-smoke-owner"
  cat >"$temp/state/openclaw.json" <<'JSONEOF'
{
  "agents": {"defaults": {"elevatedDefault": "full"}},
  "channels": {},
  "gateway": {
    "port": 18789,
    "mode": "local",
    "controlUi": {"allowedOrigins": ["*"]},
    "auth": {"mode": "token", "token": "smoke-token"}
  }
}
JSONEOF
  OPENCLAW_SMOKE_TEMP="$temp"
  OPENCLAW_SMOKE_COMPOSE="$compose"
  OPENCLAW_SMOKE_PROJECT="$project"
  trap cleanup_openclaw_smoke EXIT

  docker build -t "$OPENCLAW_SMOKE_IMAGE" "$root"
  AIDEPLOY_OPENCLAW_IMAGE="$OPENCLAW_SMOKE_IMAGE" \
  AIDEPLOY_OPENCLAW_STATE="$temp/state" \
  AIDEPLOY_WORKSPACE="$temp/workspace" \
  OPENCLAW_GATEWAY_TOKEN=smoke-token \
    docker compose -f "$compose" --project-name "$project" up -d

  for _ in $(seq 1 60); do
    if [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' aideploy-openclaw 2>/dev/null || true)" = "healthy" ]; then
      echo "OpenClaw boot smoke: PASS"
      cleanup_openclaw_smoke
      return 0
    fi
    sleep 3
  done
  docker logs --tail 160 aideploy-openclaw >&2 || true
  echo "OpenClaw boot smoke: FAIL" >&2
  cleanup_openclaw_smoke
  return 1
}

smoke_hermes() {
  local root="$RUNTIME_ROOT/hermes"
  local manifest="$root/manifest.json"
  local url expected image source_commit source_repo source_url source_expected
  jq -e '
    (.releaseTag | type == "string" and length > 0) and
    (.sourceRepository == "https://github.com/NousResearch/hermes-agent.git") and
    (.sourceCommit | test("^[a-f0-9]{40}$")) and
    (.sourceArchiveSha256 | test("^[a-f0-9]{64}$"))
  ' "$manifest" >/dev/null
  url="$(jq -er '.installUrl' "$manifest")"
  expected="$(jq -er '.installSha256' "$manifest")"
  image="$(jq -er '.openWebUiImage' "$manifest")"
  source_commit="$(jq -er '.sourceCommit' "$manifest")"
  source_repo="$(jq -er '.sourceRepository' "$manifest")"
  source_url="$(jq -er '.sourceArchiveUrl' "$manifest")"
  source_expected="$(jq -er '.sourceArchiveSha256' "$manifest")"
  [ "$source_repo" = "https://github.com/NousResearch/hermes-agent.git" ]
  [ "$url" = "https://raw.githubusercontent.com/NousResearch/hermes-agent/$source_commit/scripts/install.sh" ]
  [ "$source_url" = "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/$source_commit" ]
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]]
  [[ "$image" =~ @sha256:[a-f0-9]{64}$ ]]
  grep -Fq -- "--branch '\"\$source_commit\"'" "$RUNTIME_ROOT/bootstrap.sh"
  grep -Fq 'git -C /home/aideploy/.hermes/hermes-agent rev-parse HEAD' "$RUNTIME_ROOT/bootstrap.sh"
  HERMES_OPEN_WEBUI_IMAGE="$image" \
  HERMES_GATEWAY_TOKEN=smoke-token \
  HERMES_MODEL=gpt-5.5 \
  HERMES_WEBUI_OWNER_EMAIL=owner@aideploy.local \
  HERMES_WEBUI_OWNER_PASSWORD=smoke-owner-password \
    docker compose -f "$root/docker-compose.yml" config >/dev/null
  echo "Hermes runtime contract: PASS"

  [ "${SMOKE_UP:-0}" = "1" ] || return 0
  local actual installer_path source_actual source_archive
  trap cleanup_hermes_smoke EXIT
  if [ -n "${HERMES_SMOKE_INSTALLER_PATH:-}" ]; then
    [ -f "$HERMES_SMOKE_INSTALLER_PATH" ] || {
      echo "HERMES_SMOKE_INSTALLER_PATH does not exist: $HERMES_SMOKE_INSTALLER_PATH" >&2
      return 1
    }
    installer_path="$HERMES_SMOKE_INSTALLER_PATH"
  else
    HERMES_SMOKE_INSTALLER="$(mktemp "${TMPDIR:-/tmp}/aideploy-hermes-smoke.XXXXXX")"
    download_file "$url" "$HERMES_SMOKE_INSTALLER"
    installer_path="$HERMES_SMOKE_INSTALLER"
  fi
  actual="$(sha256_file "$installer_path")"
  [ "$actual" = "$expected" ] || {
    echo "Hermes installer checksum mismatch: expected $expected, got $actual" >&2
    return 1
  }
  bash -n "$installer_path"
  echo "Hermes pinned-installer smoke: PASS"

  if [ -n "${HERMES_SMOKE_SOURCE_ARCHIVE:-}" ]; then
    [ -f "$HERMES_SMOKE_SOURCE_ARCHIVE" ] || {
      echo "HERMES_SMOKE_SOURCE_ARCHIVE does not exist: $HERMES_SMOKE_SOURCE_ARCHIVE" >&2
      return 1
    }
    source_archive="$HERMES_SMOKE_SOURCE_ARCHIVE"
  else
    HERMES_SMOKE_ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/aideploy-hermes-source.XXXXXX")"
    download_file "$source_url" "$HERMES_SMOKE_ARCHIVE"
    source_archive="$HERMES_SMOKE_ARCHIVE"
  fi
  source_actual="$(sha256_file "$source_archive")"
  [ "$source_actual" = "$source_expected" ] || {
    echo "Hermes source checksum mismatch: expected $source_expected, got $source_actual" >&2
    return 1
  }

  # This image is digest-pinned and contains only the Python runtime. Installing
  # the API-server extra from the exact source archive proves the gateway can
  # import, bind, and answer health checks without any provider credentials.
  docker run --rm \
    -e API_SERVER_ENABLED=true \
    -e API_SERVER_HOST=127.0.0.1 \
    -e API_SERVER_PORT=8642 \
    -e API_SERVER_KEY=aideploy-hermes-smoke-key \
    -e GATEWAY_ALLOW_ALL_USERS=false \
    -e HERMES_HOME=/tmp/hermes-home \
    -e HOME=/tmp/home \
    -e TIRITH_ENABLED=false \
    -v "$source_archive:/tmp/hermes-source.tgz:ro" \
    --entrypoint /bin/sh \
    python@sha256:9d3abd9fc11d06998ccdbdd93b4dd49b5ad7d67fcbbc11c016eb0eb2c2194891 \
    -ceu '
      mkdir -p "$HOME" "$HERMES_HOME" /tmp/hermes-source
      python - <<'"'"'PY'"'"'
import tarfile
from pathlib import Path

archive = Path("/tmp/hermes-source.tgz")
destination = Path("/tmp/hermes-source")
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    root = members[0].name.split("/", 1)[0]
    prefix = root + "/"
    for member in members:
        if member.name == root:
            continue
        if not member.name.startswith(prefix):
            raise SystemExit("source archive has an unexpected root")
        member.name = member.name[len(prefix):]
        if not member.name:
            continue
        target = (destination / member.name).resolve()
        if destination.resolve() not in target.parents and target != destination.resolve():
            raise SystemExit("source archive attempts path traversal")
        bundle.extract(member, destination, filter="data")
PY
      python -m venv /tmp/hermes-venv
      installed=false
      for install_attempt in 1 2 3; do
        # A timed-out wheel must not poison the next attempt. The source archive
        # is checksum-pinned separately; transient dependency bytes are not.
        if PIP_DEFAULT_TIMEOUT=180 PIP_NO_CACHE_DIR=1 \
          /tmp/hermes-venv/bin/pip install \
            --disable-pip-version-check --retries 8 \
            -e "/tmp/hermes-source[homeassistant]"; then
          installed=true
          break
        fi
        echo "Hermes dependency install attempt $install_attempt failed; retrying" >&2
        sleep $((install_attempt * 5))
      done
      [ "$installed" = true ]
      /tmp/hermes-venv/bin/hermes gateway run >/tmp/hermes-gateway.log 2>&1 &
      gateway_pid=$!
      cleanup_gateway() {
        kill -TERM "$gateway_pid" 2>/dev/null || true
        wait "$gateway_pid" 2>/dev/null || true
      }
      trap cleanup_gateway EXIT INT TERM
      for _ in $(seq 1 120); do
        if ! kill -0 "$gateway_pid" 2>/dev/null; then
          cat /tmp/hermes-gateway.log >&2
          exit 1
        fi
        if /tmp/hermes-venv/bin/python - <<'"'"'PY'"'"' >/dev/null 2>&1
from urllib.request import Request, urlopen

request = Request(
    "http://127.0.0.1:8642/health",
    headers={"Authorization": "Bearer aideploy-hermes-smoke-key"},
)
with urlopen(request, timeout=2) as response:
    raise SystemExit(0 if response.status == 200 else 1)
PY
        then
          echo "Hermes gateway boot smoke: PASS"
          exit 0
        fi
        sleep 2
      done
      cat /tmp/hermes-gateway.log >&2
      exit 1
    '
  cleanup_hermes_smoke
  HERMES_SMOKE_INSTALLER=""
  HERMES_SMOKE_ARCHIVE=""
  trap - EXIT
}

case "$RUNTIME" in
  openclaw) smoke_openclaw ;;
  hermes) smoke_hermes ;;
  *) echo "unknown runtime: $RUNTIME" >&2; exit 2 ;;
esac
