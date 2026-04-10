"""
Internal REST API for the Backend MCP Server Manager.

FastAPI-based HTTP API for remote control: server lifecycle, health,
updates, logs, and system info. Authenticated via bearer token.
"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import os
import platform
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Header, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from models import ApiResponse, ServerStatus, BackendError
import hmac


logger = logging.getLogger("backend.api")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_API_VERSION = "v1"
_BACKEND_VERSION = "1.0.0"
_API_PROTOCOL_VERSION = "2025-01-01"
_DEFAULT_LOG_LINES = 100
_MAX_LOG_LINES = 10000
_RATE_LIMIT_PER_MINUTE = 60
_RATE_LIMIT_WINDOW = 60.0  # seconds


# ---------------------------------------------------------------------------
# Rate limiter (in-memory, per IP)
# ---------------------------------------------------------------------------

class _RateLimiter:
    """Simple sliding window rate limiter per IP."""

    def __init__(self, max_requests: int = _RATE_LIMIT_PER_MINUTE, window: float = _RATE_LIMIT_WINDOW):
        self._max = max_requests
        self._window = window
        self._requests: Dict[str, list] = collections.defaultdict(list)

    def check(self, client_ip: str) -> bool:
        """Return True if request is allowed, False if rate limited."""
        now = time.time()
        timestamps = self._requests[client_ip]
        # Remove old entries
        self._requests[client_ip] = [t for t in timestamps if now - t < self._window]
        if len(self._requests[client_ip]) >= self._max:
            return False
        self._requests[client_ip].append(now)
        return True


_rate_limiter = _RateLimiter()


# ---------------------------------------------------------------------------
# Shared state (set by start_server.py during initialization)
# ---------------------------------------------------------------------------

_registry = None
_supervisor = None
_health_monitor = None
_updater = None
_shutdown_callback = None
_mcp_logger = None


def init_api(registry, supervisor, health_monitor, updater, shutdown_callback=None, mcp_logger=None):
    """
    Initialize the API with shared backend components.
    Called by start_server.py after all components are created.
    """
    global _registry, _supervisor, _health_monitor, _updater, _shutdown_callback, _mcp_logger, _app_start_time
    _registry = registry
    _supervisor = supervisor
    _health_monitor = health_monitor
    _updater = updater
    _shutdown_callback = shutdown_callback
    _mcp_logger = mcp_logger
    _app_start_time = time.time()
    logger.info("API initialized with all backend components (mcp_logger=%s)", "yes" if mcp_logger else "no")


# ---------------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Sudx Backend MCP Manager",
    version="1.0.0",
    description="REST API for managing MCP servers on VPS",
)

# CORS — restrict to known origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://sudx.de"],
    allow_origin_regex=r"^http://localhost:\d+$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Global exception handler — catch unhandled errors safely
# ---------------------------------------------------------------------------

@app.exception_handler(BackendError)
async def backend_error_handler(request: Request, exc: BackendError):
    """Handle BackendError subclasses with structured error response."""
    logger.error("BackendError [%s]: %s", exc.code, exc)
    return JSONResponse(
        status_code=500,
        content={"error": str(exc), "code": exc.code, "suggestion": exc.suggestion},
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch all unhandled exceptions — log full traceback, return safe error."""
    import traceback
    logger.critical("Unhandled exception on %s %s: %s", request.method, request.url.path, exc)
    logger.debug("Traceback:\n%s", traceback.format_exc())
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error", "code": "E_INTERNAL", "detail": "An unexpected error occurred"},
    )


# ---------------------------------------------------------------------------
# Auth middleware
# ---------------------------------------------------------------------------

def _get_auth_token() -> str:
    """Get the expected auth token from environment."""
    token = os.environ.get("SUDX_BACKEND_TOKEN", "")
    if not token:
        logger.warning("SUDX_BACKEND_TOKEN not set — API is unprotected!")
    return token


async def verify_token(authorization: Optional[str] = Header(None)) -> str:
    """Verify bearer token authentication."""
    expected = _get_auth_token()
    if not expected:
        return "no-auth"

    if not authorization:
        logger.debug("Auth failed: no Authorization header")
        raise HTTPException(status_code=401, detail={"error": "Missing Authorization header", "code": "E_AUTH_MISSING"})

    if not authorization.startswith("Bearer "):
        logger.debug("Auth failed: invalid format")
        raise HTTPException(status_code=401, detail={"error": "Invalid Authorization format", "code": "E_AUTH_FORMAT"})

    token = authorization[7:]
    if not hmac.compare_digest(token.encode("utf-8"), expected.encode("utf-8")):
        logger.warning("Auth failed: invalid token")
        raise HTTPException(status_code=401, detail={"error": "Invalid token", "code": "E_AUTH_INVALID"})

    return token


# ---------------------------------------------------------------------------
# Request/Response logging + Rate limiting middleware
# ---------------------------------------------------------------------------

