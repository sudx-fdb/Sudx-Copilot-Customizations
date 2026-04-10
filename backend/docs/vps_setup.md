# VPS Setup Guide — Sudx MCP Backend

## Minimum Requirements

- **OS:** Ubuntu 22.04 LTS or 24.04 LTS
- **CPU:** 2 vCPUs minimum
- **RAM:** 2 GB minimum (4 GB recommended)
- **Disk:** 20 GB SSD minimum
- **Python:** 3.10 or higher
- **Docker:** 20.10+ (for Docker-based MCP servers)
- **nginx:** 1.18+ (reverse proxy + SSL termination)
- **certbot:** For Let's Encrypt SSL certificates

## Install Commands (Ubuntu 22.04/24.04)

```bash
# System update
sudo apt update && sudo apt upgrade -y

# Python 3.10+
sudo apt install -y python3 python3-venv python3-pip

# Docker
sudo apt install -y docker.io docker-compose
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker basti

# nginx + certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# Additional tools
sudo apt install -y git curl jq htop
```

## User Setup

```bash
# Create service user (if not exists)
sudo useradd -m -s /bin/bash basti
sudo mkdir -p /opt/sudx-backend
sudo chown -R basti:basti /opt/sudx-backend
```

## Firewall Rules (ufw)

```bash
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP (redirect to HTTPS)
sudo ufw allow 443/tcp    # HTTPS (nginx → backend)
sudo ufw deny 8420/tcp    # Block direct API access from outside
sudo ufw enable
```

## DNS

Create an A record:
```
rtnc.sudx.de  →  <VPS-IP>
```

## SSL Setup

```bash
sudo certbot --nginx -d rtnc.sudx.de
# Follow prompts, auto-renew is set up automatically
```

## Deployment

From local machine:
```bash
python deploy.py --target vps
```

## First Start

```bash
cd /opt/sudx-backend
cp .env.example .env
# Edit .env: set SUDX_BACKEND_TOKEN to a secure random value

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Validate config
python start_server.py --validate

# Start
python start_server.py
```

## Systemd Service (recommended)

```bash
sudo python start_server.py --install-service
sudo systemctl enable sudx-mcp-backend
sudo systemctl start sudx-mcp-backend
```
