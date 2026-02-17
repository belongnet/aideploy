# ──────────────────────────────────────────────────────────────
# OpenClaw — Azure Provider Module
# ──────────────────────────────────────────────────────────────

terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.95"
    }
  }
}

variable "token" {
  type      = string
  sensitive = true
}

variable "location" {
  type    = string
  default = "eastus"
}

variable "vm_size" {
  type    = string
  default = "Standard_B1ms"
}

variable "deploy_id" {
  type = string
}

variable "cloud_init" {
  type = string
}

variable "subscription_id" {
  type    = string
  default = ""
}

provider "azurerm" {
  features {}
  subscription_id          = var.subscription_id
  use_oidc                 = false
  skip_provider_registration = true
}

# Resource group
resource "azurerm_resource_group" "openclaw" {
  name     = "openclaw-${var.deploy_id}"
  location = var.location

  tags = {
    project   = "openclaw"
    deploy_id = var.deploy_id
  }
}

# Virtual network
resource "azurerm_virtual_network" "openclaw" {
  name                = "openclaw-vnet-${var.deploy_id}"
  address_space       = ["10.0.0.0/16"]
  location            = azurerm_resource_group.openclaw.location
  resource_group_name = azurerm_resource_group.openclaw.name
}

# Subnet
resource "azurerm_subnet" "openclaw" {
  name                 = "openclaw-subnet"
  resource_group_name  = azurerm_resource_group.openclaw.name
  virtual_network_name = azurerm_virtual_network.openclaw.name
  address_prefixes     = ["10.0.1.0/24"]
}

# Public IP
resource "azurerm_public_ip" "openclaw" {
  name                = "openclaw-ip-${var.deploy_id}"
  resource_group_name = azurerm_resource_group.openclaw.name
  location            = azurerm_resource_group.openclaw.location
  allocation_method   = "Static"
  sku                 = "Standard"
}

# Network security group
resource "azurerm_network_security_group" "openclaw" {
  name                = "openclaw-nsg-${var.deploy_id}"
  location            = azurerm_resource_group.openclaw.location
  resource_group_name = azurerm_resource_group.openclaw.name

  security_rule {
    name                       = "SSH"
    priority                   = 1001
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "HTTP"
    priority                   = 1002
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "HTTPS"
    priority                   = 1003
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "Tailscale"
    priority                   = 1004
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Udp"
    source_port_range          = "*"
    destination_port_range     = "41641"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "Gateways"
    priority                   = 1005
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "8081-8090"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

# NIC
resource "azurerm_network_interface" "openclaw" {
  name                = "openclaw-nic-${var.deploy_id}"
  location            = azurerm_resource_group.openclaw.location
  resource_group_name = azurerm_resource_group.openclaw.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.openclaw.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.openclaw.id
  }
}

resource "azurerm_network_interface_security_group_association" "openclaw" {
  network_interface_id      = azurerm_network_interface.openclaw.id
  network_security_group_id = azurerm_network_security_group.openclaw.id
}

# Virtual machine
resource "azurerm_linux_virtual_machine" "openclaw" {
  name                  = "openclaw-${var.deploy_id}"
  resource_group_name   = azurerm_resource_group.openclaw.name
  location              = azurerm_resource_group.openclaw.location
  size                  = var.vm_size
  admin_username        = "openclaw"
  network_interface_ids = [azurerm_network_interface.openclaw.id]

  admin_ssh_key {
    username   = "openclaw"
    public_key = file("~/.ssh/id_rsa.pub")
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 30
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  custom_data = base64encode(var.cloud_init)

  tags = {
    project   = "openclaw"
    deploy_id = var.deploy_id
  }

  lifecycle {
    create_before_destroy = true
  }
}

output "server_ip" {
  value = azurerm_public_ip.openclaw.ip_address
}

output "server_id" {
  value = azurerm_linux_virtual_machine.openclaw.id
}
