# Legacy Compose services

`stack/agent`, `stack/gateway`, `stack/dashboard`, `stack/master-dashboard`,
`stack/db`, and `stack/docker-compose.yml.tpl` are part of the original Python
Compose architecture. They remain as Apache-2.0 reference code and are not
executed by `aideploy up`.

The live self-host sources are under `stack/runtime/`:

- OpenClaw runs from a release-built, cosign-signed wrapper around a pinned
  upstream image.
- Hermes installs from a commit-specific URL with a pinned SHA-256, then adds
  a commit-pinned gstack checkout.

The CLI vendors these live assets with
`terraform/self-host-digitalocean/` into each npm release.
