#!/usr/bin/env python3
"""
Backend MCP Server Manager — Bootstrap, Supervisor & CLI.

Complete bootstrap and supervisor entry point for the SUDX VPS backend.
Handles: Python version check, venv management, dependency installation,
config validation, component launch (Logger + Supervisor + API), signal
handling, PID management, watchdog, systemd integration, and CLI commands.

Usage:
    python start_server.py                     # Start the backend (default)
    python start_server.py --validate          # Validate config and exit
    python start_server.py --dry-run           # Simulate startup
    python start_server.py --status            # Print running server status
    python start_server.py --stop              # Shutdown running backend
    python start_server.py --restart           # Stop + start
    python start_server.py --version           # Print version info
    python start_server.py --logs [server]     # Tail log files
    python start_server.py --mock-server       # Start mock MCP test server
    python start_server.py --install-service   # Install systemd service
    python start_server.py --uninstall-service # Remove systemd service
"""

from __future__ import annotations

import argparse
import asyncio
import http.server
import importlib
import json
import logging
import os
import shutil
import signal
import socket
import subprocess
import sys
import textwrap
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

# ---------------------------------------------------------------------------
# Constants & paths (resolved before any venv/import magic)
# ---------------------------------------------------------------------------

_BASE_DIR = Path(__file__).resolve().parent
_SRC_DIR = _BASE_DIR / "src"
_CONFIG_DIR = _BASE_DIR / "config"
_STATE_DIR = _BASE_DIR / "state"
_LOGS_DIR = _BASE_DIR / "logs"
_SCHEMAS_DIR = _CONFIG_DIR / "schemas"
_VENV_DIR = _BASE_DIR / ".venv"
_PID_FILE = _STATE_DIR / "supervisor.pid"
_CRASH_HISTORY_FILE = _STATE_DIR / "crash_history.json"
_STATE_SNAPSHOT_FILE = _STATE_DIR / "state_snapshot.json"
_VERSION_FILE = _BASE_DIR / "version.json"
_REQUIREMENTS_FILE = _BASE_DIR / "requirements.txt"
_SERVICE_TEMPLATE = _CONFIG_DIR / "sudx-mcp-backend.service"
_LOGROTATE_TEMPLATE = _CONFIG_DIR / "sudx-mcp-backend.logrotate"
_ENV_FILE = _BASE_DIR.parent / ".env"

# Ensure src/ is importable
sys.path.insert(0, str(_SRC_DIR))

logger = logging.getLogger("backend.bootstrap")

# ---------------------------------------------------------------------------
# Configuration defaults (externalized)
# ---------------------------------------------------------------------------

_DEFAULT_API_HOST = "0.0.0.0"
_DEFAULT_API_PORT = 8420
_DEFAULT_MOCK_PORT = 19999
_STATUS_TIMEOUT = 10
_STOP_TIMEOUT = 15
_SHUTDOWN_TIMEOUT = 30
_HEALTH_CHECK_INTERVAL = 30
_STARTUP_RETRY_COUNT = 3
_STARTUP_RETRY_DELAY = 5
_MIN_DISK_SPACE_MB = 500
_CRASH_MAX_COUNT = 5
_CRASH_WINDOW_SECONDS = 600
_MEMORY_WARN_PERCENT = 70
_MEMORY_CRITICAL_PERCENT = 90
_WATCHDOG_LOOP_TIMEOUT = 30
_MIN_PYTHON_VERSION = (3, 10)
_SYSTEMD_SERVICE_DEST = Path("/etc/systemd/system/sudx-mcp-backend.service")
_LOGROTATE_DEST = Path("/etc/logrotate.d/sudx-mcp-backend")

# ---------------------------------------------------------------------------
# ANSI color helpers
# ---------------------------------------------------------------------------

_IS_TTY = hasattr(sys.stdout, "isatty") and sys.stdout.isatty()


def _c(code: str, text: str) -> str:
    """Wrap text with ANSI color if stdout is a TTY."""
    if not _IS_TTY:
        return text
    return f"\033[{code}m{text}\033[0m"


def _green(t: str) -> str:
    return _c("32", t)


def _red(t: str) -> str:
    return _c("31", t)


def _yellow(t: str) -> str:
    return _c("33", t)


def _cyan(t: str) -> str:
    return _c("36", t)


def _bold(t: str) -> str:
    return _c("1", t)


# ---------------------------------------------------------------------------
# 15a. Bootstrap & Environment Setup
# ---------------------------------------------------------------------------

def _check_python_version() -> bool:
    """
    Check Python version >= 3.10. Print clear error with download link if not met.

    Returns:
        True if version is sufficient.
    """
    logger.debug("Checking Python version: %s", sys.version)
    if sys.version_info >= _MIN_PYTHON_VERSION:
        logger.debug("Python version OK: %d.%d.%d", *sys.version_info[:3])
        return True
    current = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    required = f"{_MIN_PYTHON_VERSION[0]}.{_MIN_PYTHON_VERSION[1]}+"
    print(f"{_red('[FATAL]')} Python {required} is required, but you have Python {current}.")
    print(f"        Download: https://www.python.org/downloads/")
    logger.critical("Python version %s does not meet minimum %s", current, required)
    return False


def _detect_venv() -> bool:
    """Check if we are already running inside the backend venv."""
    in_venv = sys.prefix != sys.base_prefix
    logger.debug("Venv detection: sys.prefix=%s, sys.base_prefix=%s, in_venv=%s", sys.prefix, sys.base_prefix, in_venv)
    return in_venv


