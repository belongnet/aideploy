# aideploy

### Your AI agent. Your cloud. Your rules.

[![CI](https://github.com/belongnet/aideploy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/belongnet/aideploy/actions/workflows/ci.yml)
[![Release](https://github.com/belongnet/aideploy/actions/workflows/release.yml/badge.svg)](https://github.com/belongnet/aideploy/releases)
[![Latest release](https://img.shields.io/github/v/release/belongnet/aideploy?include_prereleases&sort=semver)](https://github.com/belongnet/aideploy/releases/latest)
[![OpenClaw image](https://img.shields.io/badge/GHCR-signed-2496ED?logo=docker&logoColor=white)](https://github.com/belongnet/aideploy/pkgs/container/aideploy-openclaw-runtime)
[![License](https://img.shields.io/badge/core-Apache--2.0-blue)](#licensing)

**aideploy is the deployment and operations layer for private AI agents.** It
turns a cloud account, an AI provider, a messaging channel, and a Tailscale
network into a working [OpenClaw](https://github.com/openclaw/openclaw) or
Hermes Agent deployment—with live readiness proof, private browser access,
backups, diagnostics, and deterministic teardown.

Start with the public self-host kit in this repository, or use
[aideploy.co](https://www.aideploy.co/?utm_source=github&utm_medium=readme&utm_campaign=public_launch)
for the guided OAuth flow, more clouds and channels, multi-agent fleets, and
managed operations.

[**Launch with the hosted wizard →**](https://www.aideploy.co/?utm_source=github&utm_medium=readme_cta&utm_campaign=public_launch)
 · [**Self-host from source →**](#self-host-in-your-own-cloud)
 · [**Read the release notes →**](https://github.com/belongnet/aideploy/releases)

## What makes aideploy different

- **It runs in your cloud account.** You own the VM, data, runtime state, and
  cloud bill. The agent is not trapped inside somebody else's chat SaaS.
- **A deploy is not “done” because a VM exists.** aideploy waits for the real
  runtime, model path, Telegram path, and private browser surface to become
  usable before it reports success.
- **Private by default.** Runtime and dashboard ports stay on loopback and are
  exposed to your devices through Tailscale Serve HTTPS. The public self-host
  path needs only two tailnet nodes: your device and the VM.
- **Choose the agent runtime.** OpenClaw is the multi-agent path; Hermes is a
  lean single-agent alternative. Both are beta and tested as real booting
  runtimes, not configuration-file mocks.
- **The whole lifecycle is covered.** Deploy, inspect, diagnose, back up,
  restore, replace, and destroy without hunting for orphaned resources.
- **The supply chain is verifiable.** Images are digest-pinned and keyless
  Sigstore-signed; Hermes source is checksum-pinned; release archives bind the
  exact commit and source tree consumed by the hosted build.

## Two ways to run it

| | Public self-host kit — this repo | Hosted + managed platform |
|---|---|---|
| Best for | Developers who want full control | Individuals, teams, agencies, and fleet operators |
| Setup | Source checkout today; `npx aideploy` after the npm beta is enabled | Guided web wizard and API |
| Cloud | DigitalOcean golden path | DigitalOcean, OVHcloud, Google Cloud, AWS, and Scaleway adapters |
| Runtime | OpenClaw or Hermes | OpenClaw or Hermes |
| AI auth | OpenAI, Anthropic, or Kimi API key | ChatGPT and Claude connection flows plus OpenAI, Anthropic, Gemini, Kimi, and DeepSeek keys |
| Messaging | Telegram | OpenClaw: Telegram, WhatsApp, Slack, Discord, Signal, iMessage, Google Chat, Teams; Hermes: Telegram and WhatsApp |
| Agents | One deployment at a time | 1–16 agents per deployment, isolated workspaces, virtual-office presets |
| Operations | Local status, daily VM backup, blue/green upgrade, full teardown | Command Center, monitoring, offsite backup, managed updates, REST API and MCP |
| Network | Tailscale-private browser and runtime | Same private data plane, with conditional signed webhook ingress when a channel needs it |

The public repository is the generic deployment foundation. Managed features
are a separate product layer; this README labels that boundary instead of
pretending every hosted feature ships in the public CLI.

## Self-host in your own cloud

The current public beta supports **DigitalOcean + Telegram**. Choose either
OpenClaw or Hermes and one of OpenAI, Anthropic, or Kimi.

### Before you deploy

Run the CLI on **macOS or Linux** (amd64 or arm64) with Node.js 18.3 or newer
and [Cosign](https://docs.sigstore.dev/cosign/system_config/installation/).
Windows is not yet supported because safe OpenTofu interruption depends on
POSIX process groups. You also need four credentials:

1. A DigitalOcean read/write API token.
2. An OpenAI, Anthropic, or Kimi API key.
3. A Telegram bot token from **@BotFather** and your numeric account ID from
   **@userinfobot**.
4. A one-off Tailscale auth key with **Reusable disabled**.

Install Tailscale on the laptop or phone that will open the agent, sign it into
the same tailnet, enable MagicDNS and HTTPS certificates, then run the beta from
the tagged source release:

```bash
(
set -Eeuo pipefail

git clone --branch v0.4.2-beta.5 --depth 1 https://github.com/belongnet/aideploy.git
cd aideploy

release=v0.4.2-beta.5
digest_dir="$(mktemp -d)"
manifest="$digest_dir/aideploy-base-$release.manifest.json"
bundle="$manifest.sigstore.json"
curl -fsSL \
  "https://github.com/belongnet/aideploy/releases/download/$release/aideploy-base-$release.manifest.json" \
  -o "$manifest"
curl -fsSL \
  "https://github.com/belongnet/aideploy/releases/download/$release/aideploy-base-$release.manifest.json.sigstore.json" \
  -o "$bundle"
identity="https://github.com/belongnet/aideploy/.github/workflows/release.yml@refs/tags/$release"
issuer="https://token.actions.githubusercontent.com"
cosign verify-blob \
  --bundle "$bundle" \
  --certificate-identity "$identity" \
  --certificate-oidc-issuer "$issuer" \
  "$manifest"

# Fail closed unless this checkout is the exact commit and tree recorded in
# the signed release manifest. Do this before running any repository script.
expected_commit="$(node -e \
  'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(m.commitSha)' \
  "$manifest")"
expected_tree="$(node -e \
  'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(m.sourceTreeSha)' \
  "$manifest")"
test "$(git rev-parse HEAD)" = "$expected_commit"
test "$(git rev-parse 'HEAD^{tree}')" = "$expected_tree"

node -e \
  'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(m.runtimeImages.openclaw)' \
  "$manifest" > "$digest_dir/openclaw-runtime"
digest="$(tr -d '[:space:]' < "$digest_dir/openclaw-runtime")"
cosign verify \
  --certificate-identity "$identity" \
  --certificate-oidc-issuer "$issuer" \
  "ghcr.io/belongnet/aideploy-openclaw-runtime@$digest"

# Only now execute the verified checkout and prepare its release assets.
./cli/scripts/vendor-assets.sh
GITHUB_REPOSITORY_OWNER=belongnet ./cli/scripts/pin-image-digests.sh "$digest_dir"

npm --prefix cli ci
npm --prefix cli run build
node cli/dist/index.js up
)
```

The source setup is intentionally explicit until the npm publication gate is
enabled. Once `aideploy` appears on npm, the equivalent command is:

```bash
npx aideploy up
```

The CLI validates credentials, region, server size, Tailscale prerequisites,
and the live DigitalOcean account **before** it creates billable resources. It
then downloads checksum-verified OpenTofu, creates one tagged VM, installs the
selected runtime, waits for a live AI response and private HTTPS surface, and
prints the browser sign-in plus a Telegram test.

```bash
node cli/dist/index.js doctor             # find every aideploy-tagged resource
node cli/dist/index.js down <deploy-id>   # destroy the deployment and scrub local secrets
```

OpenClaw saves its private one-click sign-in; Hermes saves the owner login.
Both live in `~/.aideploy/<deploy-id>/access.json` with mode `0600`. A successful
teardown deletes credentials, OpenTofu state, provider cache, and browser access,
leaving only a non-secret destruction receipt.

See the complete [self-host guide](./docs/self-host.md),
[backup and restore guide](./docs/backup-restore.md), and
[upgrade guide](./docs/upgrade.md).

## Full platform support matrix

### Cloud providers

| Provider | Public repository | Hosted platform | Current status |
|---|---|---|---|
| **DigitalOcean** | Live CLI module | OAuth wizard | **Golden path; CI + live E2E** |
| **OVHcloud** | Not in the v1 CLI | Application credentials | Hosted beta; production control plane runs on OVH |
| **Google Cloud** | OpenTofu reference module | OAuth adapter | Hosted beta; public module validate-only |
| **AWS** | OpenTofu reference module | Access-key adapter | Hosted beta; public module validate-only |
| **Scaleway Apple Silicon** | Not in the v1 CLI | API-key adapter | Hosted beta |
| **Microsoft Azure** | OpenTofu reference module | Retained compatibility only | Validate-only; new hosted Azure deployments are disabled |

“Reference module” means credential-free `tofu validate` runs in CI, but the
public `aideploy up` command does not execute that module yet. We would rather
show a precise support level than turn an untested adapter into a marketing
checkmark.

### Agent runtimes

| Runtime | Shape | Public self-host | Hosted |
|---|---|---|---|
| **OpenClaw** | Multi-agent gateway and browser UI | Beta | Beta |
| **Hermes Agent** | Fast single-agent runtime with skill workspace | Beta | Beta, default |

OpenClaw boots from the signed aideploy wrapper image. Hermes downloads a
commit-specific source archive and refuses to install if its SHA-256 differs
from the reviewed manifest.

### AI providers

| Provider | Public self-host | Hosted connection | Default hosted model |
|---|---|---|---|
| OpenAI / ChatGPT | API key | ChatGPT device connection or API key | GPT-5.5 |
| Anthropic / Claude | API key | Claude connection or API key | Claude Opus 4.8 (1M) |
| Google Gemini | — | API key | Gemini 3 Deep Think |
| Kimi | API key | API key | Kimi K2.6 |
| DeepSeek | — | API key | DeepSeek Chat |

Hosted agents can also connect an owner-managed Composio account for Gmail,
Google Calendar, Sheets, Notion, Slack, HubSpot, and other business apps. Those
credentials stay owner-controlled and are never accepted through ordinary chat.

### Messaging and surfaces

| Surface | Public self-host | Hosted OpenClaw | Hosted Hermes |
|---|---:|---:|---:|
| Private browser over Tailscale HTTPS | ✅ | ✅ | ✅ |
| Telegram | ✅ outbound polling | ✅ | ✅ |
| WhatsApp Cloud API | — | ✅ | ✅ beta bridge |
| Slack | — | ✅ | — |
| Discord, Signal, iMessage, Google Chat, Teams | — | ✅ | — |

Public webhook ingress is conditional: it is opened only for a selected channel
that requires inbound delivery. Telegram remains private and uses outbound
polling.

## From one agent to a command center

The hosted product builds on the same runtime contract:

- Deploy **1–16 agents** on one server with isolated workspaces, models,
  channels, and responsibilities.
- Use virtual-office presets for research, sales, operations, publishing, and
  specialist handoffs instead of starting from blank prompts.
- Share long-term memory through Supabase/Postgres and route delegation over a
  Postgres `LISTEN/NOTIFY` bus.
- Operate agents from per-agent dashboards and a fleet-level Command Center.
- Attach separately entitled workload overlays without baking customer or
  internal agent code into the generic public image.
- Manage deployments through the web wizard, REST API, or MCP server.
- Add central heartbeats, diagnostics, offsite backups, signed updates, and
  rollback-aware release management while the data plane stays in the
  customer's cloud.

That separation is deliberate: `belongnet/aideploy` is the reusable public
foundation; the hosted control plane consumes an immutable, signed public
release instead of copying source from a private monorepo.

## Architecture

```text
Your laptop / phone
        │
        │ Tailscale Serve HTTPS
        ▼
┌──────────────────────── your cloud VM ────────────────────────┐
│  private browser UI  ──►  OpenClaw or Hermes runtime          │
│                              │                                 │
│  Telegram polling  ◄─────────┤  AI provider                   │
│                              │                                 │
│  daily backup timer  ◄──── workspace + runtime state          │
│                                                                │
│  loopback-only services; no public dashboard/runtime ports     │
└────────────────────────────────────────────────────────────────┘
```

The managed platform expands this base with a Supabase data plane, dashboards,
multi-agent orchestration, provider-native object storage, workload overlays,
and a signed control-plane release set. The VM and agent data still remain in
the selected customer cloud.

## Security and release integrity

- Local deployment state and browser credentials are written with mode `0600`.
- The one-off Tailscale key is erased from runtime configuration after the VM
  joins the tailnet.
- Only the supplied numeric Telegram owner ID can message the self-hosted bot.
- Runtime ports bind to loopback; access is through private Tailscale HTTPS.
- Every cloud resource has generic and deploy-specific tags, so `doctor` can
  find orphaned infrastructure even when local state is damaged.
- CI is credential-free for forks and pins every GitHub Action by commit SHA.
- Public releases include deterministic source archives, manifests, SHA-256
  values, and keyless Sigstore bundles.

Verify the beta.5 release manifest, then verify the exact OpenClaw image digest
recorded in it:

```bash
release=v0.4.2-beta.5
release_dir="$(mktemp -d)"
base="https://github.com/belongnet/aideploy/releases/download/$release/aideploy-base-$release.manifest.json"
curl -fsSL "$base" -o "$release_dir/manifest.json"
curl -fsSL "$base.sigstore.json" -o "$release_dir/manifest.sigstore.json"

identity="https://github.com/belongnet/aideploy/.github/workflows/release.yml@refs/tags/$release"
issuer="https://token.actions.githubusercontent.com"
cosign verify-blob \
  --bundle "$release_dir/manifest.sigstore.json" \
  --certificate-identity "$identity" \
  --certificate-oidc-issuer "$issuer" \
  "$release_dir/manifest.json"

digest="$(node -e \
  'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(m.runtimeImages.openclaw)' \
  "$release_dir/manifest.json")"
cosign verify \
  --certificate-identity "$identity" \
  --certificate-oidc-issuer "$issuer" \
  "ghcr.io/belongnet/aideploy-openclaw-runtime@$digest"
```

Report vulnerabilities privately through GitHub or
`security@aideploy.co`; see [SECURITY.md](./SECURITY.md).

## Repository map

| Path | Purpose |
|---|---|
| [`cli/`](./cli) | The `aideploy` lifecycle CLI |
| [`stack/runtime/`](./stack/runtime) | Live OpenClaw and Hermes bootstrap/runtime assets |
| [`terraform/self-host-digitalocean/`](./terraform/self-host-digitalocean) | Live public DigitalOcean module |
| [`terraform/`](./terraform) | Provider reference modules and contracts |
| [`contracts/`](./contracts) | Runtime update and compatibility contracts |
| [`docs/`](./docs) | Self-hosting, backups, upgrades, and project provenance |
| [`stack/`](./stack) | Deprecated Python/Compose reference architecture, not the live CLI path |

## Project status and history

This is a public beta. The support labels above are contractual: DigitalOcean +
Telegram is the self-host golden path, both runtimes boot in CI, and broader
provider/channel support belongs to the hosted product until it graduates into
the public CLI.

The repository intentionally began with one clean, source-only root commit on
August 24, 2026. Importing the private product monorepo's historical objects
would have exposed private paths and invalidated the public-source boundary.
From the clean launch onward, normal changes land through protected pull
requests with required CI. See [Project history and provenance](./docs/project-history.md).

## Licensing

The deployed stack, OpenTofu modules, and contracts are **Apache-2.0**. The
`cli/` directory is **FSL-1.1-ALv2**: it is free to use, modify, and self-host;
offering it as a competing managed service is restricted for two years per
release, after which that release converts to Apache-2.0. Details are in
[`cli/LICENSE.md`](./cli/LICENSE.md).

Built on the MIT-licensed OpenClaw and gstack projects; see [NOTICE](./NOTICE).

## Build with us

Contributions that make the path from clone to “my agent replied” faster,
safer, or available on another provider are especially welcome. Start with
[CONTRIBUTING.md](./CONTRIBUTING.md), open an
[issue](https://github.com/belongnet/aideploy/issues), or try the
[hosted wizard](https://www.aideploy.co/?utm_source=github&utm_medium=readme_footer&utm_campaign=public_launch).
