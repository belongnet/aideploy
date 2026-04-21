##
## OpenClaw Agent Launcher — Docker Compose Template
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
      - "3000:3000"
    environment:
      PORT: "3000"
      DATABASE_URL: "postgresql://postgres:${DB_PASSWORD:?DB_PASSWORD is required}@${DB_HOST:-supabase-db}:${DB_PORT:-5432}/postgres"
      AGENT_COUNT: "${AGENT_COUNT:?AGENT_COUNT is required}"
      DEPLOY_ID: "${DEPLOY_ID:?DEPLOY_ID is required}"
      AGENT_SERVICE_TOKEN: "${AGENT_SERVICE_TOKEN:?AGENT_SERVICE_TOKEN is required}"
      AGENT_INTERNAL_HOST_TEMPLATE: "agent-{index0}"
      SUPABASE_URL: "${SUPABASE_URL:-http://supabase-kong:8000}"
      SUPABASE_PUBLIC_URL: "${SUPABASE_PUBLIC_URL:-http://localhost:8000}"
      SUPABASE_ANON_KEY: "${SUPABASE_ANON_KEY:-}"
      SUPABASE_SERVICE_ROLE_KEY: "${SUPABASE_SERVICE_ROLE_KEY:-}"
      AIDEPLOY_MAINTENANCE_TAILSCALE_POLICY: "${AIDEPLOY_MAINTENANCE_TAILSCALE_POLICY:-ssh-equivalent}"
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
      - "{{this.agent_port}}:{{this.agent_port}}"
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
      - "{{this.gateway_port}}:{{this.gateway_port}}"
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
      WHATSAPP_VERIFY_TOKEN: "openclaw-verify-{{../deploy_id}}"
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
      - "{{this.dashboard_port}}:{{this.dashboard_port}}"
    environment:
      PORT: "{{this.dashboard_port}}"
      DASHBOARD_PORT: "{{this.dashboard_port}}"
      AGENT_INDEX: "{{this.index}}"
      AGENT_NAME: "{{this.name}}"
      AGENT_HOST: "agent-{{this.index}}"
      AGENT_PORT: "{{this.agent_port}}"
      DEPLOY_ID: "{{../deploy_id}}"
      GATEWAY_INTERNAL_URL: "http://gateway-{{this.index}}:{{this.gateway_port}}"
      AGENT_SERVICE_TOKEN: "${AGENT_SERVICE_TOKEN:?AGENT_SERVICE_TOKEN is required}"
      SUPABASE_URL: "${SUPABASE_URL:-http://supabase-kong:8000}"
      SUPABASE_PUBLIC_URL: "${SUPABASE_PUBLIC_URL:-http://localhost:8000}"
      SUPABASE_ANON_KEY: "${SUPABASE_ANON_KEY:-}"
      SUPABASE_SERVICE_ROLE_KEY: "${SUPABASE_SERVICE_ROLE_KEY:-}"
      SUPABASE_STORAGE_BUCKET: "${SUPABASE_STORAGE_BUCKET:-agent-files}"
      NEXT_PUBLIC_SUPABASE_URL: "${SUPABASE_PUBLIC_URL:-http://localhost:8000}"
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "${SUPABASE_ANON_KEY:-}"
      AIDEPLOY_MAINTENANCE_TAILSCALE_POLICY: "${AIDEPLOY_MAINTENANCE_TAILSCALE_POLICY:-ssh-equivalent}"
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
