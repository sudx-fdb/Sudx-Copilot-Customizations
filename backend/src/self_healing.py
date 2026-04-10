"""
Self-Healing & Error Recovery for the Backend MCP Server Manager.

Provides: Docker daemon monitoring, disk space monitoring, state file
corruption recovery, atomic writes, zombie process cleanup, resource
limit enforcement, cascading failure prevention, emergency shutdown.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger("backend.self_healing")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_DISK_WARN_PERCENT = 90
_DISK_BLOCK_PERCENT = 95
_DOCKER_RETRY_INTERVAL = 60  # seconds
_ZOMBIE_SCAN_INTERVAL = 300  # seconds
_MEMORY_LIMIT_MAIN_MB = 500
_DISK_EMERGENCY_PERCENT = 95
_CASCADE_RESTART_DELAY = 5.0  # seconds between restarting crashed servers
_RESOURCE_WARN_MULTIPLIER = 1.0
_RESOURCE_KILL_MULTIPLIER = 2.0


# ---------------------------------------------------------------------------
# Docker Daemon Health Check
# ---------------------------------------------------------------------------

class DockerDaemonMonitor:
    """Monitor Docker daemon availability. Retry on failure."""

    def __init__(self):
        self._available: bool = False
        self._last_check: float = 0.0
        self._check_interval: float = _DOCKER_RETRY_INTERVAL
        logger.debug("DockerDaemonMonitor initialized")

    def is_available(self) -> bool:
        """Check if Docker daemon is responsive. Caches result."""
        now = time.time()
        if now - self._last_check < self._check_interval:
            return self._available

        self._last_check = now
        try:
            result = subprocess.run(
                ["docker", "info"],
                capture_output=True, text=True, timeout=10,
            )
            self._available = result.returncode == 0
            if self._available:
                logger.debug("Docker daemon is available")
            else:
                logger.warning("Docker daemon not responsive: %s", result.stderr.strip())
        except FileNotFoundError:
            logger.error("Docker binary not found on PATH")
            self._available = False
        except subprocess.TimeoutExpired:
            logger.error("Docker info timed out (10s)")
            self._available = False
        except Exception as exc:
            logger.error("Docker daemon check failed: %s", exc)
            self._available = False

        return self._available

    def force_recheck(self) -> bool:
        """Force immediate recheck regardless of cache."""
        self._last_check = 0.0
        return self.is_available()


# ---------------------------------------------------------------------------
# Disk Space Monitoring
# ---------------------------------------------------------------------------

class DiskMonitor:
    """Monitor disk space and enforce thresholds."""

    def __init__(self, path: str = "/"):
        self._path = path
        logger.debug("DiskMonitor initialized for path: %s", path)

    def get_usage(self) -> Dict[str, Any]:
        """Get disk usage stats."""
        try:
            usage = shutil.disk_usage(self._path)
            percent_used = (usage.used / usage.total) * 100
            return {
                "total_gb": usage.total / (1024 ** 3),
                "used_gb": usage.used / (1024 ** 3),
                "free_gb": usage.free / (1024 ** 3),
                "percent_used": percent_used,
            }
        except Exception as exc:
            logger.error("Failed to get disk usage for %s: %s", self._path, exc)
            return {"total_gb": 0, "used_gb": 0, "free_gb": 0, "percent_used": 100}

    def check(self) -> str:
        """Check disk space. Returns 'ok', 'warning', or 'critical'."""
        usage = self.get_usage()
        percent = usage["percent_used"]

        if percent >= _DISK_BLOCK_PERCENT:
            logger.critical(
                "DISK CRITICAL: %.1f%% used (%.1f GB free) — blocking new operations",
                percent, usage["free_gb"],
            )
            return "critical"
        elif percent >= _DISK_WARN_PERCENT:
            logger.warning(
                "DISK WARNING: %.1f%% used (%.1f GB free)",
                percent, usage["free_gb"],
            )
            return "warning"
        else:
            logger.debug("Disk OK: %.1f%% used (%.1f GB free)", percent, usage["free_gb"])
            return "ok"

    def can_proceed(self) -> bool:
        """Return True if disk space allows new operations."""
        status = self.check()
        return status != "critical"


# ---------------------------------------------------------------------------
# State File Corruption Recovery
# ---------------------------------------------------------------------------

def safe_read_json(path: Path, default: Any = None) -> Any:
    """
    Read a JSON file with corruption recovery.
    Tries: primary → .bak → recreate from default.
    """
    logger.debug("safe_read_json: reading %s", path)
    bak_path = path.with_suffix(path.suffix + ".bak")

    # Try primary file
    try:
        if path.exists():
            raw = path.read_text(encoding="utf-8")
            data = json.loads(raw)
            logger.debug("safe_read_json: primary file OK (%d bytes)", len(raw))
            return data
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        logger.warning("State file corrupted: %s — %s. Trying backup.", path, exc)

    # Try backup
    try:
        if bak_path.exists():
            raw = bak_path.read_text(encoding="utf-8")
            data = json.loads(raw)
            logger.warning("Restored from backup: %s", bak_path)
            # Restore primary from backup
            atomic_write_json(path, data)
            return data
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        logger.error("Backup also corrupted: %s — %s. Recreating from default.", bak_path, exc)

    # Both corrupted — use default
    if default is not None:
        logger.warning("Recreating %s from default", path)
        atomic_write_json(path, default)
        return default

    logger.error("No default available for %s — returning None", path)
    return None


# ---------------------------------------------------------------------------
# Atomic State Writes
# ---------------------------------------------------------------------------

def atomic_write_json(path: Path, data: Any) -> bool:
    """
    Write JSON atomically: write to temp → fsync → rename.
    Also maintains a .bak copy.
    """
    logger.debug("atomic_write_json: writing %s", path)
    path.parent.mkdir(parents=True, exist_ok=True)
    bak_path = path.with_suffix(path.suffix + ".bak")

    try:
        # Create backup of current file
        if path.exists():
            try:
                shutil.copy2(str(path), str(bak_path))
            except Exception as exc:
                logger.warning("Failed to create backup %s: %s", bak_path, exc)

        # Write to temp file in same directory (same filesystem for atomic rename)
        fd, tmp_path = tempfile.mkstemp(
            dir=str(path.parent), suffix=".tmp", prefix=path.stem + "_"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, str(path))
            logger.debug("atomic_write_json: successfully wrote %s", path)
            return True
        except Exception:
            # Clean up temp file on failure
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
    except Exception as exc:
        logger.error("atomic_write_json failed for %s: %s", path, exc)
        return False


def atomic_write_text(path: Path, content: str) -> bool:
    """Write text atomically: write to temp → fsync → rename."""
    logger.debug("atomic_write_text: writing %s", path)
    path.parent.mkdir(parents=True, exist_ok=True)

    try:
        fd, tmp_path = tempfile.mkstemp(
            dir=str(path.parent), suffix=".tmp", prefix=path.stem + "_"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, str(path))
            return True
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
    except Exception as exc:
        logger.error("atomic_write_text failed for %s: %s", path, exc)
        return False


# ---------------------------------------------------------------------------
# Zombie Process Cleanup
# ---------------------------------------------------------------------------

def cleanup_zombie_processes() -> int:
    """
    Scan for and reap orphaned child processes.
    Returns number of reaped processes.
    Windows has no zombie processes — returns 0 immediately.
    """
    if sys.platform == "win32":
        logger.debug("Zombie cleanup skipped: not applicable on Windows")
        return 0

    logger.debug("Scanning for zombie processes")
    reaped = 0
    try:
        while True:
            pid, status = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                break
            reaped += 1
            logger.info("Reaped zombie process PID=%d (status=%d)", pid, status)
    except ChildProcessError:
        # No child processes — normal
        pass
    except Exception as exc:
        logger.debug("Zombie scan: %s", exc)

    if reaped > 0:
        logger.info("Reaped %d zombie processes", reaped)
    else:
        logger.debug("No zombie processes found")
    return reaped


def find_orphaned_pids(state_dir: Path) -> Dict[str, int]:
    """
    Find PID files in state_dir whose processes are no longer running.
    Returns {server_name: stale_pid}.
    """
    logger.debug("Scanning for orphaned PID files in %s", state_dir)
    orphans = {}
    if not state_dir.exists():
        return orphans

    for pid_file in state_dir.glob("*.pid"):
        server_name = pid_file.stem
        try:
            pid = int(pid_file.read_text().strip())
            # Check if process exists
            try:
                os.kill(pid, 0)  # signal 0 = check existence
                logger.debug("PID %d (%s) is still running", pid, server_name)
            except ProcessLookupError:
                logger.warning("Orphaned PID file: %s (PID %d not running)", pid_file, pid)
                orphans[server_name] = pid
                pid_file.unlink()
            except PermissionError:
                logger.debug("PID %d (%s) exists but not owned by us", pid, server_name)
        except (ValueError, OSError) as exc:
            logger.warning("Invalid PID file %s: %s — removing", pid_file, exc)
            try:
                pid_file.unlink()
            except OSError:
                pass

    return orphans


# ---------------------------------------------------------------------------
# Resource Limit Enforcement
# ---------------------------------------------------------------------------

def check_process_memory(pid: int) -> Optional[float]:
    """Get memory usage of a process in MB. Returns None if unavailable."""
    try:
        import psutil
        proc = psutil.Process(pid)
        mem_mb = proc.memory_info().rss / (1024 * 1024)
        logger.debug("PID %d memory: %.1f MB", pid, mem_mb)
        return mem_mb
    except ImportError:
        logger.debug("psutil not available for memory check")
        return None
    except Exception as exc:
        logger.debug("Failed to check memory for PID %d: %s", pid, exc)
        return None


def enforce_resource_limits(
    pid: int,
    server_name: str,
    memory_limit_mb: float,
    on_warn: Optional[Callable] = None,
    on_kill: Optional[Callable] = None,
) -> str:
    """
    Check if process exceeds memory limits.
    Returns 'ok', 'warning', or 'killed'.
    """
    mem_mb = check_process_memory(pid)
    if mem_mb is None:
        return "ok"

    warn_limit = memory_limit_mb * _RESOURCE_WARN_MULTIPLIER
    kill_limit = memory_limit_mb * _RESOURCE_KILL_MULTIPLIER

    if mem_mb > kill_limit:
        logger.critical(
            "Server '%s' (PID %d) exceeds 2x memory limit: %.1f MB > %.1f MB — forcing restart",
            server_name, pid, mem_mb, kill_limit,
        )
        if on_kill:
            on_kill(server_name, mem_mb)
        return "killed"
    elif mem_mb > warn_limit:
        logger.warning(
            "Server '%s' (PID %d) exceeds memory limit: %.1f MB > %.1f MB",
            server_name, pid, mem_mb, warn_limit,
        )
        if on_warn:
            on_warn(server_name, mem_mb)
        return "warning"
    else:
        logger.debug("Server '%s' memory OK: %.1f MB / %.1f MB", server_name, mem_mb, memory_limit_mb)
        return "ok"


# ---------------------------------------------------------------------------
# Cascading Failure Prevention
# ---------------------------------------------------------------------------

class CascadeController:
    """
    Prevent cascading failures when multiple servers crash simultaneously.
    Restarts one at a time with delays.
    """

    def __init__(self, delay: float = _CASCADE_RESTART_DELAY):
        self._delay = delay
        self._restart_queue: list = []
        self._restarting = False
        self._lock = asyncio.Lock()
        logger.debug("CascadeController initialized (delay=%.1fs)", delay)

    async def queue_restart(self, server_name: str, restart_fn: Callable) -> None:
        """Queue a server restart. Will be executed sequentially with delays."""
        logger.info("Queuing restart for '%s'", server_name)
        async with self._lock:
            self._restart_queue.append((server_name, restart_fn))

        if not self._restarting:
            asyncio.create_task(self._process_queue())

    async def _process_queue(self) -> None:
        """Process restart queue one at a time with delays."""
        self._restarting = True
        logger.debug("Processing restart queue (%d items)", len(self._restart_queue))

        while True:
            async with self._lock:
                if not self._restart_queue:
                    break
                server_name, restart_fn = self._restart_queue.pop(0)

            logger.info("Restarting '%s' (cascade-controlled)", server_name)
            try:
                await restart_fn(server_name)
                logger.info("Cascade restart of '%s' completed", server_name)
            except Exception as exc:
                logger.error("Cascade restart of '%s' failed: %s", server_name, exc)

            # Delay before next restart
            if self._restart_queue:
                logger.debug("Waiting %.1fs before next cascade restart", self._delay)
                await asyncio.sleep(self._delay)

        self._restarting = False
        logger.debug("Restart queue empty")


# ---------------------------------------------------------------------------
# Emergency Shutdown
# ---------------------------------------------------------------------------

class EmergencyShutdown:
    """
    Monitor system resources and trigger emergency shutdown if critical thresholds are exceeded.
    """

    def __init__(
        self,
        memory_limit_mb: float = _MEMORY_LIMIT_MAIN_MB,
        disk_path: str = "/",
        supervisor=None,
    ):
        self._memory_limit = memory_limit_mb
        self._disk_monitor = DiskMonitor(disk_path)
        self._supervisor = supervisor
        self._triggered = False
        logger.debug(
            "EmergencyShutdown initialized (mem_limit=%.0f MB, disk_path=%s)",
            memory_limit_mb, disk_path,
        )

    async def check(self) -> bool:
        """
        Check emergency conditions. Returns True if emergency shutdown triggered.
        Conditions: main process > 500MB RAM OR disk < 5%.
        """
        if self._triggered:
            return True

        # Check main process memory
        main_mem = check_process_memory(os.getpid())
        if main_mem is not None and main_mem > self._memory_limit:
            logger.critical(
                "EMERGENCY: Main process memory %.1f MB exceeds limit %.1f MB",
                main_mem, self._memory_limit,
            )
            await self._trigger_emergency("memory_exceeded")
            return True

        # Check disk space
        usage = self._disk_monitor.get_usage()
        if usage["percent_used"] >= _DISK_EMERGENCY_PERCENT:
            logger.critical(
                "EMERGENCY: Disk usage %.1f%% exceeds %d%% — free: %.2f GB",
                usage["percent_used"], _DISK_EMERGENCY_PERCENT, usage["free_gb"],
            )
            await self._trigger_emergency("disk_critical")
            return True

        return False

    async def _trigger_emergency(self, reason: str) -> None:
        """Execute emergency shutdown sequence."""
        self._triggered = True
        logger.critical("=== EMERGENCY SHUTDOWN TRIGGERED: %s ===", reason)

        if self._supervisor:
            try:
                logger.critical("Stopping all managed servers...")
                await self._supervisor.shutdown_all()
                logger.critical("All servers stopped")
            except Exception as exc:
                logger.critical("Failed to stop servers during emergency: %s", exc)

        try:
            logger.critical("Persisting state for recovery...")
            if self._supervisor and hasattr(self._supervisor, "_save_all_states"):
                self._supervisor._save_all_states()
        except Exception as exc:
            logger.critical("Failed to persist state: %s", exc)

        logger.critical("=== EMERGENCY SHUTDOWN COMPLETE — Exiting ===")
        # Let the main process handle the actual exit
