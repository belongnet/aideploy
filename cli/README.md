# aideploy CLI

`aideploy` deploys a private OpenClaw or Hermes Agent runtime into your own
DigitalOcean account. Both runtime choices are currently beta.
The CLI supports macOS and Linux on amd64 and arm64; Windows is not yet
supported because graceful OpenTofu interruption requires POSIX process groups.

```bash
npx aideploy up
```

The command validates the required DigitalOcean, AI-provider, Telegram, and
Tailscale credentials; installs a checksum-verified OpenTofu binary; creates
one VM; waits for a live model response; and prints the private Tailscale
browser sign-in. It saves the corresponding OpenClaw sign-in URL or Hermes
owner credentials to `~/.aideploy/<deploy-id>/access.json` with mode `0600`.
Treat that file as a secret; OpenClaw's sign-in must be opened again for each
new browser tab/session. Use a one-off Tailscale auth key with **Reusable**
disabled; the VM erases it from runtime config immediately after joining the
tailnet.

```bash
npx aideploy down <deploy-id>
npx aideploy doctor
```

Resume and teardown must use the same CLI version that created the deployment;
the completion output prints the exact teardown command. Upgrades are blue/green
with a new deploy ID rather than in-place VM replacement.

After a successful teardown, the CLI scrubs local browser credentials,
cloud/AI/messaging credentials, OpenTofu state, and provider cache, retaining
only a non-secret destruction receipt.

See the [source repository](https://github.com/belongnet/aideploy), or
[aideploy.co](https://www.aideploy.co/), for setup, security, backup, and
recovery documentation. The CLI source is licensed under FSL-1.1-ALv2; the
vendored deployment assets retain their Apache-2.0 license.