@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    """Log all requests with method, path, status, duration. Apply rate limiting."""
    client_ip = request.client.host if request.client else "unknown"
    start_time = time.time()

    # Rate limiting
    if not _rate_limiter.check(client_ip):
        logger.warning("Rate limit exceeded for %s: %s %s", client_ip, request.method, request.url.path)
        return JSONResponse(
            status_code=429,
            content={"error": "Rate limit exceeded", "code": "E_RATE_LIMIT", "detail": f"Max {_RATE_LIMIT_PER_MINUTE} requests per minute"},
        )

    response = await call_next(request)
    elapsed_ms = (time.time() - start_time) * 1000

    logger.info(
        "%s %s → %d (%.1fms) [%s]",
        request.method, request.url.path, response.status_code, elapsed_ms, client_ip,
    )

    return response


# ---------------------------------------------------------------------------
# Health (no auth)
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    """Basic health check — no auth required. Includes version info for compatibility."""
    logger.debug("GET /health")
    import os as _os
    _start = getattr(health, '_start_time', None)
    if _start is None:
        health._start_time = time.time()
        _start = health._start_time
    return {
        "status": "ok",
        "timestamp": time.time(),
        "version": _BACKEND_VERSION,
        "api_version": 1,
        "protocol_version": _API_PROTOCOL_VERSION,
        "uptime": int(time.time() - _start),
    }


# ---------------------------------------------------------------------------
# Server endpoints (auth required)
# ---------------------------------------------------------------------------

@app.get(f"/api/{_API_VERSION}/servers")
async def list_servers(token: str = Depends(verify_token)):
    """List all configured servers with current status."""
    logger.debug("GET /api/v1/servers")

    if _supervisor is None:
        raise HTTPException(status_code=503, detail={"error": "Backend not initialized", "code": "E_NOT_READY"})

    statuses = _supervisor.get_all_statuses()
    servers = {}
    for name, state in statuses.items():
        servers[name] = {
            "status": state.status.value,
            "pid": state.pid,
            "uptime_seconds": state.uptime_seconds,
            "restart_count": state.restart_count,
            "healthy": state.health.healthy,
            "version": state.version,
        }

    return ApiResponse(
        success=True,
        message=f"{len(servers)} servers",
        data={"servers": servers, "total": len(servers)},
    )


@app.get(f"/api/{_API_VERSION}/servers/{{name}}")
async def get_server(name: str, token: str = Depends(verify_token)):
    """Detailed server info with health history."""
    logger.debug("GET /api/v1/servers/%s", name)

    if _supervisor is None or _health_monitor is None or _registry is None:
        raise HTTPException(status_code=503, detail={"error": "Backend not initialized", "code": "E_NOT_READY"})

    config = _registry.get_server(name)
    if config is None:
        raise HTTPException(status_code=404, detail={"error": f"Server '{name}' not found", "code": "E_NOT_FOUND"})

    state = _supervisor.get_server_status(name)
    health_report = _health_monitor.get_health_report(name)

    return ApiResponse(
        success=True,
        data={
            "server_name": name,
            "config": config.model_dump(),
            "state": state.model_dump(),
            "health": health_report,
        },
    )


@app.post(f"/api/{_API_VERSION}/servers/{{name}}/start")
async def start_server(name: str, token: str = Depends(verify_token)):
    """Start a stopped server."""
    logger.info("POST /api/v1/servers/%s/start", name)

    if _supervisor is None:
        raise HTTPException(status_code=503, detail={"error": "Backend not initialized", "code": "E_NOT_READY"})

    try:
        state = await _supervisor.start_server(name)
        return ApiResponse(success=True, message=f"Server '{name}' started", data=state.model_dump())
    except KeyError:
        raise HTTPException(status_code=404, detail={"error": f"Server '{name}' not found", "code": "E_NOT_FOUND"})
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail={"error": str(exc), "code": "E_CONFLICT"})


@app.post(f"/api/{_API_VERSION}/servers/{{name}}/stop")
async def stop_server(name: str, token: str = Depends(verify_token)):
    """Gracefully stop a running server."""
    logger.info("POST /api/v1/servers/%s/stop", name)

    if _supervisor is None:
        raise HTTPException(status_code=503, detail={"error": "Backend not initialized", "code": "E_NOT_READY"})

    try:
        state = await _supervisor.stop_server(name)
        return ApiResponse(success=True, message=f"Server '{name}' stopped", data=state.model_dump())
    except KeyError:
        raise HTTPException(status_code=404, detail={"error": f"Server '{name}' not found", "code": "E_NOT_FOUND"})


@app.post(f"/api/{_API_VERSION}/servers/{{name}}/restart")
async def restart_server(name: str, token: str = Depends(verify_token)):
    """Restart a server."""
    logger.info("POST /api/v1/servers/%s/restart", name)

    if _supervisor is None:
        raise HTTPException(status_code=503, detail={"error": "Backend not initialized", "code": "E_NOT_READY"})

    try:
        state = await _supervisor.restart_server(name)
        return ApiResponse(success=True, message=f"Server '{name}' restarted", data=state.model_dump())
    except KeyError:
        raise HTTPException(status_code=404, detail={"error": f"Server '{name}' not found", "code": "E_NOT_FOUND"})


