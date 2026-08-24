# Terraform layout

`self-host-digitalocean/` is the live module used by `aideploy up`. Its variable
contract is tested against the CLI, and the npm release vendors it unchanged as
`assets/terraform/digitalocean/`.

The sibling `digitalocean/`, `aws/`, `gcp/`, and `azure/` modules predate the
current OpenClaw/Hermes runtime path. They are retained as Apache-2.0 reference
modules and receive credential-free `tofu validate` coverage, but the v1 CLI
does not execute them. Do not copy their reference cloud-init into a golden-
path deployment.
