# terraform/ — REFERENCE ONLY, not used by any live deploy path

Nothing under `provisioner/src` reads, imports, or executes any file in this
directory. No CI workflow runs `terraform init`/`plan`/`apply` against it
either. Grep for yourself:

```
grep -rn '"terraform/\|path.*terraform' provisioner/src --include="*.ts"
```

That returns exactly one hit: `workflow-security.test.ts` reading
`terraform/cloud-init.yml` as a text fixture, to assert its *contents* stay
in sync with the equivalent template in `templates.ts` for drift-detection.
It never executes this directory — no `require`, no `import`, no shelling
out to a path under here.

## Where deploys actually come from

The live provisioning code is `provisioner/src/deployer.ts` (plus
`provisioner/src/hermes-runtime.ts` for the Hermes runtime path). It talks to
each cloud directly:

- **DigitalOcean, GCP, Azure** — direct REST API calls from `deployer.ts`
  (OAuth or API-key auth, no Terraform involved at all).
- **AWS** — the one case that *does* use Terraform, but not this directory.
  `deployer.ts`'s `createAWSServer()` builds its own complete Terraform
  config as an inline template string (VPC, subnets, NAT gateway, EC2
  instance — see the `tfMain` literal starting at deployer.ts:8626),
  writes it to a throwaway `/tmp/aideploy-tf-<deployId>` directory, and runs
  `terraform init` / `terraform apply -auto-approve` against *that* (see
  `execSync("terraform init", …)` at deployer.ts:8788). The temp directory is
  deleted afterward. This directory's `main.tf` / `aws/main.tf` are never
  touched by that flow.
- **Scaleway** — Apple Silicon Mac Mini servers, provisioned over SSH
  directly (also no Terraform; this directory has no `scaleway/` module at
  all).

`provisioner/Dockerfile` installs the `terraform` CLI binary for the reason
above (the AWS inline-template flow needs the binary on `PATH`), not to run
anything in this directory.

There is also a second, *separate* set of Terraform-flavored text —
`TF_MAIN`, `TF_AWS_MAIN`, `TF_DO_MAIN`, `TF_GCP_MAIN`, `TF_AZURE_MAIN`,
`TF_VARIABLES`, `TF_OUTPUTS` exported from `provisioner/src/templates.ts` —
which largely mirrors the files in this directory. Those constants are only
referenced from `provisioner/src/deployer.test.ts` assertions; they are not
imported by `deployer.ts`'s runtime code path either. So there are three
Terraform-shaped things in this repo and only one of them ships anything:
the inline template in `createAWSServer()`.

## Sizing here is known-drifted — do not copy it

This module's size maps (`terraform/main.tf` `locals.*_sizes`) have not been
kept in sync with the live sizing in `deployer.ts`'s `SIZE_MAP` (around
deployer.ts:656):

| Provider | Tier | This directory (`terraform/main.tf`) | Live (`deployer.ts` `SIZE_MAP`) |
|---|---|---|---|
| AWS | starter | `t3.small` | `t3.large` |
| AWS | growing | `t3.medium` | `t3.xlarge` |
| AWS | power | `t3.large` | `t3.2xlarge` |
| GCP | starter | `e2-small` | `e2-standard-2` |
| GCP | growing | `e2-medium` | `e2-standard-4` |
| GCP | power | `e2-standard-2` | `e2-standard-8` |
| Azure | starter | `Standard_B2s` | `Standard_D2as_v5` |
| Azure | growing | `Standard_B2s` | `Standard_D4as_v5` |
| Azure | power | `Standard_B2ms` | `Standard_D8as_v5` |
| DigitalOcean | all tiers | matches | matches (coincidence, not maintenance) |

Azure has drifted onto a different VM family entirely (burstable `B`-series
here vs. general-purpose `Dv5`-series live). Don't use this directory as a
reference for "what size does aideploy actually provision" — check
`SIZE_MAP` in `deployer.ts` instead.

## Why this exists / why it isn't deleted

This tree was the original planned IaC layer (see the project blueprint's
build order, which lists `terraform/` — main.tf + 4 provider modules +
cloud-init — as an early build step). The live path evolved to direct
REST/API calls for speed (OAuth-based deploys without a Terraform apply in
the loop) plus the one inline-template exception for AWS above. This
directory was kept as a design reference rather than deleted — that's a
deliberate call, not an oversight, so it is *not* being removed here. But
because it still gets touched in PRs as if it matters operationally (e.g. the
deployment-trust-boundary hardening in #322), it needs this marker so nobody
mistakes edits here for something that ships.

**If you're changing how aideploy actually provisions a server, edit
`provisioner/src/deployer.ts` (or `hermes-runtime.ts`), not this directory.**