@app.post(f"/api/{_API_VERSION}/servers/{{name}}/update")
async def update_server(name: str, token: str = Depends(verify_token)):
    """Trigger update for a specific server. Returns 202 Accepted."""
    logger.info("POST /api/v1/servers/%s/update", name)

    if _updater is None:
        raise HTTPException(status_code=503, detail={"error": "Backend not initialized", "code": "E_NOT_READY"})

    if _registry.get_server(name) is None:
        raise HTTPException(status_code=404, detail={"error": f"Server '{name}' not found", "code": "E_NOT_FOUND"})

    # Run update in background
    asyncio.create_task(_updater.update_server(name))
    return JSONResponse(
        status_code=202,
        content={"success": True, "message": f"Update started for '{name}'", "poll": f"/api/{_API_VERSION}/servers/{name}"},
    )


@app.post(f"/api/{_API_VERSION}/update-all")
async def update_all(token: str = Depends(verify_token)):
    """Trigger update for all enabled servers. Returns 202 Accepted."""
    logger.info("POST /api/v1/update-all")

    if _updater is None:
        raise HTTPException(status_code=503, detail={"error": "Backend not initialized", "code": "E_NOT_READY"})

    asyncio.create_task(_updater.update_all())
    return JSONResponse(
        status_code=202,
        content={"success": True, "message": "Update started for all enabled servers"},
    )


# ---------------------------------------------------------------------------
# Log endpoints
# ---------------------------------------------------------------------------

@app.get(f"/api/{_API_VERSION}/servers/{{name}}/logs")
async def get_server_logs(
    name: str,
    lines: int = Query(default=_DEFAULT_LOG_LINES, ge=1, le=_MAX_LOG_LINES),
    token: str = Depends(verify_token),
):
    """Return last N lines of a server's log."""
    logger.debug("GET /api/v1/servers/%s/logs?lines=%d", name, lines)

    if _registry is None:
        raise HTTPException(status_code=503, detail={"error": "Backend not initialized", "code": "E_NOT_READY"})

    if _registry.get_server(name) is None:
        raise HTTPException(status_code=404, detail={"error": f"Server '{name}' not found", "code": "E_NOT_FOUND"})

    global_cfg = _registry.global_config
    log_path = Path(global_cfg.remote_base_path) / global_cfg.log_dir / f"{name}.log"

    if not log_path.exists():
        return ApiResponse(success=True, data={"lines": [], "total": 0})

    try:
        all_lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        tail = all_lines[-lines:]
        return ApiResponse(success=True, data={"lines": tail, "total": len(all_lines)})
    except Exception as exc:
        raise HTTPException(status_code=500, detail={"error": f"Failed to read logs: {exc}", "code": "E_LOG_READ"})


