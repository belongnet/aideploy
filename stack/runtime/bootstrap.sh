#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_FILE="${AIDEPLOY_CONFIG_FILE:-/etc/aideploy/config.json}"
ASSET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_ROOT="/var/lib/aideploy"
STATUS_FILE="$STATE_ROOT/status.json"
PUBLIC_STATUS_ROOT="/run/aideploy"
PUBLIC_STATUS_FILE="$PUBLIC_STATUS_ROOT/status.json"
LOG_FILE="/var/log/aideploy-bootstrap.log"
TAILSCALE_DNS_NAME=""
DASHBOARD_URL=""
CURRENT_STEP="bootstrap"

install -d -m 700 "$STATE_ROOT"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

status() {
  local state="$1"
  local step="$2"
  local message="$3"
  if [ "$state" = "running" ]; then
    CURRENT_STEP="$step"
  fi
  jq -n \
    --arg state "$state" \
    --arg step "$step" \
    --arg message "$message" \
    --arg updated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{state:$state,step:$step,message:$message,updatedAt:$updated_at}' \
    >"$STATUS_FILE.tmp"
  mv "$STATUS_FILE.tmp" "$STATUS_FILE"
  chmod 644 "$STATUS_FILE"
  install -d -m 755 "$PUBLIC_STATUS_ROOT"
  install -m 644 "$STATUS_FILE" "$PUBLIC_STATUS_FILE.tmp"
  mv "$PUBLIC_STATUS_FILE.tmp" "$PUBLIC_STATUS_FILE"
  echo "[aideploy] $step: $message"
}

on_error() {
  local exit_code=$?
  status "failed" "$CURRENT_STEP" "Setup failed with exit code $exit_code. See $LOG_FILE."
  exit "$exit_code"
}
trap on_error ERR

require_config() {
  if [ ! -s "$CONFIG_FILE" ] || ! jq -e 'type == "object"' "$CONFIG_FILE" >/dev/null; then
    echo "[aideploy] Missing or invalid $CONFIG_FILE" >&2
    return 1
  fi
  local required
  for required in deploy_id runtime channel ai_provider ai_api_key telegram_bot_token telegram_user_id gateway_token hermes_webui_owner_email hermes_webui_owner_password; do
    if ! jq -e --arg key "$required" '.[$key] | type == "string" and length > 0' "$CONFIG_FILE" >/dev/null; then
      echo "[aideploy] Missing required configuration field: $required" >&2
      return 1
    fi
  done
  if ! jq -e '.tailscale_auth_key | type == "string"' "$CONFIG_FILE" >/dev/null; then
    echo "[aideploy] Missing required configuration field: tailscale_auth_key" >&2
    return 1
  fi
}

json_value() {
  jq -er --arg key "$1" '.[$key]' "$CONFIG_FILE"
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-80}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS --connect-timeout 3 --max-time 5 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

install_common_packages() {
  status "running" "packages" "Installing Docker and runtime dependencies"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq \
    ca-certificates curl docker.io docker-compose-v2 git jq nginx python3 sudo unzip
  systemctl enable --now docker
}

install_bun() {
  local version="1.3.14"
  local installed_version machine arch expected archive extract binary
  installed_version="$(sudo -u aideploy -H env PATH=/home/aideploy/.bun/bin:/usr/local/bin:/usr/bin:/bin \
    bun --version 2>/dev/null || true)"
  if [ "$installed_version" = "$version" ]; then
    return 0
  fi

  machine="$(uname -m)"
  case "$machine" in
    x86_64 | amd64)
      arch="x64"
      expected="951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f"
      ;;
    aarch64 | arm64)
      arch="aarch64"
      expected="a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b"
      ;;
    *)
      echo "[aideploy] Unsupported architecture for Bun: $machine" >&2
      return 1
      ;;
  esac

  status "running" "bun_install" "Installing checksum-verified Bun $version"
  archive="$(mktemp /tmp/aideploy-bun.XXXXXX.zip)"
  extract="$(mktemp -d /tmp/aideploy-bun.XXXXXX)"
  curl --fail --silent --show-error --location \
    --connect-timeout 10 --max-time 300 \
    --retry 4 --retry-delay 2 --retry-all-errors \
    "https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-linux-${arch}.zip" -o "$archive"
  printf '%s  %s\n' "$expected" "$archive" | sha256sum -c -
  unzip -q "$archive" -d "$extract"
  binary="$extract/bun-linux-${arch}/bun"
  if [ ! -x "$binary" ]; then
    echo "[aideploy] Verified Bun archive is missing its binary" >&2
    return 1
  fi
  install -d -o aideploy -g aideploy -m 0755 /home/aideploy/.bun/bin
  install -o aideploy -g aideploy -m 0755 "$binary" /home/aideploy/.bun/bin/bun
  ln -snf bun /home/aideploy/.bun/bin/bunx
  chown -h aideploy:aideploy /home/aideploy/.bun/bin/bunx
  rm -rf "$archive" "$extract"
}

install_gstack_browser_dependencies() {
  status "running" "gstack_dependencies" "Installing browser dependencies for gstack"
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq \
    fonts-noto-color-emoji \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libcairo2 \
    libcups2t64 \
    libdbus-1-3 \
    libgbm1 \
    libglib2.0-0t64 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2
}

