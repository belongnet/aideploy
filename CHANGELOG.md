# Changelog

All notable public releases are documented here. GitHub Releases carry the
commit-by-commit notes, signed hosted-build source assets, and the exact npm
tarball when npm publishing is enabled.

## Unreleased

### Fixed

- Replaced a provider-shaped Tailscale test fixture with an explicit non-secret
  value and a regression assertion, preventing false credential alerts.
- Restored the 166-commit audited public-only development history to `main`
  without rewriting the signed beta release commits, and added a CI ancestry
  guard so the filtered and clean-launch lineages cannot be dropped again.
- Moved the commit-pinned Node and OpenTofu setup actions to verified,
  Node 24-native releases before GitHub removes Node 20 runner support.

## [0.4.2-beta.5] - 2026-08-25

### Fixed

- The deprecated dashboard reference packages now use patched Next.js, PostCSS,
  and transitive dependencies, with their test, lint, build, and audit checks
  enforced in public CI.
- The dashboard images now bind the standalone server predictably and probe an
  authentication-safe health endpoint, so Docker can report their real status.
- The deprecated Python agent reference no longer installs the unused
  `cryptography` package, and its shipped image now runs its unit tests in CI.
- Python agent model timestamps now use timezone-aware UTC defaults instead of
  the deprecated naive `datetime.utcnow()` API.

## [0.4.2-beta.4] - 2026-08-25

### Fixed

- `aideploy up` and `aideploy down` now handle terminal `Ctrl-C` and `SIGTERM`
  gracefully, allow state-mutating OpenTofu commands to finish reconciliation,
  and preserve private recovery state with conventional exit codes 130 and 143.
- Recovery guidance now requires the printed deployment ID, preventing an
  interrupted retry from accidentally creating a second billable VM.
- Runtime readiness polling keeps its five-second request timeout while also
  honoring the outer CLI interruption signal, cancels pending retry timers,
  and cannot let telemetry mask an interrupt.
- The CLI now fails closed on unsupported operating systems before accepting a
  system OpenTofu binary; safe interrupt recovery is supported on macOS/Linux.
- Unsupported-cloud guidance now describes Azure as retained compatibility
  validation rather than a new-deployment path.

### For contributors

- Packed `npx aideploy` tests now exercise real terminal behavior, including
  npm signal forwarding, readline prompts, and child process isolation; the
  recovery suite also covers stalled-command escalation and interrupted state.

## [0.4.2-beta.3] - 2026-08-24

### Fixed

- The public repository now starts from a source-only root commit, keeping its
  history limited to the open-source distribution.

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