@app.get(f"/api/{_API_VERSION}/servers/{{name}}/logs/stream")
async def stream_server_logs(name: str, token: str = Depends(verify_token)):
    """SSE endpoint for real-time log streaming."""
    logger.debug("GET /api/v1/servers/%s/logs/stream", name)

    if _registry is None:
        raise HTTPException(status_code=503, detail={"error": "Backend not initialized", "code": "E_NOT_READY"})

    if _registry.get_server(name) is None:
        raise HTTPException(status_code=404, detail={"error": f"Server '{name}' not found", "code": "E_NOT_FOUND"})

    global_cfg = _registry.global_config
    log_path = Path(global_cfg.remote_base_path) / global_cfg.log_dir / f"{name}.log"

    async def log_generator():
        """Tail-like log streaming via SSE."""
        last_pos = 0
        if log_path.exists():
            last_pos = log_path.stat().st_size

        while True:
            try:
                if log_path.exists():
                    current_size = log_path.stat().st_size
                    if current_size > last_pos:
                        with open(str(log_path), "r", encoding="utf-8", errors="replace") as f:
                            f.seek(last_pos)
                            new_data = f.read()
                            last_pos = f.tell()
                            for line in new_data.splitlines():
                                yield f"data: {line}\n\n"
                    elif current_size < last_pos:
                        # File was rotated
                        last_pos = 0
                # Heartbeat
                yield f": heartbeat {time.time()}\n\n"
                await asyncio.sleep(1)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                yield f"data: [ERROR] {exc}\n\n"
                await asyncio.sleep(5)

    return StreamingResponse(log_generator(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# System endpoints
# ---------------------------------------------------------------------------

@app.get(f"/api/{_API_VERSION}/system")
async def system_info(token: str = Depends(verify_token)):
    """System info: CPU, RAM, disk, Python version, etc."""
    logger.debug("GET /api/v1/system")

    try:
        import psutil
        cpu_percent = psutil.cpu_percent(interval=0.1)
        mem = psutil.virtual_memory()
        disk = shutil.disk_usage("/")
    except ImportError:
        cpu_percent = None
        mem = None
        disk = shutil.disk_usage("/")

    running_count = 0
    if _supervisor:
        for state in _supervisor.get_all_statuses().values():
            if state.status == ServerStatus.RUNNING:
                running_count += 1

    # Docker version
    docker_version = "unknown"
    try:
        import subprocess
        result = subprocess.run(["docker", "--version"], capture_output=True, text=True, timeout=5)
        docker_version = result.stdout.strip() if result.returncode == 0 else "not installed"
    except Exception:
        docker_version = "not available"

    return ApiResponse(
        success=True,
        data={
            "python_version": platform.python_version(),
            "platform": platform.platform(),
            "docker_version": docker_version,
            "cpu_percent": cpu_percent,
            "memory": {
                "total_mb": mem.total // (1024 * 1024) if mem else None,
                "used_mb": mem.used // (1024 * 1024) if mem else None,
                "percent": mem.percent if mem else None,
            },
            "disk": {
                "total_gb": disk.total / (1024**3),
                "used_gb": disk.used / (1024**3),
                "free_gb": disk.free / (1024**3),
            },
            "running_servers": running_count,
            "uptime_seconds": time.time() - _app_start_time,
        },
    )

_app_start_time = 0.0  # Set properly in init_api()


@app.post(f"/api/{_API_VERSION}/system/shutdown")
async def system_shutdown(
    token: str = Depends(verify_token),
    x_confirm_shutdown: Optional[str] = Header(None, alias="X-Confirm-Shutdown"),
):
    """Graceful backend shutdown. Requires X-Confirm-Shutdown: yes header."""
    logger.warning("POST /api/v1/system/shutdown")

    if x_confirm_shutdown != "yes":
        raise HTTPException(
            status_code=400,
            detail={"error": "Missing X-Confirm-Shutdown: yes header", "code": "E_CONFIRM_REQUIRED"},
        )

    if _shutdown_callback:
        asyncio.create_task(_shutdown_callback())
        return ApiResponse(success=True, message="Shutdown initiated")
    else:
        raise HTTPException(status_code=503, detail={"error": "Shutdown callback not configured", "code": "E_NOT_READY"})


@app.post(f"/api/{_API_VERSION}/system/reload-config")
async def reload_config(token: str = Depends(verify_token)):
    """Hot-reload mcp_servers.json without restart."""
    logger.info("POST /api/v1/system/reload-config")

    if _registry is None:
        raise HTTPException(status_code=503, detail={"error": "Backend not initialized", "code": "E_NOT_READY"})

    reloaded = _registry.reload()
    if reloaded:
        return ApiResponse(success=True, message="Config reloaded successfully")
    else:
        return ApiResponse(success=True, message="Config unchanged, no reload needed")


class LogLevelRequest(BaseModel):
    component: str
    level: str


@app.post(f"/api/{_API_VERSION}/system/log-level")
async def set_log_level_endpoint(body: LogLevelRequest, token: str = Depends(verify_token)):
    """Adjust log level of a component at runtime."""
    logger.info("POST /api/v1/system/log-level: %s → %s", body.component, body.level)

    try:
        from logging_setup import set_log_level, get_log_levels
        success = set_log_level(body.component, body.level)
        if success:
            return ApiResponse(success=True, message=f"Log level of '{body.component}' set to '{body.level}'", data=get_log_levels())
        else:
            raise HTTPException(
                status_code=400,
                detail={"error": f"Invalid log level: {body.level}", "code": "E_INVALID_LEVEL"},
            )
    except ImportError:
        raise HTTPException(status_code=503, detail={"error": "Logging module not available", "code": "E_NOT_READY"})


# ---------------------------------------------------------------------------
# MCP Proxy — forward requests to local MCP server endpoints
# ---------------------------------------------------------------------------

@app.api_route(
    f"/mcp/{{server_name}}/{{path:path}}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
)
async def mcp_proxy(
    server_name: str,
    path: str,
    request: Request,
    token: str = Depends(verify_token),
):
    """
    Proxy MCP protocol requests to local MCP server endpoints.
    Handles both SSE streaming and regular HTTP responses.
    """
    logger.info("MCP PROXY: %s %s → server '%s'", request.method, path, server_name)

    if _registry is None:
        raise HTTPException(status_code=503, detail={"error": "Backend not initialized", "code": "E_NOT_READY"})

    config = _registry.get_server(server_name)
    if config is None:
        raise HTTPException(status_code=404, detail={"error": f"MCP server '{server_name}' not found", "code": "E_NOT_FOUND"})

    # Determine target URL based on transport type
    if config.transport == "sse" and config.health_check and config.health_check.target:
        base_url = config.health_check.target.rsplit("/", 1)[0]
        target_url = f"{base_url}/{path}"
    elif config.transport == "sse" and config.port:
        target_url = f"http://127.0.0.1:{config.port}/{path}"
    elif config.transport == "stdio":
        # stdio servers need the stdio-to-SSE bridge
        return await _stdio_to_sse_bridge(server_name, path, request)
    else:
        raise HTTPException(
            status_code=502,
            detail={"error": f"Server '{server_name}' transport '{config.transport}' not proxyable", "code": "E_TRANSPORT"},
        )

    # Forward the request using urllib (no httpx dependency)
    import urllib.request
    import urllib.error

    headers = {}
    accept = request.headers.get("accept", "")

    try:
        body = await request.body()
        req = urllib.request.Request(
            target_url,
            data=body if body else None,
            method=request.method,
        )
        for key in ["content-type", "accept"]:
            val = request.headers.get(key)
            if val:
                req.add_header(key, val)

        response = await asyncio.to_thread(urllib.request.urlopen, req, timeout=30)
        content_type = response.headers.get("content-type", "application/json")

        # SSE streaming passthrough
        if "text/event-stream" in content_type:
            async def sse_passthrough():
                try:
                    while True:
                        line = await asyncio.to_thread(response.readline)
                        if not line:
                            break
                        yield line.decode("utf-8", errors="replace")
                except Exception as exc:
                    logger.error("SSE proxy error for %s: %s", server_name, exc)
                    yield f"data: {{\"error\": \"{exc}\"}}\n\n"
                finally:
                    response.close()

            return StreamingResponse(sse_passthrough(), media_type="text/event-stream")

        # Regular response
        resp_body = response.read()
        return JSONResponse(
            content=json.loads(resp_body) if "json" in content_type else {"raw": resp_body.decode()},
            status_code=response.status,
        )
    except urllib.error.HTTPError as exc:
        logger.error("MCP proxy HTTP error for %s: %d %s", server_name, exc.code, exc.reason)
        return JSONResponse(status_code=exc.code, content={"error": exc.reason, "code": "E_MCP_PROXY"})
    except Exception as exc:
        logger.error("MCP proxy failed for %s: %s", server_name, exc)
        raise HTTPException(status_code=502, detail={"error": f"Proxy error: {exc}", "code": "E_MCP_PROXY"})


async def _stdio_to_sse_bridge(server_name: str, path: str, request: Request):
    """
    Bridge for stdio-transport MCP servers: convert stdin/stdout communication
    to SSE event stream that VS Code can consume.
    """
    logger.info("stdio-to-SSE bridge for '%s', path='%s'", server_name, path)

    if _supervisor is None:
        raise HTTPException(status_code=503, detail={"error": "Backend not initialized", "code": "E_NOT_READY"})

    state = _supervisor.get_server_status(server_name)
    if not state or not state.pid:
        raise HTTPException(
            status_code=503,
            detail={"error": f"Server '{server_name}' is not running", "code": "E_NOT_RUNNING"},
        )

    # For stdio MCP servers, forward the JSON-RPC message via stdin and read response from stdout
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail={"error": "Request body required for stdio bridge", "code": "E_BODY_REQUIRED"})

    try:
        import subprocess
        # Write to server's stdin pipe and read response
        # This requires the supervisor to maintain the process stdin/stdout handles
        if hasattr(_supervisor, "send_to_server"):
            response_data = await _supervisor.send_to_server(server_name, body.decode("utf-8"))
            return JSONResponse(content=json.loads(response_data))
        else:
            raise HTTPException(
                status_code=501,
                detail={"error": "stdio bridge not yet supported for direct process communication", "code": "E_NOT_IMPLEMENTED"},
            )
    except json.JSONDecodeError as exc:
        logger.error("stdio bridge: invalid JSON response from %s: %s", server_name, exc)
        raise HTTPException(status_code=502, detail={"error": f"Invalid response from server: {exc}", "code": "E_MCP_BRIDGE"})
    except Exception as exc:
        logger.error("stdio bridge error for %s: %s", server_name, exc)
        raise HTTPException(status_code=502, detail={"error": f"Bridge error: {exc}", "code": "E_MCP_BRIDGE"})


# ---------------------------------------------------------------------------
# MCP Logger — SSE Event Stream & REST Endpoints (Cat 13d)
# ---------------------------------------------------------------------------

_SSE_HEARTBEAT_INTERVAL = 15  # seconds
_SSE_MAX_CLIENTS = 10


@app.get(f"/api/{_API_VERSION}/mcp/events/stream")
async def mcp_events_stream(
    request: Request,
    token: str = Depends(verify_token),
    mcp: Optional[str] = Query(None, description="Filter by MCP name"),
    types: Optional[str] = Query(None, description="Comma-separated event types"),
    severity: Optional[str] = Query(None, description="Comma-separated min severity levels"),
):
    """SSE event stream for real-time MCP log events."""
    logger.info("SSE stream requested (mcp=%s, types=%s, severity=%s)", mcp, types, severity)

    if _mcp_logger is None:
        raise HTTPException(status_code=503, detail={"error": "MCP Logger not initialized", "code": "E_NOT_READY"})

    # Check max clients
    if _mcp_logger.event_bus.get_subscriber_count() >= _SSE_MAX_CLIENTS:
        raise HTTPException(status_code=429, detail={"error": "Max SSE clients reached", "code": "E_SSE_LIMIT"})

    # Build filter
    from mcp_logger import EventFilter, McpSeverity
    evt_filter = None
    if mcp or types or severity:
        mcp_names = {mcp} if mcp else None
        event_types = set(types.split(",")) if types else None
        min_sev = McpSeverity(severity.split(",")[0]) if severity else None
        evt_filter = EventFilter(mcp_names=mcp_names, event_types=event_types, min_severity=min_sev)

    # Subscribe
    sub_id, queue = _mcp_logger.event_bus.subscribe(evt_filter)

    # Handle reconnection replay via Last-Event-ID
    last_event_id = request.headers.get("last-event-id")
    replay_events = []
    if last_event_id:
        replay_events = _mcp_logger.event_bus.get_events_after_id(last_event_id)
        logger.info("SSE reconnect: replaying %d events after %s", len(replay_events), last_event_id)

    async def event_generator():
        """Generate SSE events."""
        try:
            # Replay missed events
            for evt in replay_events:
                yield f"id: {evt.event_id}\nevent: mcpEvent\ndata: {evt.to_json()}\n\n"

            # Live stream
            last_heartbeat = time.time()
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=1.0)
                    yield f"id: {event.event_id}\nevent: mcpEvent\ndata: {event.to_json()}\n\n"
                except asyncio.TimeoutError:
                    # Send heartbeat if no events
                    now = time.time()
                    if now - last_heartbeat >= _SSE_HEARTBEAT_INTERVAL:
                        yield f": ping {now}\n\n"
                        last_heartbeat = now

                # Check if client disconnected
                if await request.is_disconnected():
                    break
        except asyncio.CancelledError:
            pass
        finally:
            _mcp_logger.event_bus.unsubscribe(sub_id)
            logger.info("SSE subscriber %d disconnected", sub_id)

    return StreamingResponse(event_generator(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })


