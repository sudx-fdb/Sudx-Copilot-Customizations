# Backend MCP Server Manager — Technical Code Documentation

## Overview

The Backend MCP Server Manager is a Python-based VPS service that manages MCP (Model Context Protocol) server processes. It handles lifecycle management, health monitoring, automatic updates, structured logging, security, and exposes a REST API for remote control from the VS Code extension.

**Stack:** Python 3.10+, FastAPI, uvicorn, Pydantic v2, psutil, sse-starlette, aiofiles

---

## Architecture

### File Structure

```
backend/
├── start_server.py              ← Bootstrap, CLI, supervisor entry point (~2000 lines)
├── requirements.txt             ← Python dependencies
├── .env.example                 ← Environment variable template
├── src/
│   ├── models.py                ← Pydantic data models and enums
│   ├── mcp_registry.py          ← Config loader, SIGHUP hot-reload
│   ├── mcp_supervisor.py        ← Process lifecycle manager
│   ├── mcp_health.py            ← Health checks and auto-restart
│   ├── mcp_updater.py           ← Atomic update pipeline
│   ├── internal_api.py          ← FastAPI REST API
│   ├── security.py              ← Auth, IP allowlist, injection prevention
│   ├── logging_setup.py         ← JSON structured logging
│   ├── mcp_logger.py            ← Central event bus + metrics
│   ├── mcp_logging_helper.py    ← Logging utilities for MCP servers
│   └── self_healing.py          ← Docker monitoring, disk, recovery
├── config/
│   ├── mcp_servers.json         ← Server definitions
│   ├── mcp_servers.json.example ← Template with safe defaults
│   ├── mcp_alerts.json          ← Alert threshold configuration
│   ├── mcp_logging.json         ← Logger configuration
│   ├── mcp_protocol_quirks.json ← Per-MCP protocol workarounds
│   ├── nginx-sudx-backend.conf  ← Nginx reverse proxy template
│   ├── sudx-mcp-backend.service ← systemd unit file
│   ├── sudx-mcp-backend.logrotate ← logrotate config
│   └── schemas/                 ← JSON Schema validation files
├── docs/
│   ├── disaster_recovery.md     ← Recovery procedures A-E
│   ├── vps_setup.md             ← VPS installation guide
│   ├── monitoring.md            ← Health checks and alerting
│   └── logger_integration_guide.md ← Logger integration docs
├── state/                       ← Runtime state (JSON files)
├── logs/                        ← Rotated log files
└── tests/                       ← Test files
```

---

## Module Reference

### `models.py` — Data Models

Pydantic v2 models for all backend data structures.

#### Enums

| Enum | Values | Purpose |
|------|--------|---------|
| `InstallMethod` | `docker`, `pip`, `system` | How an MCP server is installed |
| `TransportType` | `stdio`, `sse`, `streamable-http` | MCP transport protocol |
| `HealthCheckType` | `http`, `tcp`, `command` | Health check method |
| `RestartPolicy` | `always`, `on-failure`, `never` | Process restart behavior |
| `ServerStatus` | `stopped`, `starting`, `running`, `unhealthy`, `stopping`, `crashed`, `updating`, `unknown` | Runtime state |
| `UpdateStatus` | `pending`, `in_progress`, `success`, `failed`, `rolled_back` | Update operation state |

#### Configuration Models

| Model | Fields | Purpose |
|-------|--------|---------|
| `HealthCheckConfig` | `type`, `target`, `interval_seconds`, `timeout_seconds`, `retries_before_restart` | Per-server health check settings |
| `ResourceLimits` | `memory_mb`, `cpu_percent` | Process resource constraints |
| `SecurityConfig` | `requires_root`, `sudoers_rule`, `restricted_capabilities` | Privilege requirements |
| `ServerConfig` | `enabled`, `install_method`, `start_command`, `transport`, `health_check`, `resource_limits`, `security`, etc. | Complete server definition |
| `GlobalConfig` | `remote_base_path`, `state_dir`, `log_dir`, `api_port`, `api_host` | Backend-wide settings |
| `McpServersConfig` | `servers`, `global_config` | Top-level config container |

#### Runtime Models

