##
## OpenClaw Agent Launcher — Docker Compose Template
## Handlebars template rendered by the provisioner for N agents.
##
## Variables: deploy_id, db_password, encryption_key, agent_count, agents[]
##

version: "3.9"

services:
  # ── Database ──────────────────────────────────────────────────
  db:
    build: ./db
    container_name: openclaw-db
    restart: unless-stopped
    environment:
      POSTGRES_DB: openclaw
      POSTGRES_USER: openclaw
      POSTGRES_PASSWORD: "{{db_password}}"
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - openclaw
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U openclaw -d openclaw"]
      interval: 10s
      timeout: 5s
      retries: 5

  # ── Master Dashboard ──────────────────────────────────────────
  master-dashboard:
    build: ./master-dashboard
    container_name: openclaw-master-dashboard
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      PORT: "3000"
      DATABASE_URL: "postgresql://openclaw:{{db_password}}@db:5432/openclaw"
      AGENT_COUNT: "{{agent_count}}"
      DEPLOY_ID: "{{deploy_id}}"
    depends_on:
      db:
        condition: service_healthy
    networks:
      - openclaw

  # ── Per-Agent Services ────────────────────────────────────────
  {{#each agents}}
  agent-{{this.index}}:
    build: ./agent
    container_name: openclaw-agent-{{this.index}}
    restart: unless-stopped
    ports:
      - "{{this.agent_port}}:{{this.agent_port}}"
    environment:
      AGENT_INDEX: "{{this.index}}"
      AGENT_SCHEMA: "{{this.schema_name}}"
      AGENT_PORT: "{{this.agent_port}}"
      DATABASE_URL: "postgresql://openclaw:{{../db_password}}@db:5432/openclaw"
      DB_PASSWORD: "{{../db_password}}"
      ENCRYPTION_KEY: "{{../encryption_key}}"
      DEPLOY_ID: "{{../deploy_id}}"
    depends_on:
      db:
        condition: service_healthy
    networks:
      - openclaw

  gateway-{{this.index}}:
    build: ./gateway
    container_name: openclaw-gateway-{{this.index}}
    restart: unless-stopped
    ports:
      - "{{this.gateway_port}}:{{this.gateway_port}}"
    environment:
      AGENT_INDEX: "{{this.index}}"
      GATEWAY_PORT: "{{this.gateway_port}}"
      AGENT_URL: "http://agent-{{this.index}}:{{this.agent_port}}"
      DEPLOY_ID: "{{../deploy_id}}"
      TELEGRAM_BOT_TOKEN: "${CHANNEL_{{this.index}}_TELEGRAM_TOKEN:-}"
      WHATSAPP_ACCESS_TOKEN: "${CHANNEL_{{this.index}}_WHATSAPP_TOKEN:-}"
      WHATSAPP_VERIFY_TOKEN: "openclaw-verify-{{../deploy_id}}"
      WHATSAPP_PHONE_NUMBER_ID: "${CHANNEL_{{this.index}}_WHATSAPP_PHONE_ID:-}"
      SLACK_BOT_TOKEN: "${CHANNEL_{{this.index}}_SLACK_TOKEN:-}"
      SLACK_SIGNING_SECRET: "${CHANNEL_{{this.index}}_SLACK_SECRET:-}"
    depends_on:
      - agent-{{this.index}}
    networks:
      - openclaw

  dashboard-{{this.index}}:
    build: ./dashboard
    container_name: openclaw-dashboard-{{this.index}}
    restart: unless-stopped
    ports:
      - "{{this.dashboard_port}}:{{this.dashboard_port}}"
    environment:
      PORT: "{{this.dashboard_port}}"
      DASHBOARD_PORT: "{{this.dashboard_port}}"
      AGENT_URL: "http://agent-{{this.index}}:{{this.agent_port}}"
      AGENT_INDEX: "{{this.index}}"
      AGENT_NAME: "{{this.name}}"
    depends_on:
      - agent-{{this.index}}
    networks:
      - openclaw
  {{/each}}

volumes:
  pgdata:
    driver: local

networks:
  openclaw:
    driver: bridge