@app.get(f"/api/{_API_VERSION}/mcp/events/history")
async def mcp_events_history(
    token: str = Depends(verify_token),
    mcp: Optional[str] = Query(None),
    type: Optional[str] = Query(None),
    since: Optional[float] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
):
    """Paginated event history from ring buffer."""
    logger.debug("GET /api/v1/mcp/events/history (mcp=%s, type=%s, limit=%d)", mcp, type, limit)

    if _mcp_logger is None:
        raise HTTPException(status_code=503, detail={"error": "MCP Logger not initialized", "code": "E_NOT_READY"})

    events = _mcp_logger.event_bus.get_history(mcp_name=mcp, event_type=type, since=since, limit=limit)
    return ApiResponse(
        success=True,
        message=f"{len(events)} events",
        data={"events": [e.to_dict() for e in events], "total": len(events)},
    )


@app.get(f"/api/{_API_VERSION}/mcp/events/archive")
async def mcp_events_archive(
    token: str = Depends(verify_token),
    mcp: Optional[str] = Query(None),
    type: Optional[str] = Query(None),
    start_time: Optional[float] = Query(None),
    end_time: Optional[float] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
):
    """Query events from disk-backed JSONL archive."""
    logger.debug("GET /api/v1/mcp/events/archive")

    if _mcp_logger is None:
        raise HTTPException(status_code=503, detail={"error": "MCP Logger not initialized", "code": "E_NOT_READY"})

    events = _mcp_logger.event_bus.get_archived_events(
        mcp_name=mcp, event_type=type, start_time=start_time, end_time=end_time, limit=limit,
    )
    return ApiResponse(success=True, message=f"{len(events)} archived events", data={"events": events})


