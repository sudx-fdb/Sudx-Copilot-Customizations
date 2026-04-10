"""
MCP Process Supervisor — Lifecycle management for MCP server processes.

Handles starting, stopping, restarting MCP servers as subprocesses or Docker
containers. Manages PID files, graceful shutdown, dependency ordering,
per-server logging, and orphan adoption on startup.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import signal
import subprocess
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from models import (
    InstallMethod,
    ServerConfig,
    ServerState,
    ServerStatus,
    SupervisorSnapshot,
)
from mcp_registry import McpRegistry

logger = logging.getLogger("backend.supervisor")

# ---------------------------------------------------------------------------
# Constants (from config defaults, overridable via GlobalConfig)
# ---------------------------------------------------------------------------

_DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024  # 10 MB
_DEFAULT_LOG_BACKUP_COUNT = 5
_PROCESS_POLL_INTERVAL = 0.5  # seconds
_DOCKER_INSPECT_FORMAT = "{{.State.Running}}"


class McpSupervisor:
    """
    Core process lifecycle manager for MCP servers.

    Manages starting, stopping, and restarting MCP server processes.
    Tracks state in ServerState objects, persists PID files, and handles
    Docker container lifecycle.
    """

    def __init__(self, registry: McpRegistry) -> None:
        """
        Initialize the supervisor.

        Args:
            registry: Loaded McpRegistry with server configs and global settings.
        """
        self._registry = registry
        self._global = registry.global_config
        self._base_path = Path(self._global.remote_base_path)
        self._state_dir = self._base_path / self._global.state_dir
        self._log_dir = self._base_path / self._global.log_dir
        self._states: Dict[str, ServerState] = {}
        self._processes: Dict[str, subprocess.Popen] = {}
        self._log_handles: Dict[str, Any] = {}  # Process stdout log file handles
        self._server_loggers: Dict[str, logging.Logger] = {}
        self._shutdown_event = asyncio.Event()

        logger.debug(
            "McpSupervisor init: base=%s, state_dir=%s, log_dir=%s, servers=%d",
            self._base_path, self._state_dir, self._log_dir,
            len(registry.get_enabled_servers()),
        )

        # Ensure directories exist
        self._state_dir.mkdir(parents=True, exist_ok=True)
        self._log_dir.mkdir(parents=True, exist_ok=True)

        # Initialize server states
        for name in registry.get_server_names():
            self._states[name] = ServerState(server_name=name)

        logger.debug("McpSupervisor initialized with %d server states", len(self._states))

    # -----------------------------------------------------------------------
    # Per-server logging
    # -----------------------------------------------------------------------

    def _get_server_logger(self, name: str) -> logging.Logger:
        """
        Get or create a dedicated logger for a specific MCP server.
        Each server logs to backend/logs/{name}.log with rotation.
        """
        if name in self._server_loggers:
            return self._server_loggers[name]

        srv_logger = logging.getLogger(f"backend.mcp.{name}")
        srv_logger.setLevel(logging.DEBUG)

        log_file = self._log_dir / f"{name}.log"
        handler = RotatingFileHandler(
            str(log_file),
            maxBytes=_DEFAULT_LOG_MAX_BYTES,
            backupCount=_DEFAULT_LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter(
            "%(asctime)s [%(levelname)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        ))
        srv_logger.addHandler(handler)

        self._server_loggers[name] = srv_logger
        logger.debug("Created server logger for '%s' → %s", name, log_file)
        return srv_logger

    # -----------------------------------------------------------------------
    # PID file management
    # -----------------------------------------------------------------------

    def _pid_file_path(self, name: str) -> Path:
        """Get the PID file path for a server."""
        return self._state_dir / f"{name}.pid"

    def _write_pid(self, name: str, pid: int) -> None:
        """Write PID to file."""
        pid_path = self._pid_file_path(name)
        try:
            pid_path.write_text(str(pid), encoding="utf-8")
            logger.debug("Wrote PID %d to %s", pid, pid_path)
        except Exception as exc:
            logger.error("Failed to write PID file for '%s': %s", name, exc)

    def _read_pid(self, name: str) -> Optional[int]:
        """Read PID from file. Returns None if file doesn't exist or is invalid."""
        pid_path = self._pid_file_path(name)
        try:
            if not pid_path.exists():
                return None
            raw = pid_path.read_text(encoding="utf-8").strip()
            pid = int(raw)
            logger.debug("Read PID %d from %s", pid, pid_path)
            return pid
        except (ValueError, OSError) as exc:
            logger.warning("Invalid PID file for '%s': %s", name, exc)
            return None

    def _clean_pid(self, name: str) -> None:
        """Remove PID file."""
        pid_path = self._pid_file_path(name)
        try:
            if pid_path.exists():
                pid_path.unlink()
                logger.debug("Cleaned PID file: %s", pid_path)
        except OSError as exc:
            logger.error("Failed to clean PID file for '%s': %s", name, exc)

    @staticmethod
    def _is_process_alive(pid: int) -> bool:
        """Check if a process with given PID is still running."""
        try:
            os.kill(pid, 0)
            return True
        except (ProcessLookupError, PermissionError):
            return False
        except OSError:
            return False

    # -----------------------------------------------------------------------
    # Docker helpers
    # -----------------------------------------------------------------------

    def _docker_container_name(self, name: str) -> str:
        """Get the Docker container name for a server."""
        return f"mcp-{name}"

    def _is_docker_running(self, name: str) -> bool:
        """Check if a Docker container is running."""
        container = self._docker_container_name(name)
        try:
            result = subprocess.run(
                ["docker", "inspect", f"--format={_DOCKER_INSPECT_FORMAT}", container],
                capture_output=True, text=True, timeout=10,
            )
            is_running = result.stdout.strip().lower() == "true"
            logger.debug("Docker container '%s' running=%s", container, is_running)
            return is_running
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
            logger.debug("Docker inspect failed for '%s': %s", container, exc)
            return False

    def _get_docker_container_id(self, name: str) -> Optional[str]:
        """Get the Docker container ID for a running container."""
        container = self._docker_container_name(name)
        try:
            result = subprocess.run(
                ["docker", "inspect", "--format={{.Id}}", container],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0 and result.stdout.strip():
                cid = result.stdout.strip()[:12]
                logger.debug("Docker container '%s' ID=%s", container, cid)
                return cid
            return None
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            return None

    # -----------------------------------------------------------------------
    # Start server
    # -----------------------------------------------------------------------

    async def start_server(self, name: str) -> ServerState:
        """
        Start an MCP server by name.

        Resolves config from registry, checks not already running, executes
        the start command, stores PID, and verifies the process is alive.

        Args:
            name: Server name as defined in mcp_servers.json.

        Returns:
            Updated ServerState.

        Raises:
            KeyError: If server name not found.
            RuntimeError: If server is already running or start fails.
        """
        srv_log = self._get_server_logger(name)
        logger.info("Starting server '%s'...", name)
        srv_log.info("=== START REQUEST ===")

        config = self._registry.get_server_or_raise(name)
        state = self._states[name]

        # Check not already running
        if state.status == ServerStatus.RUNNING:
            msg = f"Server '{name}' is already running (PID={state.pid})"
            logger.warning(msg)
            srv_log.warning(msg)
            raise RuntimeError(msg)

        state.status = ServerStatus.STARTING
        state.last_error = None

        try:
            if config.install_method == InstallMethod.DOCKER:
                await self._start_docker_server(name, config, state, srv_log)
            else:
                await self._start_process_server(name, config, state, srv_log)

            state.status = ServerStatus.RUNNING
            state.start_time = time.time()
            state.stop_time = None

            srv_log.info("Server started successfully (PID=%s, container=%s)", state.pid, state.container_id)
            logger.info("Server '%s' started: status=%s, pid=%s", name, state.status, state.pid)

        except Exception as exc:
            state.status = ServerStatus.CRASHED
            state.last_error = str(exc)
            srv_log.error("Start failed: %s", exc)
            logger.error("Failed to start '%s': %s", name, exc)

        # Persist state
        self._persist_server_state(name)
        return state

    async def _start_docker_server(
        self, name: str, config: ServerConfig, state: ServerState, srv_log: logging.Logger
    ) -> None:
        """Start a Docker-based MCP server."""
        srv_log.debug("Starting Docker server: method=docker, image=%s", config.docker_image)

        if config.docker_compose_file:
            # Use docker compose
            compose_path = self._base_path / config.docker_compose_file
            cmd = ["docker", "compose", "-f", str(compose_path), "up", "-d"]
            srv_log.debug("Using docker compose: %s", cmd)
        else:
            # Use docker run (from config start_command)
            cmd = list(config.start_command)
            if not cmd:
                raise RuntimeError(f"No start_command defined for Docker server '{name}'")

            # Ensure -d (detached) flag is present
            if "-d" not in cmd and "--detach" not in cmd:
                # Insert -d after 'docker run'
                try:
                    run_idx = cmd.index("run")
                    cmd.insert(run_idx + 1, "-d")
                except ValueError:
                    pass

            # Remove --rm for detached mode (incompatible in some setups)
            if "--rm" in cmd and "-d" in cmd:
                cmd.remove("--rm")

            srv_log.debug("Using docker run: %s", cmd)

        # Execute
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        srv_log.debug("Docker command exit=%d, stdout=%s, stderr=%s", result.returncode, result.stdout.strip()[:200], result.stderr.strip()[:200])

        if result.returncode != 0:
            raise RuntimeError(f"Docker command failed (exit={result.returncode}): {result.stderr.strip()[:500]}")

        # Get container ID
        container_id = self._get_docker_container_id(name)
        state.container_id = container_id

        # Verify running
        if not self._is_docker_running(name):
            raise RuntimeError(f"Docker container '{self._docker_container_name(name)}' not running after start")

        srv_log.info("Docker container started: id=%s", container_id)

    async def _start_process_server(
        self, name: str, config: ServerConfig, state: ServerState, srv_log: logging.Logger
    ) -> None:
        """Start a pip/system-based MCP server as a subprocess."""
        cmd = list(config.start_command)
        if not cmd:
            raise RuntimeError(f"No start_command defined for server '{name}'")

        # Wrap with sudo if server requires root and we're not running as root
        needs_root = config.security is not None and config.security.requires_root
        if needs_root and hasattr(os, 'geteuid') and os.geteuid() != 0:
            srv_log.info("Server '%s' requires root — wrapping with sudo", name)
            cmd = ["sudo", "--non-interactive", "--"] + cmd

        srv_log.debug("Starting process server: cmd=%s", cmd)

        # Prepare environment
        env = os.environ.copy()
        env.update(config.env)

        # Open log file for stdout/stderr
        log_file = self._log_dir / f"{name}.stdout.log"
        log_fh = open(str(log_file), "a", encoding="utf-8")

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                env=env,
                cwd=str(self._base_path),
                start_new_session=True,  # Detach from parent's session
            )
        except Exception as exc:
            log_fh.close()
            raise RuntimeError(f"Failed to spawn process for '{name}': {exc}") from exc

        self._processes[name] = proc
        self._log_handles[name] = log_fh
        state.pid = proc.pid
        self._write_pid(name, proc.pid)

        # Brief wait to check if process crashed immediately
        await asyncio.sleep(0.5)
        if proc.poll() is not None:
            exit_code = proc.returncode
            log_fh.close()
            self._clean_pid(name)
            raise RuntimeError(f"Process '{name}' exited immediately with code {exit_code}")

        srv_log.info("Process started: PID=%d, cmd=%s", proc.pid, cmd)

    # -----------------------------------------------------------------------
    # Stop server
    # -----------------------------------------------------------------------

    async def stop_server(self, name: str) -> ServerState:
        """
        Stop an MCP server by name.

        Sends stop signal, waits for timeout, sends SIGKILL if needed,
        cleans up PID file and state.

        Args:
            name: Server name.

        Returns:
            Updated ServerState.
        """
        srv_log = self._get_server_logger(name)
        logger.info("Stopping server '%s'...", name)
        srv_log.info("=== STOP REQUEST ===")

        config = self._registry.get_server_or_raise(name)
        state = self._states[name]

        if state.status in (ServerStatus.STOPPED, ServerStatus.CRASHED):
            logger.debug("Server '%s' already stopped/crashed", name)
            return state

        state.status = ServerStatus.STOPPING

        try:
            if config.install_method == InstallMethod.DOCKER:
                await self._stop_docker_server(name, config, srv_log)
            else:
                await self._stop_process_server(name, config, state, srv_log)

            state.status = ServerStatus.STOPPED
            state.stop_time = time.time()
            state.pid = None
            state.container_id = None
            self._clean_pid(name)

            srv_log.info("Server stopped successfully")
            logger.info("Server '%s' stopped", name)

        except Exception as exc:
            state.status = ServerStatus.UNKNOWN
            state.last_error = str(exc)
            srv_log.error("Stop failed: %s", exc)
            logger.error("Failed to stop '%s': %s", name, exc)

        self._persist_server_state(name)
        return state

    async def _stop_docker_server(
        self, name: str, config: ServerConfig, srv_log: logging.Logger
    ) -> None:
        """Stop a Docker-based MCP server."""
        container = self._docker_container_name(name)
        timeout = config.stop_timeout_seconds

        if config.docker_compose_file:
            compose_path = self._base_path / config.docker_compose_file
            cmd = ["docker", "compose", "-f", str(compose_path), "stop", "-t", str(timeout)]
        else:
            cmd = ["docker", "stop", "-t", str(timeout), container]

        srv_log.debug("Stopping Docker container: %s", cmd)

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 30)
            srv_log.debug("Docker stop exit=%d", result.returncode)
        except subprocess.TimeoutExpired:
            srv_log.warning("Docker stop timed out, forcing kill")
            subprocess.run(["docker", "kill", container], capture_output=True, timeout=10)

        # Remove container if not using compose
        if not config.docker_compose_file:
            try:
                subprocess.run(["docker", "rm", "-f", container], capture_output=True, timeout=10)
                srv_log.debug("Docker container removed: %s", container)
            except (subprocess.TimeoutExpired, OSError):
                pass

    async def _stop_process_server(
        self, name: str, config: ServerConfig, state: ServerState, srv_log: logging.Logger
    ) -> None:
        """Stop a pip/system-based MCP server process."""
        pid = state.pid
        if pid is None:
            pid = self._read_pid(name)

        if pid is None:
            srv_log.warning("No PID found for '%s', nothing to stop", name)
            return

        srv_log.debug("Stopping process PID=%d with signal %s, timeout=%ds", pid, config.stop_signal, config.stop_timeout_seconds)

        # Send stop signal
        sig = getattr(signal, config.stop_signal, signal.SIGTERM)
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            srv_log.debug("Process %d already dead", pid)
            self._clean_pid(name)
            return

        # Wait for graceful shutdown
        deadline = time.time() + config.stop_timeout_seconds
        while time.time() < deadline:
            if not self._is_process_alive(pid):
                srv_log.debug("Process %d exited gracefully", pid)
                return
            await asyncio.sleep(_PROCESS_POLL_INTERVAL)

        # Force kill
        srv_log.warning("Process %d did not exit within %ds, sending SIGKILL", pid, config.stop_timeout_seconds)
        try:
            kill_signal = getattr(signal, 'SIGKILL', None)
            if kill_signal is not None:
                os.kill(pid, kill_signal)
            else:
                # Windows: SIGKILL not available, use proc.terminate() / taskkill
                proc = self._processes.get(name)
                if proc is not None:
                    proc.kill()
                else:
                    os.kill(pid, signal.SIGTERM)
            await asyncio.sleep(1)
        except ProcessLookupError:
            pass

        # Clean up subprocess handle
        proc = self._processes.pop(name, None)
        if proc is not None:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

        # Close log file handle
        fh = self._log_handles.pop(name, None)
        if fh is not None:
            try:
                fh.close()
            except OSError:
                pass

    # -----------------------------------------------------------------------
    # Restart server
    # -----------------------------------------------------------------------

    async def restart_server(self, name: str) -> ServerState:
        """
        Restart an MCP server: stop → wait → start → verify.

        If start fails after stop, the server remains in CRASHED state.

        Args:
            name: Server name.

        Returns:
            Updated ServerState.
        """
        srv_log = self._get_server_logger(name)
        logger.info("Restarting server '%s'...", name)
        srv_log.info("=== RESTART REQUEST ===")

        state = self._states[name]
        state.restart_count += 1
        state.last_restart_time = time.time()

        # Stop
        await self.stop_server(name)

        # Brief pause
        await asyncio.sleep(1)

        # Start
        try:
            await self.start_server(name)
            srv_log.info("Restart completed successfully (count=%d)", state.restart_count)
        except Exception as exc:
            srv_log.error("Restart failed on start phase: %s", exc)
            state.status = ServerStatus.CRASHED
            state.last_error = f"Restart failed: {exc}"

        self._persist_server_state(name)
        return state

    def handle_child_exit(self, pid: int, exit_code: int) -> None:
        """Handle SIGCHLD notification for a child process exit.

        Called by start_server.py's signal handler when a child process exits.

        Args:
            pid: The exited process PID.
            exit_code: The process exit code.
        """
        # Find the server name by matching PID
        server_name: Optional[str] = None
        for name, proc in self._processes.items():
            if proc.pid == pid:
                server_name = name
                break

        if server_name is None:
            logger.debug("handle_child_exit: PID %d not found in managed processes", pid)
            return

        state = self._states.get(server_name)
        if state is None:
            return

        if exit_code != 0:
            state.status = ServerStatus.CRASHED
            state.last_error = f"Process exited with code {exit_code}"
            logger.warning("Server '%s' (PID %d) crashed with exit code %d", server_name, pid, exit_code)
        else:
            state.status = ServerStatus.STOPPED
            logger.info("Server '%s' (PID %d) exited cleanly", server_name, pid)

        state.stop_time = time.time()
        state.pid = None
        self._processes.pop(server_name, None)
        fh = self._log_handles.pop(server_name, None)
        if fh is not None:
            try:
                fh.close()
            except OSError:
                pass
        self._clean_pid(server_name)
        self._persist_server_state(server_name)

    # -----------------------------------------------------------------------
    # Status
    # -----------------------------------------------------------------------

    def get_server_status(self, name: str) -> ServerState:
        """
        Get the current status of a server, refreshing from process/Docker state.

        Args:
            name: Server name.

        Returns:
            Current ServerState.
        """
        logger.debug("get_server_status('%s')", name)

        config = self._registry.get_server_or_raise(name)
        state = self._states.get(name)
        if state is None:
            state = ServerState(server_name=name)
            self._states[name] = state

        # Refresh actual status
        if config.install_method == InstallMethod.DOCKER:
            is_alive = self._is_docker_running(name)
        else:
            pid = state.pid or self._read_pid(name)
            is_alive = pid is not None and self._is_process_alive(pid)

        # Update state based on reality
        if is_alive and state.status not in (ServerStatus.RUNNING, ServerStatus.UNHEALTHY, ServerStatus.STOPPING):
            state.status = ServerStatus.RUNNING
        elif not is_alive and state.status in (ServerStatus.RUNNING, ServerStatus.UNHEALTHY):
            state.status = ServerStatus.CRASHED
            state.stop_time = time.time()
            logger.warning("Server '%s' detected as crashed", name)

        return state

    def get_all_statuses(self) -> Dict[str, ServerState]:
        """Get fresh status for all registered servers."""
        logger.debug("get_all_statuses()")
        result: Dict[str, ServerState] = {}
        for name in self._registry.get_server_names():
            result[name] = self.get_server_status(name)
        return result

    # -----------------------------------------------------------------------
    # Startup / Shutdown sequences
    # -----------------------------------------------------------------------

    async def startup_all(self) -> Dict[str, ServerState]:
        """
        Start all enabled servers in dependency order.

        Detects already-running servers, adopts orphaned processes,
        and starts remaining servers.

        Returns:
            Dict of all server states after startup.
        """
        logger.info("=== SUPERVISOR STARTUP ===")

        # 1. Detect/adopt orphaned processes
        self._adopt_orphans()

        # 2. Get dependency-ordered server list
        try:
            order = self._registry.get_dependency_order()
        except ValueError as exc:
            logger.error("Dependency resolution failed: %s", exc)
            order = list(self._registry.get_enabled_servers().keys())

        enabled = self._registry.get_enabled_servers()

        # 3. Start each enabled server in order
        results: Dict[str, ServerState] = {}
        for name in order:
            if name not in enabled:
                logger.debug("Skipping disabled server '%s'", name)
                continue

            state = self._states.get(name)
            if state and state.status == ServerStatus.RUNNING:
                logger.info("Server '%s' already running (adopted), skipping start", name)
                results[name] = state
                continue

            try:
                results[name] = await self.start_server(name)
            except Exception as exc:
                logger.error("Failed to start '%s' during startup: %s", name, exc)
                results[name] = self._states[name]

        # 4. Persist full snapshot
        self._persist_snapshot()
        logger.info("Supervisor startup complete: %d servers processed", len(results))
        return results

    async def shutdown_all(self) -> None:
        """
        Gracefully stop all running servers in reverse dependency order.
        Persists final state and cleans up.
        """
        logger.info("=== SUPERVISOR SHUTDOWN ===")
        self._shutdown_event.set()

        # Reverse dependency order for shutdown
        try:
            order = list(reversed(self._registry.get_dependency_order()))
        except ValueError:
            order = list(self._states.keys())

        for name in order:
            state = self._states.get(name)
            if state and state.status in (ServerStatus.RUNNING, ServerStatus.UNHEALTHY, ServerStatus.STARTING):
                try:
                    await self.stop_server(name)
                except Exception as exc:
                    logger.error("Error stopping '%s' during shutdown: %s", name, exc)

        # Final snapshot
        self._persist_snapshot()

        # Close any remaining log file handles
        for name, fh in list(self._log_handles.items()):
            try:
                fh.close()
            except OSError:
                pass
        self._log_handles.clear()

        logger.info("Supervisor shutdown complete")

    async def stop_all(self) -> None:
        """Alias for shutdown_all() — used by start_server.py signal handlers."""
        return await self.shutdown_all()

    # -----------------------------------------------------------------------
    # Orphan adoption
    # -----------------------------------------------------------------------

    def _adopt_orphans(self) -> None:
        """
        On startup, check for existing PID files and adopt running processes.
        If PID file exists but process is dead → clean up.
        If PID file exists and process is alive → adopt.
        """
        logger.debug("Checking for orphaned processes...")

        for name in self._registry.get_server_names():
            config = self._registry.get_server(name)
            if config is None:
                continue

            state = self._states.get(name, ServerState(server_name=name))

            if config.install_method == InstallMethod.DOCKER:
                # Check Docker container directly
                if self._is_docker_running(name):
                    state.status = ServerStatus.RUNNING
                    state.container_id = self._get_docker_container_id(name)
                    state.start_time = state.start_time or time.time()
                    logger.info("Adopted running Docker container for '%s' (id=%s)", name, state.container_id)
                else:
                    state.status = ServerStatus.STOPPED
            else:
                # Check PID file
                pid = self._read_pid(name)
                if pid is not None:
                    if self._is_process_alive(pid):
                        state.status = ServerStatus.RUNNING
                        state.pid = pid
                        state.start_time = state.start_time or time.time()
                        logger.info("Adopted running process for '%s' (PID=%d)", name, pid)
                    else:
                        logger.info("Stale PID file for '%s' (PID=%d dead) — cleaning up", name, pid)
                        self._clean_pid(name)
                        state.status = ServerStatus.STOPPED
                        state.pid = None
                else:
                    state.status = ServerStatus.STOPPED

            self._states[name] = state

    # -----------------------------------------------------------------------
    # Wait helper
    # -----------------------------------------------------------------------

    async def _wait_for_process(self, pid: int, timeout: float) -> Optional[int]:
        """
        Wait for a process to exit with a configurable timeout.

        Args:
            pid: Process ID to wait for.
            timeout: Maximum seconds to wait.

        Returns:
            Exit code if process exited, None if timeout.
        """
        logger.debug("Waiting for PID %d (timeout=%ds)", pid, timeout)
        deadline = time.time() + timeout

        while time.time() < deadline:
            if not self._is_process_alive(pid):
                # Process exited — try to get exit code from Popen if available
                for name, proc in self._processes.items():
                    if proc.pid == pid:
                        return proc.poll()
                return 0
            await asyncio.sleep(_PROCESS_POLL_INTERVAL)

        logger.debug("Timeout waiting for PID %d", pid)
        return None

    # -----------------------------------------------------------------------
    # State persistence
    # -----------------------------------------------------------------------

    def _persist_server_state(self, name: str) -> None:
        """Persist a single server's state to disk."""
        state = self._states.get(name)
        if state is None:
            return
        try:
            state_path = state.to_state_file(self._state_dir)
            state_path.parent.mkdir(parents=True, exist_ok=True)
            state_path.write_text(state.model_dump_json(indent=2), encoding="utf-8")
            logger.debug("Persisted state for '%s' to %s", name, state_path)
        except Exception as exc:
            logger.error("Failed to persist state for '%s': %s", name, exc)

    def _persist_snapshot(self) -> None:
        """Persist full supervisor snapshot for autorecovery."""
        try:
            snapshot = SupervisorSnapshot(
                servers=dict(self._states),
                last_config_hash=self._registry.config_hash,
            )
            snapshot.save(self._state_dir)
            logger.debug("Supervisor snapshot saved")
        except Exception as exc:
            logger.error("Failed to save supervisor snapshot: %s", exc)

    def _load_snapshot(self) -> Optional[SupervisorSnapshot]:
        """Load supervisor snapshot from disk for autorecovery."""
        snapshot = SupervisorSnapshot.load(self._state_dir)
        if snapshot:
            logger.info("Loaded supervisor snapshot (age=%.0fs)", time.time() - snapshot.timestamp)
            # Restore server states from snapshot
            for name, state in snapshot.servers.items():
                if name in self._states:
                    # Only restore non-running info, actual status will be verified
                    self._states[name].restart_count = state.restart_count
                    self._states[name].version = state.version
                    self._states[name].start_time = state.start_time
        return snapshot

    # -----------------------------------------------------------------------
    # Properties
    # -----------------------------------------------------------------------

    @property
    def states(self) -> Dict[str, ServerState]:
        """Get all server states."""
        return dict(self._states)

    @property
    def is_shutting_down(self) -> bool:
        """Check if supervisor is in shutdown mode."""
        return self._shutdown_event.is_set()
