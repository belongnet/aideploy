# DEPRECATED

The services in this directory (agent, gateway, dashboard, master-dashboard, db) are
from the original Docker Compose-based architecture. They are no longer used.

## New Architecture

OpenClaw is now the user-facing default runtime. Our system deploys:
- **OpenClaw** via the pinned `ghcr.io/openclaw/openclaw` gateway container
- **Management Dashboard** (port 3000) — our multi-agent management UI in `provisioner/src/dashboard-generator.ts`
- **Docker Compose services** for the gateway, dashboard, Supabase, billing proxy, and extra runtime slots

Each agent has isolated `.openclaw` state, credentials, workspace roots, and
ports managed by the generated runtime contract.

The code in this directory is preserved for reference only. It is not the
OpenClaw runtime and should not be described as a public harness.