install_tailscale() {
  local version="1.98.8"
  local machine arch expected archive extract source_dir
  machine="$(uname -m)"
  case "$machine" in
    x86_64 | amd64)
      arch="amd64"
      expected="3a55b5900dd7e11e09b6c74d1e46d223d549dfbefbdc1f044a8ab7bdbafb933c"
      ;;
    aarch64 | arm64)
      arch="arm64"
      expected="53eb3ce89d062fd34e393d24a6c8ec08c769fede8eb77fe9c6e347ad4ae00f84"
      ;;
    armv7l | armv7)
      arch="arm"
      expected="3de36af9fa58f465113bc7cfce7cdb5eb7fc2d99d24b48febd819672916b58ac"
      ;;
    *)
      echo "[aideploy] Unsupported architecture for Tailscale: $machine" >&2
      return 1
      ;;
  esac

  if command -v tailscale >/dev/null 2>&1 && [ "$(tailscale version 2>/dev/null | head -n 1)" = "$version" ]; then
    return 0
  fi

  status "running" "tailscale_install" "Installing checksum-verified Tailscale $version"
  archive="$(mktemp /tmp/aideploy-tailscale.XXXXXX.tgz)"
  extract="$(mktemp -d /tmp/aideploy-tailscale.XXXXXX)"
  curl --fail --silent --show-error --location \
    --connect-timeout 10 --max-time 300 \
    --retry 4 --retry-delay 2 --retry-all-errors \
    "https://pkgs.tailscale.com/stable/tailscale_${version}_${arch}.tgz" -o "$archive"
  printf '%s  %s\n' "$expected" "$archive" | sha256sum -c -
  tar -xzf "$archive" -C "$extract"
  source_dir="$(find "$extract" -mindepth 1 -maxdepth 1 -type d -name 'tailscale_*' -print -quit)"
  if [ -z "$source_dir" ] || [ ! -x "$source_dir/tailscale" ] || [ ! -x "$source_dir/tailscaled" ]; then
    echo "[aideploy] Verified Tailscale archive is missing its binaries" >&2
    return 1
  fi
  install -m 0755 "$source_dir/tailscale" /usr/bin/tailscale
  install -m 0755 "$source_dir/tailscaled" /usr/sbin/tailscaled
  rm -rf "$archive" "$extract"

  cat >/etc/systemd/system/tailscaled.service <<'TAILSCALESERVICEEOF'
[Unit]
Description=Tailscale node agent
Documentation=https://tailscale.com/kb/
Wants=network-pre.target
After=network-pre.target NetworkManager.service systemd-resolved.service

[Service]
EnvironmentFile=-/etc/default/tailscaled
ExecStart=/usr/sbin/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock $FLAGS
ExecStopPost=/usr/sbin/tailscaled --cleanup
Restart=on-failure
RuntimeDirectory=tailscale
RuntimeDirectoryMode=0755
StateDirectory=tailscale
StateDirectoryMode=0700

[Install]
WantedBy=multi-user.target
TAILSCALESERVICEEOF
  systemctl daemon-reload
}

tailscale_is_connected() {
  tailscale status --json 2>/dev/null \
    | jq -e '.BackendState == "Running"' >/dev/null 2>&1 \
    && tailscale ip -4 >/dev/null 2>&1
}

scrub_tailscale_auth_key() {
  local scrubbed
  scrubbed="$(mktemp "${CONFIG_FILE}.tmp.XXXXXX")"
  if ! jq '.tailscale_auth_key = ""' "$CONFIG_FILE" >"$scrubbed"; then
    rm -f "$scrubbed"
    echo "[aideploy] Could not remove the consumed Tailscale auth key" >&2
    return 1
  fi
  chmod 600 "$scrubbed"
  mv "$scrubbed" "$CONFIG_FILE"
}

connect_tailscale() {
  local auth_key="$1"
  local hostname="$2"
  status "running" "tailscale" "Connecting the VM to your tailnet"
  install_tailscale
  systemctl enable --now tailscaled

  if tailscale_is_connected; then
    scrub_tailscale_auth_key
    return 0
  fi
  if [ -z "$auth_key" ]; then
    echo "[aideploy] Tailscale is not connected and its one-off auth key has already been consumed" >&2
    return 1
  fi
  tailscale up --authkey="$auth_key" --hostname="$hostname" --ssh
  for _ in $(seq 1 30); do
    if tailscale_is_connected; then
      scrub_tailscale_auth_key
      return 0
    fi
    sleep 2
  done
  echo "[aideploy] Tailscale did not assign an address" >&2
  return 1
}

load_tailscale_dns_name() {
  local candidate
  for _ in $(seq 1 30); do
    candidate="$(tailscale status --json 2>/dev/null | jq -er '.Self.DNSName | rtrimstr(".")' 2>/dev/null || true)"
    if [[ "$candidate" =~ ^[a-z0-9][a-z0-9.-]*\.ts\.net$ ]]; then
      TAILSCALE_DNS_NAME="$candidate"
      return 0
    fi
    sleep 2
  done
  echo "[aideploy] Tailscale did not report an HTTPS-capable DNS name" >&2
  return 1
}

