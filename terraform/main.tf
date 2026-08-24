# REFERENCE ONLY — not used by any live deploy path; see terraform/README.md.
# ──────────────────────────────────────────────────────────────
# OpenClaw Agent Launcher — Terraform Main
# Provisions a single server on the user's chosen cloud provider.
# Design reference only — no code path executes this module, including for
# AWS: deployer.ts builds its own inline Terraform config for that flow.
# See terraform/README.md for where deploys actually come from.
# ──────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.34"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 5.20"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.95"
    }
  }
}

# Providers live in the root module so child modules can be conditionally
# instantiated with count. Terraform treats child modules with local provider
# blocks as legacy modules and rejects count/for_each on those modules.
provider "digitalocean" {
  token = var.cloud_provider == "digitalocean" ? var.cloud_token : "unused"
}

provider "aws" {
  region     = var.region
  access_key = var.cloud_provider == "aws" ? try(split(":", var.cloud_token)[0], "unused") : "unused"
  secret_key = var.cloud_provider == "aws" ? try(split(":", var.cloud_token)[1], "unused") : "unused"

  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
}

provider "google" {
  access_token = var.cloud_provider == "gcp" ? var.cloud_token : "unused"
  project      = var.gcp_project_id
  zone         = var.region
}

provider "azurerm" {
  features {}
  subscription_id            = var.azure_subscription_id
  use_oidc                   = false
  skip_provider_registration = true
}

# ── Size Mappings ──────────────────────────────────────────────

locals {
  # DigitalOcean sizes
  do_sizes = {
    starter = "s-2vcpu-4gb"
    growing = "s-4vcpu-8gb"
    power   = "s-8vcpu-16gb"
  }

  # AWS sizes
  aws_sizes = {
    starter = "t3.small"
    growing = "t3.medium"
    power   = "t3.large"
  }

  # GCP sizes
  gcp_sizes = {
    starter = "e2-small"
    growing = "e2-medium"
    power   = "e2-standard-2"
  }

  # Azure sizes
  azure_sizes = {
    starter = "Standard_B2s"
    growing = "Standard_B2s"
    power   = "Standard_B2ms"
  }

  # Cloud-init template variables
  cloud_init_vars = {
    deploy_id          = var.deploy_id
    db_password        = var.db_password
    encryption_key     = var.encryption_key
    tailscale_auth_key = var.tailscale_auth_key
    agent_count        = tostring(var.agent_count)
  }

  cloud_init_rendered = templatefile("${path.module}/cloud-init.yml", local.cloud_init_vars)
}

# ── Provider Modules (conditional) ─────────────────────────────

module "digitalocean" {
  source = "./digitalocean"
  count  = var.cloud_provider == "digitalocean" ? 1 : 0

  token                      = var.cloud_token
  region                     = var.region
  size                       = local.do_sizes[var.server_size]
  deploy_id                  = var.deploy_id
  cloud_init                 = local.cloud_init_rendered
  ssh_key                    = var.ssh_public_key
  webhook_ingress_ipv4_cidrs = var.webhook_ingress_ipv4_cidrs
  webhook_ingress_ipv6_cidrs = var.webhook_ingress_ipv6_cidrs
  egress_ipv4_cidrs          = var.egress_ipv4_cidrs
  egress_ipv6_cidrs          = var.egress_ipv6_cidrs
}

module "aws" {
  source = "./aws"
  count  = var.cloud_provider == "aws" ? 1 : 0

  access_key                 = var.cloud_token
  region                     = var.region
  instance_type              = local.aws_sizes[var.server_size]
  deploy_id                  = var.deploy_id
  cloud_init                 = local.cloud_init_rendered
  ssh_key                    = var.ssh_public_key
  webhook_ingress_ipv4_cidrs = var.webhook_ingress_ipv4_cidrs
  webhook_ingress_ipv6_cidrs = var.webhook_ingress_ipv6_cidrs
  egress_ipv4_cidrs          = var.egress_ipv4_cidrs
  egress_ipv6_cidrs          = var.egress_ipv6_cidrs
}

module "gcp" {
  source = "./gcp"
  count  = var.cloud_provider == "gcp" ? 1 : 0

  token                      = var.cloud_token
  zone                       = var.region
  machine_type               = local.gcp_sizes[var.server_size]
  deploy_id                  = var.deploy_id
  cloud_init                 = local.cloud_init_rendered
  webhook_ingress_ipv4_cidrs = var.webhook_ingress_ipv4_cidrs
  webhook_ingress_ipv6_cidrs = var.webhook_ingress_ipv6_cidrs
  egress_ipv4_cidrs          = var.egress_ipv4_cidrs
  egress_ipv6_cidrs          = var.egress_ipv6_cidrs
}

module "azure" {
  source = "./azure"
  count  = var.cloud_provider == "azure" ? 1 : 0

  token                      = var.cloud_token
  location                   = var.region
  vm_size                    = local.azure_sizes[var.server_size]
  deploy_id                  = var.deploy_id
  cloud_init                 = local.cloud_init_rendered
  ssh_key                    = var.ssh_public_key
  webhook_ingress_ipv4_cidrs = var.webhook_ingress_ipv4_cidrs
  webhook_ingress_ipv6_cidrs = var.webhook_ingress_ipv6_cidrs
  egress_ipv4_cidrs          = var.egress_ipv4_cidrs
  egress_ipv6_cidrs          = var.egress_ipv6_cidrs
}