| Model | Fields | Purpose |
|-------|--------|---------|
| `ServerState` | `status`, `pid`, `start_time`, `restart_count`, `last_error`, `uptime()` | Per-server runtime state |
| `HealthStatus` | `healthy`, `last_check`, `consecutive_failures`, `details` | Health check results |
| `UpdateResult` | `status`, `server_name`, `old_version`, `new_version`, `started_at`, `completed_at`, `error` | Update operation result |
| `SupervisorSnapshot` | `states`, `timestamp` | Full supervisor state dump |
| `ApiResponse` | `success`, `message`, `data`, `error_code` | Standard API response wrapper |
| `BackendError` | `code`, `message`, `suggestion` | Structured error response |

---

### `mcp_registry.py` — Configuration Registry

Central configuration loader and typed access layer.

#### Class: `McpRegistry`

| Method | Signature | Description |
|--------|-----------|-------------|
| `__init__()` | `(config_path: Path)` | Load and validate `mcp_servers.json` |
| `get_server()` | `(name: str) → ServerConfig` | Get config for a specific server |
| `get_enabled_servers()` | `() → Dict[str, ServerConfig]` | All servers with `enabled=True` |
| `get_server_names()` | `() → List[str]` | All server names (enabled + disabled) |
| `reload()` | `() → bool` | Hot-reload config, returns True if changed |
| `global_config` | property → `GlobalConfig` | Backend-wide settings |

#### Features

- **Hot-reload:** Listens for `SIGHUP` signal, reloads `mcp_servers.json` without restart
- **Hash change detection:** SHA-256 of config file, only reloads on actual content change
- **Structural validation:** `_validate_raw_config()` checks required fields and valid enum values before Pydantic parsing
- **Pydantic validation:** Full type checking and constraint enforcement via Pydantic v2

#### Exception: `ConfigValidationError`

Raised when config fails structural validation. Contains `errors: List[str]` with all validation failures.

---

### `mcp_supervisor.py` — Process Supervisor

Lifecycle management for MCP server processes.

#### Class: `McpSupervisor`

| Method | Signature | Description |
|--------|-----------|-------------|
| `__init__()` | `(registry: McpRegistry)` | Initialize with server configs |
| `start_server()` | `async (name: str) → bool` | Start a single server process |
| `stop_server()` | `async (name: str, timeout: int) → bool` | Graceful stop with SIGTERM/SIGKILL fallback |
| `restart_server()` | `async (name: str) → bool` | Stop + start with state preservation |
| `start_all()` | `async () → Dict[str, bool]` | Start all enabled servers in dependency order |
| `stop_all()` | `async () → Dict[str, bool]` | Stop all servers in reverse dependency order |
| `get_state()` | `(name: str) → ServerState` | Current runtime state |
| `get_snapshot()` | `() → SupervisorSnapshot` | Full state dump of all servers |
| `adopt_orphans()` | `async ()` | Detect and adopt running processes from previous instance |

#### Process Management

- **Docker servers:** Uses `docker start/stop/restart` commands
- **pip/system servers:** Spawns via `subprocess.Popen` with per-server log files
- **Sudo wrapping:** Servers with `requires_root=True` get commands wrapped with `sudo`
- **PID files:** Stored in `state/` directory for orphan adoption
- **Dependency ordering:** Respects `depends_on` field for start/stop sequencing
- **Per-server logging:** Each server gets a dedicated `RotatingFileHandler` in `logs/`

---

### `mcp_health.py` — Health Monitor

Continuous background health checking with auto-restart.

#### Class: `HealthMonitor`

| Method | Signature | Description |
|--------|-----------|-------------|
| `__init__()` | `(registry, supervisor, state_dir)` | Initialize monitor |
| `start()` | `async ()` | Start background monitoring loop |
| `stop()` | `async ()` | Stop monitoring gracefully |
| `get_status()` | `(name: str) → HealthStatus` | Latest health check result |
| `get_all_statuses()` | `() → Dict[str, HealthStatus]` | All server health statuses |
| `force_check()` | `async (name: str)` | Trigger immediate health check |

#### Health Check Methods

| Type | Implementation | Target Format |
|------|---------------|---------------|
| `HTTP` | `aiohttp.ClientSession.get()` with timeout | `http://host:port/health` |
| `TCP` | `asyncio.open_connection()` with timeout | `host:port` |
| `command` | `asyncio.create_subprocess_shell()` | Shell command (exit code 0 = healthy) |

#### Auto-Restart Logic