start_bootstrap_status() {
  status "running" "bootstrap_status" "Publishing private setup progress"
  install -m 755 "$ASSET_ROOT/status_server.py" /usr/local/bin/aideploy-bootstrap-status
  cat >/etc/systemd/system/aideploy-bootstrap-status.service <<'STATUSSERVICEEOF'
[Unit]
Description=Private aideploy bootstrap status endpoint
After=network.target

[Service]
Type=simple
User=nobody
Group=nogroup
ExecStart=/usr/bin/python3 /usr/local/bin/aideploy-bootstrap-status
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadOnlyPaths=/run/aideploy

[Install]
WantedBy=multi-user.target
STATUSSERVICEEOF
  systemctl daemon-reload
  systemctl start aideploy-bootstrap-status.service
  wait_for_http http://127.0.0.1:18791/_aideploy/status 20
  tailscale serve --bg --yes 18791 >/dev/null
}

serve_bootstrap_status() {
  [ -n "$TAILSCALE_DNS_NAME" ] || load_tailscale_dns_name
  DASHBOARD_URL="https://$TAILSCALE_DNS_NAME"
  wait_for_http "$DASHBOARD_URL/_aideploy/status" 40
}

serve_dashboard() {
  local port="$1"
  [ -n "$TAILSCALE_DNS_NAME" ] || load_tailscale_dns_name
  status "running" "tailscale_serve" "Publishing the private dashboard with Tailscale HTTPS"
  tailscale serve --bg --yes "$port" >/dev/null
  DASHBOARD_URL="https://$TAILSCALE_DNS_NAME"
  if ! wait_for_http "$DASHBOARD_URL" 40; then
    tailscale serve status >&2 || true
    echo "[aideploy] Tailscale Serve did not make the dashboard reachable" >&2
    return 1
  fi
  systemctl stop aideploy-bootstrap-status.service >/dev/null 2>&1 || true
}

