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

provider "digitalocean" {
  token = var.token
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

# Firewall: allow SSH, HTTP/S, Tailscale, and gateway ports
resource "digitalocean_firewall" "openclaw" {
  name        = "openclaw-${var.deploy_id}"
  droplet_ids = [digitalocean_droplet.openclaw.id]

  # SSH
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # HTTP/HTTPS (for webhook endpoints via Tailscale Funnel)
  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # Tailscale UDP
  inbound_rule {
    protocol         = "udp"
    port_range       = "41641"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # Gateway ports (8081-8090 for up to 10 agents)
  inbound_rule {
    protocol         = "tcp"
    port_range       = "8081-8090"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # Allow all outbound
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

output "server_ip" {
  value = digitalocean_droplet.openclaw.ipv4_address
}

output "server_id" {
  value = tostring(digitalocean_droplet.openclaw.id)
}
