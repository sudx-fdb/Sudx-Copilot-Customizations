# Backend MCP Server Manager — User Documentation

## Overview

The Backend MCP Server Manager runs on a VPS and manages MCP (Model Context Protocol) server processes. It starts, stops, monitors, and updates MCP servers automatically, and provides a REST API for remote management from the VS Code extension.

---

## Requirements

- VPS with Ubuntu 22.04+ or Debian 12+
- Python 3.10+
- Docker Engine (for Docker-based MCP servers)
- 2 GB RAM minimum, 4 GB recommended
- Open port 8420 (API) behind nginx reverse proxy with HTTPS

---

## Installation

### Quick Setup

1. Clone the repository to the VPS:
   ```bash
   git clone <repo-url> /opt/sudx-backend
   cd /opt/sudx-backend/backend
   ```

2. Copy and configure environment file:
   ```bash
   cp .env.example .env
   nano .env
   ```

3. Copy and edit server configuration:
   ```bash
   cp config/mcp_servers.json.example config/mcp_servers.json
   nano config/mcp_servers.json
   ```

4. Start the backend:
   ```bash
   python start_server.py
   ```

The first run automatically:
- Creates a Python virtual environment
- Installs all dependencies
- Creates required directories (`state/`, `logs/`)
- Validates configuration

### Systemd Service

Install as a system service for automatic startup:
```bash
sudo python start_server.py --install-service
```

Remove the service:
```bash
sudo python start_server.py --uninstall-service
```

---

## Configuration

### Environment Variables (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `SUDX_API_TOKEN` | Yes | Bearer token for API authentication |
| `SUDX_API_HOST` | No | API bind host (default: `0.0.0.0`) |
| `SUDX_API_PORT` | No | API bind port (default: `8420`) |
| `SUDX_LOG_LEVEL` | No | Log level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `SUDX_IP_ALLOWLIST` | No | Comma-separated allowed IP addresses |
| `SUDX_HTTPS_REQUIRED` | No | Require HTTPS in production (default: `true`) |

### Server Configuration (`config/mcp_servers.json`)

Each MCP server is defined with:

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Whether the server should be managed |
| `install_method` | `docker`/`pip`/`system` | How the server is installed |
| `start_command` | string | Command to start the server |
| `transport` | `stdio`/`sse`/`streamable-http` | MCP transport protocol |
| `health_check` | object | Health monitoring configuration |
| `resource_limits` | object | Memory and CPU limits |
| `depends_on` | array | Servers that must start first |

Example server entry:
```json
{
  "servers": {
    "playwright": {
      "enabled": true,
      "install_method": "docker",
      "start_command": "docker run -d --name playwright-mcp playwright-mcp:latest",
      "transport": "stdio",
      "health_check": {
        "type": "command",
        "target": "docker inspect --format='{{.State.Running}}' playwright-mcp",
        "interval_seconds": 30,
        "timeout_seconds": 10,
        "retries_before_restart": 3
      }
    }
  }
}
```

---

## CLI Commands

### Starting and Stopping

| Command | Description |
|---------|-------------|
| `python start_server.py` | Start the backend and all enabled servers |
| `python start_server.py --stop` | Gracefully stop the running backend |
| `python start_server.py --restart` | Stop and restart the backend |

### Diagnostics

| Command | Description |
|---------|-------------|
| `python start_server.py --status` | Show status of all managed servers |
| `python start_server.py --validate` | Validate configuration without starting |
| `python start_server.py --dry-run` | Simulate startup (no processes launched) |
| `python start_server.py --version` | Show backend version |
| `python start_server.py --logs` | Tail the main backend log |
| `python start_server.py --logs <server>` | Tail a specific server's log |

### Testing

| Command | Description |
|---------|-------------|
| `python start_server.py --mock-server` | Start a mock MCP server for testing |

### Recovery

| Command | Description |
|---------|-------------|
| `python start_server.py --restore-state <TIMESTAMP>` | Restore state from a backup |

The timestamp format is `YYYYMMDD_HHMMSS`. To see available backups, run the command without a valid timestamp — it will list all available restore points.

---

## API Endpoints

All API endpoints (except `/health`) require authentication via `Authorization: Bearer <token>` header.

### Health Check (No Auth)

```
GET /health
```

Returns backend status, version info, and uptime. Used by monitoring tools.

### Server Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/servers` | List all servers with current status |
| GET | `/api/v1/servers/{name}` | Get details of a specific server |
| POST | `/api/v1/servers/{name}/start` | Start a stopped server |
| POST | `/api/v1/servers/{name}/stop` | Stop a running server |
| POST | `/api/v1/servers/{name}/restart` | Restart a server |
| POST | `/api/v1/servers/{name}/update` | Trigger an update for a server |
| GET | `/api/v1/servers/{name}/logs` | View recent log lines |

### Health Monitoring

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/health/all` | Health status of all servers |
| GET | `/api/v1/health/{name}` | Health status of a specific server |

### System Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/system/storage` | Disk usage and retention policy |
| POST | `/api/v1/system/cleanup` | Trigger manual cleanup |
| POST | `/api/v1/system/restart` | Restart the backend itself |

### Deployment

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/deploy/lock` | Acquire deployment lock |
| DELETE | `/api/v1/deploy/lock` | Release deployment lock |
| GET | `/api/v1/deploy/history` | View deployment history |

---

## Monitoring

### Health Endpoint

The `/health` endpoint returns:
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "api_version": "v1",
  "protocol_version": "2025-01-01",
  "uptime": 86400,
  "servers": { "playwright": "running", "crawl4ai": "running" }
}
```

Use this with UptimeRobot, Healthchecks.io, or similar monitoring services.

### Alert Thresholds

Alerts are configured in `config/mcp_alerts.json`. The system automatically:
- Detects when servers crash or become unhealthy
- Monitors disk space and memory usage
- Detects anomalous event rates (sudden spikes)

---

## Auto-Recovery

The backend includes multiple layers of self-healing:

| Feature | Description |
|---------|-------------|
| **Auto-restart** | Crashed servers are automatically restarted with exponential backoff |
| **Health monitoring** | Continuous checks at configurable intervals |
| **State backups** | Automatic state snapshots on shutdown, kept for recovery |
| **Orphan adoption** | On restart, detects and adopts running processes from previous instance |
| **Crash loop detection** | Stops restarting if a server crashes too frequently |
| **Disk monitoring** | Warns at 90%, blocks operations at 95% |
| **Docker monitoring** | Detects Docker daemon failures and retries |

---

## Configuration Hot-Reload

Send `SIGHUP` to the backend process to reload `mcp_servers.json` without restart:
```bash
kill -HUP $(cat backend/state/supervisor.pid)
```

Only actual content changes trigger a reload (SHA-256 comparison).

---

## Disaster Recovery

Detailed recovery procedures are documented in `backend/docs/disaster_recovery.md`:

| Procedure | Scenario |
|-----------|----------|
| A | Complete VPS rebuild |
| B | Corrupted state files |
| C | Failed deployment |
| D | Docker daemon failure |
| E | Disk full |

---

## Security

- All API calls require bearer token authentication
- Constant-time token comparison prevents timing attacks
- IP allowlist restricts API access to known addresses
- HTTPS enforcement in production (via nginx reverse proxy)
- Command injection prevention for all subprocess calls
- Path traversal prevention for log file access
- Docker command whitelist blocks dangerous operations
- Audit logging for all security-relevant actions
- Secret redaction in all log output