configure_openclaw_browser() {
  local browser_root="/var/www/aideploy-openclaw"
  status "running" "openclaw_browser" "Preparing the private OpenClaw browser sign-in"
  install -d -m 755 "$browser_root"
  cat >"$browser_root/bootstrap.html" <<'BOOTSTRAPHTMLEOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Connecting to OpenClaw</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; line-height: 1.5; }
      main { max-width: 34rem; margin: 10vh auto; }
      p { color: #4b5563; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connecting to your agent</h1>
      <p>Signing this private browser tab in&hellip;</p>
    </main>
    <script>
      (function () {
        var params = new URLSearchParams(window.location.search || '');
        var token = params.get('token') || '';
        if (!token) {
          document.querySelector('main').innerHTML = '<h1>Sign-in link incomplete</h1><p>Open the full browser sign-in link printed by aideploy.</p>';
          return;
        }
        var settingsKey = 'openclaw.control.settings.v1';
        var gatewayUrl = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host;
        var scopedSettingsKey = settingsKey + ':' + gatewayUrl;
        var scopedTokenKey = 'openclaw.control.token.v1:' + gatewayUrl;
        var settings = { gatewayUrl: gatewayUrl, sessionKey: 'main', lastActiveSessionKey: 'main' };
        try {
          var previous = window.localStorage.getItem(scopedSettingsKey) || window.localStorage.getItem(settingsKey);
          if (previous) {
            var parsed = JSON.parse(previous);
            if (parsed && typeof parsed === 'object') settings = Object.assign({}, parsed, settings);
          }
          delete settings.token;
          window.sessionStorage.setItem(scopedTokenKey, token);
          window.localStorage.setItem(scopedSettingsKey, JSON.stringify(settings));
          window.localStorage.setItem(settingsKey, JSON.stringify(settings));
          window.history.replaceState({}, '', '/');
          window.location.replace('/');
        } catch (_) {
          document.querySelector('main').innerHTML = '<h1>Browser storage is unavailable</h1><p>Allow local storage for this private site, then open the sign-in link again.</p>';
        }
      })();
    </script>
  </body>
</html>
BOOTSTRAPHTMLEOF
  chmod 644 "$browser_root/bootstrap.html"

  cat >/etc/nginx/sites-available/aideploy-openclaw <<'NGINXEOF'
server {
    listen 127.0.0.1:18790;
    server_name _;

    location = /_aideploy/bootstrap {
        alias /var/www/aideploy-openclaw/bootstrap.html;
        default_type text/html;
        access_log off;
        add_header Cache-Control "no-store" always;
        add_header Referrer-Policy "no-referrer" always;
    }

    location = /_aideploy/status {
        alias /run/aideploy/status.json;
        default_type application/json;
        access_log off;
        add_header Cache-Control "no-store" always;
        add_header X-Aideploy-Bootstrap-Status "1" always;
    }

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
NGINXEOF
  rm -f /etc/nginx/sites-enabled/default
  ln -sfn /etc/nginx/sites-available/aideploy-openclaw /etc/nginx/sites-enabled/aideploy-openclaw
  nginx -t
  systemctl enable nginx
  systemctl restart nginx
  wait_for_http http://127.0.0.1:18790/ 20
}

install_openclaw_autopair() {
  status "running" "openclaw_pairing" "Enabling private browser device approval"
  install -m 755 "$ASSET_ROOT/openclaw/autopair.sh" /usr/local/bin/aideploy-openclaw-autopair

  cat >/etc/systemd/system/aideploy-openclaw-autopair.service <<'AUTOPAIRSVCEOF'
[Unit]
Description=Approve authenticated OpenClaw browser devices on the private tailnet
After=docker.service
Requires=docker.service

[Service]
Type=simple
ExecStart=/usr/local/bin/aideploy-openclaw-autopair
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
AUTOPAIRSVCEOF
  systemctl daemon-reload
  systemctl enable --now aideploy-openclaw-autopair.service
  systemctl is-active --quiet aideploy-openclaw-autopair.service
}

verify_openclaw_remote_gateway() {
  local gateway_token="$1"
  local image tailscale_ip client_home response_file error_file device_id verified
  image="$(docker inspect -f '{{.Config.Image}}' aideploy-openclaw)"
  if ! [[ "$image" =~ @sha256:[a-f0-9]{64}$ ]]; then
    echo "[aideploy] Running OpenClaw image is not digest-pinned" >&2
    return 1
  fi
  tailscale_ip="$(tailscale ip -4 | head -n 1)"
  if ! [[ "$tailscale_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "[aideploy] Tailscale did not report an IPv4 address for the gateway probe" >&2
    return 1
  fi

  client_home="$(mktemp -d /tmp/aideploy-openclaw-client.XXXXXX)"
  response_file="$(mktemp /tmp/aideploy-openclaw-health.XXXXXX.json)"
  error_file="$(mktemp /tmp/aideploy-openclaw-health.XXXXXX.log)"
  chmod 0777 "$client_home"
  verified=false

  for attempt in $(seq 1 12); do
    if docker run --rm --network host \
      --add-host "$TAILSCALE_DNS_NAME:$tailscale_ip" \
      -e HOME=/client \
      -e OPENCLAW_GATEWAY_URL="wss://$TAILSCALE_DNS_NAME" \
      -e OPENCLAW_GATEWAY_TOKEN="$gateway_token" \
      -v "$client_home:/client" \
      --entrypoint node \
      "$image" \
      /app/openclaw.mjs gateway call health \
      --timeout 30000 \
      --json \
      >"$response_file" 2>>"$error_file"; then
      verified=true
      break
    fi
    echo "[aideploy] Waiting for private gateway device approval (attempt $attempt of 12)"
    sleep 5
  done

  if [ "$verified" != "true" ]; then
    echo "[aideploy] Private OpenClaw WebSocket readiness check failed" >&2
    tail -n 80 "$error_file" >&2 || true
    rm -rf "$client_home"
    rm -f "$response_file" "$error_file"
    return 1
  fi

  device_id="$(jq -er '.deviceId | select(test("^[a-f0-9]{64}$"))' \
    "$client_home/.openclaw/identity/device.json" 2>/dev/null || true)"
  if [ -n "$device_id" ]; then
    docker exec aideploy-openclaw node /app/openclaw.mjs devices remove "$device_id" \
      --url ws://127.0.0.1:18789 \
      --token "$gateway_token" \
      --json >/dev/null 2>&1 || true
  fi
  rm -rf "$client_home"
  rm -f "$response_file" "$error_file"
}

install_backup_timer() {
  install -m 755 "$ASSET_ROOT/backup.sh" /usr/local/bin/aideploy-backup
  cat >/etc/systemd/system/aideploy-backup.service <<'SERVICEEOF'
[Unit]
Description=aideploy local runtime backup

[Service]
Type=oneshot
ExecStart=/usr/local/bin/aideploy-backup
SERVICEEOF
  cat >/etc/systemd/system/aideploy-backup.timer <<'TIMEREOF'
[Unit]
Description=Run the aideploy local backup daily

[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true

[Install]
WantedBy=timers.target
TIMEREOF
  systemctl daemon-reload
  systemctl enable --now aideploy-backup.timer
}

verify_openclaw_model() {
  local provider="$1"
  local model="$2"
  local deploy_id="$3"
  local model_id="${model#*/}"
  local nonce="AIDEPLOY_MODEL_READY"
  local output_file error_file attempt

  output_file="$(mktemp "$STATE_ROOT/openclaw-model-probe.XXXXXX.json")"
  error_file="$(mktemp "$STATE_ROOT/openclaw-model-probe.XXXXXX.log")"
  chmod 600 "$output_file" "$error_file"

  for attempt in 1 2 3; do
    status "running" "openclaw_model_verify" "Verifying the configured AI model (attempt $attempt of 3)"
    : >"$output_file"
    : >"$error_file"
    if timeout -k 10 150 docker exec aideploy-openclaw \
      node /app/openclaw.mjs agent \
      --local \
      --agent main \
      --session-id "aideploy-bootstrap-$deploy_id" \
      --message "Reply exactly: $nonce" \
      --thinking off \
      --timeout 120 \
      --json \
      >"$output_file" 2>"$error_file" &&
      jq -e \
        --arg provider "$provider" \
        --arg model "$model_id" \
        --arg nonce "$nonce" \
        '(.meta.agentMeta.provider == $provider) and
         (.meta.agentMeta.model == $model) and
         ([.payloads[]?.text? | select(type == "string") | gsub("^\\s+|\\s+$"; "")] | any(. == $nonce))' \
        "$output_file" >/dev/null; then
      jq -n \
        --arg provider "$provider" \
        --arg model "$model" \
        --arg verified_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{provider:$provider,model:$model,verified:true,verifiedAt:$verified_at}' \
        >"$STATE_ROOT/model-verification.json"
      chmod 600 "$STATE_ROOT/model-verification.json"
      rm -f "$output_file" "$error_file"
      return 0
    fi
    sleep 5
  done

  echo "[aideploy] OpenClaw did not return the expected response from $model" >&2
  tail -n 80 "$error_file" >&2 || true
  rm -f "$output_file" "$error_file"
  return 1
}

verify_hermes_model() {
  local provider="$1"
  local model="$2"
  local gateway_token="$3"
  local deploy_id="$4"
  local nonce="AIDEPLOY_HERMES_MODEL_READY"
  local request_file response_file error_file attempt

  request_file="$(mktemp "$STATE_ROOT/hermes-model-request.XXXXXX.json")"
  response_file="$(mktemp "$STATE_ROOT/hermes-model-response.XXXXXX.json")"
  error_file="$(mktemp "$STATE_ROOT/hermes-model-response.XXXXXX.log")"
  chmod 600 "$request_file" "$response_file" "$error_file"
  jq -n \
    --arg model "$model" \
    --arg nonce "$nonce" \
    '{model:$model,messages:[{role:"user",content:("Reply exactly: " + $nonce)}],temperature:0,max_tokens:32}' \
    >"$request_file"

  for attempt in 1 2 3; do
    status "running" "hermes_model_verify" "Verifying the configured AI model (attempt $attempt of 3)"
    : >"$response_file"
    : >"$error_file"
    if curl -fsS --connect-timeout 10 --max-time 150 \
      -H "Authorization: Bearer $gateway_token" \
      -H "Content-Type: application/json" \
      --data-binary "@$request_file" \
      http://127.0.0.1:8642/v1/chat/completions \
      >"$response_file" 2>"$error_file" &&
      jq -e \
        --arg nonce "$nonce" \
        '([.choices[]?.message?.content? | select(type == "string") | gsub("^\\s+|\\s+$"; "")] | any(. == $nonce))' \
        "$response_file" >/dev/null; then
      jq -n \
        --arg runtime "hermes" \
        --arg provider "$provider" \
        --arg model "$model" \
        --arg deploy_id "$deploy_id" \
        --arg verified_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{runtime:$runtime,provider:$provider,model:$model,deployId:$deploy_id,verified:true,verifiedAt:$verified_at}' \
        >"$STATE_ROOT/model-verification.json"
      chmod 600 "$STATE_ROOT/model-verification.json"
      rm -f "$request_file" "$response_file" "$error_file"
      return 0
    fi
    sleep 5
  done

  echo "[aideploy] Hermes did not return the expected response from $model" >&2
  tail -n 80 "$error_file" >&2 || true
  rm -f "$request_file" "$response_file" "$error_file"
  return 1
}

verify_hermes_webui_owner() {
  local owner_email="$1"
  local owner_password="$2"
  local request_file response_file attempt
  request_file="$(mktemp "$STATE_ROOT/hermes-webui-signin.XXXXXX.json")"
  response_file="$(mktemp "$STATE_ROOT/hermes-webui-signin.XXXXXX.response.json")"
  chmod 600 "$request_file" "$response_file"
  jq -n --arg email "$owner_email" --arg password "$owner_password" \
    '{email:$email,password:$password}' >"$request_file"

  if ! docker inspect aideploy-hermes-webui \
    --format '{{json .Config.Env}}' | \
    jq -e 'index("WEBUI_AUTH=true") != null and index("ENABLE_SIGNUP=false") != null' >/dev/null; then
    echo "[aideploy] Hermes browser chat is not enforcing owner authentication" >&2
    rm -f "$request_file" "$response_file"
    return 1
  fi

  for attempt in $(seq 1 40); do
    : >"$response_file"
    if curl -fsS --connect-timeout 3 --max-time 10 \
      -H "Content-Type: application/json" \
      --data-binary "@$request_file" \
      http://127.0.0.1:3001/api/v1/auths/signin \
      >"$response_file" 2>/dev/null &&
      jq -e '.token | type == "string" and length > 20' "$response_file" >/dev/null; then
      rm -f "$request_file" "$response_file"
      return 0
    fi
    sleep 3
  done

  echo "[aideploy] Hermes browser owner credential could not sign in" >&2
  rm -f "$request_file" "$response_file"
  return 1
}

install_openclaw() {
  local deploy_id="$1"
  local provider="$2"
  local api_key="$3"
  local telegram_token="$4"
  local telegram_user_id="$5"
  local gateway_token="$6"
  local state_dir="$STATE_ROOT/openclaw"
  local workspace_dir="$STATE_ROOT/workspace"
  local compose_file="$ASSET_ROOT/openclaw/docker-compose.yml"
  local model

  case "$provider" in
    openai) model="openai/gpt-5.5" ;;
    anthropic) model="anthropic/claude-opus-4-8" ;;
    kimi) model="kimi/kimi-for-coding" ;;
  esac

  if grep -Eq '^[[:space:]]*image:.*(AIDEPLOY_OWNER|RELEASE_TAG)' "$compose_file" || ! grep -Eq '@sha256:[a-f0-9]{64}' "$compose_file"; then
    echo "[aideploy] OpenClaw image was not pinned by the release workflow" >&2
    return 1
  fi

  status "running" "openclaw_config" "Writing the OpenClaw runtime configuration"
  install -d -m 700 \
    "$state_dir/credentials" \
    "$state_dir/agents/main/agent" \
    "$workspace_dir"

  jq -n \
    --arg model "$model" \
    --arg provider "$provider" \
    --arg telegram_token "$telegram_token" \
    --arg telegram_user_id "$telegram_user_id" \
    --arg gateway_token "$gateway_token" \
    --arg dashboard_origin "https://$TAILSCALE_DNS_NAME" \
    '{
      agents:{defaults:{model:{primary:$model},models:{($model):{}},elevatedDefault:"full"}},
      channels:{telegram:{enabled:true,botToken:$telegram_token,dmPolicy:"allowlist",allowFrom:[$telegram_user_id]}},
      commands:{ownerAllowFrom:[("telegram:" + $telegram_user_id)]},
      plugins:{entries:{telegram:{enabled:true}}},
      gateway:{
        port:18789,
        mode:"local",
        trustedProxies:["127.0.0.1","::1"],
        controlUi:{allowedOrigins:[$dashboard_origin]},
        auth:{mode:"token",token:$gateway_token,allowTailscale:false}
      }
    } + if $provider == "kimi" then {
      models:{providers:{kimi:{
        baseUrl:"https://api.kimi.com/coding/",
        api:"anthropic-messages",
        headers:{"User-Agent":"claude-code/0.1.0"},
        models:[{
          id:"kimi-for-coding",
          name:"Kimi Code",
          reasoning:true,
          input:["text","image"],
          cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
          contextWindow:262144,
          maxTokens:32768
        }]
      }}}
    } else {} end' >"$state_dir/openclaw.json"

  jq -n \
    --arg id "$provider:default" \
    --arg provider "$provider" \
    --arg api_key "$api_key" \
    '{version:1,profiles:{($id):{provider:$provider,type:"api_key",key:$api_key}}}' \
    >"$state_dir/agents/main/agent/auth-profiles.json"
  jq '.profiles' "$state_dir/agents/main/agent/auth-profiles.json" \
    >"$state_dir/credentials/profiles.json"
  chmod -R go-rwx "$state_dir"

  status "running" "openclaw_start" "Starting the pinned OpenClaw image"
  AIDEPLOY_OPENCLAW_STATE="$state_dir" \
  AIDEPLOY_WORKSPACE="$workspace_dir" \
  OPENCLAW_GATEWAY_TOKEN="$gateway_token" \
    docker compose -f "$compose_file" --project-name aideploy-openclaw up -d

  local healthy=false
  for _ in $(seq 1 80); do
    if [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' aideploy-openclaw 2>/dev/null || true)" = "healthy" ]; then
      healthy=true
      break
    fi
    sleep 3
  done
  if [ "$healthy" != "true" ]; then
    docker logs --tail 160 aideploy-openclaw >&2 || true
    return 1
  fi

  verify_openclaw_model "$provider" "$model" "$deploy_id"
  install_openclaw_autopair
  configure_openclaw_browser
  serve_dashboard 18790
  status "running" "openclaw_remote_gateway" "Verifying the private OpenClaw browser gateway"
  verify_openclaw_remote_gateway "$gateway_token"

  jq -n \
    --arg runtime "openclaw" \
    --arg hostname "$TAILSCALE_DNS_NAME" \
    --arg url "$DASHBOARD_URL" \
    --arg provider "$provider" \
    --arg model "$model" \
    '{runtime:$runtime,tailscaleHostname:$hostname,dashboardUrl:$url,modelProvider:$provider,model:$model,modelVerified:true}' \
    >"$STATE_ROOT/runtime.json"
}

install_hermes() {
  local deploy_id="$1"
  local provider="$2"
  local api_key="$3"
  local telegram_token="$4"
  local telegram_user_id="$5"
  local gateway_token="$6"
  local webui_owner_email="$7"
  local webui_owner_password="$8"
  local manifest="$ASSET_ROOT/hermes/manifest.json"
  local install_url install_sha release_tag source_repo source_commit gstack_repo gstack_commit webui_image model

  install_url="$(jq -er '.installUrl' "$manifest")"
  install_sha="$(jq -er '.installSha256' "$manifest")"
  release_tag="$(jq -er '.releaseTag' "$manifest")"
  source_repo="$(jq -er '.sourceRepository' "$manifest")"
  source_commit="$(jq -er '.sourceCommit' "$manifest")"
  gstack_repo="$(jq -er '.gstackRepository' "$manifest")"
  gstack_commit="$(jq -er '.gstackCommit' "$manifest")"
  webui_image="$(jq -er '.openWebUiImage' "$manifest")"
  if ! [[ "$install_sha" =~ ^[a-f0-9]{64}$ && "$source_commit" =~ ^[a-f0-9]{40}$ && "$gstack_commit" =~ ^[a-f0-9]{40}$ && "$webui_image" =~ @sha256:[a-f0-9]{64}$ ]]; then
    echo "[aideploy] Hermes manifest is not fully pinned" >&2
    return 1
  fi
  if [ "$source_repo" != "https://github.com/NousResearch/hermes-agent.git" ] || \
     [[ "$install_url" != "https://raw.githubusercontent.com/NousResearch/hermes-agent/$source_commit/"* ]]; then
    echo "[aideploy] Hermes installer and source repository do not match the pinned commit" >&2
    return 1
  fi

  case "$provider" in
    openai) model="gpt-5.5" ;;
    anthropic) model="claude-opus-4-8" ;;
    kimi) model="kimi-for-coding" ;;
  esac

  status "running" "hermes_install" "Installing the pinned Hermes release"
  id aideploy >/dev/null 2>&1 || useradd -m -s /bin/bash aideploy
  usermod -aG docker aideploy
  install -d -o aideploy -g aideploy -m 700 /home/aideploy/.hermes
  install -d -o aideploy -g aideploy -m 755 /home/aideploy/workspace
  install -d -o aideploy -g aideploy -m 700 "$STATE_ROOT/hermes-open-webui"

  local installer
  installer="$(mktemp /tmp/aideploy-hermes.XXXXXX.sh)"
  curl --fail --silent --show-error --location \
    --connect-timeout 10 --max-time 300 \
    --retry 4 --retry-delay 2 --retry-all-errors \
    "$install_url" -o "$installer"
  printf '%s  %s\n' "$install_sha" "$installer" | sha256sum -c -
  chmod 755 "$installer"

  # Seed the install directory from the immutable commit. The upstream
  # installer accepts a branch/ref but uses `git clone --branch` for a fresh
  # directory, which cannot address a raw commit. Pre-seeding makes its update
  # path check out and pull this exact commit without ever executing a tag tip.
  sudo -u aideploy -H env HERMES_SOURCE_REPO="$source_repo" HERMES_SOURCE_COMMIT="$source_commit" bash -lc '
    set -Eeuo pipefail
    install_dir=/home/aideploy/.hermes/hermes-agent
    install -d -m 700 "$install_dir"
    git init "$install_dir"
    if git -C "$install_dir" remote get-url origin >/dev/null 2>&1; then
      git -C "$install_dir" remote set-url origin "$HERMES_SOURCE_REPO"
    else
      git -C "$install_dir" remote add origin "$HERMES_SOURCE_REPO"
    fi
    git -C "$install_dir" fetch --depth 1 origin "$HERMES_SOURCE_COMMIT"
    git -C "$install_dir" checkout --detach FETCH_HEAD
    test "$(git -C "$install_dir" rev-parse HEAD)" = "$HERMES_SOURCE_COMMIT"
  '
  sudo -u aideploy -H env HERMES_INSTALL_SCRIPT="$installer" bash -lc \
    'set -Eeuo pipefail; export HERMES_HOME=/home/aideploy/.hermes; export HERMES_INSTALL_DIR=/home/aideploy/.hermes/hermes-agent; export PATH=/home/aideploy/.local/bin:$PATH; bash "$HERMES_INSTALL_SCRIPT" --skip-setup --branch '"$source_commit"' --dir "$HERMES_INSTALL_DIR"'
  rm -f "$installer"
  local installed_commit
  installed_commit="$(sudo -u aideploy -H git -C /home/aideploy/.hermes/hermes-agent rev-parse HEAD)"
  if [ "$installed_commit" != "$source_commit" ]; then
    echo "[aideploy] Hermes installed commit $installed_commit, expected $source_commit ($release_tag)" >&2
    return 1
  fi

  install_bun
  install_gstack_browser_dependencies

  status "running" "gstack_fetch" "Fetching the pinned gstack release"
  sudo -u aideploy -H env GSTACK_REPO="$gstack_repo" GSTACK_COMMIT="$gstack_commit" bash -lc '
    set -Eeuo pipefail
    install_root=/home/aideploy/.gstack/repos/gstack
    mkdir -p "$(dirname "$install_root")"
    git init "$install_root"
    git -C "$install_root" remote get-url origin >/dev/null 2>&1 || git -C "$install_root" remote add origin "$GSTACK_REPO"
    git -C "$install_root" fetch --depth 1 origin "$GSTACK_COMMIT"
    git -C "$install_root" checkout --detach FETCH_HEAD
    test "$(git -C "$install_root" rev-parse HEAD)" = "$GSTACK_COMMIT"
  '

  status "running" "gstack_setup" "Installing the pinned gstack skills"
  sudo -u aideploy -H bash -lc '
    set -Eeuo pipefail
    install_root=/home/aideploy/.gstack/repos/gstack
    export PATH=/home/aideploy/.bun/bin:/home/aideploy/.local/bin:$PATH
    cd "$install_root"
    ./setup --host codex
    mkdir -p /home/aideploy/.hermes/skills
    for skill_dir in /home/aideploy/.codex/skills/gstack* /home/aideploy/.gstack/repos/gstack/.agents/skills/gstack*; do
      [ -e "$skill_dir" ] || continue
      ln -snf "$skill_dir" "/home/aideploy/.hermes/skills/$(basename "$skill_dir")"
    done
  '

  status "running" "hermes_config" "Configuring Hermes and Telegram"
  {
    printf 'API_SERVER_ENABLED=true\n'
    printf 'API_SERVER_HOST=0.0.0.0\n'
    printf 'API_SERVER_PORT=8642\n'
    printf 'API_SERVER_KEY=%s\n' "$gateway_token"
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$telegram_token"
    printf 'TELEGRAM_ALLOWED_USERS=%s\n' "$telegram_user_id"
    case "$provider" in
      openai) printf 'OPENAI_API_KEY=%s\n' "$api_key" ;;
      anthropic) printf 'ANTHROPIC_API_KEY=%s\n' "$api_key" ;;
      kimi)
        printf 'KIMI_API_KEY=%s\n' "$api_key"
        printf 'ANTHROPIC_API_KEY=%s\n' "$api_key"
        ;;
    esac
  } >/home/aideploy/.hermes/.env
  chown aideploy:aideploy /home/aideploy/.hermes/.env
  chmod 600 /home/aideploy/.hermes/.env

  sudo -u aideploy -H env HERMES_HOME=/home/aideploy/.hermes bash -lc '
    set -Eeuo pipefail
    export PATH=/home/aideploy/.local/bin:$PATH
    hermes config set terminal.backend local
    hermes config set terminal.cwd /home/aideploy/workspace
    hermes config set display.tool_progress all
    hermes config set model '"$model"'
    if [ '"$provider"' = kimi ]; then
      hermes config set model.provider anthropic
      hermes config set model.base_url https://api.kimi.com/coding/
    fi
  '
  env HERMES_HOME=/home/aideploy/.hermes /home/aideploy/.local/bin/hermes gateway install --system --run-as-user aideploy
  install -d -m 755 /etc/systemd/system/hermes-gateway.service.d
  cat >/etc/systemd/system/hermes-gateway.service.d/aideploy-env.conf <<'HERMESSERVICEEOF'
