# ──────────────────────────────────────────────────────────────
# OpenClaw — AWS Provider Module
# ──────────────────────────────────────────────────────────────

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }
}

variable "access_key" {
  type      = string
  sensitive = true
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "instance_type" {
  type    = string
  default = "t3.small"
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
  default = []
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

locals {
  webhook_ingress_enabled = length(var.webhook_ingress_ipv4_cidrs) + length(var.webhook_ingress_ipv6_cidrs) > 0
  egress_enabled          = length(var.egress_ipv4_cidrs) + length(var.egress_ipv6_cidrs) > 0
  webhook_ingress_rules = [
    {
      from_port = 443
      to_port   = 443
      protocol  = "tcp"
    },
  ]
}

# Look up latest Ubuntu 24.04 AMI
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# Security group
resource "aws_security_group" "openclaw" {
  name_prefix = "openclaw-${var.deploy_id}-"
  description = "OpenClaw Agent Launcher security group"

  dynamic "ingress" {
    for_each = local.webhook_ingress_enabled ? local.webhook_ingress_rules : []

    content {
      from_port        = ingress.value.from_port
      to_port          = ingress.value.to_port
      protocol         = ingress.value.protocol
      cidr_blocks      = var.webhook_ingress_ipv4_cidrs
      ipv6_cidr_blocks = var.webhook_ingress_ipv6_cidrs
    }
  }

  dynamic "egress" {
    for_each = local.egress_enabled ? [1] : []

    content {
      from_port        = 0
      to_port          = 0
      protocol         = "-1"
      cidr_blocks      = var.egress_ipv4_cidrs
      ipv6_cidr_blocks = var.egress_ipv6_cidrs
    }
  }

  tags = {
    Name = "openclaw-${var.deploy_id}"
  }
}

# SSH key pair (optional)
resource "aws_key_pair" "openclaw" {
  count      = var.ssh_key != "" ? 1 : 0
  key_name   = "openclaw-${var.deploy_id}"
  public_key = var.ssh_key
}

# EC2 instance
resource "aws_instance" "openclaw" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  vpc_security_group_ids = [aws_security_group.openclaw.id]
  key_name               = var.ssh_key != "" ? aws_key_pair.openclaw[0].key_name : null

  user_data = var.cloud_init

  root_block_device {
    volume_size = 64
    volume_type = "gp3"
  }

  tags = {
    Name     = "openclaw-${var.deploy_id}"
    Project  = "openclaw"
    DeployID = var.deploy_id
  }

  lifecycle {
    create_before_destroy = true
  }
}

output "server_ip" {
  value = aws_instance.openclaw.public_ip
}

output "server_id" {
  value = aws_instance.openclaw.id
}
