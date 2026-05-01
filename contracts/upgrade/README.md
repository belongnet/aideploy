# AI Deploy Upgrade Contracts

This directory is the source of truth for dashboard-driven runtime upgrades.
Runtime services should generate or validate their local types from these
contracts rather than hand-maintaining request and response shapes.

## Files

| File | Purpose |
|---|---|
| `release-manifest.schema.json` | Signed release manifest published by the release broker |
| `capability-token.schema.json` | Short-lived token claims for mutating updater calls |
| `progress-event.schema.json` | Fixed updater progress event contract |
| `support-bundle.schema.json` | Redacted diagnostics bundle contract |
| `updater-openapi.json` | Local updater API surface |
| `error-registry.json` | Stable `UPD-*` errors and dashboard actions |

## Versioning

- Contract version: `aideploy-upgrade-contract-v1`
- Manifest schema: `aideploy-release-v1`
- Capability token schema: `aideploy-update-capability-v1`

Breaking changes require a new schema version and old/new compatibility tests.
Additive fields must be optional unless every supported updater version already
understands them.
