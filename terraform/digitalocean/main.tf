# ──────────────────────────────────────────────────────────────
# OpenClaw — DigitalOcean Provider Module
# ──────────────────────────────────────────────────────────────

terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.34"
    }
  }
}

variable "token" {
  type      = string
  sensitive = true
}

variable "region" {
  type    = string
  default = "nyc1"
}

variable "size" {
  type    = string
  default = "s-1vcpu-2gb"
}

variable "deploy_id" {
  type = string
}

variable "cloud_init" {
  type = string
}

variable "ssh_key" {
  type    = string
  default = ""
}

variable "webhook_ingress_ipv4_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0"]
}

variable "webhook_ingress_ipv6_cidrs" {
  type    = list(string)
  default = []
}

variable "egress_ipv4_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0"]
}

variable "egress_ipv6_cidrs" {
  type    = list(string)
  default = []
}

provider "digitalocean" {
  token = var.token
}

locals {
  webhook_ingress_addresses = concat(var.webhook_ingress_ipv4_cidrs, var.webhook_ingress_ipv6_cidrs)
  egress_addresses          = concat(var.egress_ipv4_cidrs, var.egress_ipv6_cidrs)
  webhook_ingress_rules = [
    {
      protocol   = "tcp"
      port_range = "443"
    },
  ]
  egress_rules = [
    {
      protocol   = "tcp"
      port_range = "1-65535"
    },
    {
      protocol   = "udp"
      port_range = "1-65535"
    },
    {
      protocol = "icmp"
    },
  ]
}

# SSH key (optional)
resource "digitalocean_ssh_key" "openclaw" {
  count      = var.ssh_key != "" ? 1 : 0
  name       = "openclaw-${var.deploy_id}"
  public_key = var.ssh_key
}

# Droplet
resource "digitalocean_droplet" "openclaw" {
  image    = "ubuntu-24-04-x64"
  name     = "openclaw-${var.deploy_id}"
  region   = var.region
  size     = var.size
  ssh_keys = var.ssh_key != "" ? [digitalocean_ssh_key.openclaw[0].fingerprint] : []

  user_data = var.cloud_init

  tags = ["openclaw", "deploy-${var.deploy_id}"]

  lifecycle {
    create_before_destroy = true
  }
}

# Firewall: allow only webhook ingress and allowlisted egress
resource "digitalocean_firewall" "openclaw" {
  name        = "openclaw-${var.deploy_id}"
  droplet_ids = [digitalocean_droplet.openclaw.id]

  dynamic "inbound_rule" {
    for_each = length(local.webhook_ingress_addresses) > 0 ? local.webhook_ingress_rules : []

    content {
      protocol         = inbound_rule.value.protocol
      port_range       = inbound_rule.value.port_range
      source_addresses = local.webhook_ingress_addresses
    }
  }

  dynamic "outbound_rule" {
    for_each = length(local.egress_addresses) > 0 ? local.egress_rules : []

    content {
      protocol              = outbound_rule.value.protocol
      port_range            = try(outbound_rule.value.port_range, null)
      destination_addresses = local.egress_addresses
    }
  }
}

output "server_ip" {
  value = digitalocean_droplet.openclaw.ipv4_address
}

output "server_id" {
  value = tostring(digitalocean_droplet.openclaw.id)
}
