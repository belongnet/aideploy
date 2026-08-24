terraform {
  required_version = ">= 1.8.0"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.34"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

variable "do_token" {
  description = "DigitalOcean API token used by the provider."
  type        = string
  sensitive   = true
}

variable "deploy_id" {
  description = "Stable aideploy deployment identifier."
  type        = string

  validation {
    condition     = can(regex("^adp-[a-z0-9]([a-z0-9-]{0,42}[a-z0-9])?$", var.deploy_id))
    error_message = "deploy_id must be a lowercase aideploy id such as adp-1a2b3c4d."
  }
}

variable "resource_tag" {
  description = "Deploy-scoped DigitalOcean tag used by aideploy doctor."
  type        = string

  validation {
    condition     = var.resource_tag == "aideploy-${var.deploy_id}"
    error_message = "resource_tag must equal aideploy-<deploy_id>."
  }
}

variable "region" {
  type = string
}

variable "droplet_size" {
  type = string
}

variable "runtime" {
  type = string

  validation {
    condition     = contains(["openclaw", "hermes"], var.runtime)
    error_message = "runtime must be openclaw or hermes."
  }
}

variable "channel" {
  type = string

  validation {
    condition     = var.channel == "telegram"
    error_message = "The v1 self-host path supports the telegram channel."
  }
}

variable "enable_tailscale" {
  type = bool

  validation {
    condition     = var.enable_tailscale
    error_message = "The v1 self-host path requires Tailscale so the runtime is not exposed publicly."
  }
}

variable "ai_provider" {
  type = string

  validation {
    condition     = contains(["openai", "anthropic", "kimi"], var.ai_provider)
    error_message = "ai_provider must be openai, anthropic, or kimi."
  }
}

variable "ai_api_key" {
  type      = string
  sensitive = true
}

variable "telegram_bot_token" {
  type      = string
  sensitive = true
}

variable "telegram_user_id" {
  description = "Numeric Telegram account ID allowed to control the agent."
  type        = string

  validation {
    condition     = can(regex("^[1-9][0-9]{4,14}$", var.telegram_user_id))
    error_message = "telegram_user_id must be a numeric Telegram account ID."
  }
}

variable "tailscale_auth_key" {
  type      = string
  sensitive = true
}

provider "digitalocean" {
  token = var.do_token
}

resource "random_password" "gateway_token" {
  length  = 48
  special = false
}

resource "random_password" "hermes_webui_owner_password" {
  length  = 32
  special = false
}

locals {
  runtime_asset_root  = abspath("${path.module}/../../stack/runtime")
  runtime_asset_files = fileset(local.runtime_asset_root, "**")
  runtime_config = {
    deploy_id                   = var.deploy_id
    runtime                     = var.runtime
    channel                     = var.channel
    ai_provider                 = var.ai_provider
    ai_api_key                  = var.ai_api_key
    telegram_bot_token          = var.telegram_bot_token
    telegram_user_id            = var.telegram_user_id
    tailscale_auth_key          = var.tailscale_auth_key
    gateway_token               = random_password.gateway_token.result
    hermes_webui_owner_email    = "owner@aideploy.local"
    hermes_webui_owner_password = random_password.hermes_webui_owner_password.result
  }
  cloud_init = {
    package_update = true
    packages       = ["ca-certificates", "curl", "jq"]
    write_files = concat(
      [
        {
          path        = "/etc/aideploy/config.json"
          permissions = "0600"
          encoding    = "b64"
          content     = base64encode(jsonencode(local.runtime_config))
        }
      ],
      [
        for relative_path in local.runtime_asset_files : {
          path        = "/opt/aideploy/runtime/${relative_path}"
          permissions = endswith(relative_path, ".sh") ? "0755" : "0644"
          encoding    = "b64"
          content     = filebase64("${local.runtime_asset_root}/${relative_path}")
        }
      ]
    )
    runcmd = [["/usr/bin/env", "bash", "/opt/aideploy/runtime/bootstrap.sh"]]
  }
}

resource "digitalocean_droplet" "aideploy" {
  image     = "ubuntu-24-04-x64"
  name      = "aideploy-${var.deploy_id}"
  region    = var.region
  size      = var.droplet_size
  user_data = "#cloud-config\n${yamlencode(local.cloud_init)}"

  tags = ["aideploy", var.resource_tag]
}

resource "digitalocean_firewall" "aideploy" {
  name        = "aideploy-${var.deploy_id}"
  droplet_ids = [digitalocean_droplet.aideploy.id]

  # Tailscale establishes encrypted access. Runtime ports remain closed on
  # the droplet's public interface.
  inbound_rule {
    protocol         = "udp"
    port_range       = "41641"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

output "droplet_ip" {
  description = "Public IP for DigitalOcean console diagnostics; runtime ports are firewall-closed."
  value       = digitalocean_droplet.aideploy.ipv4_address
}

output "server_id" {
  value = tostring(digitalocean_droplet.aideploy.id)
}

output "tailscale_hostname" {
  value = "aideploy-${var.deploy_id}"
}

output "gateway_token" {
  value     = random_password.gateway_token.result
  sensitive = true
}

output "hermes_webui_owner_email" {
  value = "owner@aideploy.local"
}

output "hermes_webui_owner_password" {
  value     = random_password.hermes_webui_owner_password.result
  sensitive = true
}