1. Failed check increments `consecutive_failures`
2. After `retries_before_restart` failures → trigger restart via supervisor
3. Exponential backoff between restarts (capped at `_MAX_BACKOFF_SECONDS = 300`)
4. After `_SUSTAINED_HEALTHY_COUNT = 10` consecutive successes → reset restart counter
5. `_permanently_failed` flag prevents infinite restart loops

#### History Persistence

- Last `_HISTORY_MAX_PER_SERVER = 100` check results stored per server
- Flushed to `state/health_history.json` every `_HISTORY_FLUSH_INTERVAL = 10` checks

---

### `mcp_updater.py` — Update Manager

Atomic update pipeline for MCP servers.

#### Class: `McpUpdater`

| Method | Signature | Description |
|--------|-----------|-------------|
| `__init__()` | `(registry, supervisor, health_monitor, state_dir)` | Initialize updater |
| `update_server()` | `async (name: str) → UpdateResult` | Update a single server atomically |
| `update_all()` | `async () → Dict[str, UpdateResult]` | Update all enabled servers sequentially |
| `get_last_result()` | `(name: str) → Optional[UpdateResult]` | Last update result for a server |
| `get_update_log()` | `() → List[Dict]` | Full update history |

#### Update Methods by Install Type

| InstallMethod | Backup | Apply | Verify |
|---------------|--------|-------|--------|
| `docker` | `docker tag` current image | `docker pull` new image | Health check pass |
| `pip` | `pip freeze` current versions | `pip install --upgrade` | Import test + health check |
| `system` | N/A | N/A (manual) | Health check pass |

#### Atomic Update Sequence

1. Acquire `asyncio.Lock` + file lock (`_LOCK_FILE`)
2. Pre-check: server exists and is enabled
3. Backup: method-specific state saving
4. Stop: graceful server shutdown
5. Apply: run update command
6. Start: restart server
7. Verify: health check passes
8. On failure: rollback backup, restart old version

---

### `internal_api.py` — REST API

FastAPI-based HTTP API for remote control.

#### Authentication

All endpoints require `Authorization: Bearer <token>` header. Token validated via `verify_token_constant_time()` from `security.py`.

#### Rate Limiting

In-memory sliding window rate limiter: `_RATE_LIMIT_PER_MINUTE = 60` per IP.

#### Versioning

| Constant | Value | Purpose |
|----------|-------|---------|
| `_API_VERSION` | `"v1"` | URL prefix: `/api/v1/...` |
| `_BACKEND_VERSION` | `"1.0.0"` | Backend software version |
| `_API_PROTOCOL_VERSION` | `"2025-01-01"` | API protocol version for compatibility checking |

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health status (public, no auth), returns version info + uptime |
| `GET` | `/api/v1/servers` | List all servers with status |
| `GET` | `/api/v1/servers/{name}` | Single server details |
| `POST` | `/api/v1/servers/{name}/start` | Start a server |
| `POST` | `/api/v1/servers/{name}/stop` | Stop a server |
| `POST` | `/api/v1/servers/{name}/restart` | Restart a server |
| `POST` | `/api/v1/servers/{name}/update` | Trigger update |
| `GET` | `/api/v1/servers/{name}/logs` | Tail server log lines |
| `GET` | `/api/v1/health/all` | Health status of all servers |
| `GET` | `/api/v1/health/{name}` | Health status of specific server |
| `POST` | `/api/v1/deploy/lock` | Acquire deployment lock |
| `DELETE` | `/api/v1/deploy/lock` | Release deployment lock |
| `GET` | `/api/v1/deploy/history` | Deployment history |
| `POST` | `/api/v1/events/emit` | Emit a custom event to the logger |
| `POST` | `/api/v1/system/restart` | Trigger backend self-restart |
| `GET` | `/api/v1/system/storage` | Disk usage + retention policy summary |
| `POST` | `/api/v1/system/cleanup` | Manual cleanup trigger |
| `GET` | `/api/v1/events/stream` | SSE event stream (for VS Code logger bridge) |
| `GET` | `/api/v1/events/metrics` | Current metrics snapshot |
| `GET` | `/api/v1/events/metrics/{name}` | Per-MCP detailed metrics |

#### SSE Event Stream

`GET /api/v1/events/stream` returns a `text/event-stream` response. Supports:
- `?mcp=<name>` query parameter for server-specific filtering
- `Last-Event-ID` header for replay on reconnect
- Heartbeat comments (`:heartbeat\n\n`) every 30 seconds

