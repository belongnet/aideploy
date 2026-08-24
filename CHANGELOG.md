# Changelog

All notable public releases are documented here. GitHub Releases carry the
commit-by-commit notes, signed hosted-build source assets, and the exact npm
tarball when npm publishing is enabled.

## Unreleased

## [0.4.2-beta.2] - 2026-08-24

### Added

- Deterministic, checksum-bound public-base archives with keyless Sigstore
  provenance for hosted consumers.

### Fixed

- OpenClaw boot-smoke cleanup now handles root-owned Linux bind-mount state without re-entering an expired function-local EXIT trap.
- Hermes boot smoke downloads resume across bounded network retry windows and
  dependency retries cannot reuse a partially downloaded wheel.
- CLI development dependencies now pin patched `brace-expansion` and `js-yaml` releases so a clean install has no known npm audit findings.

## [0.4.2-beta.1] - 2026-07-19

- Public-repository extraction with retained history and final layered scans.
- Canonical source, package, image, and signature metadata for `belongnet/aideploy`.
- Resume safety bound to the original DigitalOcean account, plus one-off Tailscale enrollment keys erased from VM config after joining.
- `npx aideploy` golden path for DigitalOcean + Telegram.
- First-class OpenClaw and Hermes runtime bootstrap contracts.
