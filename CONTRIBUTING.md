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

# From the repository root:
npm --prefix web test
npm --prefix web run build
python3 -m unittest scripts/publication-guard/test_scan.py -v
python3 scripts/publication-guard/scan.py --repo . --all-refs
```

CI on pull requests is credential-free by design: lint, unit tests,
`tofu validate`, an OpenClaw boot smoke, and an exact-source Hermes gateway
boot/health smoke. Live deploys run only on trusted triggers from maintainers.

Before your first push, install the repository's pre-push publication check:

```bash
./scripts/publication-guard/install-hook.sh
```

The installer is repeatable and refuses to overwrite an unrelated hook. The
local hook prevents unsafe commits from being pushed. CI independently scans
the pull request's Git objects after a push, including intermediate commits,
using the policy and scanner from the protected base branch. It never checks
out or executes pull-request code, and findings never print matched content.
Organizations can add a second local boundary scanner by setting
`aideploy.privateBoundaryCommand` to an absolute executable path. The hook
invokes that file directly with repository and commit-boundary arguments; it
never evaluates a shell command from Git configuration.

The public repository accepts only its documented top-level source and docs
directories. Local state, credentials, private or hosted source trees,
archives, symlinks, and submodules are rejected. If a protected guardrail file
must change, one write-capable maintainer must approve the exact current head
and a different write-capable maintainer must apply the
`publication-guard-break-glass` label. Neither may be the pull-request author,
and branch protection prevents the latest pusher from supplying the required
approval. The trusted-base scan still runs.

## Reporting bugs

Use the issue templates. For the golden path, include the CLI's printed
deploy-id and the failing step; `aideploy doctor` output helps.
