# aideploy — production deployment kit for OpenClaw and Hermes agents, on your own cloud

Source: [github.com/belongnet/aideploy](https://github.com/belongnet/aideploy)

<!-- PROVENANCE-BLOCK: numbers stamped by the assembly script -->
> **In production since early 2026.** Extracted from our production monorepo
> (**597 commits** across the platform, counted at extraction): every one of the
> **160 commits and 60 releases** that ever touched this public code carries
> over with full, real history — run `git log` and check. The control-plane
> commits stay private; nothing here is a squashed facade. Same code that powers
> the hosted product at [aideploy.co](https://www.aideploy.co/?utm_source=github&utm_medium=readme).

Your agent runs on **your** cloud account — not someone else's platform. One
command deploys [OpenClaw](https://github.com/openclaw/openclaw) (beta,
default) or Hermes Agent (beta, with
[gstack](https://github.com/garrytan/gstack)) with a
Telegram gateway, a private browser surface over Tailscale, VM-local state and
backups, and a documented upgrade path.

## Before the one command: get these 4 keys (~10 minutes)

| # | Credential | Where |
|---|---|---|
| 1 | DigitalOcean API token (read+write) | https://cloud.digitalocean.com/account/api/tokens |
| 2 | AI provider API key (OpenAI, Anthropic, or Kimi) | your provider dashboard |
| 3 | Telegram bot token + your numeric account ID | **@BotFather** → `/newbot`, **@userinfobot** → `/start` |
| 4 | One-off Tailscale auth key (leave **Reusable** off) | https://login.tailscale.com/admin/settings/keys |

Honesty note: creating the keys is the hard part. The deploy itself is one
command and a few minutes of watching progress. Install Tailscale on the
laptop/phone you will use and sign it into the same tailnet first; the VM is
the second and only other required node. Keep MagicDNS enabled and enable
Tailscale HTTPS certificates so the CLI can print a private `https://` URL.
The VM erases the consumed one-off auth key from runtime config immediately
after it joins.

```bash
npx aideploy up
```

That's it. The CLI validates your region/size against the live DigitalOcean
API, downloads a checksum-verified OpenTofu, creates one VM, boots the full
runtime from a signed image (OpenClaw) or checksum-pinned installer (Hermes),
waits for it to answer through Tailscale Serve HTTPS, and prints the private
browser sign-in, Telegram test instruction, and teardown command. It also saves
the browser credential to `~/.aideploy/<deploy-id>/access.json` with mode
`0600`; treat that file and the printed sign-in URL as secrets. OpenClaw stores
the credential only for that browser tab/session, so open the full sign-in link
again in each new session. Hermes prints and saves its owner email and password.

```bash
npx aideploy down <deploy-id>   # full teardown
npx aideploy doctor             # list every aideploy-tagged resource on your account
```

Successful teardown removes the local browser credential, cloud/AI/messaging
credentials, OpenTofu state, and provider cache, leaving only a non-secret
`destroyed.json` receipt.

**Zero-setup alternative:** the [hosted wizard](https://www.aideploy.co/?utm_source=github&utm_medium=readme_alt)
does the same deploy with 3 OAuth logins and no API keys, plus a managed tier
(monitoring, offsite backups, auto-upgrades) when you'd rather not operate it
yourself.

## What's in the box

| Capability | This kit | [Managed tier](https://www.aideploy.co/?utm_source=github&utm_medium=feature_table) |
|---|---|---|
| Deploy to your own cloud | ✅ CLI, API keys | ✅ OAuth 3-login wizard |
| Tailscale-private dashboards | ✅ | ✅ |
| Backups | ✅ encrypted-tailnet access + VM-local archive job | ✅ offsite + verified |
| Upgrades | ✅ documented procedure per release | ✅ automatic |
| Monitoring | local status + container/systemd health | ✅ central heartbeats + alerting |

## Support boundaries (honest labels)

- **Golden path (beta, CI + live E2E):** DigitalOcean + OpenClaw + Telegram.
- **Alternate runtime (beta, CI + rotating live E2E):** Hermes Agent + Telegram.
- **Community-supported (validate-only CI):** the reference `terraform/` modules for AWS, GCP, and Azure. The CLI golden path doesn't drive them yet. PRs welcome.
- **Messaging boundary:** the public CLI currently wires Telegram only. Legacy
  WhatsApp/Slack code is reference-only and is not part of `aideploy up`;
  channels offered by the hosted service are a separate support promise.
- **Not here yet:** Scaleway/OVH modules and additional public-CLI messaging
  adapters.

## Repository layout

- `stack/runtime/` — live OpenClaw + Hermes bootstrap assets (Apache-2.0)
- `stack/agent`, `stack/gateway`, and dashboards — legacy Compose architecture retained as reference, not used by `aideploy up`
- `terraform/self-host-digitalocean/` — the live CLI golden-path module; other provider modules are validate-only references (Apache-2.0)
- `contracts/` — upgrade/updater JSON contracts (Apache-2.0)
- `cli/` — `npx aideploy` (FSL-1.1-ALv2: free to self-host, converts to Apache-2.0 after two years; the one thing you can't do with it is sell it as a competing managed service — [why](./cli/LICENSE.md))
- `docs/` — [self-host](./docs/self-host.md), [backup/restore](./docs/backup-restore.md), and [upgrade](./docs/upgrade.md) guides

## License, in one honest paragraph

Everything you deploy — the stack, the terraform, the contracts — is
**Apache-2.0, genuinely open source**. The `cli/` directory is
**source-available** under FSL-1.1-ALv2: use it, fork it, self-host with it
freely; offering it as a competing hosted service is restricted for two years
per release, after which that code becomes Apache-2.0 too. We say "open
source" only about the Apache parts.

## Verify what you run

The aideploy OpenClaw wrapper is published to ghcr.io, pinned by digest in the
npm package, and cosign-signed with provenance:

```bash
cosign verify ghcr.io/belongnet/aideploy-openclaw-runtime@sha256:... \
  --certificate-identity-regexp '^https://github\.com/belongnet/aideploy/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Hermes is installed from a commit-specific URL whose SHA-256 lives in
`stack/runtime/hermes/manifest.json`; the bootstrap refuses a mismatch.

Every tagged release also publishes a deterministic
`aideploy-base-vX.Y.Z.tgz`, its manifest, checksum, and keyless Sigstore bundles.
Hosted consumers pin both file hashes and verify the signer identity against
this repository's tag-triggered `release.yml`; they never build from a mutable
branch or GitHub's generated source archive.

## Attribution

Built on the MIT-licensed [OpenClaw](https://github.com/openclaw/openclaw) and
[gstack](https://github.com/garrytan/gstack) projects — see [NOTICE](./NOTICE).
