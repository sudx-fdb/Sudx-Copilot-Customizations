# Monitoring Endpoints — Sudx MCP Backend

## Health Endpoints for External Monitoring

### Basic Health Check
- **URL:** `GET https://rtnc.sudx.de/health`
- **Auth:** None required
- **Expected Response:** `200 OK`
  ```json
  { "status": "ok", "version": "1.0.0", "api_version": 1, "uptime": 86400 }
  ```
- **Alert if:** HTTP status != 200, or response time > 5s
- **Check interval:** 60 seconds

### MCP Servers Status
- **URL:** `GET https://rtnc.sudx.de/api/v1/servers`
- **Auth:** `Authorization: Bearer <token>`
- **Expected Response:** `200 OK` with server list
- **Alert if:** Any server has `status: "error"` or `status: "stopped"` unexpectedly
- **Check interval:** 300 seconds

### System Resources
- **URL:** `GET https://rtnc.sudx.de/api/v1/system`
- **Auth:** `Authorization: Bearer <token>`
- **Expected Response:** `200 OK` with CPU, RAM, disk stats
- **Alert thresholds:**
  - CPU > 90% sustained for 5 minutes
  - RAM > 85%
  - Disk > 90%

### Storage Usage
- **URL:** `GET https://rtnc.sudx.de/api/v1/system/storage`
- **Auth:** `Authorization: Bearer <token>`
- **Alert if:** `disk_free_gb < 2`

## UptimeRobot / Healthchecks.io Setup

### UptimeRobot
1. New Monitor → Type: HTTP(s)
2. URL: `https://rtnc.sudx.de/health`
3. Interval: 60 seconds
4. Alert Contacts: Configure email/Slack/Telegram

### Healthchecks.io (Cron-style)
- For the cleanup daemon: create a check with 1-hour expected interval
- Ping URL from cleanup task on success

## Prometheus Metrics (Future)

The backend exposes metrics at `GET /api/v1/mcp/metrics` in JSON format.
A Prometheus exporter (`/api/v1/mcp/metrics/prometheus`) is planned for a future release.

Current endpoints return JSON that can be parsed by custom Prometheus exporters or Grafana's JSON data source plugin.
