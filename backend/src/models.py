"""
Pydantic models for the Backend MCP Server Manager.

Defines typed data models for server configuration, runtime state,
health status, update results, and API responses.
"""

from __future__ import annotations

import logging
import time
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, validator

logger = logging.getLogger("backend.models")


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class InstallMethod(str, Enum):
    """Supported MCP server installation methods."""
    DOCKER = "docker"
    PIP = "pip"
    SYSTEM = "system"


class TransportType(str, Enum):
    """MCP transport protocol types."""
    STDIO = "stdio"
    SSE = "sse"
    STREAMABLE_HTTP = "streamable-http"


class HealthCheckType(str, Enum):
    """Types of health checks."""
    HTTP = "http"
    TCP = "tcp"
    COMMAND = "command"


class RestartPolicy(str, Enum):
    """Process restart policies."""
    ALWAYS = "always"
    ON_FAILURE = "on-failure"
    NEVER = "never"


class ServerStatus(str, Enum):
    """Runtime status of an MCP server."""
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    UNHEALTHY = "unhealthy"
    STOPPING = "stopping"
    CRASHED = "crashed"
    UPDATING = "updating"
    UNKNOWN = "unknown"


class UpdateStatus(str, Enum):
    """Status of an update operation."""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    SUCCESS = "success"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"


# ---------------------------------------------------------------------------
# Configuration Models (loaded from mcp_servers.json)
# ---------------------------------------------------------------------------

class HealthCheckConfig(BaseModel):
    """Health check configuration for an MCP server."""
    type: HealthCheckType = HealthCheckType.COMMAND
    target: str = ""
    interval_seconds: int = Field(default=30, ge=5, le=600)
    timeout_seconds: int = Field(default=10, ge=1, le=120)
    retries_before_restart: int = Field(default=3, ge=1, le=20)


class ResourceLimits(BaseModel):
    """Resource constraints for an MCP server process."""
    memory_mb: Optional[int] = Field(default=None, ge=64, le=65536)
    cpu_percent: Optional[int] = Field(default=None, ge=1, le=100)


class SecurityConfig(BaseModel):
    """Security constraints for servers requiring elevated privileges."""
    requires_root: bool = False
    sudoers_rule: Optional[str] = None
    restricted_capabilities: List[str] = Field(default_factory=list)


class ServerConfig(BaseModel):
    """
    Complete configuration for a single MCP server.
    Loaded from backend/config/mcp_servers.json.
    """
    enabled: bool = True
    install_method: InstallMethod = InstallMethod.DOCKER
    docker_image: Optional[str] = None
    docker_compose_file: Optional[str] = None
    pip_package: Optional[str] = None
    git_repo: Optional[str] = None
    start_command: List[str] = Field(default_factory=list)
    stop_signal: str = "SIGTERM"
    stop_timeout_seconds: int = Field(default=30, ge=5, le=300)
    health_check: HealthCheckConfig = Field(default_factory=HealthCheckConfig)
    port: Optional[int] = Field(default=None, ge=1, le=65535)
    env: Dict[str, str] = Field(default_factory=dict)
    volumes: List[str] = Field(default_factory=list)
    depends_on: List[str] = Field(default_factory=list)
    restart_policy: RestartPolicy = RestartPolicy.ON_FAILURE
    max_restart_count: int = Field(default=10, ge=0, le=100)
    restart_backoff_base: float = Field(default=2.0, ge=1.0, le=60.0)
    resource_limits: ResourceLimits = Field(default_factory=ResourceLimits)
    transport: TransportType = TransportType.STDIO
    mcp_endpoint: Optional[str] = None
    security: Optional[SecurityConfig] = None
    tags: List[str] = Field(default_factory=list)

    @validator("start_command")
    def start_command_not_empty(cls, v: List[str]) -> List[str]:
        if not v:
            logger.warning("ServerConfig has empty start_command — server won't be startable")
        return v

    @validator("docker_image")
    def docker_image_required_for_docker(cls, v: Optional[str], values: Dict[str, Any]) -> Optional[str]:
        method = values.get("install_method")
        if method == InstallMethod.DOCKER and not v and not values.get("docker_compose_file"):
            logger.warning("Docker install method but no docker_image or docker_compose_file specified")
        return v


