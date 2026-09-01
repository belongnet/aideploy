##
## AI Deploy — Docker Compose Template
## Handlebars template rendered by the provisioner for N agents.
##
## Variables: deploy_id, db_password, encryption_key, agent_count, agents[]
##

services:
  # ── Master Dashboard ──────────────────────────────────────────
  master-dashboard:
    build: ./master-dashboard
    container_name: openclaw-master-dashboard
    restart: unless-stopped
    # init reaps child processes; without it, PID 1 accumulates zombies from
    # exec/subprocess tools until new exec calls hang.
    init: true
    ports:
      - "${AIDEPLOY_HOST_BIND:-127.0.0.1}:3000:3000"
    environment:
      PORT: "3000"
      DATABASE_URL: "postgresql://postgres:${DB_PASSWORD:?DB_PASSWORD is required}@${DB_HOST:-supabase-db}:${DB_PORT:-5432}/postgres"
      AGENT_COUNT: "${AGENT_COUNT:?AGENT_COUNT is required}"
      DEPLOY_ID: "${DEPLOY_ID:?DEPLOY_ID is required}"
      AIDEPLOY_LOCALE: "${AIDEPLOY_LOCALE:-en}"
      AGENT_SERVICE_TOKEN: "${AGENT_SERVICE_TOKEN:?AGENT_SERVICE_TOKEN is required}"
      AGENT_INTERNAL_HOST_TEMPLATE: "agent-{index0}"
      DASHBOARD_TOKEN: "${DASHBOARD_TOKEN:-}"
      DASHBOARD_BOOTSTRAP_TOKEN: "${DASHBOARD_BOOTSTRAP_TOKEN:-}"
      AIDEPLOY_MAINTENANCE_TOKEN: "${AIDEPLOY_MAINTENANCE_TOKEN:-}"
      AIDEPLOY_DASHBOARD_JSON_MAX_BODY_BYTES: "${AIDEPLOY_DASHBOARD_JSON_MAX_BODY_BYTES:-65536}"
      AIDEPLOY_DASHBOARD_REQUEST_BODY_LIMIT: "${AIDEPLOY_DASHBOARD_REQUEST_BODY_LIMIT:-1mb}"
      SUPABASE_URL: "${SUPABASE_URL:-http://supabase-kong:8000}"
      SUPABASE_PUBLIC_URL: "${SUPABASE_PUBLIC_URL:-http://localhost:8000}"
      SUPABASE_ANON_KEY: "${SUPABASE_ANON_KEY:-}"
      SUPABASE_SERVICE_ROLE_KEY: "${SUPABASE_SERVICE_ROLE_KEY:-}"
      AIDEPLOY_MAINTENANCE_TAILSCALE_POLICY: "${AIDEPLOY_MAINTENANCE_TAILSCALE_POLICY:-disabled}"
    networks:
      - openclaw
      - supabase

  # ── Per-Agent Services ────────────────────────────────────────
  {{#each agents}}
  agent-{{this.index}}:
    build: ./agent
    container_name: openclaw-agent-{{this.index}}
    restart: unless-stopped
    init: true
    ports:
      - "${AIDEPLOY_HOST_BIND:-127.0.0.1}:{{this.agent_port}}:{{this.agent_port}}"
    environment:
      AGENT_INDEX: "{{this.index}}"
      AGENT_SCHEMA: "{{this.schema_name}}"
      AGENT_PORT: "{{this.agent_port}}"
      AGENT_WORKSPACE_DIR: "/workspace"
      DATABASE_URL: "postgresql://postgres:${DB_PASSWORD:?DB_PASSWORD is required}@${DB_HOST:-supabase-db}:${DB_PORT:-5432}/postgres"
      DB_PASSWORD: "${DB_PASSWORD:?DB_PASSWORD is required}"
      ENCRYPTION_KEY: "${ENCRYPTION_KEY:?ENCRYPTION_KEY is required}"
      DEPLOY_ID: "${DEPLOY_ID:?DEPLOY_ID is required}"
      AGENT_SERVICE_TOKEN: "${AGENT_SERVICE_TOKEN:?AGENT_SERVICE_TOKEN is required}"
      OPENCLAW_AGENT_MAX_REQUEST_BODY_BYTES: "${OPENCLAW_AGENT_MAX_REQUEST_BODY_BYTES:-1048576}"
      OPENCLAW_AGENT_API_CALL_ALLOWED_HOSTS: "${OPENCLAW_AGENT_API_CALL_ALLOWED_HOSTS:-}"
      OPENCLAW_AGENT_ALLOW_PRIVATE_API_CALLS: "${OPENCLAW_AGENT_ALLOW_PRIVATE_API_CALLS:-false}"
      SUPABASE_URL: "${SUPABASE_URL:-http://supabase-kong:8000}"
      SUPABASE_PUBLIC_URL: "${SUPABASE_PUBLIC_URL:-http://localhost:8000}"
      SUPABASE_ANON_KEY: "${SUPABASE_ANON_KEY:-}"
      SUPABASE_SERVICE_ROLE_KEY: "${SUPABASE_SERVICE_ROLE_KEY:-}"
      SUPABASE_JWT_SECRET: "${SUPABASE_JWT_SECRET:-}"
    volumes:
      - agent-workspace-{{this.index}}:/workspace
    networks:
      - openclaw
      - supabase

  gateway-{{this.index}}:
    build: ./gateway
    container_name: openclaw-gateway-{{this.index}}
    restart: unless-stopped
    init: true
    ports:
      - "${AIDEPLOY_HOST_BIND:-127.0.0.1}:{{this.gateway_port}}:{{this.gateway_port}}"
    environment:
      AGENT_INDEX: "{{this.index}}"
      GATEWAY_PORT: "{{this.gateway_port}}"
      AGENT_URL: "http://agent-{{this.index}}:{{this.agent_port}}"
      DASHBOARD_INTERNAL_URL: "http://dashboard-{{this.index}}:{{this.dashboard_port}}"
      DEPLOY_ID: "{{../deploy_id}}"
      AGENT_SERVICE_TOKEN: "${AGENT_SERVICE_TOKEN:?AGENT_SERVICE_TOKEN is required}"
      TELEGRAM_BOT_TOKEN: "${CHANNEL_{{this.index}}_TELEGRAM_TOKEN:-}"
      TELEGRAM_WEBHOOK_SECRET: "${CHANNEL_{{this.index}}_TELEGRAM_SECRET:-}"
      WHATSAPP_ACCESS_TOKEN: "${CHANNEL_{{this.index}}_WHATSAPP_TOKEN:-}"
      WHATSAPP_VERIFY_TOKEN: "${CHANNEL_{{this.index}}_WHATSAPP_VERIFY_TOKEN:-${WHATSAPP_VERIFY_TOKEN:-}}"
      WHATSAPP_PHONE_NUMBER_ID: "${CHANNEL_{{this.index}}_WHATSAPP_PHONE_ID:-}"
      WHATSAPP_APP_SECRET: "${CHANNEL_{{this.index}}_WHATSAPP_APP_SECRET:-}"
      SLACK_BOT_TOKEN: "${CHANNEL_{{this.index}}_SLACK_TOKEN:-}"
      SLACK_SIGNING_SECRET: "${CHANNEL_{{this.index}}_SLACK_SECRET:-}"
      SUPABASE_URL: "${SUPABASE_URL:-http://supabase-kong:8000}"
      SUPABASE_SERVICE_ROLE_KEY: "${SUPABASE_SERVICE_ROLE_KEY:-}"
      SUPABASE_STORAGE_BUCKET: "${SUPABASE_STORAGE_BUCKET:-agent-files}"
      SUPABASE_STORAGE_MAX_BYTES: "${SUPABASE_STORAGE_MAX_BYTES:-26214400}"
    depends_on:
      - agent-{{this.index}}
    networks:
      - openclaw
      - supabase

  dashboard-{{this.index}}:
    build: ./dashboard
    container_name: openclaw-dashboard-{{this.index}}
    restart: unless-stopped
    init: true
    ports:
      - "${AIDEPLOY_HOST_BIND:-127.0.0.1}:{{this.dashboard_port}}:{{this.dashboard_port}}"
    environment:
      PORT: "{{this.dashboard_port}}"
      DASHBOARD_PORT: "{{this.dashboard_port}}"
      AGENT_INDEX: "{{this.index}}"
      AGENT_NAME: "{{this.name}}"
      AGENT_HOST: "agent-{{this.index}}"
      AGENT_PORT: "{{this.agent_port}}"
      DEPLOY_ID: "{{../deploy_id}}"
      AIDEPLOY_LOCALE: "${AIDEPLOY_LOCALE:-en}"
      GATEWAY_INTERNAL_URL: "http://gateway-{{this.index}}:{{this.gateway_port}}"
      AGENT_SERVICE_TOKEN: "${AGENT_SERVICE_TOKEN:?AGENT_SERVICE_TOKEN is required}"
      DASHBOARD_TOKEN: "${DASHBOARD_TOKEN:-}"
      DASHBOARD_BOOTSTRAP_TOKEN: "${DASHBOARD_BOOTSTRAP_TOKEN:-}"
      AIDEPLOY_MAINTENANCE_TOKEN: "${AIDEPLOY_MAINTENANCE_TOKEN:-}"
      AIDEPLOY_DASHBOARD_JSON_MAX_BODY_BYTES: "${AIDEPLOY_DASHBOARD_JSON_MAX_BODY_BYTES:-65536}"
      AIDEPLOY_DASHBOARD_REQUEST_BODY_LIMIT: "${AIDEPLOY_DASHBOARD_REQUEST_BODY_LIMIT:-1mb}"
      SUPABASE_URL: "${SUPABASE_URL:-http://supabase-kong:8000}"
      SUPABASE_PUBLIC_URL: "${SUPABASE_PUBLIC_URL:-http://localhost:8000}"
      SUPABASE_ANON_KEY: "${SUPABASE_ANON_KEY:-}"
      SUPABASE_SERVICE_ROLE_KEY: "${SUPABASE_SERVICE_ROLE_KEY:-}"
      SUPABASE_STORAGE_BUCKET: "${SUPABASE_STORAGE_BUCKET:-agent-files}"
      NEXT_PUBLIC_SUPABASE_URL: "${SUPABASE_PUBLIC_URL:-http://localhost:8000}"
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "${SUPABASE_ANON_KEY:-}"
      AIDEPLOY_MAINTENANCE_TAILSCALE_POLICY: "${AIDEPLOY_MAINTENANCE_TAILSCALE_POLICY:-disabled}"
    depends_on:
      - agent-{{this.index}}
    networks:
      - openclaw
      - supabase
  {{/each}}

networks:
  openclaw:
    driver: bridge
  supabase:
    external: true
    name: supabase_default

volumes:
  {{#each agents}}
  agent-workspace-{{this.index}}:
  {{/each}}
