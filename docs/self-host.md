# Self-host on DigitalOcean

The default OpenClaw path and the alternate Hermes Agent path are both beta.
The public CLI currently supports Telegram only; messaging choices in the
hosted wizard do not imply support in this self-hosted CLI.

## 1. Prepare the four credentials

Create a read/write DigitalOcean token, an OpenAI, Anthropic, or Kimi API key, a bot
token from Telegram's BotFather, and a one-off Tailscale auth key (leave
**Reusable** off). The VM consumes it and erases it from runtime config after
joining. Also copy
your numeric Telegram account ID from @userinfobot; the runtime uses it as the
owner allowlist. The CLI masks every interactive secret. For noninteractive
automation, set `DIGITALOCEAN_TOKEN`, `AIDEPLOY_AI_PROVIDER`,
`AIDEPLOY_AI_KEY`, `AIDEPLOY_TG_TOKEN`, `AIDEPLOY_TG_USER_ID`, and
`AIDEPLOY_TS_KEY`, then pass either `--yes-telemetry` or `--no-telemetry`.

Install Tailscale on the device where you will open the browser URL and sign
that device into the same tailnet. The deployment adds exactly one cloud VM to
that tailnet. MagicDNS and Tailscale HTTPS certificates must be enabled for the
tailnet; the CLI checks both before creating paid resources.

## 2. Deploy

```bash
npx aideploy up --runtime openclaw --region nyc3
# or
npx aideploy up --runtime hermes --region nyc3
```

To resume an interrupted deployment, rerun the same CLI version and command
with `--deploy-id <printed-id>`, plus the original settings and runtime
credentials. Do not omit the deployment ID: the default command creates a new
one and could create a second billable VM. You may rotate the DigitalOcean
token, but `/v2/account` must identify the same account UUID. All other
immutable values—including the original one-off Tailscale key saved in local
deployment state—must match; otherwise, choose a new deploy ID for a replacement
deployment.

On `Ctrl-C` or `SIGTERM`, the CLI interrupts OpenTofu once and waits for it to
finish provider reconciliation and write recovery state before exiting with
code 130 or 143. Let that cleanup finish; do not kill the OpenTofu process.

The command validates the region and size against DigitalOcean, stores state
under `~/.aideploy/<deploy-id>/`, applies the live
`terraform/self-host-digitalocean` module, and waits for the runtime's
Tailscale Serve HTTPS browser surface. The underlying OpenClaw and Hermes ports
listen only on VM loopback and are never exposed directly.

For OpenClaw, success is reported only after the structured private status is
`ready` and a fresh device can pair through the complete Tailscale HTTPS and
WebSocket proxy path. An HTTP dashboard response by itself is not treated as
runtime readiness.

On success, the CLI prints the private browser sign-in and saves its details to
`~/.aideploy/<deploy-id>/access.json` with mode `0600`:

- OpenClaw saves a one-click sign-in URL. Its gateway token is stored only in
  browser session storage, so open the full link again for each new browser
  tab/session that needs to sign in.
- Hermes prints and saves the browser owner's email and password.

Treat the sign-in URL and `access.json` as secrets. If terminal output is no
longer available, read the saved file locally instead of copying its contents
into chat or an issue.

Only the numeric Telegram account ID supplied during setup can send direct
messages to the agent. Open the bot and send `/start`, then send a normal prompt.

## 3. Diagnose or remove

```bash
npx aideploy doctor
tailscale ssh root@aideploy-<deploy-id>
sudo cat /var/lib/aideploy/status.json
sudo tail -200 /var/log/aideploy-bootstrap.log
npx aideploy down <deploy-id>
```

`doctor` lists every droplet carrying both the generic `aideploy` tag and its
deploy-scoped tag, even if the local OpenTofu state was lost. Runtime ports are
not opened on the droplet's public interface.

The local state, secret tfvars, and browser access file are mode `0600`. They
contain credentials needed for destroy/resume, so keep `~/.aideploy` out of
backups you do not encrypt. After a successful `down`, the CLI removes those
credentials, OpenTofu state, browser access, and provider cache, leaving only a
non-secret `destroyed.json` receipt.