@app.get(f"/api/{_API_VERSION}/mcp/metrics")
async def mcp_metrics(token: str = Depends(verify_token)):
    """Return current metrics snapshot for all MCPs."""
    logger.debug("GET /api/v1/mcp/metrics")

    if _mcp_logger is None:
        raise HTTPException(status_code=503, detail={"error": "MCP Logger not initialized", "code": "E_NOT_READY"})

    snapshot = _mcp_logger.metrics.get_snapshot()
    return ApiResponse(success=True, data=snapshot)


@app.get(f"/api/{_API_VERSION}/mcp/metrics/{{mcp_name}}")
async def mcp_metrics_detail(mcp_name: str, token: str = Depends(verify_token)):
    """Detailed metrics for a specific MCP with per-tool breakdown."""
    logger.debug("GET /api/v1/mcp/metrics/%s", mcp_name)

    if _mcp_logger is None:
        raise HTTPException(status_code=503, detail={"error": "MCP Logger not initialized", "code": "E_NOT_READY"})

    snapshot = _mcp_logger.metrics.get_snapshot(mcp_name)
    return ApiResponse(success=True, data=snapshot)


@app.get(f"/api/{_API_VERSION}/mcp/metrics/global")
async def mcp_metrics_global(token: str = Depends(verify_token)):
    """Aggregate metrics: total calls, error rate, team split, tokens."""
    logger.debug("GET /api/v1/mcp/metrics/global")

    if _mcp_logger is None:
        raise HTTPException(status_code=503, detail={"error": "MCP Logger not initialized", "code": "E_NOT_READY"})

    global_metrics = _mcp_logger.metrics.get_global_metrics()
    return ApiResponse(success=True, data=global_metrics)


