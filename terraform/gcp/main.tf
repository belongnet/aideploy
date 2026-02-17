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

provider "google" {
  access_token = var.token
  project      = var.project_id
  zone         = var.zone
}

# Firewall rules
resource "google_compute_firewall" "openclaw" {
  name    = "openclaw-${var.deploy_id}"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22", "80", "443", "8081-8090"]
  }

  allow {
    protocol = "udp"
    ports    = ["41641"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["openclaw"]
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
