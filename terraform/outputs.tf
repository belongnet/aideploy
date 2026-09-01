# ──────────────────────────────────────────────────────────────
# AI Deploy — Terraform Outputs
# ──────────────────────────────────────────────────────────────

output "server_ip" {
  description = "Public IP of the provisioned server"
  value = (
    var.cloud_provider == "digitalocean" ? module.digitalocean[0].server_ip :
    var.cloud_provider == "aws" ? module.aws[0].server_ip :
    var.cloud_provider == "gcp" ? module.gcp[0].server_ip :
    module.azure[0].server_ip
  )
}

output "server_id" {
  description = "Provider-specific server identifier"
  value = (
    var.cloud_provider == "digitalocean" ? module.digitalocean[0].server_id :
    var.cloud_provider == "aws" ? module.aws[0].server_id :
    var.cloud_provider == "gcp" ? module.gcp[0].server_id :
    module.azure[0].server_id
  )
}

output "deploy_id" {
  description = "Deployment identifier"
  value       = var.deploy_id
}

output "cloud_provider" {
  description = "Cloud provider used"
  value       = var.cloud_provider
}

output "dashboard_url" {
  description = "Master dashboard URL (via Tailscale)"
  value       = "http://${local.server_ip}:3000"
}

output "agent_endpoints" {
  description = "Per-agent dashboard and gateway endpoints"
  value = [
    for i in range(var.agent_count) : {
      agent_index    = i
      dashboard_port = 3001 + i
      gateway_port   = 8081 + i
      agent_port     = 8101 + i
      dashboard_url  = "http://${local.server_ip}:${3001 + i}"
    }
  ]
}

locals {
  server_ip = (
    var.cloud_provider == "digitalocean" ? module.digitalocean[0].server_ip :
    var.cloud_provider == "aws" ? module.aws[0].server_ip :
    var.cloud_provider == "gcp" ? module.gcp[0].server_ip :
    module.azure[0].server_ip
  )
}
