# Contributing

Thanks for considering it. Honest ground rules first:

- **This repo optimizes for strangers getting a running agent.** PRs that
  shorten or harden the path from `git clone` to "my bot replied on
  Telegram" get reviewed first.
- **Support boundaries are real.** DigitalOcean + OpenClaw + Telegram is the
  default beta path, and DigitalOcean + Hermes + Telegram is an alternate beta
  path. AWS and GCP modules are community-supported — your PRs largely ARE the
  support. Azure is retained compatibility/validate-only code; new Azure
  deployment paths are out of scope.
- **Licensing:** contributions to everything except `cli/` are accepted
  under Apache-2.0. Contributions to `cli/` are accepted under
  FSL-1.1-ALv2 (which converts to Apache-2.0 two years after each release).
  By contributing you agree your contribution is licensed accordingly.
- **DCO:** sign your commits (`git commit -s`). We use the Developer
  Certificate of Origin instead of a CLA.

## Development

```bash
cd cli
npm ci
npm run lint
npm test
npm run test:version
npm run test:package
./scripts/backup-smoke.sh
SMOKE_UP=1 ./scripts/runtime-smoke.sh openclaw
SMOKE_UP=1 ./scripts/runtime-smoke.sh hermes
```

CI on pull requests is credential-free by design: lint, unit tests,
`tofu validate`, an OpenClaw boot smoke, and an exact-source Hermes gateway
boot/health smoke. Live deploys run only on trusted triggers from maintainers.

## Reporting bugs

Use the issue templates. For the golden path, include the CLI's printed
deploy-id and the failing step; `aideploy doctor` output helps.