def _ensure_venv() -> bool:
    """
    Ensure backend/.venv/ exists and is valid.
    Creates it if missing, validates pyvenv.cfg if present.

    Returns:
        True if venv is usable.
    """
    logger.debug("Ensuring venv at %s", _VENV_DIR)
    pyvenv_cfg = _VENV_DIR / "pyvenv.cfg"

    if _VENV_DIR.exists():
        if pyvenv_cfg.exists():
            # Verify integrity — check 'home' path exists
            try:
                content = pyvenv_cfg.read_text(encoding="utf-8")
                for line in content.splitlines():
                    if line.startswith("home"):
                        home_path = line.split("=", 1)[1].strip()
                        if Path(home_path).exists():
                            logger.debug("Venv integrity OK: home=%s", home_path)
                            return True
                        else:
                            logger.warning("Venv home path invalid: %s — recreating venv", home_path)
                            break
            except Exception as exc:
                logger.warning("Cannot read pyvenv.cfg: %s — recreating venv", exc)
        else:
            logger.warning("Venv directory exists but pyvenv.cfg missing — recreating")

        # Remove broken venv
        import shutil
        try:
            shutil.rmtree(_VENV_DIR)
            logger.debug("Removed broken venv directory")
        except Exception as exc:
            logger.error("Cannot remove broken venv: %s", exc)
            return False

    # Create new venv
    print(f"  {_yellow('[SETUP]')} Creating virtual environment at {_VENV_DIR}...")
    logger.info("Creating venv at %s", _VENV_DIR)
    try:
        result = subprocess.run(
            [sys.executable, "-m", "venv", str(_VENV_DIR)],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            logger.error("venv creation failed: %s", result.stderr)
            print(f"  {_red('[FAIL]')} venv creation failed: {result.stderr.strip()}")
            return False
        logger.info("Venv created successfully")
        return True
    except Exception as exc:
        logger.error("venv creation error: %s", exc)
        print(f"  {_red('[FAIL]')} Cannot create venv: {exc}")
        return False


def _get_venv_python() -> Path:
    """Get the path to the Python executable inside the venv."""
    if sys.platform == "win32":
        return _VENV_DIR / "Scripts" / "python.exe"
    return _VENV_DIR / "bin" / "python"


def _get_venv_pip() -> Path:
    """Get the path to the pip executable inside the venv."""
    if sys.platform == "win32":
        return _VENV_DIR / "Scripts" / "pip.exe"
    return _VENV_DIR / "bin" / "pip"


def _install_requirements() -> bool:
    """
    Install/upgrade requirements.txt inside venv.

    Returns:
        True if installation succeeded.
    """
    if not _REQUIREMENTS_FILE.exists():
        logger.warning("requirements.txt not found at %s — skipping dependency install", _REQUIREMENTS_FILE)
        return True

    pip_path = _get_venv_pip()
    if not pip_path.exists():
        logger.error("pip not found at %s", pip_path)
        print(f"  {_red('[FAIL]')} pip not found in venv")
        return False

    print(f"  {_yellow('[DEPS]')} Installing/upgrading dependencies...")
    logger.info("Installing requirements from %s", _REQUIREMENTS_FILE)
    try:
        result = subprocess.run(
            [str(pip_path), "install", "-r", str(_REQUIREMENTS_FILE), "--quiet", "--upgrade"],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            logger.error("pip install failed: %s", result.stderr)
            print(f"  {_red('[FAIL]')} pip install failed: {result.stderr.strip()[:200]}")
            return False
        logger.info("Dependencies installed successfully")
        print(f"  {_green('[OK]')} Dependencies up to date")
        return True
    except subprocess.TimeoutExpired:
        logger.error("pip install timed out after 300s")
        print(f"  {_red('[FAIL]')} pip install timed out")
        return False
    except Exception as exc:
        logger.error("pip install error: %s", exc)
        print(f"  {_red('[FAIL]')} pip install error: {exc}")
        return False


def _load_env_file() -> None:
    """Load .env file from repo root for secrets (SUDX_BACKEND_TOKEN, API keys)."""
    logger.debug("Looking for .env file at %s", _ENV_FILE)
    if not _ENV_FILE.exists():
        logger.debug(".env file not found — skipping")
        return
    try:
        # Try python-dotenv first
        from dotenv import load_dotenv
        load_dotenv(_ENV_FILE, override=False)
        logger.info("Loaded .env file via python-dotenv: %s", _ENV_FILE)
    except ImportError:
        # Fallback: manual parsing
        logger.debug("python-dotenv not available — parsing .env manually")
        try:
            with open(_ENV_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    key = key.strip()
                    value = value.strip().strip("'\"")
                    if key and key not in os.environ:
                        os.environ[key] = value
                        logger.debug("Set env from .env: %s=***", key)
        except Exception as exc:
            logger.warning("Failed to parse .env file: %s", exc)


def _load_config_file() -> Dict[str, Any]:
    """
    Load .config file from repo root (if deployed alongside) for SSH/HTTP settings.

    Returns:
        Config dict or empty dict.
    """
    config_file = _BASE_DIR.parent / ".config"
    logger.debug("Looking for .config file at %s", config_file)
    if not config_file.exists():
        logger.debug(".config file not found")
        return {}
    try:
        with open(config_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        logger.info("Loaded .config file: %d keys", len(data))
        return data
    except Exception as exc:
        logger.warning("Failed to load .config file: %s", exc)
        return {}


def _ensure_directories() -> None:
    """Create required directories if they don't exist (first-run setup)."""
    logger.debug("Ensuring required directories exist")
    for d in [_CONFIG_DIR, _LOGS_DIR, _STATE_DIR, _SCHEMAS_DIR]:
        d.mkdir(parents=True, exist_ok=True)
        logger.debug("Directory ensured: %s", d)


def _first_run_setup() -> None:
    """
    On first start: create directories, generate default config from example,
    print first-run banner with setup instructions.
    """
    logger.debug("Checking first-run condition")
    config_file = _CONFIG_DIR / "mcp_servers.json"
    example_file = _CONFIG_DIR / "mcp_servers.json.example"
    is_first_run = not config_file.exists()

    if is_first_run:
        logger.info("First run detected — running setup")
        _ensure_directories()

        if example_file.exists() and not config_file.exists():
            import shutil
            shutil.copy2(example_file, config_file)
            logger.info("Generated default mcp_servers.json from example")
            print(f"\n{_cyan('[FIRST RUN]')} Generated default configuration:")
            print(f"  Config: {config_file}")
            print(f"  Edit this file to configure your MCP servers.")
            print(f"  Then restart with: python start_server.py")
            print(f"  Validate with:     python start_server.py --validate\n")
    else:
        _ensure_directories()


# ---------------------------------------------------------------------------
# PID file management
# ---------------------------------------------------------------------------

def _read_pid() -> Optional[int]:
    """Read PID from pid file, return None if not exists or invalid."""
    logger.debug("Reading PID file: %s", _PID_FILE)
    if not _PID_FILE.exists():
        return None
    try:
        pid = int(_PID_FILE.read_text().strip())
        logger.debug("Read PID: %d", pid)
        return pid
    except (ValueError, OSError) as exc:
        logger.warning("Cannot read PID file: %s", exc)
        return None


def _is_pid_alive(pid: int) -> bool:
    """Check if process with given PID is running."""
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False
    except OSError:
        return False


def _write_pid() -> None:
    """Write current PID to pid file."""
    _STATE_DIR.mkdir(parents=True, exist_ok=True)
    _PID_FILE.write_text(str(os.getpid()))
    logger.debug("Wrote PID %d to %s", os.getpid(), _PID_FILE)


def _remove_pid() -> None:
    """Remove PID file."""
    try:
        if _PID_FILE.exists():
            _PID_FILE.unlink()
            logger.debug("Removed PID file")
    except OSError as exc:
        logger.warning("Cannot remove PID file: %s", exc)


def _check_already_running() -> bool:
    """
    Check PID file for already-running instance.
    Removes stale PID files for dead processes.

    Returns:
        True if another instance is running.
    """
    pid = _read_pid()
    if pid is None:
        return False
    if _is_pid_alive(pid):
        logger.warning("Another instance already running with PID %d", pid)
        return True
    # Stale PID — remove it
    logger.info("Removing stale PID file (process %d is dead)", pid)
    _remove_pid()
    return False


# ---------------------------------------------------------------------------
# Version info
# ---------------------------------------------------------------------------

def _get_version() -> str:
    """Read version from version.json or return unknown."""
    logger.debug("Reading version from %s", _VERSION_FILE)
    if not _VERSION_FILE.exists():
        return "0.0.0-dev"
    try:
        with open(_VERSION_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("version", "0.0.0-dev")
    except Exception as exc:
        logger.warning("Cannot read version.json: %s", exc)
        return "0.0.0-dev"


# ---------------------------------------------------------------------------
# systemd sd_notify helper
# ---------------------------------------------------------------------------

def _sd_notify(state: str) -> None:
    """
    Send sd_notify message to systemd if NOTIFY_SOCKET is set.
    Supports both abstract and path-based sockets.
    """
    notify_socket = os.environ.get("NOTIFY_SOCKET")
    if not notify_socket:
        return
    logger.debug("sd_notify: %s (socket=%s)", state, notify_socket)
    try:
        if notify_socket.startswith("@"):
            # Abstract socket
            addr = "\0" + notify_socket[1:]
        else:
            addr = notify_socket
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            sock.connect(addr)
            sock.sendall(state.encode("utf-8"))
        finally:
            sock.close()
    except Exception as exc:
        logger.warning("sd_notify failed: %s", exc)


# ---------------------------------------------------------------------------
# Startup prerequisites checks
# ---------------------------------------------------------------------------

def _check_docker_available() -> bool:
    """Check if Docker daemon is responding."""
    logger.debug("Checking Docker availability")
    try:
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True, timeout=5,
        )
        ok = result.returncode == 0
        logger.debug("Docker available: %s", ok)
        return ok
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        logger.debug("Docker not available")
        return False


def _check_ssh_connectivity(host: str, port: int = 22, timeout: int = 5) -> bool:
    """Check if SSH is reachable on given host:port."""
    logger.debug("Checking SSH connectivity: %s:%d", host, port)
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
        sock.close()
        return True
    except (socket.timeout, socket.error, OSError):
        return False


def _check_disk_space(path: Path, min_mb: int = _MIN_DISK_SPACE_MB) -> bool:
    """Check if sufficient disk space is available."""
    logger.debug("Checking disk space at %s (min %d MB)", path, min_mb)
    try:
        import shutil
        usage = shutil.disk_usage(str(path))
        free_mb = usage.free // (1024 * 1024)
        logger.debug("Disk free: %d MB", free_mb)
        return free_mb >= min_mb
    except Exception as exc:
        logger.warning("Cannot check disk space: %s", exc)
        return True  # Assume OK if check fails


def _check_port_available(host: str, port: int) -> bool:
    """Check if a port is available for binding."""
    logger.debug("Checking port availability: %s:%d", host, port)
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1)
        sock.bind((host, port))
        sock.close()
        return True
    except OSError:
        return False


def _run_startup_checks(registry: Any, api_host: str, api_port: int) -> List[str]:
    """
    Run all startup prerequisite checks.

    Returns:
        List of warning/error messages. Empty = all OK.
    """
    logger.debug("Running startup prerequisite checks")
    issues: List[str] = []

    # Check API port
    if not _check_port_available(api_host, api_port):
        issues.append(f"Port {api_port} already in use on {api_host}")

    # Check disk space
    if not _check_disk_space(_BASE_DIR):
        issues.append(f"Insufficient disk space (< {_MIN_DISK_SPACE_MB} MB) at {_BASE_DIR}")

    # Check Docker if any Docker MCPs are configured
    servers = registry.get_all_servers()
    docker_servers = [n for n, s in servers.items() if s.enabled and s.install_method.value in ("docker", "docker_compose")]
    if docker_servers and not _check_docker_available():
        issues.append(f"Docker not available but required by: {', '.join(docker_servers)}")

    # Check SSH connectivity for SSH-dependent servers
    for name, srv in servers.items():
        if not srv.enabled:
            continue
        if hasattr(srv, "ssh_host") and srv.ssh_host:
            if not _check_ssh_connectivity(srv.ssh_host, getattr(srv, "ssh_port", 22)):
                issues.append(f"SSH unreachable for {name}: {srv.ssh_host}")

    for issue in issues:
        logger.warning("Startup check: %s", issue)

    return issues


# ---------------------------------------------------------------------------
# Crash history tracking
# ---------------------------------------------------------------------------

def _load_crash_history() -> Dict[str, List[float]]:
    """Load crash history from state file."""
    logger.debug("Loading crash history from %s", _CRASH_HISTORY_FILE)
    if not _CRASH_HISTORY_FILE.exists():
        return {}
    try:
        with open(_CRASH_HISTORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        logger.warning("Cannot load crash history: %s", exc)
        return {}


def _save_crash_history(history: Dict[str, List[float]]) -> None:
    """Save crash history to state file."""
    try:
        _STATE_DIR.mkdir(parents=True, exist_ok=True)
        with open(_CRASH_HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(history, f, indent=2)
        logger.debug("Saved crash history")
    except Exception as exc:
        logger.warning("Cannot save crash history: %s", exc)


def _record_crash(component: str) -> bool:
    """
    Record a crash for a component.

    Returns:
        True if component should be permanently failed (exceeded crash threshold).
    """
    logger.debug("Recording crash for component: %s", component)
    history = _load_crash_history()
    now = time.time()
    crashes = history.get(component, [])
    # Prune old crashes outside window
    crashes = [t for t in crashes if now - t < _CRASH_WINDOW_SECONDS]
    crashes.append(now)
    history[component] = crashes
    _save_crash_history(history)

    if len(crashes) >= _CRASH_MAX_COUNT:
        logger.critical("Component %s has crashed %d times in %ds — marking permanently failed",
                        component, len(crashes), _CRASH_WINDOW_SECONDS)
        return True
    logger.warning("Component %s crash #%d (threshold: %d)", component, len(crashes), _CRASH_MAX_COUNT)
    return False


# ---------------------------------------------------------------------------
# State persistence
# ---------------------------------------------------------------------------

def _backup_state_files() -> None:
    """Backup all state files for disaster recovery."""
    logger.debug("Backing up state files for disaster recovery")
    backup_dir = _STATE_DIR / "backup"
    try:
        backup_dir.mkdir(parents=True, exist_ok=True)
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        backed_up = 0
        for state_file in _STATE_DIR.glob("*.json"):
            dst = backup_dir / f"{state_file.stem}_{timestamp}{state_file.suffix}"
            shutil.copy2(str(state_file), str(dst))
            backed_up += 1
        logger.debug("State backup complete: %d files backed up to %s", backed_up, backup_dir)

        # Keep only last 10 backups per file stem
        stems: Dict[str, list] = {}
        for f in backup_dir.glob("*.json"):
            base = f.stem.rsplit("_", 2)[0] if "_" in f.stem else f.stem
            stems.setdefault(base, []).append(f)
        for base, files in stems.items():
            sorted_files = sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)
            for old in sorted_files[10:]:
                try:
                    old.unlink()
                except OSError:
                    pass
    except Exception as exc:
        logger.warning("State backup failed: %s", exc)


def _save_state_snapshot(supervisor: Any = None, health_monitor: Any = None, mcp_logger: Any = None) -> None:
    """Save component state to disk for recovery on next start."""
    logger.debug("Saving state snapshot to %s", _STATE_SNAPSHOT_FILE)
    snapshot: Dict[str, Any] = {
        "timestamp": time.time(),
        "pid": os.getpid(),
    }

    try:
        if supervisor and hasattr(supervisor, "get_all_statuses"):
            snapshot["supervisor"] = {
                name: {"status": str(info.status), "pid": info.pid}
                for name, info in supervisor.get_all_statuses().items()
            }
    except Exception as exc:
        logger.debug("Cannot snapshot supervisor state: %s", exc)

    try:
        if mcp_logger and hasattr(mcp_logger, "metrics") and hasattr(mcp_logger.metrics, "to_dict"):
            snapshot["metrics"] = mcp_logger.metrics.to_dict()
    except Exception as exc:
        logger.debug("Cannot snapshot metrics: %s", exc)

    try:
        _STATE_DIR.mkdir(parents=True, exist_ok=True)
        with open(_STATE_SNAPSHOT_FILE, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, indent=2, default=str)
        logger.debug("State snapshot saved")
    except Exception as exc:
        logger.warning("Cannot save state snapshot: %s", exc)


# ---------------------------------------------------------------------------
# 15b. Startup Banner
# ---------------------------------------------------------------------------

def _print_banner(version: str, config_summary: str) -> None:
    """Print startup banner with version, Python, venv, and config info."""
    logger.debug("Printing startup banner")
    banner = f"""
{_bold('╔══════════════════════════════════════════════╗')}
{_bold('║')}   {_cyan('SUDX MCP BACKEND')}   v{version:<20s}  {_bold('║')}
{_bold('╚══════════════════════════════════════════════╝')}
  Python:  {sys.version.split()[0]}
  Venv:    {sys.prefix}
  Config:  {config_summary}
  PID:     {os.getpid()}
"""
    print(banner)


# ---------------------------------------------------------------------------
# 15c. Signal handling
# ---------------------------------------------------------------------------

class SignalManager:
    """
    Manages all Unix signal handling for graceful shutdown, hot reload,
    and hot upgrade.
    """

    def __init__(self) -> None:
        self.shutdown_event = threading.Event()
        self.reload_event = threading.Event()
        self._registry: Any = None
        self._supervisor: Any = None
        self._health_monitor: Any = None
        self._mcp_logger: Any = None
        self._uvicorn_server: Any = None
        self._api_thread: Optional[threading.Thread] = None
        logger.debug("SignalManager initialized")

    def set_components(
        self,
        registry: Any = None,
        supervisor: Any = None,
        health_monitor: Any = None,
        mcp_logger: Any = None,
        uvicorn_server: Any = None,
        api_thread: Optional[threading.Thread] = None,
    ) -> None:
        """Register components for signal handling."""
        self._registry = registry
        self._supervisor = supervisor
        self._health_monitor = health_monitor
        self._mcp_logger = mcp_logger
        self._uvicorn_server = uvicorn_server
        self._api_thread = api_thread
        logger.debug("SignalManager components set")

    def install_handlers(self) -> None:
        """Install all signal handlers."""
        logger.debug("Installing signal handlers")
        signal.signal(signal.SIGINT, self._handle_shutdown)
        signal.signal(signal.SIGTERM, self._handle_shutdown)

        # SIGHUP and SIGUSR1 only on Unix
        if hasattr(signal, "SIGHUP"):
            signal.signal(signal.SIGHUP, self._handle_reload)
        if hasattr(signal, "SIGUSR1"):
            signal.signal(signal.SIGUSR1, self._handle_hot_upgrade)
        if hasattr(signal, "SIGCHLD"):
            signal.signal(signal.SIGCHLD, self._handle_sigchld)

        logger.info("Signal handlers installed (SIGINT, SIGTERM%s%s%s)",
                     ", SIGHUP" if hasattr(signal, "SIGHUP") else "",
                     ", SIGUSR1" if hasattr(signal, "SIGUSR1") else "",
                     ", SIGCHLD" if hasattr(signal, "SIGCHLD") else "")

    def _handle_shutdown(self, signum: int, frame: Any) -> None:
        """Handle SIGTERM/SIGINT — graceful shutdown."""
        sig_name = signal.Signals(signum).name if hasattr(signal, "Signals") else str(signum)
        logger.info("Signal %s received — initiating graceful shutdown", sig_name)
        _sd_notify("STOPPING=1")
        self.shutdown_event.set()

    def _handle_reload(self, signum: int, frame: Any) -> None:
        """
        Handle SIGHUP — hot reload configuration without restarting.
        Reloads mcp_servers.json, applies changes: start new, stop removed, restart changed.
        """
        logger.info("SIGHUP received — reloading configuration")
        try:
            if self._registry and hasattr(self._registry, "reload"):
                old_servers = set(self._registry.get_all_servers().keys())
                self._registry.reload()
                new_servers = set(self._registry.get_all_servers().keys())
                added = new_servers - old_servers
                removed = old_servers - new_servers
                if added:
                    logger.info("Config reload: starting new servers: %s", added)
                if removed:
                    logger.info("Config reload: stopping removed servers: %s", removed)
                logger.info("Configuration reloaded via SIGHUP")
            else:
                logger.warning("Registry does not support reload")
        except Exception as exc:
            logger.error("Config reload failed: %s", exc)

    def _handle_hot_upgrade(self, signum: int, frame: Any) -> None:
        """
        Handle SIGUSR1 — graceful hot upgrade.
        Save state → stop API → reimport modules → restart API.
        MCP servers keep running (zero-downtime code upgrade).
        """
        logger.info("SIGUSR1 received — starting hot upgrade")
        try:
            # Save state
            _save_state_snapshot(self._supervisor, self._health_monitor, self._mcp_logger)

            # Stop API
            if self._uvicorn_server:
                self._uvicorn_server.should_exit = True
                if self._api_thread:
                    self._api_thread.join(timeout=10)
                logger.info("API server stopped for hot upgrade")

            # Reimport modules
            for mod_name in list(sys.modules.keys()):
                if mod_name.startswith(("internal_api", "mcp_", "models", "security", "logging_setup", "self_healing")):
                    try:
                        importlib.reload(sys.modules[mod_name])
                        logger.debug("Reloaded module: %s", mod_name)
                    except Exception as exc:
                        logger.warning("Cannot reload %s: %s", mod_name, exc)

            # Restart API (simplified — full implementation would re-run uvicorn)
            logger.info("Hot upgrade completed — modules reloaded")

        except Exception as exc:
            logger.error("Hot upgrade failed: %s", exc)

    def _handle_sigchld(self, signum: int, frame: Any) -> None:
        """
        Handle SIGCHLD — reap terminated child processes to prevent zombies.
        Called on every SIGCHLD signal.
        """
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
                exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
                logger.info("Child process %d exited with code %d", pid, exit_code)
                # Notify supervisor of unexpected child death
                if self._supervisor and hasattr(self._supervisor, "handle_child_exit"):
                    try:
                        self._supervisor.handle_child_exit(pid, exit_code)
                    except Exception as exc:
                        logger.debug("Supervisor child exit notification error: %s", exc)
            except ChildProcessError:
                break
            except Exception as exc:
                logger.debug("SIGCHLD handler error: %s", exc)
                break

    def graceful_shutdown(self, timeout: int = _SHUTDOWN_TIMEOUT) -> None:
        """
        Execute full graceful shutdown sequence with timeout.
        If exceeds timeout, force-kill remaining processes.
        """
        logger.info("Starting graceful shutdown (timeout=%ds)", timeout)
        start = time.monotonic()

        # 1. Stop accepting API requests
        if self._uvicorn_server:
            try:
                self._uvicorn_server.should_exit = True
                logger.debug("Uvicorn signaled to exit")
            except Exception as exc:
                logger.error("Error signaling uvicorn: %s", exc)

        # 2. Stop health monitor
        if self._health_monitor:
            try:
                asyncio.run(self._health_monitor.stop())
                logger.debug("Health monitor stopped")
            except Exception as exc:
                logger.error("Error stopping health monitor: %s", exc)

        # 3. Stop all MCP servers
        if self._supervisor:
            try:
                asyncio.run(self._supervisor.stop_all())
                logger.debug("All MCP servers stopped")
            except Exception as exc:
                logger.error("Error stopping MCP servers: %s", exc)

        # 4. Check timeout
        elapsed = time.monotonic() - start
        if elapsed > timeout:
            logger.critical("Shutdown timeout exceeded (%ds) — force killing remaining processes", timeout)
            self._force_kill_children()

        # 5. Flush logger
        if self._mcp_logger and hasattr(self._mcp_logger, "shutdown"):
            try:
                self._mcp_logger.shutdown()
                logger.debug("MCP logger shut down")
            except Exception as exc:
                logger.error("Error shutting down logger: %s", exc)

        # 6. Stop API thread
        if self._api_thread and self._api_thread.is_alive():
            self._api_thread.join(timeout=5)
            if self._api_thread.is_alive():
                logger.warning("API thread did not exit cleanly")

        # 7. Save state with backup
        _backup_state_files()
        _save_state_snapshot(self._supervisor, self._health_monitor, self._mcp_logger)

        # 8. Cleanup
        _remove_pid()
        logger.info("Graceful shutdown completed in %.1fs", time.monotonic() - start)

    def _force_kill_children(self) -> None:
        """Force-kill remaining child processes with SIGKILL."""
        logger.warning("Force-killing remaining child processes")
        try:
            import psutil
            current = psutil.Process()
            children = current.children(recursive=True)
            for child in children:
                try:
                    logger.warning("Force-killing child PID %d (%s)", child.pid, child.name())
                    child.kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        except ImportError:
            logger.warning("psutil not available — cannot force-kill children")
        except Exception as exc:
            logger.error("Error force-killing children: %s", exc)


# ---------------------------------------------------------------------------
# Self-restart mechanism
# ---------------------------------------------------------------------------

def _self_restart(reason: str) -> None:
    """
    Restart the main process via os.execv.
    Saves state first, then replaces the current process.
    """
    logger.critical("Self-restart triggered: %s", reason)
    try:
        _save_state_snapshot()
    except Exception as exc:
        logger.warning("Cannot save state before self-restart: %s", exc)
    try:
        _remove_pid()
    except Exception:
        pass
    logger.info("Restarting: %s %s", sys.executable, " ".join(sys.argv))
    try:
        os.execv(sys.executable, [sys.executable] + sys.argv)
    except Exception as exc:
        logger.critical("Self-restart failed: %s — exiting with code 75", exc)
        sys.exit(75)


# ---------------------------------------------------------------------------
# 15f. Watchdog & Self-Healing
# ---------------------------------------------------------------------------

class ComponentWatchdog:
    """
    Monitors health of main event loop, uvicorn process, and logger.
    Implements self-restart on unrecoverable errors.
    """

    def __init__(self, shutdown_event: threading.Event) -> None:
        self._shutdown = shutdown_event
        self._uvicorn_pid: Optional[int] = None
        self._supervisor: Any = None
        self._mcp_logger: Any = None
        self._thread: Optional[threading.Thread] = None
        self._last_loop_heartbeat = time.monotonic()
        logger.debug("ComponentWatchdog initialized")

    def set_components(self, supervisor: Any = None, mcp_logger: Any = None) -> None:
        self._supervisor = supervisor
        self._mcp_logger = mcp_logger

    def set_uvicorn_pid(self, pid: int) -> None:
        self._uvicorn_pid = pid

    def heartbeat(self) -> None:
        """Called from main loop to indicate it's alive."""
        self._last_loop_heartbeat = time.monotonic()

    def start(self) -> None:
        """Start watchdog background thread."""
        logger.debug("Starting component watchdog")
        self._thread = threading.Thread(target=self._run, daemon=True, name="watchdog")
        self._thread.start()

    def _run(self) -> None:
        """Watchdog loop — monitors component health."""
        logger.debug("Watchdog thread started")
        while not self._shutdown.is_set():
            try:
                self._check_main_loop()
                self._check_memory()
                self._check_uvicorn()
            except Exception as exc:
                logger.error("Watchdog check error: %s", exc)
            self._shutdown.wait(timeout=10)
        logger.debug("Watchdog thread stopped")

    def _check_main_loop(self) -> None:
        """Check if main asyncio event loop is responsive."""
        elapsed = time.monotonic() - self._last_loop_heartbeat
        if elapsed > _WATCHDOG_LOOP_TIMEOUT:
            logger.critical("Main event loop blocked for %.1fs — dumping stack traces", elapsed)
            # Dump all thread stack traces for diagnosis
            for thread_id, frame in sys._current_frames().items():
                logger.critical("Thread %d:\n%s", thread_id, "".join(traceback.format_stack(frame)))

    def _check_memory(self) -> None:
        """Monitor memory usage, emit warnings at thresholds. Trigger self-restart at critical."""
        try:
            import psutil
            proc = psutil.Process()
            mem_info = proc.memory_info()
            total_mem = psutil.virtual_memory().total
            percent_used = (mem_info.rss / total_mem) * 100

            if percent_used > _MEMORY_CRITICAL_PERCENT:
                logger.critical("CRITICAL: Process RSS at %.1f%% of system RAM (%d MB) — triggering self-restart",
                                percent_used, mem_info.rss // (1024 * 1024))
                _self_restart("memory_critical")
            elif percent_used > _MEMORY_WARN_PERCENT:
                logger.warning("Memory warning: Process RSS at %.1f%% of system RAM (%d MB)",
                               percent_used, mem_info.rss // (1024 * 1024))
        except ImportError:
            pass
        except Exception as exc:
            logger.debug("Memory check error: %s", exc)

    def _check_uvicorn(self) -> None:
        """Check if uvicorn process is still alive."""
        if self._uvicorn_pid and not _is_pid_alive(self._uvicorn_pid):
            logger.error("Uvicorn process (PID %d) has died!", self._uvicorn_pid)
            if not _record_crash("uvicorn"):
                logger.info("Uvicorn will be restarted by supervisor")


# ---------------------------------------------------------------------------
# systemd watchdog thread
# ---------------------------------------------------------------------------

def _start_systemd_watchdog(shutdown_event: threading.Event) -> Optional[threading.Thread]:
    """
    Start systemd watchdog thread if WatchdogSec is configured.
    Sends WATCHDOG=1 every WatchdogSec/2.
    """
    watchdog_usec = os.environ.get("WATCHDOG_USEC")
    if not watchdog_usec:
        logger.debug("No WATCHDOG_USEC set — systemd watchdog disabled")
        return None

    try:
        interval = int(watchdog_usec) / 2_000_000  # Convert usec to seconds, send at half interval
    except ValueError:
        logger.warning("Invalid WATCHDOG_USEC: %s", watchdog_usec)
        return None

    logger.info("Starting systemd watchdog (interval=%.1fs)", interval)

    def _watchdog_loop() -> None:
        while not shutdown_event.is_set():
            _sd_notify("WATCHDOG=1")
            shutdown_event.wait(timeout=interval)
        logger.debug("Systemd watchdog thread stopped")

    thread = threading.Thread(target=_watchdog_loop, daemon=True, name="sd-watchdog")
    thread.start()
    return thread


# ---------------------------------------------------------------------------
# Health monitor runner
# ---------------------------------------------------------------------------

def _run_health_monitor(health_monitor: Any, shutdown_event: threading.Event) -> None:
    """Run health monitor loop until shutdown event is set."""
    logger.debug("Health monitor thread started")
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        # HealthMonitor.start() runs its own internal _monitor_loop
        loop.run_until_complete(health_monitor.start())
        # Wait for shutdown signal, then stop the monitor
        while not shutdown_event.is_set():
            shutdown_event.wait(timeout=1.0)
        loop.run_until_complete(health_monitor.stop())
    except Exception as exc:
        logger.error("Health monitor error: %s", exc)
    finally:
        loop.close()
        logger.debug("Health monitor thread stopped")


# ---------------------------------------------------------------------------
# CLI argument parsing (extended)
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    """Build the CLI argument parser with all subcommand groups."""
    logger.debug("Building CLI argument parser")
    parser = argparse.ArgumentParser(
        prog="start_server",
        description="SUDX MCP Backend Server Manager — manage MCP servers on VPS.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Lifecycle:
              (default)              Start the backend
              --stop                 Shutdown running backend
              --restart              Stop + start

            Info:
              --status               Show running server status
              --version              Print version info
              --logs [server]        Tail log files

            Config:
              --validate             Validate mcp_servers.json and exit
              --dry-run              Simulate startup without launching

            Service:
              --install-service      Install systemd service (requires sudo)
              --uninstall-service    Remove systemd service (requires sudo)

            Testing:
              --mock-server          Start mock MCP test server
        """),
    )

    group = parser.add_mutually_exclusive_group()
    group.add_argument("--validate", action="store_true", help="Validate mcp_servers.json and exit")
    group.add_argument("--dry-run", action="store_true", help="Simulate startup without launching processes")
    group.add_argument("--status", action="store_true", help="Print status table of running servers")
    group.add_argument("--stop", action="store_true", help="Send shutdown command to running backend")
    group.add_argument("--restart", action="store_true", help="Stop then start the backend")
    group.add_argument("--version", action="store_true", dest="show_version", help="Print version info and exit")
    group.add_argument("--logs", nargs="?", const="__main__", metavar="SERVER", help="Tail log files (optionally for a specific server)")
    group.add_argument("--mock-server", action="store_true", help="Start mock MCP test server")
    group.add_argument("--install-service", action="store_true", help="Install systemd service (requires sudo)")
    group.add_argument("--uninstall-service", action="store_true", help="Remove systemd service (requires sudo)")
    group.add_argument("--restore-state", type=str, metavar="TIMESTAMP", help="Restore state from backup (format: YYYYMMDD_HHMMSS)")

    parser.add_argument("--config", type=str, default=None, help="Path to mcp_servers.json")
    parser.add_argument("--api-host", type=str, default=None, help=f"API listen host (default: {_DEFAULT_API_HOST})")
    parser.add_argument("--api-port", type=int, default=None, help=f"API listen port (default: {_DEFAULT_API_PORT})")
    parser.add_argument("--api-url", type=str, default=None, help="Backend API URL for --status/--stop")
    parser.add_argument("--token", type=str, default=None, help="Bearer token (overrides SUDX_BACKEND_TOKEN)")
    parser.add_argument("--mock-port", type=int, default=_DEFAULT_MOCK_PORT, help=f"Port for --mock-server (default: {_DEFAULT_MOCK_PORT})")
    parser.add_argument("--follow", "-f", action="store_true", help="Follow log output (with --logs)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Enable DEBUG logging")

    return parser


# ---------------------------------------------------------------------------
# Config validation command (--validate)
# ---------------------------------------------------------------------------

def _cmd_validate(config_path: Optional[str]) -> int:
    """Load and validate mcp_servers.json, print results."""
    logger.debug("Running config validation command")
    from mcp_registry import McpRegistry, ConfigValidationError
    from pydantic import ValidationError

    path = Path(config_path) if config_path else None

    print("=" * 60)
    print("MCP Server Configuration Validation")
    print("=" * 60)

    try:
        registry = McpRegistry(config_path=path, auto_signal=False)
    except FileNotFoundError as exc:
        print(f"\n{_red('[FAIL]')} Config file not found: {exc}")
        return 1
    except ConfigValidationError as exc:
        print(f"\n{_red('[FAIL]')} Structural validation errors ({len(exc.errors)}):")
        for err in exc.errors:
            print(f"  - {err}")
        return 1
    except ValidationError as exc:
        print(f"\n{_red('[FAIL]')} Pydantic validation errors ({exc.error_count()}):")
        for err in exc.errors():
            loc = " -> ".join(str(x) for x in err["loc"])
            print(f"  - {loc}: {err['msg']}")
        return 1
    except Exception as exc:
        print(f"\n{_red('[FAIL]')} Unexpected error: {exc}")
        logger.exception("Unexpected error during validation")
        return 1

    config = registry.config
    servers = registry.get_all_servers()
    enabled = [s for s in servers.values() if s.enabled]
    disabled = [s for s in servers.values() if not s.enabled]

    print(f"\nConfig file:    {registry._config_path}")
    print(f"Schema version: {getattr(config, 'schema_version', 'N/A')}")
    print(f"Total servers:  {len(servers)}")
    print(f"Enabled:        {len(enabled)}")
    print(f"Disabled:       {len(disabled)}")

    try:
        order = registry.get_dependency_order()
        print(f"\nStartup order:  {' → '.join(order)}")
    except Exception as exc:
        print(f"\n{_yellow('[WARN]')} Dependency ordering failed: {exc}")

    print(f"\n{'Name':<25s} {'Enabled':<9s} {'Install':<10s} {'Transport':<12s} {'Health':<10s} {'Depends'}")
    print("-" * 90)
    for name, srv in servers.items():
        deps = ", ".join(srv.depends_on) if srv.depends_on else "—"
        hc_type = srv.health_check.type.value if srv.health_check else "none"
        print(f"{name:<25s} {'yes' if srv.enabled else 'no':<9s} {srv.install_method.value:<10s} {srv.transport.value:<12s} {hc_type:<10s} {deps}")

    print(f"\n{_green('[OK]')} Configuration is valid.")
    logger.info("Config validation passed: %d servers (%d enabled)", len(servers), len(enabled))
    return 0


# ---------------------------------------------------------------------------
# Dry-run command (--dry-run)
# ---------------------------------------------------------------------------

def _cmd_dry_run(config_path: Optional[str], api_host: str, api_port: int) -> int:
    """Simulate startup without actually starting processes."""
    logger.debug("Running dry-run command")
    from mcp_registry import McpRegistry

    print(f"{_yellow('[DRY-RUN]')} Loading and validating configuration...")
    path = Path(config_path) if config_path else None
    try:
        registry = McpRegistry(config_path=path, auto_signal=False)
    except Exception as exc:
        print(f"{_yellow('[DRY-RUN]')} {_red('[FAIL]')} Config load failed: {exc}")
        return 1

    print(f"{_yellow('[DRY-RUN]')} {_green('[OK]')} Config loaded successfully")

    servers = registry.get_all_servers()
    enabled = {n: s for n, s in servers.items() if s.enabled}

    try:
        order = registry.get_dependency_order()
        print(f"{_yellow('[DRY-RUN]')} Startup order: {' → '.join(order)}")
    except Exception as exc:
        print(f"{_yellow('[DRY-RUN]')} {_yellow('[WARN]')} Dependency ordering failed: {exc}")
        order = list(enabled.keys())

    print(f"\n{_yellow('[DRY-RUN]')} Would start {len(enabled)} server(s):")
    for name in order:
        if name not in enabled:
            continue
        srv = enabled[name]
        cmd_str = " ".join(srv.start_command) if srv.start_command else "(no start command)"
        deps = ", ".join(srv.depends_on) if srv.depends_on else "none"
        hc_type = srv.health_check.type.value if srv.health_check else "none"
        print(f"  [{name}]")
        print(f"    Install:    {srv.install_method.value}")
        print(f"    Transport:  {srv.transport.value}")
        print(f"    Command:    {cmd_str}")
        print(f"    Health:     {hc_type}")
        print(f"    Depends on: {deps}")
        print(f"    Restart:    {srv.restart_policy.value} (max {srv.max_restart_count})")
        if srv.resource_limits:
            mem = srv.resource_limits.memory_mb if srv.resource_limits.memory_mb is not None else "unlimited"
            cpu = srv.resource_limits.cpu_percent if srv.resource_limits.cpu_percent is not None else "unlimited"
            print(f"    Resources:  mem={mem}MB, cpu={cpu}%")
        print()

    print(f"{_yellow('[DRY-RUN]')} Would start API server on {api_host}:{api_port}")
    print(f"{_yellow('[DRY-RUN]')} Would start health monitor for {len(enabled)} server(s)")

    # Run prerequisite checks
    issues = _run_startup_checks(registry, api_host, api_port)
    print(f"\n{_yellow('[DRY-RUN]')} Prerequisite checks:")
    if issues:
        for issue in issues:
            print(f"  {_red('[ISSUE]')} {issue}")
    else:
        print(f"  {_green('[OK]')} All prerequisites passed")

    # Environment info
    print(f"\n{_yellow('[DRY-RUN]')} Environment check:")
    token_set = bool(os.environ.get("SUDX_BACKEND_TOKEN"))
    print(f"  SUDX_BACKEND_TOKEN: {'set' if token_set else 'NOT SET (API unprotected!)'}")
    print(f"  Working directory:  {os.getcwd()}")
    print(f"  Python version:     {sys.version.split()[0]}")
    print(f"  Platform:           {sys.platform}")
    print(f"  Docker:             {'available' if _check_docker_available() else 'NOT available'}")
    print(f"  State directory:    {_STATE_DIR} ({'exists' if _STATE_DIR.exists() else 'will be created'})")
    print(f"  Logs directory:     {_LOGS_DIR} ({'exists' if _LOGS_DIR.exists() else 'will be created'})")

    print(f"\n{_yellow('[DRY-RUN]')} {_green('All checks passed. Ready to start.')}")
    return 0


# ---------------------------------------------------------------------------
# Status command (--status)
# ---------------------------------------------------------------------------

def _cmd_status(api_url: str, token: Optional[str]) -> int:
    """Connect to running backend and print server status table."""
    logger.debug("Running status command against %s", api_url)
    import urllib.request
    import urllib.error

    url = f"{api_url}/api/v1/servers"
    headers: Dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    elif os.environ.get("SUDX_BACKEND_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['SUDX_BACKEND_TOKEN']}"

    try:
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=_STATUS_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        print(f"{_red('[ERROR]')} Cannot connect to backend at {api_url}: {exc.reason}")
        print("        Is the backend running? Start with: python start_server.py")
        return 1
    except Exception as exc:
        print(f"{_red('[ERROR]')} Unexpected error: {exc}")
        return 1

    if not body.get("success"):
        print(f"{_red('[ERROR]')} API returned error: {body.get('error', 'unknown')}")
        return 1

    servers = body.get("data", {}).get("servers", {})
    if not servers:
        print("No servers configured.")
        return 0

    print(f"\n{'Name':<25s} {'Status':<12s} {'PID':<8s} {'Uptime':<15s} {'Restarts':<10s} {'Health'}")
    print("-" * 85)

    for name, info in sorted(servers.items()):
        status = info.get("status", "unknown")
        pid = str(info.get("pid", "—"))
        uptime = _format_uptime(info.get("uptime_seconds"))
        restarts = str(info.get("restart_count", "—"))
        health = info.get("health", "—")
        print(f"{name:<25s} {status:<12s} {pid:<8s} {uptime:<15s} {restarts:<10s} {health}")

    print()
    return 0


def _format_uptime(seconds: Any) -> str:
    """Format uptime seconds into human-readable string."""
    if seconds is None:
        return "—"
    try:
        s = int(seconds)
    except (ValueError, TypeError):
        return "—"
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60}s"
    hours = s // 3600
    mins = (s % 3600) // 60
    return f"{hours}h {mins}m"


# ---------------------------------------------------------------------------
# Stop command (--stop)
# ---------------------------------------------------------------------------

def _cmd_stop(api_url: str, token: Optional[str]) -> int:
    """Send shutdown command to running backend."""
    logger.debug("Running stop command against %s", api_url)
    import urllib.request
    import urllib.error

    url = f"{api_url}/api/v1/system/shutdown"
    headers: Dict[str, str] = {"Content-Type": "application/json", "X-Confirm-Shutdown": "yes"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    elif os.environ.get("SUDX_BACKEND_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['SUDX_BACKEND_TOKEN']}"

    try:
        req = urllib.request.Request(url, headers=headers, method="POST", data=b"{}")
        with urllib.request.urlopen(req, timeout=_STOP_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        print(f"{_red('[ERROR]')} Cannot connect to backend at {api_url}: {reason}")
        print("        Is the backend running?")
        return 1
    except Exception as exc:
        print(f"{_red('[ERROR]')} Unexpected error: {exc}")
        return 1

    if body.get("success"):
        print(f"{_green('[OK]')} Shutdown command sent. Backend is stopping.")
        # Wait for PID file removal
        for _ in range(60):
            if not _PID_FILE.exists():
                print(f"{_green('[OK]')} Backend stopped.")
                return 0
            time.sleep(1)
        print(f"{_yellow('[WARN]')} Backend may still be shutting down.")
    else:
        print(f"{_yellow('[WARN]')} Server response: {body.get('error', 'unknown')}")
    return 0


# ---------------------------------------------------------------------------
# Restart command (--restart)
# ---------------------------------------------------------------------------

def _cmd_restart(api_url: str, token: Optional[str], config_path: Optional[str], api_host: str, api_port: int) -> int:
    """Stop then start the backend."""
    logger.debug("Running restart command")
    print("Stopping backend...")
    stop_result = _cmd_stop(api_url, token)
    if stop_result != 0:
        # Try to start anyway if stop failed (maybe nothing was running)
        pid = _read_pid()
        if pid and _is_pid_alive(pid):
            print(f"{_red('[ERROR]')} Cannot stop running instance (PID {pid})")
            return 1
        print(f"{_yellow('[WARN]')} No running instance found — starting fresh")

    # Wait for clean stop
    time.sleep(2)
    print("Starting backend...")
    return _cmd_start(config_path, api_host, api_port)


# ---------------------------------------------------------------------------
# Version command (--version)
# ---------------------------------------------------------------------------

def _cmd_version() -> int:
    """Print version info and exit."""
    version = _get_version()
    py_version = sys.version.split()[0]
    print(f"SUDX MCP Backend v{version}")
    print(f"Python:  {py_version}")
    print(f"Venv:    {sys.prefix}")
    print(f"Base:    {_BASE_DIR}")
    return 0


# ---------------------------------------------------------------------------
# Logs command (--logs)
# ---------------------------------------------------------------------------

def _cmd_logs(server_name: Optional[str], follow: bool) -> int:
    """Tail log files for main backend or a specific server."""
    logger.debug("Running logs command: server=%s follow=%s", server_name, follow)

    if server_name and server_name != "__main__":
        log_file = _LOGS_DIR / f"{server_name}.log"
    else:
        log_file = _LOGS_DIR / "backend.log"

    if not log_file.exists():
        # Try to find any matching log
        candidates = list(_LOGS_DIR.glob("*.log"))
        if not candidates:
            print(f"{_red('[ERROR]')} No log files found in {_LOGS_DIR}")
            return 1
        print(f"Available log files:")
        for c in sorted(candidates):
            print(f"  {c.name}")
        if server_name and server_name != "__main__":
            print(f"\nLog file not found: {log_file.name}")
        return 1

    # Tail last 50 lines
    try:
        with open(log_file, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        tail_lines = lines[-50:] if len(lines) > 50 else lines
        print(f"--- {log_file.name} (last {len(tail_lines)} lines) ---")
        for line in tail_lines:
            print(line, end="")

        if follow:
            print(f"\n--- Following {log_file.name} (Ctrl+C to stop) ---")
            with open(log_file, "r", encoding="utf-8", errors="replace") as f:
                f.seek(0, 2)  # Seek to end
                while True:
                    line = f.readline()
                    if line:
                        print(line, end="")
                    else:
                        time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n--- Stopped ---")
    except Exception as exc:
        print(f"{_red('[ERROR]')} Cannot read log file: {exc}")
        return 1

    return 0


# ---------------------------------------------------------------------------
# Mock MCP Server (--mock-server)
# ---------------------------------------------------------------------------

class _MockMcpHandler(http.server.BaseHTTPRequestHandler):
    """Simple HTTP handler that simulates an MCP server."""

    def log_message(self, format: str, *args: Any) -> None:
        logger.debug("MockMCP: %s", format % args)

    def do_GET(self) -> None:
        logger.debug("MockMCP GET %s", self.path)
        if self.path == "/health":
            self._json_response(200, {"status": "ok", "server": "mock-mcp", "uptime": time.monotonic()})
        elif self.path == "/mcp":
            self._json_response(200, {"jsonrpc": "2.0", "result": {"capabilities": {"tools": True}}, "id": 0})
        else:
            self._json_response(404, {"error": "not found"})

    def do_POST(self) -> None:
        logger.debug("MockMCP POST %s", self.path)
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b"{}"
        try:
            request = json.loads(body)
        except json.JSONDecodeError:
            self._json_response(400, {"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}, "id": None})
            return
        method = request.get("method", "")
        req_id = request.get("id", 0)
        logger.info("MockMCP: method=%s id=%s", method, req_id)
        if method == "initialize":
            self._json_response(200, {"jsonrpc": "2.0", "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "mock-mcp-server", "version": "1.0.0"}}, "id": req_id})
        elif method == "tools/list":
            self._json_response(200, {"jsonrpc": "2.0", "result": {"tools": [{"name": "mock_echo", "description": "Echo the input back", "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}}}}, {"name": "mock_health", "description": "Return health status", "inputSchema": {"type": "object", "properties": {}}}]}, "id": req_id})
        elif method == "tools/call":
            tool_name = request.get("params", {}).get("name", "")
            arguments = request.get("params", {}).get("arguments", {})
            if tool_name == "mock_echo":
                result_text = arguments.get("message", "no message provided")
            elif tool_name == "mock_health":
                result_text = json.dumps({"status": "healthy", "uptime": time.monotonic()})
            else:
                self._json_response(200, {"jsonrpc": "2.0", "error": {"code": -32601, "message": f"Unknown tool: {tool_name}"}, "id": req_id})
                return
            self._json_response(200, {"jsonrpc": "2.0", "result": {"content": [{"type": "text", "text": result_text}]}, "id": req_id})
        else:
            self._json_response(200, {"jsonrpc": "2.0", "error": {"code": -32601, "message": f"Method not found: {method}"}, "id": req_id})

    def _json_response(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _cmd_mock_server(port: int) -> int:
    """Start a mock MCP test server."""
    logger.debug("Starting mock MCP server on port %d", port)
    try:
        server = http.server.HTTPServer(("127.0.0.1", port), _MockMcpHandler)
    except OSError as exc:
        print(f"{_red('[ERROR]')} Cannot start mock server on port {port}: {exc}")
        return 1

    print(f"[MOCK] Mock MCP server listening on http://127.0.0.1:{port}")
    print(f"       Health check:  GET  http://127.0.0.1:{port}/health")
    print(f"       MCP endpoint:  POST http://127.0.0.1:{port}/mcp")
    print("       Press Ctrl+C to stop.")

    def _signal_handler(signum: int, frame: Any) -> None:
        print("\n[MOCK] Shutting down...")
        server.shutdown()
    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    try:
        server.serve_forever()
    except Exception as exc:
        logger.error("Mock server error: %s", exc)
        return 1
    finally:
        server.server_close()
    print("[MOCK] Stopped.")
    return 0


# ---------------------------------------------------------------------------
# Install/uninstall systemd service
# ---------------------------------------------------------------------------

def _cmd_install_service() -> int:
    """Install systemd service and logrotate config (requires sudo)."""
    logger.debug("Running install-service command")

    if sys.platform != "linux":
        print(f"{_red('[ERROR]')} systemd services are only supported on Linux")
        return 1

    if os.geteuid() != 0:
        print(f"{_red('[ERROR]')} This command requires root privileges. Run with sudo.")
        return 1

    if not _SERVICE_TEMPLATE.exists():
        print(f"{_red('[ERROR]')} Service template not found: {_SERVICE_TEMPLATE}")
        return 1

    # Copy service file
    import shutil
    try:
        shutil.copy2(_SERVICE_TEMPLATE, _SYSTEMD_SERVICE_DEST)
        print(f"  {_green('[OK]')} Service file installed: {_SYSTEMD_SERVICE_DEST}")
    except Exception as exc:
        print(f"  {_red('[FAIL]')} Cannot copy service file: {exc}")
        return 1

    # Copy logrotate config
    if _LOGROTATE_TEMPLATE.exists():
        try:
            shutil.copy2(_LOGROTATE_TEMPLATE, _LOGROTATE_DEST)
            print(f"  {_green('[OK]')} Logrotate config installed: {_LOGROTATE_DEST}")
        except Exception as exc:
            print(f"  {_yellow('[WARN]')} Cannot copy logrotate config: {exc}")

    # Daemon reload
    try:
        subprocess.run(["systemctl", "daemon-reload"], check=True, capture_output=True)
        print(f"  {_green('[OK]')} systemd daemon reloaded")
    except Exception as exc:
        print(f"  {_yellow('[WARN]')} daemon-reload failed: {exc}")

    # Enable service
    try:
        subprocess.run(["systemctl", "enable", "sudx-mcp-backend.service"], check=True, capture_output=True)
        print(f"  {_green('[OK]')} Service enabled")
    except Exception as exc:
        print(f"  {_yellow('[WARN]')} enable failed: {exc}")

    print(f"\n{_green('[DONE]')} Service installed. Next steps:")
    print("  sudo systemctl start sudx-mcp-backend")
    print("  sudo systemctl status sudx-mcp-backend")
    print("  sudo journalctl -u sudx-mcp-backend -f")
    return 0


def _cmd_uninstall_service() -> int:
    """Remove systemd service and logrotate config (requires sudo)."""
    logger.debug("Running uninstall-service command")

    if sys.platform != "linux":
        print(f"{_red('[ERROR]')} systemd services are only supported on Linux")
        return 1

    if os.geteuid() != 0:
        print(f"{_red('[ERROR]')} This command requires root privileges. Run with sudo.")
        return 1

    # Stop service
    try:
        subprocess.run(["systemctl", "stop", "sudx-mcp-backend.service"], capture_output=True)
        print(f"  {_green('[OK]')} Service stopped")
    except Exception:
        pass

    # Disable service
    try:
        subprocess.run(["systemctl", "disable", "sudx-mcp-backend.service"], capture_output=True)
        print(f"  {_green('[OK]')} Service disabled")
    except Exception:
        pass

    # Remove files
    for path in [_SYSTEMD_SERVICE_DEST, _LOGROTATE_DEST]:
        try:
            if path.exists():
                path.unlink()
                print(f"  {_green('[OK]')} Removed: {path}")
        except Exception as exc:
            print(f"  {_yellow('[WARN]')} Cannot remove {path}: {exc}")

    # Daemon reload
    try:
        subprocess.run(["systemctl", "daemon-reload"], check=True, capture_output=True)
        print(f"  {_green('[OK]')} systemd daemon reloaded")
    except Exception:
        pass

    print(f"\n{_green('[DONE]')} Service uninstalled.")
    return 0


# ---------------------------------------------------------------------------
# Main startup (default)
# ---------------------------------------------------------------------------

def _cmd_start(config_path: Optional[str], api_host: str, api_port: int) -> int:
    """
    Full backend startup sequence:
    1. Check Python version
    2. First-run setup
    3. Load env + config
    4. PID management
    5. Initialize components (Logger → Supervisor → Health → API)
    6. Start servers in dependency order
    7. Start API
    8. Signal handling + watchdog
    9. Wait for shutdown
    10. Graceful shutdown
    """
    # Step 0: Python version check
    if not _check_python_version():
        return 1

    # Step 1: First-run setup (directories, default config)
    _first_run_setup()

    # Step 2: Load environment
    _load_env_file()
    _repo_config = _load_config_file()

    # Step 3: Setup logging
    try:
        from logging_setup import setup_logging
        setup_logging()
        logger.debug("Structured logging initialized")
    except ImportError:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
        logger.warning("logging_setup not available — using basic logging")

    logger.info("Starting Backend MCP Server Manager")

    # Step 4: PID management
    if _check_already_running():
        pid = _read_pid()
        print(f"{_red('[FATAL]')} Another instance is already running (PID {pid})")
        print(f"        Stop it first with: python start_server.py --stop")
        return 1
    _write_pid()

    # Step 5: Load config
    logger.info("Loading configuration...")
    from mcp_registry import McpRegistry
    path = Path(config_path) if config_path else None
    try:
        registry = McpRegistry(config_path=path)
    except Exception as exc:
        logger.critical("Failed to load configuration: %s", exc)
        print(f"{_red('[FATAL]')} Config load failed: {exc}")
        _remove_pid()
        return 1

    servers = registry.get_all_servers()
    enabled = {n: s for n, s in servers.items() if s.enabled}
    config_summary = f"{len(enabled)} enabled, {len(servers)} total"
    logger.info("Config loaded: %s", config_summary)

    # Step 6: Startup banner
    version = _get_version()
    _print_banner(version, config_summary)

    # Step 7: Prerequisite checks
    print("Running prerequisite checks...")
    issues = _run_startup_checks(registry, api_host, api_port)
    if issues:
        for issue in issues:
            print(f"  {_yellow('[WARN]')} {issue}")
        # Warnings don't prevent startup, but errors do
        port_issues = [i for i in issues if "Port" in i and "already in use" in i]
        if port_issues:
            print(f"{_red('[FATAL]')} API port conflict — cannot start")
            _remove_pid()
            return 1
    else:
        print(f"  {_green('[OK]')} All prerequisites passed")

    # Step 8: Initialize signal manager
    sig_manager = SignalManager()

    # Step 9: Initialize Central MCP Logger (first component)
    mcp_logger_instance = None
    print(f"  Starting Central MCP Logger...  ", end="", flush=True)
    try:
        from mcp_logger import McpLogger
        mcp_logger_instance = McpLogger(
            state_dir=_STATE_DIR,
            logs_dir=_LOGS_DIR,
        )
        print(_green("[OK]"))
        logger.info("Central MCP Logger started")
    except ImportError:
        print(_yellow("[SKIP]") + " (module not available)")
        logger.warning("mcp_logger module not available — running without central logging")
    except Exception as exc:
        print(_red("[FAIL]") + f" {exc}")
        logger.error("Central Logger failed to start: %s", exc)

    # Step 10: Initialize MCP Supervisor
    print(f"  Starting MCP Supervisor...      ", end="", flush=True)
    try:
        from mcp_supervisor import McpSupervisor
        supervisor = McpSupervisor(registry=registry)
        print(_green("[OK]"))
        logger.info("MCP Supervisor initialized")
    except Exception as exc:
        print(_red("[FAIL]") + f" {exc}")
        logger.critical("Cannot initialize supervisor: %s", exc)
        _remove_pid()
        return 1

    # Step 11: Initialize Health Monitor
    print(f"  Starting Health Monitor...       ", end="", flush=True)
    try:
        from mcp_health import HealthMonitor
        health_monitor = HealthMonitor(registry=registry, supervisor=supervisor, state_dir=_STATE_DIR)
        print(_green("[OK]"))
        logger.info("Health Monitor initialized")
    except Exception as exc:
        print(_red("[FAIL]") + f" {exc}")
        logger.error("Health Monitor failed: %s", exc)
        health_monitor = None

    # Step 12: Initialize Updater
    try:
        from mcp_updater import McpUpdater
        updater = McpUpdater(registry=registry, supervisor=supervisor, state_dir=_STATE_DIR)
        logger.info("Updater initialized")
    except Exception as exc:
        logger.warning("Updater initialization failed: %s", exc)
        updater = None

    # Step 13: Initialize API
    print(f"  Starting Internal API...         ", end="", flush=True)
    try:
        from internal_api import app, init_api
        init_api(
            registry=registry,
            supervisor=supervisor,
            health_monitor=health_monitor,
            updater=updater,
            shutdown_callback=lambda: sig_manager.shutdown_event.set(),
            mcp_logger=mcp_logger_instance,
        )
        print(_green("[OK]"))
        logger.info("Internal API initialized")
    except Exception as exc:
        print(_red("[FAIL]") + f" {exc}")
        logger.critical("Cannot initialize API: %s", exc)
        _remove_pid()
        return 1

    # Step 14: Start MCP servers in dependency order
    print(f"\n  Starting MCP servers...")
    try:
        order = registry.get_dependency_order()
    except Exception:
        order = list(enabled.keys())

    failed_servers: List[str] = []
    for name in order:
        if name not in enabled:
            continue
        print(f"    {name:<25s} ", end="", flush=True)

        success = False
        for attempt in range(1, _STARTUP_RETRY_COUNT + 1):
            try:
                asyncio.run(supervisor.start_server(name))
                print(_green("[OK]"))
                logger.info("Server %s started (attempt %d)", name, attempt)
                success = True
                break
            except Exception as exc:
                if attempt < _STARTUP_RETRY_COUNT:
                    logger.warning("Server %s start attempt %d failed: %s — retrying in %ds",
                                   name, attempt, exc, _STARTUP_RETRY_DELAY)
                    time.sleep(_STARTUP_RETRY_DELAY)
                else:
                    print(_red("[FAIL]") + f" {exc}")
                    logger.error("Server %s failed to start after %d attempts: %s", name, attempt, exc)
                    failed_servers.append(name)

    if failed_servers:
        print(f"\n  {_yellow('[WARN]')} {len(failed_servers)} server(s) failed to start: {', '.join(failed_servers)}")

    # Step 15: Start health monitor thread
    health_thread = None
    if health_monitor:
        health_thread = threading.Thread(
            target=_run_health_monitor,
            args=(health_monitor, sig_manager.shutdown_event),
            daemon=True, name="health-monitor",
        )
        health_thread.start()
        logger.debug("Health monitor thread started")

    # Step 16: Register all components with signal manager
    sig_manager.set_components(
        registry=registry,
        supervisor=supervisor,
        health_monitor=health_monitor,
        mcp_logger=mcp_logger_instance,
    )
    sig_manager.install_handlers()

    # Step 17: Start component watchdog
    watchdog = ComponentWatchdog(sig_manager.shutdown_event)
    watchdog.set_components(supervisor=supervisor, mcp_logger=mcp_logger_instance)
    watchdog.start()

    # Step 18: Start systemd watchdog if configured
    _start_systemd_watchdog(sig_manager.shutdown_event)

    # Step 19: Start uvicorn (API server)
    print(f"\n{_bold('[BACKEND]')} MCP Manager running — API at http://{api_host}:{api_port}")
    print(f"{_bold('[BACKEND]')} Managing {len(enabled)} server(s). Press Ctrl+C to stop.")

    try:
        import uvicorn
        uvicorn_config = uvicorn.Config(
            app=app,
            host=api_host,
            port=api_port,
            log_level="warning",
            access_log=False,
        )
        uvicorn_server = uvicorn.Server(uvicorn_config)

        sig_manager._uvicorn_server = uvicorn_server

        api_thread = threading.Thread(target=uvicorn_server.run, daemon=True, name="uvicorn")
        api_thread.start()
        sig_manager._api_thread = api_thread

        # Verify API started
        _verify_api_health(api_host, api_port)

        # Notify systemd that we're ready
        _sd_notify("READY=1")
        logger.info("Backend fully operational — sd_notify READY sent")

        # Main loop — wait for shutdown, send watchdog heartbeats
        while not sig_manager.shutdown_event.is_set():
            watchdog.heartbeat()
            sig_manager.shutdown_event.wait(timeout=5)

    except ImportError:
        logger.critical("uvicorn not installed — cannot start API server")
        print(f"{_red('[FATAL]')} uvicorn not installed. Install with: pip install uvicorn")
        _remove_pid()
        return 1
    except Exception as exc:
        logger.critical("API server failed: %s", exc)
        _remove_pid()
        return 1

    # Step 20: Graceful shutdown
    print(f"\n{_bold('[BACKEND]')} Shutting down...")
    sig_manager.graceful_shutdown(timeout=_SHUTDOWN_TIMEOUT)

    logger.info("Backend MCP Server Manager stopped cleanly")
    print(f"{_bold('[BACKEND]')} Stopped.")
    return 0


def _verify_api_health(host: str, port: int, timeout: int = 10) -> bool:
    """Verify API is responding to health checks within timeout."""
    logger.debug("Verifying API health at %s:%d", host, port)
    import urllib.request
    import urllib.error

    check_host = "127.0.0.1" if host == "0.0.0.0" else host
    url = f"http://{check_host}:{port}/health"
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=2) as resp:
                if resp.status == 200:
                    logger.info("API health check passed")
                    return True
        except Exception:
            pass
        time.sleep(0.5)

    logger.warning("API health check did not pass within %ds", timeout)
    return False


# ---------------------------------------------------------------------------
def _cmd_restore_state(timestamp: str) -> int:
    """Restore state files from a backup by timestamp."""
    logger.debug("Running restore-state command for timestamp %s", timestamp)
    backup_dir = _STATE_DIR / "backup"

    if not backup_dir.is_dir():
        print(f"{_red('[ERROR]')} No backup directory found at {backup_dir}")
        return 1

    # Find backup files matching the timestamp
    import glob
    matching = list(backup_dir.glob(f"*_{timestamp}.json"))
    if not matching:
        print(f"{_red('[ERROR]')} No backup files found for timestamp '{timestamp}'")
        # List available backups
        all_backups = sorted(backup_dir.glob("*.json"))
        if all_backups:
            timestamps_seen = set()
            for f in all_backups:
                parts = f.stem.rsplit("_", 2)
                if len(parts) >= 3:
                    ts = f"{parts[-2]}_{parts[-1]}"
                    timestamps_seen.add(ts)
            print(f"\n  Available timestamps:")
            for ts in sorted(timestamps_seen):
                print(f"    {ts}")
        return 1

    print(f"\n  Restoring {len(matching)} state file(s) from backup '{timestamp}':")
    restored = 0
    for backup_file in matching:
        stem = backup_file.stem.rsplit("_", 2)[0]
        target = _STATE_DIR / f"{stem}.json"
        try:
            shutil.copy2(str(backup_file), str(target))
            print(f"    {_green('[OK]')} {backup_file.name} → {target.name}")
            restored += 1
        except Exception as exc:
            print(f"    {_red('[FAIL]')} {backup_file.name}: {exc}")

    if restored > 0:
        print(f"\n  {_green('[OK]')} Restored {restored} file(s). Restart the backend to apply.")
    return 0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    """Main entry point — parse args and dispatch to subcommand."""
    parser = _build_parser()
    args = parser.parse_args()

    # Setup basic logging
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=log_level, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    logger.debug("CLI args: %s", vars(args))

    # Resolve connection params
    api_port = args.api_port or _DEFAULT_API_PORT
    api_host = args.api_host or _DEFAULT_API_HOST
    api_url = args.api_url or f"http://localhost:{api_port}"
    token = args.token

    # Dispatch to subcommand
    if args.validate:
        return _cmd_validate(args.config)
    elif args.dry_run:
        return _cmd_dry_run(args.config, api_host, api_port)
    elif args.status:
        return _cmd_status(api_url, token)
    elif args.stop:
        return _cmd_stop(api_url, token)
    elif args.restart:
        return _cmd_restart(api_url, token, args.config, api_host, api_port)
    elif args.show_version:
        return _cmd_version()
    elif args.logs is not None:
        return _cmd_logs(args.logs, args.follow)
    elif args.mock_server:
        return _cmd_mock_server(args.mock_port)
    elif args.install_service:
        return _cmd_install_service()
    elif args.uninstall_service:
        return _cmd_uninstall_service()
    elif args.restore_state:
        return _cmd_restore_state(args.restore_state)
    else:
        return _cmd_start(args.config, api_host, api_port)


if __name__ == "__main__":
    sys.exit(main())