class GlobalConfig(BaseModel):
    """Global backend configuration from mcp_servers.json."""
    log_dir: str = "logs"
    state_dir: str = "state"
    config_dir: str = "config"
    data_dir: str = "data"
    health_check_default_interval: int = Field(default=30, ge=5, le=600)
    max_concurrent_updates: int = Field(default=1, ge=1, le=5)
    api_port: int = Field(default=8420, ge=1024, le=65535)
    api_host: str = "0.0.0.0"
    api_token_env: str = "SUDX_BACKEND_TOKEN"
    remote_base_path: str = "/opt/sudx-backend"
    venv_path: str = "backend/.venv"
    ring_buffer_size: int = Field(default=10000, ge=100, le=1000000)
    metrics_persist_interval_seconds: int = Field(default=60, ge=10, le=3600)
    event_archive_max_size_mb: int = Field(default=50, ge=1, le=1000)
    event_archive_max_rotations: int = Field(default=10, ge=1, le=100)
    sse_max_clients: int = Field(default=10, ge=1, le=100)
    sse_heartbeat_interval_seconds: int = Field(default=15, ge=5, le=120)
    alert_cooldown_seconds: int = Field(default=300, ge=10, le=3600)
    cleanup_interval_hours: int = Field(default=1, ge=1, le=168)
    retention_days_events: int = Field(default=90, ge=1, le=3650)
    retention_days_logs: int = Field(default=14, ge=1, le=365)
    retention_days_metrics: int = Field(default=365, ge=1, le=3650)


class McpServersConfig(BaseModel):
    """Root configuration model — represents the entire mcp_servers.json."""
    schema_version: int = Field(default=1, alias="$schema_version")
    servers: Dict[str, ServerConfig] = Field(default_factory=dict)
    global_config: GlobalConfig = Field(default_factory=GlobalConfig, alias="global")

    class Config:
        populate_by_name = True


# ---------------------------------------------------------------------------
# Runtime State Models
# ---------------------------------------------------------------------------

class HealthStatus(BaseModel):
    """Current health status of an MCP server."""
    server_name: str
    healthy: bool = False
    last_check_time: float = 0.0
    last_success_time: float = 0.0
    consecutive_failures: int = 0
    last_error: Optional[str] = None
    response_time_ms: Optional[float] = None

    @property
    def time_since_last_check(self) -> float:
        """Seconds since the last health check."""
        if self.last_check_time <= 0:
            return float("inf")
        return time.time() - self.last_check_time

    @property
    def time_since_last_success(self) -> float:
        """Seconds since the last successful health check."""
        if self.last_success_time <= 0:
            return float("inf")
        return time.time() - self.last_success_time


class ServerState(BaseModel):
    """
    Runtime state of an MCP server process.
    Persisted to backend/state/<server_name>.json for autorecovery.
    """
    server_name: str
    status: ServerStatus = ServerStatus.STOPPED
    pid: Optional[int] = None
    container_id: Optional[str] = None
    start_time: Optional[float] = None
    stop_time: Optional[float] = None
    restart_count: int = 0
    last_restart_time: Optional[float] = None
    health: HealthStatus = Field(default_factory=lambda: HealthStatus(server_name=""))
    last_error: Optional[str] = None
    version: Optional[str] = None
    update_in_progress: bool = False

    def __init__(self, **data: Any) -> None:
        super().__init__(**data)
        if self.health.server_name == "":
            self.health.server_name = self.server_name
        logger.debug("ServerState initialized for %s: status=%s, pid=%s", self.server_name, self.status, self.pid)

    @property
    def uptime_seconds(self) -> Optional[float]:
        """Seconds since the server was started, or None if not running."""
        if self.start_time is None or self.status not in (ServerStatus.RUNNING, ServerStatus.UNHEALTHY):
            return None
        return time.time() - self.start_time

    def to_state_file(self, state_dir: Path) -> Path:
        """Get the path to this server's state file."""
        return state_dir / f"{self.server_name}.json"


class UpdateResult(BaseModel):
    """Result of an MCP server update operation."""
    server_name: str
    status: UpdateStatus = UpdateStatus.PENDING
    old_version: Optional[str] = None
    new_version: Optional[str] = None
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    error: Optional[str] = None
    rollback_performed: bool = False
    steps_completed: List[str] = Field(default_factory=list)

    @property
    def duration_seconds(self) -> Optional[float]:
        """Duration of the update in seconds."""
        if self.started_at is None or self.completed_at is None:
            return None
        return self.completed_at - self.started_at


