# ──────────────────────────────────────────────────────────────
# OpenClaw — Google Cloud Provider Module
# ──────────────────────────────────────────────────────────────

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.20"
    }
  }
}

variable "token" {
  type      = string
  sensitive = true
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

variable "machine_type" {
  type    = string
  default = "e2-small"
}

variable "deploy_id" {
  type = string
}

variable "cloud_init" {
  type = string
}

variable "project_id" {
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

provider "google" {
  access_token = var.token
  project      = var.project_id
  zone         = var.zone
}

locals {
  webhook_ingress_cidrs = concat(var.webhook_ingress_ipv4_cidrs, var.webhook_ingress_ipv6_cidrs)
  egress_cidrs          = concat(var.egress_ipv4_cidrs, var.egress_ipv6_cidrs)
}

# Firewall rules
resource "google_compute_firewall" "openclaw_webhooks" {
  count   = length(local.webhook_ingress_cidrs) > 0 ? 1 : 0
  name    = "openclaw-webhooks-${var.deploy_id}"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["443"]
  }

  source_ranges = local.webhook_ingress_cidrs
  target_tags   = ["openclaw"]
}

resource "google_compute_firewall" "openclaw_egress" {
  count     = length(local.egress_cidrs) > 0 ? 1 : 0
  name      = "openclaw-egress-${var.deploy_id}"
  network   = "default"
  direction = "EGRESS"

  allow {
    protocol = "tcp"
  }

  allow {
    protocol = "udp"
  }

  allow {
    protocol = "icmp"
  }

  destination_ranges = local.egress_cidrs
  target_tags        = ["openclaw"]
}

resource "google_compute_firewall" "openclaw_egress_deny" {
  name      = "openclaw-egress-deny-${var.deploy_id}"
  network   = "default"
  direction = "EGRESS"
  priority  = 65534

  deny {
    protocol = "tcp"
  }

  deny {
    protocol = "udp"
  }

  deny {
    protocol = "icmp"
  }

  deny {
    protocol = "esp"
  }

  deny {
    protocol = "ah"
  }

  deny {
    protocol = "sctp"
  }

  deny {
    protocol = "ipip"
  }

  destination_ranges = ["0.0.0.0/0"]
  target_tags        = ["openclaw"]
}

# Compute instance
resource "google_compute_instance" "openclaw" {
  name         = "openclaw-${var.deploy_id}"
  machine_type = var.machine_type
  zone         = var.zone

  tags = ["openclaw"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts"
      size  = 30
      type  = "pd-ssd"
    }
  }

  network_interface {
    network = "default"
    access_config {
      # Ephemeral public IP
    }
  }

  metadata = {
    user-data = var.cloud_init
  }

  labels = {
    project   = "openclaw"
    deploy-id = var.deploy_id
  }

  lifecycle {
    create_before_destroy = true
  }
}

output "server_ip" {
  value = google_compute_instance.openclaw.network_interface[0].access_config[0].nat_ip
}

output "server_id" {
  value = google_compute_instance.openclaw.id
}