[Service]
Environment=HERMES_HOME=/home/aideploy/.hermes
EnvironmentFile=/home/aideploy/.hermes/.env
HERMESSERVICEEOF
  systemctl daemon-reload
  env HERMES_HOME=/home/aideploy/.hermes /home/aideploy/.local/bin/hermes gateway start --system
  if ! wait_for_http http://127.0.0.1:8642/health 80; then
    journalctl -u hermes-gateway --no-pager -n 160 >&2 || true
    return 1
  fi
  verify_hermes_model "$provider" "$model" "$gateway_token" "$deploy_id"

  status "running" "hermes_webui" "Starting the pinned Hermes browser chat"
  HERMES_OPEN_WEBUI_IMAGE="$webui_image" \
  HERMES_GATEWAY_TOKEN="$gateway_token" \
  HERMES_MODEL="$model" \
  HERMES_WEBUI_OWNER_EMAIL="$webui_owner_email" \
  HERMES_WEBUI_OWNER_PASSWORD="$webui_owner_password" \
  HERMES_OPEN_WEBUI_DATA="$STATE_ROOT/hermes-open-webui" \
    docker compose -f "$ASSET_ROOT/hermes/docker-compose.yml" --project-name aideploy-hermes up -d
  if ! wait_for_http http://127.0.0.1:3001 100; then
    docker logs --tail 160 aideploy-hermes-webui >&2 || true
    return 1
  fi
  verify_hermes_webui_owner "$webui_owner_email" "$webui_owner_password"

  serve_dashboard 3001

  jq -n \
    --arg runtime "hermes" \
    --arg hostname "$TAILSCALE_DNS_NAME" \
    --arg url "$DASHBOARD_URL" \
    --arg provider "$provider" \
    --arg model "$model" \
    '{runtime:$runtime,tailscaleHostname:$hostname,dashboardUrl:$url,modelProvider:$provider,model:$model,modelVerified:true}' \
    >"$STATE_ROOT/runtime.json"
}

