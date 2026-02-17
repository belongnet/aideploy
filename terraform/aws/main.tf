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

provider "aws" {
  region     = var.region
  access_key = split(":", var.access_key)[0]
  secret_key = split(":", var.access_key)[1]
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

  # SSH
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTP/HTTPS
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Tailscale
  ingress {
    from_port   = 41641
    to_port     = 41641
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Gateway ports
  ingress {
    from_port   = 8081
    to_port     = 8090
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # All outbound
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
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
    volume_size = 30
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