---

### `security.py` — Security Hardening

#### Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `verify_token_constant_time()` | `(provided: str, expected: str) → bool` | HMAC-based constant-time comparison |
| `check_https_enforcement()` | `(request, production: bool)` | Validates `X-Forwarded-Proto: https` |
| `validate_ip_allowlist()` | `(client_ip: str, allowlist: Set[str])` | IP allowlist enforcement |
| `sanitize_command()` | `(cmd: str) → str` | Shell injection prevention (blocks `; | & $ \`` etc.) |
| `prevent_path_traversal()` | `(path: str, base_dir: str) → str` | Resolves and validates path stays within `base_dir` |
| `sanitize_log_output()` | `(text: str) → str` | Redacts secrets from log output |
| `validate_docker_command()` | `(cmd_parts: List[str]) → bool` | Whitelist-based Docker command validation |
| `rate_limit_check_auth()` | `(client_ip: str) → bool` | Separate auth rate limit (10/min) |
| `write_audit_log()` | `(event: str, details: Dict)` | Append to audit log file |

#### Secret Patterns Redacted

`Bearer`, `token`, `password`, `api_key`, `secret`, private keys — all redacted in log output.

#### Docker Security

- Whitelist: `docker info|version|ps|images|pull|start|stop|restart|rm|logs|inspect|compose|up|down`
- Blocklist: `exec|run|build|push|login|save|load|export|import`

---

### `logging_setup.py` — Structured Logging

#### Class: `JsonFormatter`

Formats log records as JSON lines with fields: `timestamp`, `level`, `logger`, `message`, `module`, `function`, `line`.

#### Function: `setup_logging()`

| Parameter | Default | Description |
|-----------|---------|-------------|
| `log_dir` | `logs/` | Directory for log files |
| `level` | `DEBUG` | Root log level |
| `json_file` | `True` | Enable JSON file logging |
| `console` | `True` | Enable colored console output |

Creates per-component loggers for: `backend.supervisor`, `backend.health`, `backend.updater`, `backend.api`, `backend.registry`, `backend.security`, `backend.self_healing`, `backend.models`, `backend.logger`.

All file handlers use `RotatingFileHandler` with 10 MB rotation and 5 backups.

---

### `mcp_logger.py` — Central Event Bus

Central event capture, buffering, metrics, and alert engine.

#### Enums

| Enum | Description |
|------|-------------|
| `McpEventType` | 24 event types (tool calls, server lifecycle, health checks, protocol events, alerts) |
| `McpSeverity` | `DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL` |

#### Dataclass: `McpLogEvent`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `str` | UUID v4 |
| `timestamp` | `float` | Unix epoch |
| `event_type` | `McpEventType` | Event classification |
| `severity` | `McpSeverity` | Severity level |
| `mcp_name` | `str` | Source MCP server name |
| `tool_name` | `Optional[str]` | Tool being called |
| `message` | `str` | Human-readable description |
| `data` | `Dict` | Arbitrary payload |
| `duration_ms` | `Optional[float]` | Elapsed time for timed events |

#### Class: `McpEventBus`

In-memory ring buffer with async subscriber dispatch.

| Method | Description |
|--------|-------------|
| `emit(event)` | Add event to ring buffer and dispatch to subscribers |
| `subscribe(callback)` | Register async callback for new events |
| `unsubscribe(callback)` | Remove subscriber |
| `get_recent(count)` | Get last N events from buffer |
| `get_events_since(event_id)` | Replay events after a given ID |

Ring buffer: default 10,000 events capacity, configured via `mcp_logging.json`.

#### Class: `McpProcessProxy`

Intercepts MCP server I/O streams for logging.

| Feature | Description |
|---------|-------------|
| stdio interception | Wraps `stdin`/`stdout` pipes, parses JSON-RPC messages |
| Docker log capture | Tails `docker logs --follow` output |
| SSE event capture | Connects to SSE endpoints for logger events |
| Protocol parsing | Detects `tools/call`, `initialize`, `resources/read` MCP methods |

#### Class: `McpMetricsCollector`

Per-MCP rolling statistics with token estimation.

| Metric | Type | Description |
|--------|------|-------------|
| `total_events` | counter | Total events received |
| `tool_calls` | counter | Tool call starts |
| `errors` | counter | Error events |
| `avg_duration_ms` | rolling avg | Average tool call duration |
| `p95_duration_ms` | percentile | 95th percentile duration |
| `events_per_minute` | rate | Current event rate |
| `token_estimate` | counter | Estimated token usage |