@app.get(f"/api/{_API_VERSION}/mcp/metrics/prometheus")
async def mcp_metrics_prometheus(token: str = Depends(verify_token)):
    """Export metrics in Prometheus text exposition format."""
    logger.debug("GET /api/v1/mcp/metrics/prometheus")

    if _mcp_logger is None:
        raise HTTPException(status_code=503, detail={"error": "MCP Logger not initialized", "code": "E_NOT_READY"})

    from fastapi.responses import PlainTextResponse
    text = _mcp_logger.metrics.to_prometheus()
    return PlainTextResponse(content=text, media_type="text/plain; version=0.0.4")


# ---------------------------------------------------------------------------
#  Deploy Integration Endpoints
# ---------------------------------------------------------------------------

_deploy_lock: Dict[str, Any] = {}
_deploy_history_file = Path(__file__).resolve().parent.parent / "state" / "deploy_history.json"


def _load_deploy_history() -> List[Dict[str, Any]]:
    """Load deploy history from disk."""
    if not _deploy_history_file.exists():
        return []
    try:
        with open(_deploy_history_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_deploy_history(history: List[Dict[str, Any]]) -> None:
    """Save deploy history to disk."""
    _deploy_history_file.parent.mkdir(parents=True, exist_ok=True)
    with open(_deploy_history_file, "w", encoding="utf-8") as f:
        json.dump(history[-100:], f, indent=2, default=str)


@app.post(f"/api/{_API_VERSION}/system/deploy-lock")
async def acquire_deploy_lock(request: Request, token: str = Depends(verify_token)):
    """Acquire deploy lock to prevent concurrent deploys."""
    logger.debug("POST /api/v1/system/deploy-lock")
    import time as _time

    if _deploy_lock.get("acquired"):
        elapsed = _time.time() - _deploy_lock.get("timestamp", 0)
        timeout = _deploy_lock.get("timeout", 300)
        if elapsed < timeout:
            return {"acquired": False, "locked_by": _deploy_lock.get("locked_by", "unknown"),
                    "locked_since": _deploy_lock.get("timestamp")}
        logger.info("Deploy lock expired — allowing new lock")

    body = await request.json() if request.headers.get("content-type") == "application/json" else {}
    _deploy_lock.update({
        "acquired": True,
        "locked_by": request.client.host if request.client else "unknown",
        "timestamp": _time.time(),
        "timeout": body.get("timeout", 300),
    })
    return {"acquired": True}


@app.delete(f"/api/{_API_VERSION}/system/deploy-lock")
async def release_deploy_lock(token: str = Depends(verify_token)):
    """Release deploy lock."""
    logger.debug("DELETE /api/v1/system/deploy-lock")
    _deploy_lock.clear()
    return {"released": True}


@app.get(f"/api/{_API_VERSION}/system/deploy-history")
async def get_deploy_history(token: str = Depends(verify_token)):
    """Get deploy history."""
    logger.debug("GET /api/v1/system/deploy-history")
    return {"history": _load_deploy_history()}


@app.post(f"/api/{_API_VERSION}/system/deploy-history")
async def save_deploy_record(request: Request, token: str = Depends(verify_token)):
    """Append deploy record to history."""
    logger.debug("POST /api/v1/system/deploy-history")
    body = await request.json()
    history = _load_deploy_history()
    history.append(body)
    _save_deploy_history(history)
    return {"success": True, "total_records": len(history)}


@app.post(f"/api/{_API_VERSION}/mcp/events/emit")
async def emit_event(request: Request, token: str = Depends(verify_token)):
    """Emit a deploy/external event to the MCP Logger."""
    logger.debug("POST /api/v1/mcp/events/emit")
    body = await request.json()
    event_type = body.get("event_type", "UNKNOWN")
    data = body.get("data", {})
    source = body.get("source", "external")

    if _mcp_logger and hasattr(_mcp_logger, "event_bus"):
        from mcp_logger import McpLogEvent
        _mcp_logger.event_bus.emit(McpLogEvent(
            event_type=event_type,
            mcp_name=source,
            data=data,
            severity="INFO",
        ))

    return {"success": True, "event_type": event_type}


@app.post(f"/api/{_API_VERSION}/system/restart")
async def restart_system(token: str = Depends(verify_token)):
    """Trigger a graceful backend restart."""
    logger.debug("POST /api/v1/system/restart")
    import os as _os
    import signal as _signal

    pid = _os.getpid()
    logger.info("Restart requested — sending SIGHUP to self (PID %d)", pid)
    if hasattr(_signal, "SIGHUP"):
        _os.kill(pid, _signal.SIGHUP)
    return {"success": True, "message": "Restart initiated"}


# ---------------------------------------------------------------------------
# Data Retention & Storage (18b)
# ---------------------------------------------------------------------------

_RETENTION_DEFAULTS = {
    "event_ring_buffer": 10000,
    "event_disk_days": 90,
    "event_disk_max_mb": 50,
    "event_disk_max_rotations": 10,
    "metrics_rolling_days": 7,
    "metrics_archive_days": 365,
    "health_history_per_mcp": 1000,
    "health_disk_days": 30,
    "deploy_history_max": 100,
    "log_retention_days": 14,
    "alert_archive_days": 90,
}

_last_cleanup_time: float = 0.0


def _get_dir_size_mb(path: Path) -> float:
    """Calculate directory size in MB."""
    total = 0
    try:
        if path.is_dir():
            for f in path.rglob("*"):
                if f.is_file():
                    total += f.stat().st_size
    except OSError:
        pass
    return total / (1024 * 1024)


def _run_cleanup() -> Dict[str, Any]:
    """Apply retention policies and return cleanup results."""
    global _last_cleanup_time
    logger.debug("Running data cleanup")
    freed_bytes = 0
    details: Dict[str, Any] = {}

    base = Path("/opt/sudx-backend")
    state_dir = base / "state"
    log_dir = base / "logs"

    # Clean old event archives
    events_dir = state_dir / "events"
    if events_dir.is_dir():
        cutoff = time.time() - (_RETENTION_DEFAULTS["event_disk_days"] * 86400)
        removed = 0
        for f in events_dir.glob("*.jsonl*"):
            try:
                if f.stat().st_mtime < cutoff:
                    size = f.stat().st_size
                    f.unlink()
                    freed_bytes += size
                    removed += 1
            except OSError as e:
                logger.warning("Cleanup: failed to remove %s: %s", f, e)
        details["events_removed"] = removed

    # Clean old logs
    if log_dir.is_dir():
        cutoff = time.time() - (_RETENTION_DEFAULTS["log_retention_days"] * 86400)
        removed = 0
        for f in log_dir.glob("*.log*"):
            try:
                if f.stat().st_mtime < cutoff:
                    size = f.stat().st_size
                    f.unlink()
                    freed_bytes += size
                    removed += 1
            except OSError as e:
                logger.warning("Cleanup: failed to remove %s: %s", f, e)
        details["logs_removed"] = removed

    # Trim deploy history
    history_file = state_dir / "deploy_history.json"
    if history_file.is_file():
        try:
            history = _load_deploy_history()
            max_records = _RETENTION_DEFAULTS["deploy_history_max"]
            if len(history) > max_records:
                removed_count = len(history) - max_records
                history = history[-max_records:]
                _save_deploy_history(history)
                details["deploy_history_trimmed"] = removed_count
        except Exception as e:
            logger.warning("Cleanup: failed to trim deploy history: %s", e)

    _last_cleanup_time = time.time()
    freed_mb = freed_bytes / (1024 * 1024)
    logger.info("Cleanup complete: freed %.2f MB", freed_mb)

    return {
        "freed_mb": round(freed_mb, 2),
        "freed_bytes": freed_bytes,
        "details": details,
        "timestamp": _last_cleanup_time,
    }


@app.get(f"/api/{_API_VERSION}/system/storage")
async def system_storage(token: str = Depends(verify_token)):
    """Disk usage breakdown per category with retention policy summary."""
    logger.debug("GET /api/v1/system/storage")

    base = Path("/opt/sudx-backend")
    state_dir = base / "state"
    log_dir = base / "logs"
    config_dir = base / "config"

    categories = {
        "logs": _get_dir_size_mb(log_dir),
        "state": _get_dir_size_mb(state_dir),
        "config": _get_dir_size_mb(config_dir),
    }

    disk = shutil.disk_usage(str(base)) if base.exists() else shutil.disk_usage("/")

    return {
        "success": True,
        "data": {
            "categories_mb": categories,
            "total_managed_mb": round(sum(categories.values()), 2),
            "disk_total_gb": round(disk.total / (1024 ** 3), 2),
            "disk_used_gb": round(disk.used / (1024 ** 3), 2),
            "disk_free_gb": round(disk.free / (1024 ** 3), 2),
            "retention_policies": _RETENTION_DEFAULTS,
            "last_cleanup": _last_cleanup_time or None,
        },
    }


@app.post(f"/api/{_API_VERSION}/system/cleanup")
async def manual_cleanup(token: str = Depends(verify_token)):
    """Force immediate cleanup run."""
    logger.debug("POST /api/v1/system/cleanup")
    result = _run_cleanup()
    return {"success": True, "data": result}