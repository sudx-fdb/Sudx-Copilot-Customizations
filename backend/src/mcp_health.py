"""
MCP Health Monitor — Continuous health checking and auto-restart.

Monitors all running MCP servers via HTTP, TCP, or command-based health checks.
Detects crashes, hangs, and degraded states. Triggers auto-restart with
exponential backoff. Maintains health history for diagnostics.
"""

from __future__ import annotations

import asyncio
import json
import logging
import socket
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from models import (
    GlobalConfig,
    HealthCheckConfig,
    HealthCheckType,
    HealthStatus,
    InstallMethod,
    ServerConfig,
    ServerState,
    ServerStatus,
)
from mcp_registry import McpRegistry

logger = logging.getLogger("backend.health")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_MAX_BACKOFF_SECONDS = 300  # 5 minutes cap
_SUSTAINED_HEALTHY_COUNT = 10  # Reset restart counter after this many consecutive successes
_HISTORY_FLUSH_INTERVAL = 10  # Flush history to disk every N checks
_HISTORY_MAX_PER_SERVER = 100  # Keep last N check results per server


class HealthMonitor:
    """
    Continuous health monitoring for all running MCP servers.

    Runs as a background asyncio task, checking each server at its
    configured interval. Triggers auto-restart on repeated failures
    with exponential backoff.
    """

    def __init__(
        self,
        registry: McpRegistry,
        supervisor: Any,  # McpSupervisor — forward ref to avoid circular import
        state_dir: Optional[Path] = None,
    ) -> None:
        """
        Initialize the health monitor.

        Args:
            registry: Loaded McpRegistry.
            supervisor: McpSupervisor instance for restart calls.
            state_dir: Directory for health history persistence.
        """
        self._registry = registry
        self._supervisor = supervisor
        self._global: GlobalConfig = registry.global_config
        self._state_dir = state_dir or (Path(self._global.remote_base_path) / self._global.state_dir)
        self._history: Dict[str, List[Dict[str, Any]]] = {}
        self._permanently_failed: Dict[str, bool] = {}
        self._check_count: int = 0
        self._monitor_task: Optional[asyncio.Task] = None
        self._running = False

        logger.debug(
            "HealthMonitor init: state_dir=%s, servers=%d",
            self._state_dir, len(registry.get_enabled_servers()),
        )

        # Load existing history
        self._load_history()

    # -----------------------------------------------------------------------
    # Health check dispatchers
    # -----------------------------------------------------------------------

    async def check_server(self, name: str, config: ServerConfig) -> HealthStatus:
        """
        Run the appropriate health check for a server.

        Args:
            name: Server name.
            config: Server configuration.

        Returns:
            Updated HealthStatus.
        """
        logger.debug("check_server('%s'): type=%s", name, config.health_check.type)

        status = HealthStatus(server_name=name)
        start_time = time.time()

        try:
            hc = config.health_check

            if hc.type == HealthCheckType.HTTP:
                healthy = await self._check_http(name, hc)
            elif hc.type == HealthCheckType.TCP:
                healthy = await self._check_tcp(name, config, hc)
            elif hc.type == HealthCheckType.COMMAND:
                healthy = await self._check_command(name, hc)
            else:
                logger.warning("Unknown health check type '%s' for '%s'", hc.type, name)
                healthy = False

            # Docker: additionally verify container is running
            if config.install_method == InstallMethod.DOCKER:
                container_alive = await self._check_docker_container(name)
                if not container_alive:
                    healthy = False
                    logger.debug("Docker container check failed for '%s'", name)

            elapsed_ms = (time.time() - start_time) * 1000
            status.healthy = healthy
            status.last_check_time = time.time()
            status.response_time_ms = elapsed_ms

            if healthy:
                status.last_success_time = time.time()
                status.consecutive_failures = 0
            else:
                status.consecutive_failures = self._get_consecutive_failures(name) + 1
                status.last_error = f"Health check failed (type={hc.type})"

            logger.debug(
                "check_server('%s'): healthy=%s, elapsed=%.1fms, failures=%d",
                name, healthy, elapsed_ms, status.consecutive_failures,
            )

        except Exception as exc:
            elapsed_ms = (time.time() - start_time) * 1000
            status.healthy = False
            status.last_check_time = time.time()
            status.response_time_ms = elapsed_ms
            status.consecutive_failures = self._get_consecutive_failures(name) + 1
            status.last_error = str(exc)
            logger.error("Health check exception for '%s': %s", name, exc)

        # Record in history
        self._record_check(name, status)
        return status

    async def _check_http(self, name: str, hc: HealthCheckConfig) -> bool:
        """
        HTTP health check — GET the target URL, expect 2xx/3xx.

        Uses Python-native http.client to avoid external binary dependencies
        (curl may not be available on Windows or minimal Docker images).
        """
        logger.debug("_check_http('%s'): target=%s, timeout=%ds", name, hc.target, hc.timeout_seconds)

        try:
            import http.client
            from urllib.parse import urlparse

            def _do_http_check() -> bool:
                parsed = urlparse(hc.target)
                host = parsed.hostname or "localhost"
                port = parsed.port or (443 if parsed.scheme == "https" else 80)
                path = parsed.path or "/"
                if parsed.query:
                    path = f"{path}?{parsed.query}"

                if parsed.scheme == "https":
                    import ssl
                    ctx = ssl.create_default_context()
                    conn = http.client.HTTPSConnection(host, port, timeout=hc.timeout_seconds, context=ctx)
                else:
                    conn = http.client.HTTPConnection(host, port, timeout=hc.timeout_seconds)
                try:
                    conn.request("GET", path)
                    resp = conn.getresponse()
                    return resp.status < 400
                finally:
                    conn.close()

            healthy = await asyncio.wait_for(
                asyncio.to_thread(_do_http_check),
                timeout=hc.timeout_seconds + 5,
            )
            logger.debug("_check_http('%s'): healthy=%s", name, healthy)
            return healthy
        except asyncio.TimeoutError:
            logger.debug("_check_http('%s'): timeout", name)
            return False
        except Exception as exc:
            logger.debug("_check_http('%s'): error=%s", name, exc)
            return False

    async def _check_tcp(self, name: str, config: ServerConfig, hc: HealthCheckConfig) -> bool:
        """
        TCP health check — attempt a socket connection to the server port.
        """
        port = config.port
        if port is None:
            logger.warning("_check_tcp('%s'): no port configured", name)
            return False

        logger.debug("_check_tcp('%s'): port=%d, timeout=%ds", name, port, hc.timeout_seconds)

        try:
            loop = asyncio.get_event_loop()
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(hc.timeout_seconds)
            await loop.run_in_executor(None, sock.connect, ("127.0.0.1", port))
            sock.close()
            logger.debug("_check_tcp('%s'): connected successfully", name)
            return True
        except (socket.timeout, ConnectionRefusedError, OSError) as exc:
            logger.debug("_check_tcp('%s'): failed=%s", name, exc)
            return False

    async def _check_command(self, name: str, hc: HealthCheckConfig) -> bool:
        """
        Command health check — run command, 0 = healthy.
        """
        logger.debug("_check_command('%s'): cmd=%s, timeout=%ds", name, hc.target, hc.timeout_seconds)

        try:
            proc = await asyncio.create_subprocess_shell(
                hc.target,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            exit_code = await asyncio.wait_for(proc.wait(), timeout=hc.timeout_seconds + 5)
            healthy = exit_code == 0
            logger.debug("_check_command('%s'): exit_code=%d, healthy=%s", name, exit_code, healthy)
            return healthy
        except asyncio.TimeoutError:
            logger.debug("_check_command('%s'): timeout", name)
            return False
        except Exception as exc:
            logger.debug("_check_command('%s'): error=%s", name, exc)
            return False

    async def _check_docker_container(self, name: str) -> bool:
        """Check if a Docker container is running via docker inspect."""
        container = f"mcp-{name}"
        logger.debug("_check_docker_container('%s'): container=%s", name, container)

        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "inspect", f"--format={{{{.State.Running}}}}", container,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            is_running = stdout.decode().strip().lower() == "true"
            logger.debug("_check_docker_container('%s'): running=%s", name, is_running)
            return is_running
        except (asyncio.TimeoutError, Exception) as exc:
            logger.debug("_check_docker_container('%s'): error=%s", name, exc)
            return False

    # -----------------------------------------------------------------------
    # Failure tracking & restart logic
    # -----------------------------------------------------------------------

    def _get_consecutive_failures(self, name: str) -> int:
        """Get current consecutive failure count for a server."""
        history = self._history.get(name, [])
        count = 0
        for entry in reversed(history):
            if not entry.get("healthy", True):
                count += 1
            else:
                break
        return count

    async def _handle_failure(self, name: str, config: ServerConfig, status: HealthStatus) -> None:
        """
        Handle a health check failure — trigger auto-restart if threshold reached.
        """
        failures = status.consecutive_failures
        retries = config.health_check.retries_before_restart

        logger.debug("_handle_failure('%s'): failures=%d, retries_threshold=%d", name, failures, retries)

        # Check permanently failed
        if self._permanently_failed.get(name, False):
            logger.debug("Server '%s' is permanently failed — skipping restart", name)
            return

        if failures < retries:
            logger.debug("Server '%s' has %d/%d failures — not yet triggering restart", name, failures, retries)
            return

        # Check max restart count
        state = self._supervisor.get_server_status(name)
        if state.restart_count >= config.max_restart_count:
            logger.error(
                "Server '%s' exceeded max restart count (%d/%d) — marking permanently failed",
                name, state.restart_count, config.max_restart_count,
            )
            self._permanently_failed[name] = True
            state.status = ServerStatus.CRASHED
            state.last_error = f"Permanently failed after {state.restart_count} restarts"
            return

        # Calculate backoff
        backoff = min(config.restart_backoff_base ** state.restart_count, _MAX_BACKOFF_SECONDS)
        logger.info(
            "Server '%s' health check failed %d times — auto-restarting (backoff=%.1fs, count=%d)",
            name, failures, backoff, state.restart_count,
        )

        if backoff > 0 and state.restart_count > 0:
            await asyncio.sleep(backoff)

        try:
            await self._supervisor.restart_server(name)
            logger.info("Auto-restart of '%s' completed", name)
        except Exception as exc:
            logger.error("Auto-restart of '%s' failed: %s", name, exc)

    def _handle_sustained_healthy(self, name: str) -> None:
        """
        After N consecutive successes, reset restart counter and
        clear permanently_failed flag.
        """
        history = self._history.get(name, [])
        if len(history) < _SUSTAINED_HEALTHY_COUNT:
            return

        recent = history[-_SUSTAINED_HEALTHY_COUNT:]
        if all(entry.get("healthy", False) for entry in recent):
            state = self._supervisor.get_server_status(name)
            if state.restart_count > 0:
                logger.info("Server '%s' sustained healthy for %d checks — resetting restart counter", name, _SUSTAINED_HEALTHY_COUNT)
                state.restart_count = 0

            if self._permanently_failed.get(name, False):
                logger.info("Server '%s' recovered from permanently failed state", name)
                self._permanently_failed[name] = False

    # -----------------------------------------------------------------------
    # Health check loop
    # -----------------------------------------------------------------------

    async def _monitor_loop(self) -> None:
        """
        Main health check loop — runs as asyncio task.
        Checks all enabled and running servers at their configured intervals.
        """
        logger.info("Health monitor loop started")

        while self._running:
            try:
                enabled = self._registry.get_enabled_servers()
                tasks = []

                for name, config in enabled.items():
                    state = self._supervisor.get_server_status(name)
                    if state.status not in (ServerStatus.RUNNING, ServerStatus.UNHEALTHY):
                        continue

                    # Check if it's time for this server's check
                    last_check = state.health.last_check_time
                    interval = config.health_check.interval_seconds
                    if time.time() - last_check < interval:
                        continue

                    tasks.append(self._check_and_handle(name, config))

                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)

                self._check_count += 1
                if self._check_count % _HISTORY_FLUSH_INTERVAL == 0:
                    self._flush_history()

                # Sleep before next round
                await asyncio.sleep(1)

            except asyncio.CancelledError:
                logger.info("Health monitor loop cancelled")
                break
            except Exception as exc:
                logger.error("Health monitor loop error (will self-restart): %s", exc)
                await asyncio.sleep(5)

        logger.info("Health monitor loop exited")

    async def _check_and_handle(self, name: str, config: ServerConfig) -> None:
        """Run health check for a single server and handle the result."""
        try:
            status = await self.check_server(name, config)

            # Update supervisor state
            state = self._supervisor.get_server_status(name)
            state.health = status

            if status.healthy:
                if state.status == ServerStatus.UNHEALTHY:
                    state.status = ServerStatus.RUNNING
                    logger.info("Server '%s' recovered to healthy", name)
                self._handle_sustained_healthy(name)
            else:
                if state.status == ServerStatus.RUNNING:
                    state.status = ServerStatus.UNHEALTHY
                    logger.warning("Server '%s' is now unhealthy (failures=%d)", name, status.consecutive_failures)
                await self._handle_failure(name, config, status)

        except Exception as exc:
            logger.error("Error handling health check for '%s': %s", name, exc)

    # -----------------------------------------------------------------------
    # Lifecycle
    # -----------------------------------------------------------------------

    async def start(self) -> None:
        """Start the health monitor background task."""
        if self._running:
            logger.warning("Health monitor already running")
            return

        logger.info("Starting health monitor...")
        self._running = True
        self._monitor_task = asyncio.create_task(self._monitor_loop())
        logger.info("Health monitor started")

    async def stop(self) -> None:
        """Stop the health monitor gracefully."""
        logger.info("Stopping health monitor...")
        self._running = False

        if self._monitor_task and not self._monitor_task.done():
            self._monitor_task.cancel()
            try:
                await self._monitor_task
            except asyncio.CancelledError:
                pass

        self._flush_history()
        logger.info("Health monitor stopped")

    # -----------------------------------------------------------------------
    # Health reports
    # -----------------------------------------------------------------------

    def get_health_report(self, name: str) -> Dict[str, Any]:
        """
        Get a detailed health report for a server.

        Returns dict with: status, last N checks, restart count, uptime, last restart.
        """
        logger.debug("get_health_report('%s')", name)

        state = self._supervisor.get_server_status(name)
        history = self._history.get(name, [])[-20:]  # Last 20 checks

        return {
            "server_name": name,
            "status": state.status.value,
            "healthy": state.health.healthy,
            "consecutive_failures": state.health.consecutive_failures,
            "last_check_time": state.health.last_check_time,
            "last_success_time": state.health.last_success_time,
            "last_error": state.health.last_error,
            "response_time_ms": state.health.response_time_ms,
            "restart_count": state.restart_count,
            "uptime_seconds": state.uptime_seconds,
            "last_restart_time": state.last_restart_time,
            "permanently_failed": self._permanently_failed.get(name, False),
            "history": history,
        }

    def get_system_health(self) -> Dict[str, Any]:
        """
        Get aggregated system health across all servers.

        Returns: overall status (all_healthy/degraded/critical), per-server summaries.
        """
        logger.debug("get_system_health()")

        enabled = self._registry.get_enabled_servers()
        statuses: Dict[str, str] = {}
        healthy_count = 0
        unhealthy_count = 0
        stopped_count = 0

        for name in enabled:
            state = self._supervisor.get_server_status(name)
            statuses[name] = state.status.value

            if state.status == ServerStatus.RUNNING:
                healthy_count += 1
            elif state.status == ServerStatus.UNHEALTHY:
                unhealthy_count += 1
            else:
                stopped_count += 1

        total = len(enabled)
        if healthy_count == total:
            overall = "all_healthy"
        elif unhealthy_count > 0 or stopped_count > 0:
            if healthy_count == 0:
                overall = "critical"
            else:
                overall = "degraded"
        else:
            overall = "unknown"

        return {
            "overall": overall,
            "total": total,
            "healthy": healthy_count,
            "unhealthy": unhealthy_count,
            "stopped": stopped_count,
            "servers": statuses,
        }

    # -----------------------------------------------------------------------
    # History persistence
    # -----------------------------------------------------------------------

    def _record_check(self, name: str, status: HealthStatus) -> None:
        """Record a health check result in history."""
        if name not in self._history:
            self._history[name] = []

        entry = {
            "time": status.last_check_time,
            "healthy": status.healthy,
            "response_time_ms": status.response_time_ms,
            "error": status.last_error,
            "consecutive_failures": status.consecutive_failures,
        }
        self._history[name].append(entry)

        # Cap history size
        if len(self._history[name]) > _HISTORY_MAX_PER_SERVER:
            self._history[name] = self._history[name][-_HISTORY_MAX_PER_SERVER:]

    def _flush_history(self) -> None:
        """Persist health history to disk."""
        history_path = self._state_dir / "health_history.json"
        try:
            history_path.parent.mkdir(parents=True, exist_ok=True)
            history_path.write_text(json.dumps(self._history, indent=2), encoding="utf-8")
            logger.debug("Health history flushed to %s", history_path)
        except Exception as exc:
            logger.error("Failed to flush health history: %s", exc)

    def _load_history(self) -> None:
        """Load health history from disk."""
        history_path = self._state_dir / "health_history.json"
        try:
            if history_path.exists():
                raw = history_path.read_text(encoding="utf-8")
                self._history = json.loads(raw)
                logger.debug("Loaded health history from %s (%d servers)", history_path, len(self._history))
            else:
                logger.debug("No health history file found")
        except Exception as exc:
            logger.error("Failed to load health history: %s", exc)
            self._history = {}