main() {
  require_config
  local deploy_id runtime provider api_key telegram_token telegram_user_id tailscale_key gateway_token webui_owner_email webui_owner_password hostname
  deploy_id="$(json_value deploy_id)"
  runtime="$(json_value runtime)"
  provider="$(json_value ai_provider)"
  api_key="$(json_value ai_api_key)"
  telegram_token="$(json_value telegram_bot_token)"
  telegram_user_id="$(json_value telegram_user_id)"
  tailscale_key="$(json_value tailscale_auth_key)"
  gateway_token="$(json_value gateway_token)"
  webui_owner_email="$(json_value hermes_webui_owner_email)"
  webui_owner_password="$(json_value hermes_webui_owner_password)"
  hostname="aideploy-$deploy_id"

  case "$runtime" in
    openclaw | hermes) ;;
    *) echo "[aideploy] Unsupported runtime: $runtime" >&2; return 1 ;;
  esac
  case "$provider" in
    openai | anthropic | kimi) ;;
    *) echo "[aideploy] Unsupported AI provider: $provider" >&2; return 1 ;;
  esac

  install_common_packages
  connect_tailscale "$tailscale_key" "$hostname"
  tailscale_key=""
  start_bootstrap_status
  load_tailscale_dns_name
  serve_bootstrap_status
  install_backup_timer

  if [ "$runtime" = "openclaw" ]; then
    install_openclaw "$deploy_id" "$provider" "$api_key" "$telegram_token" "$telegram_user_id" "$gateway_token"
  else
    install_hermes "$deploy_id" "$provider" "$api_key" "$telegram_token" "$telegram_user_id" "$gateway_token" "$webui_owner_email" "$webui_owner_password"
  fi

  chmod 600 "$STATE_ROOT/runtime.json"
  status "ready" "complete" "$runtime is ready on $TAILSCALE_DNS_NAME"
  echo "[aideploy] Runtime details:"
  jq . "$STATE_ROOT/runtime.json"
}

main "$@"