#### Class: `McpAlertEngine`

Threshold-based and anomaly detection alerting.

| Feature | Description |
|---------|-------------|
| Threshold alerts | Trigger when metric exceeds configured thresholds (from `mcp_alerts.json`) |
| Anomaly detection | Z-score based anomaly detection on rolling windows |
| Alert lifecycle | `ALERT_TRIGGERED` → `ALERT_RESOLVED` with cooldown periods |

---

### `mcp_logging_helper.py` — Logging Utilities

Helper functions for MCP server code to emit standardized events.

| Function | Description |
|----------|-------------|
| `log_tool_start(tool, params)` | Emit `TOOL_CALL_START` event |
| `log_tool_end(tool, result, duration_ms)` | Emit `TOOL_CALL_END` event |
| `log_tool_error(tool, error)` | Emit `TOOL_CALL_ERROR` event |
| `redact_sensitive(data)` | Recursively redact fields matching sensitive patterns |
| `set_sensitive_patterns(patterns)` | Override default redaction patterns |

Sensitive patterns: `password`, `secret`, `token`, `api_key`, `auth_key`, `private_key`, `ssh_key`, `credential`.

---

### `self_healing.py` — Self-Healing & Recovery

#### Class: `DockerDaemonMonitor`

Monitors Docker daemon availability with cached check results.

#### Class: `DiskSpaceMonitor`

| Threshold | Value | Action |
|-----------|-------|--------|
| Warning | 90% | Log warning |
| Blocking | 95% | Block new operations |
| Emergency | 95% | Trigger emergency cleanup |

#### Functions

| Function | Description |
|----------|-------------|
| `recover_corrupted_state(state_dir)` | Detect and recover from corrupted JSON state files |
| `atomic_json_write(path, data)` | Write JSON via temp file + rename (atomic on POSIX) |
| `cleanup_zombie_processes()` | Detect and kill orphaned MCP server processes |
| `enforce_resource_limits(pid, limits)` | Check and enforce per-process resource limits |
| `prevent_cascade_failure(restart_func)` | Delay between sequential restarts to prevent cascade |
| `emergency_shutdown(supervisor)` | Stop all servers when disk is critically full |

---

### `start_server.py` — Bootstrap & CLI

Complete entry point for the backend service.

#### CLI Commands

| Flag | Description |
|------|-------------|
| (none) | Start the backend normally |
| `--validate` | Validate config and exit |
| `--dry-run` | Simulate startup without running |
| `--status` | Print running server status |
| `--stop` | Shutdown running backend |
| `--restart` | Stop + start |
| `--version` | Print version info |
| `--logs [server]` | Tail log files |
| `--mock-server` | Start mock MCP test server |
| `--install-service` | Install systemd service |
| `--uninstall-service` | Remove systemd service |
| `--restore-state TIMESTAMP` | Restore state from backup |

#### Bootstrap Sequence

1. Python version check (≥ 3.10)
2. Virtual environment detection/creation
3. Dependency installation from `requirements.txt`
4. Directory structure creation (`state/`, `logs/`, `config/`)
5. Config validation via `McpRegistry`
6. Component initialization: `McpRegistry` → `McpSupervisor` → `HealthMonitor` → `McpUpdater` → `McpLogger` → `InternalAPI`
7. PID file creation
8. Orphan process adoption
9. Start all enabled servers
10. Start health monitor
11. Start API server (uvicorn)
12. Start watchdog loop

#### Graceful Shutdown

1. Stop accepting new API requests
2. Stop health monitor
3. Stop all MCP servers (dependency order)
4. Flush logger buffers
5. Save supervisor state snapshot
6. Remove PID file
7. Backup state files
8. Save final state snapshot

#### State Backup

`_backup_state_files()`: Copies all `state/*.json` to `state/backup/` with `_YYYYMMDD_HHMMSS` suffix. Keeps last 10 backups per file stem.

#### Watchdog

Background loop monitoring:
- Main process health
- Memory usage (warning at 70%, critical at 90%)
- Disk space
- Crash loop detection (`_CRASH_MAX_COUNT = 5` within `_CRASH_WINDOW_SECONDS = 600`)
- Self-restart on critical failures via `_self_restart()`
