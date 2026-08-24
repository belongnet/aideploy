# Backup and restore

Each VM runs `aideploy-backup.timer` daily. Archives are written with mode
`0600` under `/var/backups/aideploy/` and retained for 14 days. They contain
runtime credentials and workspace data, so copy them only over your tailnet
and store them encrypted.

Create and download a backup:

```bash
tailscale ssh root@aideploy-<deploy-id> sudo systemctl start aideploy-backup.service
tailscale ssh root@aideploy-<deploy-id> ls -lt /var/backups/aideploy/
scp root@aideploy-<deploy-id>:/var/backups/aideploy/runtime-YYYYMMDDTHHMMSSZ.tar.gz .
```

To restore, stop the affected runtime, inspect the archive paths, extract to
`/`, restore ownership, then restart:

```bash
sudo tar tzf runtime-YYYYMMDDTHHMMSSZ.tar.gz
sudo systemctl stop hermes-gateway 2>/dev/null || true
sudo docker stop aideploy-openclaw aideploy-hermes-webui 2>/dev/null || true
sudo tar xzf runtime-YYYYMMDDTHHMMSSZ.tar.gz -C /
sudo chown -R aideploy:aideploy /home/aideploy 2>/dev/null || true
sudo systemctl restart hermes-gateway 2>/dev/null || true
sudo docker start aideploy-openclaw aideploy-hermes-webui 2>/dev/null || true
```

VM-local backups do not survive deleting the droplet. Download a fresh archive
before teardown or an upgrade migration. The managed tier adds offsite,
verified backups; the self-host kit deliberately does not claim that guarantee.
