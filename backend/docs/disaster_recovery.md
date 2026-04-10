# Disaster Recovery Runbook

## A. Complete VPS Rebuild from Scratch

1. **Provision Server:** Ubuntu 22.04+, min 2GB RAM, 20GB disk
2. **Install dependencies:**
   ```bash
   sudo apt update && sudo apt install -y python3.10 python3.10-venv docker.io nginx certbot python3-certbot-nginx
   ```
3. **Create user and directory:**
   ```bash
   sudo useradd -m -s /bin/bash basti
   sudo mkdir -p /opt/sudx-backend
   sudo chown basti:basti /opt/sudx-backend
   ```
4. **Deploy from local machine:**
   ```bash
   python deploy.py --target vps
   ```
5. **Setup environment:**
   ```bash
   cd /opt/sudx-backend
   cp .env.example .env
   # Edit .env with: SUDX_BACKEND_TOKEN=<secure-token>
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
6. **Start:**
   ```bash
   python start_server.py
   # Or: python start_server.py --install-service && sudo systemctl start sudx-mcp-backend
   ```
7. **Setup nginx:** Copy `config/nginx-sudx-backend.conf` to `/etc/nginx/sites-available/`
8. **SSL:** `sudo certbot --nginx -d rtnc.sudx.de`

## B. Recover from Corrupted State

1. **List available backups:**
   ```bash
   ls -la /opt/sudx-backend/state/backup/
   ```
2. **Restore:**
   ```bash
   python start_server.py --restore-state 20250101_120000
   ```
3. **Restart:**
   ```bash
   python start_server.py --restart
   ```

## C. Recover from Failed Deploy

1. **Check deploy history:**
   ```bash
   python deploy.py --history
   ```
2. **If backend is down:** SSH to VPS and manually restore:
   ```bash
   cd /opt/sudx-backend
   python start_server.py --restore-state <last-good-timestamp>
   python start_server.py
   ```
3. **If config broken:** Restore from backup:
   ```bash
   cp config/backup/mcp_servers_<timestamp>.json config/mcp_servers.json
   python start_server.py --validate
   ```

## D. Recover from Docker Daemon Failure

1. **Check Docker:**
   ```bash
   sudo systemctl status docker
   sudo journalctl -u docker --since "1 hour ago"
   ```
2. **Restart Docker:**
   ```bash
   sudo systemctl restart docker
   ```
3. **Wait for health recovery:** The backend's self-healing (self_healing.py) auto-restarts Docker-based MCPs within 60s
4. **Manual restart if needed:**
   ```bash
   python start_server.py --restart
   ```

## E. Recover from Disk Full

1. **Identify disk usage:**
   ```bash
   df -h /
   du -sh /opt/sudx-backend/logs/ /opt/sudx-backend/state/
   ```
2. **Run cleanup:**
   ```bash
   curl -X POST https://rtnc.sudx.de/api/v1/system/cleanup \
     -H "Authorization: Bearer $SUDX_BACKEND_TOKEN"
   ```
3. **Manual log cleanup:**
   ```bash
   find /opt/sudx-backend/logs/ -name "*.log.*" -mtime +7 -delete
   ```
4. **Restart services:**
   ```bash
   python start_server.py --restart
   ```
