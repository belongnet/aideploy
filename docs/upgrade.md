# Upgrade a self-host deployment

Public self-host upgrades are manual and blue/green: create a fresh deploy,
verify it, move the local data, then remove the old VM. This avoids replacing a
working droplet in place when an upstream runtime or bootstrap contract changes.

1. Download a current archive from the old VM using
   [backup and restore](./backup-restore.md).
2. Run the new CLI release with a new deploy ID and the same runtime.
3. Stop the old runtime before giving the new VM the same Telegram bot token;
   Telegram permits only one long-polling consumer for that bot.
4. Restore the workspace/config data needed on the new VM, then restart and
   send a Telegram test message.
5. Only after verification, run the exact teardown command printed by the old
   deployment, `npx aideploy@<old-cli-version> down <old-deploy-id>`.

The npm release contains the exact Terraform/bootstrap assets it deploys. Do
not copy `stack/docker-compose.yml.tpl` into a VM: that file belongs to the
deprecated Python reference architecture, not OpenClaw or Hermes.