# ---------------------------------------------------------------------------
# API Response Models
# ---------------------------------------------------------------------------

class ApiResponse(BaseModel):
    """Standard API response wrapper."""
    success: bool = True
    message: str = ""
    data: Optional[Any] = None
    error: Optional[str] = None
    timestamp: float = Field(default_factory=time.time)


class ServerStatusResponse(BaseModel):
    """API response for server status queries."""
    server_name: str
    status: ServerStatus
    pid: Optional[int] = None
    uptime_seconds: Optional[float] = None
    health: HealthStatus
    restart_count: int = 0
    version: Optional[str] = None


class AllServersStatusResponse(BaseModel):
    """API response for all-servers status overview."""
    total: int = 0
    running: int = 0
    stopped: int = 0
    unhealthy: int = 0
    servers: Dict[str, ServerStatusResponse] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Cache & Autorecovery
# ---------------------------------------------------------------------------

class SupervisorSnapshot(BaseModel):
    """
    Full supervisor state snapshot for autorecovery.
    Persisted periodically to backend/state/_supervisor.json.
    """
    timestamp: float = Field(default_factory=time.time)
    servers: Dict[str, ServerState] = Field(default_factory=dict)
    global_restart_count: int = 0
    uptime_seconds: float = 0.0
    last_config_hash: Optional[str] = None

    def save(self, state_dir: Path) -> None:
        """Persist snapshot to disk for autorecovery."""
        snapshot_path = state_dir / "_supervisor.json"
        try:
            snapshot_path.parent.mkdir(parents=True, exist_ok=True)
            snapshot_path.write_text(self.model_dump_json(indent=2), encoding="utf-8")
            logger.debug("Supervisor snapshot saved to %s", snapshot_path)
        except Exception as exc:
            logger.error("Failed to save supervisor snapshot: %s", exc)

    @classmethod
    def load(cls, state_dir: Path) -> Optional["SupervisorSnapshot"]:
        """Load snapshot from disk for autorecovery. Returns None if not found or invalid."""
        snapshot_path = state_dir / "_supervisor.json"
        try:
            if not snapshot_path.exists():
                logger.debug("No supervisor snapshot found at %s", snapshot_path)
                return None
            raw = snapshot_path.read_text(encoding="utf-8")
            snapshot = cls.model_validate_json(raw)
            logger.debug("Supervisor snapshot loaded from %s (age=%.1fs)", snapshot_path, time.time() - snapshot.timestamp)
            return snapshot
        except Exception as exc:
            logger.error("Failed to load supervisor snapshot: %s", exc)
            return None


# ---------------------------------------------------------------------------
# Custom Exception Hierarchy
# ---------------------------------------------------------------------------

class BackendError(Exception):
    """Base exception for all backend errors. Includes error code and suggested fix."""

    def __init__(self, message: str, code: str = "E_BACKEND", suggestion: str = ""):
        super().__init__(message)
        self.code = code
        self.suggestion = suggestion
        logger.debug("BackendError raised: [%s] %s", code, message)


class ConfigError(BackendError):
    """Configuration-related errors (invalid JSON, missing fields, schema mismatch)."""

    def __init__(self, message: str, suggestion: str = "Check mcp_servers.json syntax and schema"):
        super().__init__(message, code="E_CONFIG", suggestion=suggestion)


class SupervisorError(BackendError):
    """Process supervisor errors (start failure, PID conflict, orphan process)."""

    def __init__(self, message: str, suggestion: str = "Check server process and PID files"):
        super().__init__(message, code="E_SUPERVISOR", suggestion=suggestion)


class HealthCheckError(BackendError):
    """Health check errors (endpoint unreachable, timeout, unexpected response)."""

    def __init__(self, message: str, suggestion: str = "Verify server is running and health endpoint is accessible"):
        super().__init__(message, code="E_HEALTH", suggestion=suggestion)


class UpdateError(BackendError):
    """Update errors (pull failure, version mismatch, rollback needed)."""

    def __init__(self, message: str, suggestion: str = "Check network connectivity and repository access"):
        super().__init__(message, code="E_UPDATE", suggestion=suggestion)


class ApiError(BackendError):
    """API-level errors (auth failure, rate limit, invalid input)."""

    def __init__(self, message: str, code: str = "E_API", suggestion: str = "Check request format and authentication"):
        super().__init__(message, code=code, suggestion=suggestion)
