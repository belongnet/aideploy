# Security Policy

## Reporting a vulnerability

Email **security@aideploy.co** (or use GitHub's private vulnerability
reporting on this repository). Please do NOT open a public issue for
security reports.

We aim to acknowledge within 48 hours and to ship a fix or mitigation
within 30 days for confirmed issues.

## Scope note: shared code with a hosted service

Portions of this codebase (the VM stack, terraform modules, contracts) also
power the hosted service at aideploy.co. A vulnerability here may affect
hosted customers too, so coordinated disclosure covers both: we may ask for
a short embargo while the hosted fleet is patched before details go public.

## What's NOT a vulnerability here

- Secrets you place in your own `~/.aideploy/<deploy-id>/` state (0600,
  local by design — protect your machine).
- Issues in the upstream OpenClaw / Hermes Agent / gstack / Open WebUI /
  OpenTofu projects — report
  those upstream (we will help route them if you're unsure).

## Supply-chain verification

Release images are cosign-signed with GitHub OIDC provenance; the CLI
verifies its OpenTofu download against a pinned SHA256 and fails closed.
Verification commands are in the README.
