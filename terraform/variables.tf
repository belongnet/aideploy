# ──────────────────────────────────────────────────────────────
# OpenClaw Agent Launcher — Terraform Variables
# ──────────────────────────────────────────────────────────────

variable "cloud_provider" {
  description = "Cloud provider: digitalocean, aws, gcp, azure"
  type        = string
  default     = "digitalocean"

  validation {
    condition     = contains(["digitalocean", "aws", "gcp", "azure"], var.cloud_provider)
    error_message = "Must be one of: digitalocean, aws, gcp, azure."
  }
}

variable "cloud_token" {
  description = "OAuth token or API key for the cloud provider"
  type        = string
  sensitive   = true
}

variable "region" {
  description = "Region/zone for the server"
  type        = string
  default     = "nyc1"
}

variable "server_size" {
  description = "Server tier: starter, growing, power"
  type        = string
  default     = "starter"

  validation {
    condition     = contains(["starter", "growing", "power"], var.server_size)
    error_message = "Must be one of: starter, growing, power."
  }
}

variable "agent_count" {
  description = "Number of agents to deploy (1–10)"
  type        = number
  default     = 1

  validation {
    condition     = var.agent_count >= 1 && var.agent_count <= 10
    error_message = "Agent count must be between 1 and 10."
  }
}

variable "tailscale_auth_key" {
  description = "Tailscale auth key for private network"
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "Postgres database password"
  type        = string
  sensitive   = true
}

variable "encryption_key" {
  description = "AES-256 key for encrypting OAuth tokens at rest"
  type        = string
  sensitive   = true
}

variable "deploy_id" {
  description = "Unique deployment identifier"
  type        = string
}

variable "agent_configs" {
  description = "Per-agent configuration"
  type = list(object({
    name           = string
    model_provider = string
    auth_method    = string
    api_key        = optional(string, "")
    model          = optional(string, "")
    channels = optional(list(object({
      type  = string
      token = string
    })), [])
  }))
}

variable "oauth_tokens" {
  description = "Encrypted OAuth tokens for AI providers"
  type = map(object({
    access_token  = string
    refresh_token = string
    expires_at    = string
  }))
  default   = {}
  sensitive = true
}

variable "ssh_public_key" {
  description = "SSH public key for server access"
  type        = string
  default     = ""
}

variable "domain" {
  description = "Optional custom domain"
  type        = string
  default     = ""
}

variable "webhook_ingress_ipv4_cidrs" {
  description = "IPv4 CIDR blocks allowed to reach the optional public HTTPS webhook ingress; leave empty to disable public ingress"
  type        = list(string)
  default     = []
}

variable "webhook_ingress_ipv6_cidrs" {
  description = "IPv6 CIDR blocks allowed to reach the optional public HTTPS webhook ingress; leave empty to disable public ingress"
  type        = list(string)
  default     = []
}

variable "egress_ipv4_cidrs" {
  description = "IPv4 CIDR blocks allowed for outbound traffic"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "egress_ipv6_cidrs" {
  description = "IPv6 CIDR blocks allowed for outbound traffic"
  type        = list(string)
  default     = []
}
