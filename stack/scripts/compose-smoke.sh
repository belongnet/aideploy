#!/usr/bin/env bash
# compose-smoke.sh <openclaw|hermes> — credential-free stack smoke.
#
# Public CI runs this on every PR (design doc: public CI is credential-free).
# It renders the Handlebars compose template for ONE agent with dummy env,
# gates on `docker compose config` (catches template/compose drift), and —
# when SMOKE_UP=1 (CI) — boots db+dashboard and polls the health page.
# No cloud credentials, no external APIs.
set -euo pipefail
RUNTIME="${1:-openclaw}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mktemp -d /tmp/compose-smoke-XXXXXX)"
trap 'docker compose -f "$OUT/docker-compose.yml" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$OUT"' EXIT

# Render the {{#each agents}} template for a single agent (index 0).
python3 - "$HERE/docker-compose.yml.tpl" "$OUT/docker-compose.yml" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
agent = {
    "index": "0", "name": "agent-0", "schema_name": "agent_0",
    "agent_port": "8101", "gateway_port": "8081", "dashboard_port": "3001",
}
def render_block(m):
    body = m.group(1)
    body = body.replace("{{../deploy_id}}", "smoke")
    for k, v in agent.items():
        body = body.replace("{{this.%s}}" % k, v)
    return body
text = re.sub(r"\{\{#each agents\}\}(.*?)\{\{/each\}\}", render_block, text, flags=re.S)
text = text.replace("{{deploy_id}}", "smoke")
leftover = re.findall(r"\{\{[^}]+\}\}", text)
if leftover:
    sys.exit("unrendered template vars: %s" % sorted(set(leftover)))
open(dst, "w").write(text)
PY

export DB_PASSWORD=smoke-db-pass AGENT_COUNT=1 DEPLOY_ID=smoke \
  AGENT_SERVICE_TOKEN=smoke-service-token AIDEPLOY_RUNTIME="$RUNTIME" \
  AIDEPLOY_HOST_BIND=127.0.0.1
echo "==> compose config gate ($RUNTIME)"
docker compose -f "$OUT/docker-compose.yml" config -q
echo "config OK"

if [ "${SMOKE_UP:-0}" = "1" ]; then
  echo "==> booting db + master-dashboard (no cloud)"
  docker compose -f "$OUT/docker-compose.yml" up -d --build supabase-db master-dashboard 2>/dev/null \
    || docker compose -f "$OUT/docker-compose.yml" up -d --build master-dashboard
  for i in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:3000/ >/dev/null 2>&1; then
      echo "health page up after ${i}0s"; exit 0
    fi
    sleep 10
  done
  echo "master-dashboard never became healthy" >&2
  docker compose -f "$OUT/docker-compose.yml" logs --tail 50 >&2
  exit 1
fi
echo "==> smoke passed (config-only mode; set SMOKE_UP=1 for boot check)"
