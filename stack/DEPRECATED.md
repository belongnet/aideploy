# DEPRECATED

The services in this directory (agent, gateway, dashboard, master-dashboard, db) are
from the original Docker Compose-based architecture. They are no longer used.

## New Architecture

OpenClaw is now the agent runtime. Our system deploys:
- **OpenClaw** (installed globally via `npm install -g openclaw@latest`) — the AI agent runtime
- **Management Dashboard** (port 3000) — our multi-agent management UI in `provisioner/src/dashboard-generator.ts`
- **systemd services** — each OpenClaw agent runs as `openclaw-agent@{id}.service`

Each agent lives in `~/.openclaw/agents/{id}/openclaw.json` with its own config,
credentials, and port (starting at 18789).

The code in this directory is preserved for reference only.
