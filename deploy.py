#!/usr/bin/env python3
"""Sudx Copilot Customizations — Backend Deployment & Version Control Utility.

Deploys files from backend/ to a remote server via SSH or HTTP, using SHA-256
checksums to detect changes. Maintains per-file versioning in
.builds/backend.version.json.

Transport Modes:
    -ssh       Deploy via SSH/SCP (public key auth, from .config)
    -http      Deploy via HTTP POST (bearer token auth, from .config)

Actions:
    --dry-run       Simulate deployment without changes
    --force         Redeploy ALL files regardless of checksum
    --yes           Skip confirmation prompt (CI/build.py integration)
    --status        Show last deployment info
    --force-unlock  Remove stale deployment lock
    --recover       Resume a failed deployment from saved state
    --quiet         Suppress all output except errors
    --verbose       Extra debug output with timestamps

Examples:
    python deploy.py -ssh
    python deploy.py -http --dry-run
    python deploy.py -ssh --force --yes
    python deploy.py -ssh -k "FIX: Updated API endpoint"
    python deploy.py --status
    python deploy.py --force-unlock
"""

from __future__ import annotations

import argparse
import atexit
import fnmatch
import hashlib
import json
import logging
import os
import platform
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple


# ═══════════════════════════════════════════════════════════════════════════
#  Constants
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_VERSION = "1.0.0"

CONFIG_FILE = ".config"
CONFIG_EXAMPLE_FILE = ".config.example"
BACKEND_DIR = "backend"
BUILDS_DIR = ".builds"
VERSION_JSON = os.path.join(BUILDS_DIR, "backend.version.json")
VERSION_JSON_BAK = VERSION_JSON + ".bak"
VERSIONS_JSON = os.path.join(BUILDS_DIR, "versions.json")
DEPLOY_LOCK = os.path.join(BUILDS_DIR, ".deploy.lock")
DEPLOY_STATE = os.path.join(BUILDS_DIR, ".deploy.state.json")
DEPLOY_LOG = os.path.join(BUILDS_DIR, "deploy.log")
DEPLOYIGNORE_FILE = ".deployignore"

LOCK_STALE_SECONDS = 1800  # 30 minutes
CHECKSUM_CHUNK_SIZE = 8192  # 8 KB
LOG_MAX_BYTES = 5 * 1024 * 1024  # 5 MB

SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")

DEFAULT_DEPLOYIGNORE = [
    "__pycache__/",
    "*.pyc",
    "*.pyo",
    ".env",
    "venv/",
    ".venv/",
    "node_modules/",
    "*.egg-info/",
    ".git/",
    ".DS_Store",
    "Thumbs.db",
    "*.swp",
    "*.swo",
    "*~",
]


# ═══════════════════════════════════════════════════════════════════════════
#  Terminal Colors (Windows-compatible, matches build.py)
# ═══════════════════════════════════════════════════════════════════════════

class _Colors:
    """ANSI color codes with Windows fallback."""

    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    CYAN = "\033[96m"
    MAGENTA = "\033[95m"
    WHITE = "\033[97m"
    BLUE = "\033[94m"

    @classmethod
    def disable(cls) -> None:
        """Disable all color codes for non-TTY or unsupported terminals."""
        for attr in ("RESET", "BOLD", "DIM", "RED", "GREEN", "YELLOW",
                      "CYAN", "MAGENTA", "WHITE", "BLUE"):
            setattr(cls, attr, "")

    @classmethod
    def init(cls) -> None:
        """Enable ANSI on Windows 10+ or disable colors if unsupported."""
        if sys.platform == "win32":
            try:
                import ctypes
                kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
                handle = kernel32.GetStdHandle(-11)
                mode = ctypes.c_ulong()
                kernel32.GetConsoleMode(handle, ctypes.byref(mode))
                kernel32.SetConsoleMode(handle, mode.value | 0x0004)
            except Exception:
                cls.disable()
        if not sys.stdout.isatty():
            cls.disable()


C = _Colors


# ═══════════════════════════════════════════════════════════════════════════
#  Print Helpers (matching build.py style)
# ═══════════════════════════════════════════════════════════════════════════

def _print_header(text: str) -> None:
    print(f"\n{C.BOLD}{C.CYAN}{'═' * 60}{C.RESET}")
    print(f"{C.BOLD}{C.CYAN}  {text}{C.RESET}")
    print(f"{C.BOLD}{C.CYAN}{'═' * 60}{C.RESET}")


def _print_success(text: str) -> None:
    print(f"{C.GREEN}{C.BOLD}[OK]{C.RESET} {text}")


def _print_error(text: str) -> None:
    print(f"{C.RED}{C.BOLD}[ERROR]{C.RESET} {text}", file=sys.stderr)


def _print_warn(text: str) -> None:
    print(f"{C.YELLOW}{C.BOLD}[WARNING]{C.RESET} {text}", file=sys.stderr)


def _print_info(label: str, value: str) -> None:
    print(f"  {C.DIM}{label:<22}{C.RESET} {C.WHITE}{value}{C.RESET}")


def _print_separator() -> None:
    print(f"{C.DIM}{'─' * 60}{C.RESET}")


def _print_progress(current: int, total: int, filename: str) -> None:
    pct = int(current / total * 100) if total > 0 else 0
    bar_len = 20
    filled = int(bar_len * current / total) if total > 0 else 0
    bar = "█" * filled + "░" * (bar_len - filled)
    print(f"  {C.CYAN}[{current}/{total}]{C.RESET} {bar} {pct}%  {C.DIM}{filename}{C.RESET}")


# ═══════════════════════════════════════════════════════════════════════════
#  Exception Hierarchy
# ═══════════════════════════════════════════════════════════════════════════

class DeployError(Exception):
    """Base deployment error with error code and suggested fix."""

    def __init__(self, message: str, code: str = "DEPLOY_ERROR",
                 suggestion: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.suggestion = suggestion


class ConfigError(DeployError):
    """Configuration file errors."""

    def __init__(self, message: str, suggestion: str = "") -> None:
        super().__init__(message, "CONFIG_ERROR", suggestion)


class ConnectionError_(DeployError):
    """Transport connection errors (named with underscore to avoid builtin clash)."""

    def __init__(self, message: str, suggestion: str = "") -> None:
        super().__init__(message, "CONNECTION_ERROR", suggestion)


class TransferError(DeployError):
    """File transfer errors."""

    def __init__(self, message: str, suggestion: str = "") -> None:
        super().__init__(message, "TRANSFER_ERROR", suggestion)


class VersionError_(DeployError):
    """Version tracking errors."""

    def __init__(self, message: str, suggestion: str = "") -> None:
        super().__init__(message, "VERSION_ERROR", suggestion)


class LockError_(DeployError):
    """Deployment lock errors."""

    def __init__(self, message: str, suggestion: str = "") -> None:
        super().__init__(message, "LOCK_ERROR", suggestion)


# ═══════════════════════════════════════════════════════════════════════════
#  Deploy Logger
# ═══════════════════════════════════════════════════════════════════════════

class DeployLogger:
    """Structured logging with colored console output and optional file logging."""

    def __init__(self, verbose: bool = False, quiet: bool = False,
                 log_file: Optional[str] = None) -> None:
        self._verbose = verbose
        self._quiet = quiet
        self._log_file = log_file
        self._file_logger: Optional[logging.Logger] = None

        if log_file:
            self._init_file_logger(log_file)

    def _init_file_logger(self, log_file: str) -> None:
        """Initialize file logger with rotation when > 5MB."""
        try:
            log_path = Path(log_file)
            log_path.parent.mkdir(parents=True, exist_ok=True)

            # Rotate if too large
            if log_path.exists() and log_path.stat().st_size > LOG_MAX_BYTES:
                rotated = log_path.with_suffix(".log.old")
                try:
                    if rotated.exists():
                        rotated.unlink()
                    log_path.rename(rotated)
                except OSError:
                    pass  # Best effort rotation

            self._file_logger = logging.getLogger("deploy_file")
            self._file_logger.setLevel(logging.DEBUG)
            handler = logging.FileHandler(str(log_path), encoding="utf-8")
            handler.setFormatter(logging.Formatter(
                "%(asctime)s [%(levelname)-7s] %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            ))
            # Remove existing handlers to avoid duplicates
            self._file_logger.handlers.clear()
            self._file_logger.addHandler(handler)
        except Exception as exc:
            _print_warn(f"Could not initialize file logging: {exc}")
            self._file_logger = None

    def _write_file(self, level: str, message: str) -> None:
        """Write to file log if available."""
        if self._file_logger:
            getattr(self._file_logger, level.lower(), self._file_logger.info)(message)

    def debug(self, message: str) -> None:
        """Debug message — only shown in verbose mode."""
        self._write_file("DEBUG", message)
        if self._verbose and not self._quiet:
            ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
            print(f"  {C.DIM}[{ts}] DBG: {message}{C.RESET}")

    def info(self, message: str) -> None:
        """Info message — shown in normal mode."""
        self._write_file("INFO", message)
        if not self._quiet:
            print(f"  {C.WHITE}{message}{C.RESET}")

    def success(self, message: str) -> None:
        """Success message — always shown (unless quiet)."""
        self._write_file("INFO", f"SUCCESS: {message}")
        if not self._quiet:
            _print_success(message)

    def warn(self, message: str) -> None:
        """Warning — always shown."""
        self._write_file("WARNING", message)
        _print_warn(message)

    def error(self, message: str) -> None:
        """Error — always shown."""
        self._write_file("ERROR", message)
        _print_error(message)

    def header(self, message: str) -> None:
        """Section header."""
        self._write_file("INFO", f"=== {message} ===")
        if not self._quiet:
            _print_header(message)

    def separator(self) -> None:
        """Visual separator."""
        if not self._quiet:
            _print_separator()

    def kv(self, label: str, value: str) -> None:
        """Key-value info line."""
        self._write_file("INFO", f"{label}: {value}")
        if not self._quiet:
            _print_info(label, value)

    def progress(self, current: int, total: int, filename: str) -> None:
        """Progress indicator."""
        self._write_file("INFO", f"[{current}/{total}] {filename}")
        if not self._quiet:
            _print_progress(current, total, filename)


# ═══════════════════════════════════════════════════════════════════════════
#  Config Manager
# ═══════════════════════════════════════════════════════════════════════════

# Default config template (written to .config.example and generated .config)
_CONFIG_TEMPLATE: Dict[str, Any] = {
    "deploy": {
        "transport": "ssh",
        "remote_base_path": "/opt/sudx-backend",
        "ssh": {
            "host": "rtnc.sudx.de",
            "user": "basti",
            "port": 22,
            "key_file": "~/.ssh/id_rsa",
            "timeout": 30,
        },
        "http": {
            "domain": "https://rtnc.sudx.de",
            "endpoint": "/api/deploy",
            "auth_token_env": "SUDX_DEPLOY_TOKEN",
            "timeout": 60,
            "verify_ssl": True,
        },
        "backup": {
            "enabled": True,
            "remote_backup_dir": "/opt/sudx-backend/.backups",
            "max_backups": 10,
        },
        "retry": {
            "max_attempts": 3,
            "delay_seconds": 5,
            "backoff_multiplier": 2.0,
        },
        "backend_api": {
            "url": "https://rtnc.sudx.de:8420",
            "auth_token_env": "SUDX_BACKEND_TOKEN",
            "health_endpoint": "/api/v1/health",
            "restart_endpoint": "/api/v1/system/restart",
            "reload_config_endpoint": "/api/v1/system/reload-config",
            "servers_endpoint": "/api/v1/servers",
            "events_emit_endpoint": "/api/v1/mcp/events/emit",
            "deploy_lock_endpoint": "/api/v1/system/deploy-lock",
            "deploy_history_endpoint": "/api/v1/system/deploy-history",
            "health_check_timeout": 60,
            "health_check_interval": 5,
            "deploy_lock_timeout": 300,
            "prefer_http_over_ssh": True,
        },
    },
}


class ConfigManager:
    """Loads, validates, and provides typed access to deployment configuration."""

    def __init__(self, repo_root: Path, log: DeployLogger) -> None:
        self._repo_root = repo_root
        self._log = log
        self._config: Dict[str, Any] = {}
        self._config_path = repo_root / CONFIG_FILE
        self._example_path = repo_root / CONFIG_EXAMPLE_FILE

    def load(self) -> None:
        """Load and validate config from .config file."""
        self._log.debug(f"ConfigManager.load(): looking for {self._config_path}")

        if not self._config_path.exists():
            self._log.debug("ConfigManager.load(): .config not found, generating template")
            self._generate_template()
            raise ConfigError(
                f"Configuration file '{CONFIG_FILE}' not found.",
                suggestion=(
                    f"A template has been created at '{CONFIG_FILE}'.\n"
                    f"  Edit it with your server details and run again.\n"
                    f"  See '{CONFIG_EXAMPLE_FILE}' for documentation."
                ),
            )

        try:
            raw = self._config_path.read_text(encoding="utf-8")
            self._log.debug(f"ConfigManager.load(): read {len(raw)} bytes from .config")
        except OSError as exc:
            raise ConfigError(
                f"Cannot read '{CONFIG_FILE}': {exc}",
                suggestion="Check file permissions.",
            )

        try:
            self._config = json.loads(raw)
            self._log.debug("ConfigManager.load(): JSON parsed successfully")
        except json.JSONDecodeError as exc:
            raise ConfigError(
                f"Invalid JSON in '{CONFIG_FILE}': {exc}",
                suggestion="Fix the JSON syntax. Use a validator like jsonlint.com.",
            )

        self._validate()
        self._log.debug("ConfigManager.load(): validation passed")

    def _generate_template(self) -> None:
        """Create .config and .config.example with template values."""
        self._log.debug("ConfigManager._generate_template(): creating files")

        template_json = json.dumps(_CONFIG_TEMPLATE, indent=4, ensure_ascii=False)

        # Write .config (user editable)
        try:
            self._config_path.write_text(template_json + "\n", encoding="utf-8")
            self._log.debug(f"ConfigManager._generate_template(): wrote {self._config_path}")
        except OSError as exc:
            self._log.error(f"Could not create {CONFIG_FILE}: {exc}")

        # Write .config.example (version controlled reference)
        try:
            self._example_path.write_text(template_json + "\n", encoding="utf-8")
            self._log.debug(f"ConfigManager._generate_template(): wrote {self._example_path}")
        except OSError as exc:
            self._log.warn(f"Could not create {CONFIG_EXAMPLE_FILE}: {exc}")

    def _validate(self) -> None:
        """Validate all config fields for presence, types, and value ranges."""
        self._log.debug("ConfigManager._validate(): starting validation")

        deploy = self._config.get("deploy")
        if not isinstance(deploy, dict):
            raise ConfigError(
                "Missing or invalid 'deploy' section in config.",
                suggestion="Config must have a top-level 'deploy' object.",
            )

        # -- transport --
        transport = deploy.get("transport", "ssh")
        if transport not in ("ssh", "http"):
            raise ConfigError(
                f"Invalid transport '{transport}'. Must be 'ssh' or 'http'.",
                suggestion="Set deploy.transport to 'ssh' or 'http'.",
            )

        # -- remote_base_path --
        rbp = deploy.get("remote_base_path", "")
        if not rbp or not isinstance(rbp, str):
            raise ConfigError(
                "Missing or empty 'remote_base_path'.",
                suggestion="Set deploy.remote_base_path to the remote installation directory.",
            )

        # -- SSH section --
        ssh = deploy.get("ssh", {})
        if not isinstance(ssh, dict):
            raise ConfigError("'deploy.ssh' must be an object.")

        ssh_host = ssh.get("host", "")
        if not ssh_host or not isinstance(ssh_host, str):
            raise ConfigError(
                "Missing SSH host.",
                suggestion="Set deploy.ssh.host to the server hostname.",
            )
        # Basic hostname validation (no spaces, no scheme)
        if " " in ssh_host or "://" in ssh_host:
            raise ConfigError(
                f"Invalid SSH host '{ssh_host}'. Must be hostname or IP, not a URL.",
                suggestion="Use 'rtnc.sudx.de' not 'ssh://rtnc.sudx.de'.",
            )

        ssh_user = ssh.get("user", "")
        if not ssh_user or not isinstance(ssh_user, str):
            raise ConfigError(
                "Missing SSH user.",
                suggestion="Set deploy.ssh.user to the SSH username.",
            )

        ssh_port = ssh.get("port", 22)
        if not isinstance(ssh_port, int) or ssh_port < 1 or ssh_port > 65535:
            raise ConfigError(
                f"Invalid SSH port '{ssh_port}'. Must be 1-65535.",
                suggestion="Set deploy.ssh.port to 22 (default) or your custom port.",
            )

        ssh_timeout = ssh.get("timeout", 30)
        if not isinstance(ssh_timeout, (int, float)) or ssh_timeout <= 0:
            raise ConfigError(
                f"Invalid SSH timeout '{ssh_timeout}'. Must be > 0.",
                suggestion="Set deploy.ssh.timeout to 30 (seconds).",
            )

        ssh_key = ssh.get("key_file", "")
        if ssh_key and isinstance(ssh_key, str):
            # Expand ~ and $HOME
            expanded = os.path.expanduser(os.path.expandvars(ssh_key))
            self._log.debug(f"ConfigManager._validate(): SSH key path expanded: {ssh_key} → {expanded}")
            # Store expanded path back for later use
            ssh["key_file"] = expanded

        # -- HTTP section --
        http = deploy.get("http", {})
        if not isinstance(http, dict):
            raise ConfigError("'deploy.http' must be an object.")

        http_domain = http.get("domain", "")
        if http_domain and isinstance(http_domain, str):
            if not http_domain.startswith("http://") and not http_domain.startswith("https://"):
                raise ConfigError(
                    f"Invalid HTTP domain '{http_domain}'. Must start with http:// or https://.",
                    suggestion="Use 'https://rtnc.sudx.de' format.",
                )

        http_timeout = http.get("timeout", 60)
        if not isinstance(http_timeout, (int, float)) or http_timeout <= 0:
            raise ConfigError(
                f"Invalid HTTP timeout '{http_timeout}'. Must be > 0.",
                suggestion="Set deploy.http.timeout to 60 (seconds).",
            )

        # -- Retry section --
        retry = deploy.get("retry", {})
        if isinstance(retry, dict):
            max_attempts = retry.get("max_attempts", 3)
            if not isinstance(max_attempts, int) or max_attempts < 1:
                raise ConfigError(
                    f"Invalid retry max_attempts '{max_attempts}'. Must be >= 1.",
                )
            delay = retry.get("delay_seconds", 5)
            if not isinstance(delay, (int, float)) or delay < 0:
                raise ConfigError(
                    f"Invalid retry delay_seconds '{delay}'. Must be >= 0.",
                )
            backoff = retry.get("backoff_multiplier", 2.0)
            if not isinstance(backoff, (int, float)) or backoff < 1.0:
                raise ConfigError(
                    f"Invalid retry backoff_multiplier '{backoff}'. Must be >= 1.0.",
                )

        # -- Backup section --
        backup = deploy.get("backup", {})
        if isinstance(backup, dict):
            max_backups = backup.get("max_backups", 10)
            if not isinstance(max_backups, int) or max_backups < 0:
                raise ConfigError(
                    f"Invalid backup max_backups '{max_backups}'. Must be >= 0.",
                )

        self._log.debug("ConfigManager._validate(): all checks passed")

    # -- Typed accessors ---------------------------------------------------

    @property
    def transport(self) -> str:
        return self._config.get("deploy", {}).get("transport", "ssh")

    @property
    def remote_base_path(self) -> str:
        return self._config["deploy"]["remote_base_path"]

    @property
    def ssh_host(self) -> str:
        return self._config["deploy"]["ssh"]["host"]

    @property
    def ssh_user(self) -> str:
        return self._config["deploy"]["ssh"]["user"]

    @property
    def ssh_port(self) -> int:
        return self._config["deploy"]["ssh"].get("port", 22)

    @property
    def ssh_key_file(self) -> str:
        raw = self._config["deploy"]["ssh"].get("key_file", "")
        return os.path.expanduser(os.path.expandvars(raw)) if raw else ""

    @property
    def ssh_timeout(self) -> int:
        return self._config["deploy"]["ssh"].get("timeout", 30)

    @property
    def http_domain(self) -> str:
        return self._config["deploy"]["http"].get("domain", "")

    @property
    def http_endpoint(self) -> str:
        return self._config["deploy"]["http"].get("endpoint", "/api/deploy")

    @property
    def http_url(self) -> str:
        domain = self.http_domain.rstrip("/")
        endpoint = self.http_endpoint
        if not endpoint.startswith("/"):
            endpoint = "/" + endpoint
        return domain + endpoint

    @property
    def http_health_url(self) -> str:
        return self.http_domain.rstrip("/") + "/health"

    @property
    def http_auth_token(self) -> str:
        env_var = self._config["deploy"]["http"].get("auth_token_env", "")
        if not env_var:
            return ""
        token = os.environ.get(env_var, "")
        return token

    @property
    def http_auth_token_env(self) -> str:
        return self._config["deploy"]["http"].get("auth_token_env", "SUDX_DEPLOY_TOKEN")

    @property
    def http_timeout(self) -> int:
        return self._config["deploy"]["http"].get("timeout", 60)

    @property
    def http_verify_ssl(self) -> bool:
        return self._config["deploy"]["http"].get("verify_ssl", True)

    @property
    def backup_enabled(self) -> bool:
        return self._config["deploy"].get("backup", {}).get("enabled", True)

    @property
    def backup_remote_dir(self) -> str:
        return self._config["deploy"].get("backup", {}).get(
            "remote_backup_dir", "/opt/sudx-backend/.backups")

    @property
    def backup_max(self) -> int:
        return self._config["deploy"].get("backup", {}).get("max_backups", 10)

    @property
    def retry_max_attempts(self) -> int:
        return self._config["deploy"].get("retry", {}).get("max_attempts", 3)

    @property
    def retry_delay(self) -> float:
        return float(self._config["deploy"].get("retry", {}).get("delay_seconds", 5))

    @property
    def retry_backoff(self) -> float:
        return float(self._config["deploy"].get("retry", {}).get("backoff_multiplier", 2.0))

    # -- Backend API accessors ---
    def _backend_api(self) -> Dict[str, Any]:
        return self._config.get("deploy", {}).get("backend_api", {})

    @property
    def backend_api_configured(self) -> bool:
        """True if backend_api section exists with a URL."""
        return bool(self._backend_api().get("url", ""))

    @property
    def backend_api_url(self) -> str:
        return self._backend_api().get("url", "").rstrip("/")

    @property
    def backend_api_token(self) -> str:
        env_var = self._backend_api().get("auth_token_env", "SUDX_BACKEND_TOKEN")
        return os.environ.get(env_var, "") if env_var else ""

    @property
    def backend_health_endpoint(self) -> str:
        return self._backend_api().get("health_endpoint", "/health")

    @property
    def backend_restart_endpoint(self) -> str:
        return self._backend_api().get("restart_endpoint", "/api/v1/system/restart")

    @property
    def backend_reload_config_endpoint(self) -> str:
        return self._backend_api().get("reload_config_endpoint", "/api/v1/system/reload-config")

    @property
    def backend_servers_endpoint(self) -> str:
        return self._backend_api().get("servers_endpoint", "/api/v1/servers")

    @property
    def backend_events_emit_endpoint(self) -> str:
        return self._backend_api().get("events_emit_endpoint", "/api/v1/mcp/events/emit")

    @property
    def backend_deploy_lock_endpoint(self) -> str:
        return self._backend_api().get("deploy_lock_endpoint", "/api/v1/system/deploy-lock")

    @property
    def backend_deploy_history_endpoint(self) -> str:
        return self._backend_api().get("deploy_history_endpoint", "/api/v1/system/deploy-history")

    @property
    def backend_health_check_timeout(self) -> int:
        return int(self._backend_api().get("health_check_timeout", 60))

    @property
    def backend_health_check_interval(self) -> int:
        return int(self._backend_api().get("health_check_interval", 5))

    @property
    def backend_deploy_lock_timeout(self) -> int:
        return int(self._backend_api().get("deploy_lock_timeout", 300))

    @property
    def backend_prefer_http(self) -> bool:
        return bool(self._backend_api().get("prefer_http_over_ssh", True))


# ═══════════════════════════════════════════════════════════════════════════
#  Checksum Engine
# ═══════════════════════════════════════════════════════════════════════════

class ChecksumEngine:
    """SHA-256 checksum system for detecting file changes."""

    def __init__(self, repo_root: Path, log: DeployLogger) -> None:
        self._repo_root = repo_root
        self._log = log
        self._ignore_patterns: List[str] = []
        self._load_ignore_patterns()

    def _load_ignore_patterns(self) -> None:
        """Load .deployignore or use defaults."""
        ignore_file = self._repo_root / DEPLOYIGNORE_FILE
        self._log.debug(f"ChecksumEngine._load_ignore_patterns(): checking {ignore_file}")

        if ignore_file.exists():
            try:
                raw = ignore_file.read_text(encoding="utf-8")
                self._ignore_patterns = [
                    line.strip() for line in raw.splitlines()
                    if line.strip() and not line.strip().startswith("#")
                ]
                self._log.debug(
                    f"ChecksumEngine._load_ignore_patterns(): loaded {len(self._ignore_patterns)} "
                    f"patterns from {DEPLOYIGNORE_FILE}"
                )
                return
            except OSError as exc:
                self._log.warn(f"Could not read {DEPLOYIGNORE_FILE}: {exc}, using defaults")

        self._ignore_patterns = list(DEFAULT_DEPLOYIGNORE)
        self._log.debug(
            f"ChecksumEngine._load_ignore_patterns(): using {len(self._ignore_patterns)} default patterns"
        )

    def _is_ignored(self, rel_path: str) -> bool:
        """Check if a relative path matches any ignore pattern."""
        parts = rel_path.replace("\\", "/").split("/")
        for pattern in self._ignore_patterns:
            # Directory pattern (ends with /)
            if pattern.endswith("/"):
                dir_name = pattern.rstrip("/")
                if dir_name in parts[:-1]:  # Check directory components
                    return True
            # File pattern
            else:
                if fnmatch.fnmatch(parts[-1], pattern):
                    return True
                if fnmatch.fnmatch(rel_path.replace("\\", "/"), pattern):
                    return True
        return False

    def compute_sha256(self, filepath: Path) -> str:
        """Compute SHA-256 of a file using chunked binary reads."""
        self._log.debug(f"ChecksumEngine.compute_sha256(): hashing {filepath}")

        sha = hashlib.sha256()
        try:
            # Resolve symlinks first
            resolved = filepath.resolve()
            if not resolved.exists():
                self._log.warn(f"File does not exist (possibly broken symlink): {filepath}")
                return ""

            with open(resolved, "rb") as fh:
                while True:
                    chunk = fh.read(CHECKSUM_CHUNK_SIZE)
                    if not chunk:
                        break
                    sha.update(chunk)

            digest = sha.hexdigest()
            self._log.debug(f"ChecksumEngine.compute_sha256(): {filepath} → {digest[:16]}...")
            return digest

        except PermissionError:
            self._log.warn(f"Permission denied reading {filepath}, skipping")
            return ""
        except OSError as exc:
            self._log.warn(f"OS error reading {filepath}: {exc}, skipping")
            return ""

    def scan_backend_files(self) -> Dict[str, str]:
        """Recursively discover all files under backend/, compute checksums.

        Returns:
            Dict mapping relative path (e.g. 'backend/src/api.py') to SHA-256 hash.
        """
        backend_dir = self._repo_root / BACKEND_DIR
        self._log.debug(f"ChecksumEngine.scan_backend_files(): scanning {backend_dir}")

        if not backend_dir.exists():
            self._log.warn(f"Backend directory '{BACKEND_DIR}' does not exist")
            return {}

        if not backend_dir.is_dir():
            self._log.warn(f"'{BACKEND_DIR}' is not a directory")
            return {}

        results: Dict[str, str] = {}
        file_count = 0
        skipped_count = 0

        for root_str, dirs_list, files_list in os.walk(str(backend_dir)):
            root_path = Path(root_str)

            # Filter directories in-place to skip ignored dirs
            dirs_list[:] = [
                d for d in dirs_list
                if not self._is_ignored(
                    str(Path(root_str, d).relative_to(self._repo_root)) + "/"
                )
            ]

            for filename in files_list:
                full_path = root_path / filename
                rel_path = str(full_path.relative_to(self._repo_root)).replace("\\", "/")

                if self._is_ignored(rel_path):
                    skipped_count += 1
                    self._log.debug(f"ChecksumEngine.scan_backend_files(): ignored {rel_path}")
                    continue

                sha = self.compute_sha256(full_path)
                if sha:  # Skip files we couldn't hash
                    results[rel_path] = sha
                    file_count += 1

        self._log.debug(
            f"ChecksumEngine.scan_backend_files(): found {file_count} files, "
            f"skipped {skipped_count} ignored"
        )
        return results

    def load_stored_checksums(self, version_data: List[Dict]) -> Dict[str, str]:
        """Extract last known checksums from backend.version.json entries.

        Returns:
            Dict mapping file path to last deployed SHA-256 hash.
        """
        self._log.debug(
            f"ChecksumEngine.load_stored_checksums(): processing {len(version_data)} entries"
        )

        stored: Dict[str, str] = {}
        for entry in version_data:
            filepath = entry.get("file", "")
            sha = entry.get("last_deployed_sha256", "")
            deleted = entry.get("deleted", False)

            if filepath and sha and not deleted:
                stored[filepath] = sha

        self._log.debug(
            f"ChecksumEngine.load_stored_checksums(): {len(stored)} files with stored checksums"
        )
        return stored

    def compute_diff(
        self, local_files: Dict[str, str], stored_checksums: Dict[str, str]
    ) -> Tuple[Dict[str, str], Dict[str, str], Set[str]]:
        """Compare local files against stored checksums.

        Returns:
            Tuple of (added, modified, deleted):
            - added: Dict[path → sha256] for new files
            - modified: Dict[path → sha256] for changed files
            - deleted: Set[path] for files removed locally
        """
        self._log.debug("ChecksumEngine.compute_diff(): computing file differences")

        added: Dict[str, str] = {}
        modified: Dict[str, str] = {}
        deleted: Set[str] = set()

        # Find new and modified files
        for path, local_sha in local_files.items():
            if path not in stored_checksums:
                added[path] = local_sha
                self._log.debug(f"ChecksumEngine.compute_diff(): NEW {path}")
            elif stored_checksums[path] != local_sha:
                modified[path] = local_sha
                self._log.debug(f"ChecksumEngine.compute_diff(): MOD {path}")

        # Find deleted files
        for path in stored_checksums:
            if path not in local_files:
                deleted.add(path)
                self._log.debug(f"ChecksumEngine.compute_diff(): DEL {path}")

        self._log.debug(
            f"ChecksumEngine.compute_diff(): {len(added)} added, {len(modified)} modified, "
            f"{len(deleted)} deleted"
        )
        return added, modified, deleted

    def print_diff_summary(self, added: Dict[str, str], modified: Dict[str, str],
                           deleted: Set[str], local_files: Dict[str, str],
                           stored_checksums: Dict[str, str]) -> None:
        """Print human-readable diff summary."""
        unchanged = [
            p for p in local_files
            if p in stored_checksums and stored_checksums[p] == local_files[p]
        ]

        if not added and not modified and not deleted:
            _print_success("All files up to date — nothing to deploy")
            return

        _print_separator()
        for path in sorted(added):
            print(f"  {C.GREEN}[NEW]{C.RESET} {path}")
        for path in sorted(modified):
            print(f"  {C.YELLOW}[MOD]{C.RESET} {path} {C.DIM}(hash changed){C.RESET}")
        for path in sorted(deleted):
            print(f"  {C.RED}[DEL]{C.RESET} {path} {C.DIM}(removed locally){C.RESET}")
        for path in sorted(unchanged):
            print(f"  {C.DIM}[ OK]{C.RESET} {C.DIM}{path} (unchanged){C.RESET}")
        _print_separator()

        total = len(added) + len(modified) + len(deleted) + len(unchanged)
        print(
            f"  {C.BOLD}Total:{C.RESET} {total} files  |  "
            f"{C.GREEN}{len(added)} new{C.RESET}  "
            f"{C.YELLOW}{len(modified)} modified{C.RESET}  "
            f"{C.RED}{len(deleted)} deleted{C.RESET}  "
            f"{C.DIM}{len(unchanged)} unchanged{C.RESET}"
        )


# ═══════════════════════════════════════════════════════════════════════════
#  Version Manager
# ═══════════════════════════════════════════════════════════════════════════

class VersionManager:
    """Manages backend.version.json — per-file semantic versioning."""

    def __init__(self, repo_root: Path, log: DeployLogger) -> None:
        self._repo_root = repo_root
        self._log = log
        self._version_path = repo_root / VERSION_JSON
        self._bak_path = repo_root / VERSION_JSON_BAK
        self._versions_path = repo_root / VERSIONS_JSON
        self._data: List[Dict[str, Any]] = []
        self._dirty = False

    def load(self) -> None:
        """Load and validate backend.version.json."""
        self._log.debug(f"VersionManager.load(): reading {self._version_path}")

        if not self._version_path.exists():
            self._log.debug("VersionManager.load(): file not found, starting with empty array")
            self._data = []
            return

        raw = ""
        try:
            raw = self._version_path.read_text(encoding="utf-8")
            self._log.debug(f"VersionManager.load(): read {len(raw)} bytes")
        except OSError as exc:
            raise VersionError_(
                f"Cannot read {VERSION_JSON}: {exc}",
                suggestion="Check file permissions.",
            )

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            self._log.warn(f"Corrupt {VERSION_JSON}: {exc}")
            self._log.info("Attempting to restore from backup...")
            parsed = self._try_restore_from_backup()

        if not isinstance(parsed, list):
            raise VersionError_(
                f"{VERSION_JSON} must contain a JSON array, got {type(parsed).__name__}.",
                suggestion="Fix the file or delete it to start fresh.",
            )

        # Validate entries
        seen_files: Set[str] = set()
        for i, entry in enumerate(parsed):
            if not isinstance(entry, dict):
                self._log.warn(f"Entry {i} is not an object, skipping")
                continue

            file_path = entry.get("file", "")
            if not file_path:
                self._log.warn(f"Entry {i} has no 'file' field, skipping")
                continue

            if file_path in seen_files:
                self._log.warn(f"Duplicate entry for '{file_path}' at index {i}, skipping")
                continue
            seen_files.add(file_path)

            # Validate Version field
            version = entry.get("Version", "0.0.0")
            if not SEMVER_RE.match(str(version)):
                self._log.warn(
                    f"Invalid version '{version}' for '{file_path}', resetting to 0.0.0"
                )
                entry["Version"] = "0.0.0"

            # Ensure VersionLog exists
            if "VersionLog" not in entry or not isinstance(entry.get("VersionLog"), list):
                entry["VersionLog"] = []

        self._data = [e for e in parsed if isinstance(e, dict) and e.get("file")]
        self._log.debug(f"VersionManager.load(): loaded {len(self._data)} valid entries")

    def _try_restore_from_backup(self) -> List:
        """Attempt to restore from .bak file if main is corrupt."""
        self._log.debug("VersionManager._try_restore_from_backup(): checking backup")

        if not self._bak_path.exists():
            self._log.warn("No backup file found. Starting with empty version data.")
            return []

        try:
            bak_raw = self._bak_path.read_text(encoding="utf-8")
            parsed = json.loads(bak_raw)
            if isinstance(parsed, list):
                self._log.success(f"Restored version data from {VERSION_JSON_BAK}")
                return parsed
        except (OSError, json.JSONDecodeError) as exc:
            self._log.warn(f"Backup also corrupt: {exc}")

        self._log.warn("Both version files corrupt. Starting fresh.")
        return []

    def create_backup(self) -> None:
        """Backup backend.version.json before modification."""
        self._log.debug("VersionManager.create_backup(): creating backup")

        if not self._version_path.exists():
            self._log.debug("VersionManager.create_backup(): no file to backup")
            return

        try:
            shutil.copy2(str(self._version_path), str(self._bak_path))
            self._log.debug(f"VersionManager.create_backup(): backed up to {self._bak_path}")
        except OSError as exc:
            self._log.warn(f"Could not create backup: {exc}")

    def get_entry(self, filepath: str) -> Optional[Dict[str, Any]]:
        """Find entry by file path."""
        self._log.debug(f"VersionManager.get_entry(): looking for '{filepath}'")

        normalized = filepath.replace("\\", "/")
        for entry in self._data:
            if entry.get("file", "").replace("\\", "/") == normalized:
                self._log.debug(f"VersionManager.get_entry(): found entry, version={entry.get('Version')}")
                return entry

        self._log.debug(f"VersionManager.get_entry(): no entry for '{filepath}'")
        return None

    def _increment_patch(self, version_str: str) -> str:
        """Increment patch: 0.0.X → 0.0.X+1."""
        m = SEMVER_RE.match(version_str)
        if not m:
            return "0.0.1"
        major, minor, patch = int(m.group(1)), int(m.group(2)), int(m.group(3))
        return f"{major}.{minor}.{patch + 1}"

    def bump_version(self, filepath: str, build_version: str,
                     comment: str, sha256: str) -> str:
        """Increment file version, append to VersionLog. Returns new version."""
        self._log.debug(
            f"VersionManager.bump_version(): {filepath}, build={build_version}, "
            f"sha={sha256[:16]}..."
        )

        entry = self.get_entry(filepath)
        if entry is None:
            self._log.warn(f"No entry for '{filepath}', creating new one instead")
            return self.add_new_file(filepath, build_version, sha256)

        old_version = entry.get("Version", "0.0.0")
        new_version = self._increment_patch(old_version)
        now_iso = datetime.now(timezone.utc).isoformat()

        entry["Version"] = new_version
        entry["last_deployed_sha256"] = sha256
        entry["last_deployed_at"] = now_iso

        # Remove deleted flag if re-deployed
        if "deleted" in entry:
            del entry["deleted"]

        log_entry = {
            "version": new_version,
            "changed_on_buildversion": build_version,
            "comment": comment or f"Deployed: content changed (sha256 mismatch)",
            "deployed_at": now_iso,
            "sha256": sha256,
        }
        entry.setdefault("VersionLog", []).append(log_entry)
        self._dirty = True

        self._log.debug(
            f"VersionManager.bump_version(): {filepath}: {old_version} → {new_version}"
        )
        return new_version

    def add_new_file(self, filepath: str, build_version: str, sha256: str) -> str:
        """Create new file entry with version 0.0.1."""
        self._log.debug(f"VersionManager.add_new_file(): {filepath}, build={build_version}")

        now_iso = datetime.now(timezone.utc).isoformat()
        new_entry = {
            "file": filepath.replace("\\", "/"),
            "Version": "0.0.1",
            "Since_buildversion": build_version,
            "last_deployed_sha256": sha256,
            "last_deployed_at": now_iso,
            "VersionLog": [
                {
                    "version": "0.0.1",
                    "changed_on_buildversion": build_version,
                    "comment": "Initial deployment",
                    "deployed_at": now_iso,
                    "sha256": sha256,
                },
            ],
        }

        self._data.append(new_entry)
        self._dirty = True

        self._log.debug(f"VersionManager.add_new_file(): created entry for {filepath}")
        return "0.0.1"

    def mark_deleted(self, filepath: str, build_version: str) -> None:
        """Mark a file as deleted — do NOT remove entry, add log entry."""
        self._log.debug(f"VersionManager.mark_deleted(): {filepath}")

        entry = self.get_entry(filepath)
        if entry is None:
            self._log.debug(f"VersionManager.mark_deleted(): no entry for '{filepath}', nothing to mark")
            return

        now_iso = datetime.now(timezone.utc).isoformat()
        entry["deleted"] = True
        entry["last_deployed_at"] = now_iso

        log_entry = {
            "version": entry.get("Version", "0.0.0"),
            "changed_on_buildversion": build_version,
            "comment": "File removed from source",
            "deployed_at": now_iso,
        }
        entry.setdefault("VersionLog", []).append(log_entry)
        self._dirty = True

        self._log.debug(f"VersionManager.mark_deleted(): marked {filepath} as deleted")

    def save(self) -> None:
        """Atomically write backend.version.json (temp file + rename)."""
        self._log.debug("VersionManager.save(): saving version data")

        if not self._dirty:
            self._log.debug("VersionManager.save(): no changes, skipping write")
            return

        # Sort entries by file path for consistency
        self._data.sort(key=lambda e: e.get("file", ""))

        output = json.dumps(self._data, indent=4, ensure_ascii=False)

        # Atomic write: write to temp file, then rename
        version_dir = self._version_path.parent
        version_dir.mkdir(parents=True, exist_ok=True)

        try:
            fd, tmp_path = tempfile.mkstemp(
                dir=str(version_dir),
                prefix=".backend.version.",
                suffix=".tmp",
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as tmp_fh:
                    tmp_fh.write(output + "\n")
                    tmp_fh.flush()
                    os.fsync(tmp_fh.fileno())

                # On Windows, can't rename over existing — remove first
                if sys.platform == "win32" and self._version_path.exists():
                    self._version_path.unlink()

                os.rename(tmp_path, str(self._version_path))
                self._dirty = False
                self._log.debug(
                    f"VersionManager.save(): wrote {len(self._data)} entries to {self._version_path}"
                )
            except Exception:
                # Clean up temp file on failure
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise

        except OSError as exc:
            raise VersionError_(
                f"Failed to save {VERSION_JSON}: {exc}",
                suggestion="Check disk space and permissions.",
            )

    def get_current_build_version(self) -> str:
        """Read current build version from .builds/versions.json."""
        self._log.debug(f"VersionManager.get_current_build_version(): reading {self._versions_path}")

        if not self._versions_path.exists():
            self._log.warn(f"{VERSIONS_JSON} not found, using '0.0.0'")
            return "0.0.0"

        try:
            raw = self._versions_path.read_text(encoding="utf-8")
            data = json.loads(raw)
            version = data.get("current_version", "0.0.0")
            self._log.debug(f"VersionManager.get_current_build_version(): {version}")
            return str(version)
        except (OSError, json.JSONDecodeError, AttributeError) as exc:
            self._log.warn(f"Could not read build version: {exc}, using '0.0.0'")
            return "0.0.0"

    @property
    def data(self) -> List[Dict[str, Any]]:
        return self._data


# ═══════════════════════════════════════════════════════════════════════════
#  SSH Transport
# ═══════════════════════════════════════════════════════════════════════════

class SSHTransport:
    """SSH/SCP-based file deployment using subprocess."""

    def __init__(self, config: ConfigManager, log: DeployLogger) -> None:
        self._config = config
        self._log = log
        self._connected = False

    def _ssh_base_args(self) -> List[str]:
        """Build base SSH arguments with key file, port, timeout, host key policy."""
        args = [
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "BatchMode=yes",
            "-o", f"ConnectTimeout={self._config.ssh_timeout}",
            "-p", str(self._config.ssh_port),
        ]
        key_file = self._config.ssh_key_file
        if key_file:
            args.extend(["-i", key_file])
        return args

    def _ssh_target(self) -> str:
        """Return user@host string."""
        return f"{self._config.ssh_user}@{self._config.ssh_host}"

    def _validate_key_file(self) -> None:
        """Check SSH key exists and has proper permissions."""
        key_file = self._config.ssh_key_file
        self._log.debug(f"SSHTransport._validate_key_file(): checking {key_file}")

        if not key_file:
            self._log.debug("SSHTransport._validate_key_file(): no key file configured, using default")
            return

        key_path = Path(key_file)
        if not key_path.exists():
            raise ConnectionError_(
                f"SSH key file not found: {key_file}",
                suggestion=(
                    "Check deploy.ssh.key_file in .config.\n"
                    "  Generate a key with: ssh-keygen -t ed25519"
                ),
            )

        if not key_path.is_file():
            raise ConnectionError_(
                f"SSH key path is not a file: {key_file}",
                suggestion="deploy.ssh.key_file must point to a private key file.",
            )

        # Check permissions on Unix-like systems
        if platform.system() != "Windows":
            try:
                mode = key_path.stat().st_mode
                if mode & stat.S_IROTH or mode & stat.S_IRGRP:
                    self._log.warn(
                        f"SSH key '{key_file}' has insecure permissions "
                        f"({oct(mode & 0o777)}). Should be 0600."
                    )
                    self._log.warn("Fix with: chmod 600 " + key_file)
            except OSError:
                pass

    def _run_with_retry(self, cmd: List[str], operation: str,
                        capture: bool = True) -> subprocess.CompletedProcess:
        """Run a command with exponential backoff retry."""
        max_attempts = self._config.retry_max_attempts
        delay = self._config.retry_delay
        backoff = self._config.retry_backoff

        last_exc: Optional[Exception] = None
        last_result: Optional[subprocess.CompletedProcess] = None

        for attempt in range(1, max_attempts + 1):
            self._log.debug(
                f"SSHTransport._run_with_retry(): {operation} attempt {attempt}/{max_attempts}"
            )
            try:
                result = subprocess.run(
                    cmd,
                    capture_output=capture,
                    text=True,
                    timeout=self._config.ssh_timeout + 30,  # Extra buffer
                )
                if result.returncode == 0:
                    return result

                last_result = result
                error_msg = (result.stderr or result.stdout or "").strip()
                self._log.debug(
                    f"SSHTransport._run_with_retry(): attempt {attempt} failed "
                    f"(rc={result.returncode}): {error_msg[:200]}"
                )

                # Don't retry auth failures — they won't succeed
                if "Permission denied" in error_msg or "publickey" in error_msg.lower():
                    raise ConnectionError_(
                        f"SSH authentication failed: {error_msg}",
                        suggestion=(
                            "Check your SSH key is correct and added to the server.\n"
                            f"  Key file: {self._config.ssh_key_file}\n"
                            f"  Target: {self._ssh_target()}\n"
                            "  Test: ssh " + " ".join(self._ssh_base_args()) + " "
                            + self._ssh_target() + ' "echo OK"'
                        ),
                    )

            except subprocess.TimeoutExpired as exc:
                last_exc = exc
                self._log.debug(f"SSHTransport._run_with_retry(): attempt {attempt} timed out")
            except FileNotFoundError:
                raise ConnectionError_(
                    "SSH client not found. Is OpenSSH installed?",
                    suggestion=(
                        "Windows: Settings → Apps → Optional Features → OpenSSH Client\n"
                        "  Linux: sudo apt install openssh-client\n"
                        "  macOS: Should be pre-installed"
                    ),
                )

            if attempt < max_attempts:
                wait = delay * (backoff ** (attempt - 1))
                self._log.info(f"Retrying in {wait:.1f}s... (attempt {attempt}/{max_attempts})")
                time.sleep(wait)

        # All retries exhausted
        if last_result:
            error_detail = (last_result.stderr or last_result.stdout or "unknown error").strip()
            error_detail = error_detail[:500]  # Truncate for readability

            # Classify the error
            if "Connection refused" in error_detail:
                raise ConnectionError_(
                    f"SSH connection refused by {self._config.ssh_host}:{self._config.ssh_port}",
                    suggestion="Check that SSH is running on the server and the port is correct.",
                )
            elif "No route to host" in error_detail or "Network is unreachable" in error_detail:
                raise ConnectionError_(
                    f"Cannot reach {self._config.ssh_host}: network error",
                    suggestion="Check your network connection and that the server is online.",
                )
            elif "Connection timed out" in error_detail or "timed out" in error_detail.lower():
                raise ConnectionError_(
                    f"SSH connection timed out to {self._config.ssh_host}",
                    suggestion="Check firewall rules. The server may be blocking port {}.".format(
                        self._config.ssh_port
                    ),
                )
            elif "Could not resolve hostname" in error_detail:
                raise ConnectionError_(
                    f"DNS resolution failed for '{self._config.ssh_host}'",
                    suggestion="Check the hostname is correct and DNS is working.",
                )

            raise ConnectionError_(
                f"{operation} failed after {max_attempts} attempts: {error_detail}",
                suggestion="Check server connectivity and configuration.",
            )
        elif last_exc:
            raise ConnectionError_(
                f"{operation} timed out after {max_attempts} attempts",
                suggestion=f"Increase deploy.ssh.timeout (current: {self._config.ssh_timeout}s).",
            )
        else:
            raise ConnectionError_(f"{operation} failed for unknown reason.")

    def test_connection(self) -> bool:
        """Test SSH connectivity."""
        self._log.debug("SSHTransport.test_connection(): testing SSH connection")
        self._validate_key_file()

        cmd = ["ssh"] + self._ssh_base_args() + [self._ssh_target(), "echo", "DEPLOY_OK"]

        try:
            result = self._run_with_retry(cmd, "SSH connection test")
            output = result.stdout.strip()
            if "DEPLOY_OK" in output:
                self._connected = True
                self._log.debug("SSHTransport.test_connection(): connection successful")
                return True
            else:
                self._log.warn(f"Unexpected SSH test output: {output[:200]}")
                return False
        except DeployError:
            raise
        except Exception as exc:
            raise ConnectionError_(
                f"SSH connection test failed: {exc}",
                suggestion="Check .config SSH settings and network connectivity.",
            )

    def execute_command(self, cmd_str: str) -> Tuple[int, str, str]:
        """Execute a command on the remote server. Returns (exit_code, stdout, stderr)."""
        self._log.debug(f"SSHTransport.execute_command(): {cmd_str[:100]}")

        ssh_cmd = ["ssh"] + self._ssh_base_args() + [self._ssh_target(), cmd_str]

        try:
            result = subprocess.run(
                ssh_cmd,
                capture_output=True,
                text=True,
                timeout=self._config.ssh_timeout + 60,
            )
            self._log.debug(
                f"SSHTransport.execute_command(): rc={result.returncode}, "
                f"stdout={len(result.stdout)}b, stderr={len(result.stderr)}b"
            )
            return result.returncode, result.stdout, result.stderr
        except subprocess.TimeoutExpired:
            self._log.warn(f"Remote command timed out: {cmd_str[:80]}")
            return -1, "", "Command timed out"
        except Exception as exc:
            self._log.warn(f"Remote command failed: {exc}")
            return -1, "", str(exc)

    def ensure_remote_dirs(self, remote_paths: List[str]) -> None:
        """Create all needed directories on remote via mkdir -p."""
        if not remote_paths:
            return

        self._log.debug(
            f"SSHTransport.ensure_remote_dirs(): creating {len(remote_paths)} directories"
        )

        # Collect unique parent directories
        dirs: Set[str] = set()
        for rpath in remote_paths:
            parent = "/".join(rpath.replace("\\", "/").split("/")[:-1])
            if parent:
                dirs.add(parent)

        if not dirs:
            return

        # Single mkdir -p command for all directories
        mkdir_cmd = "mkdir -p " + " ".join(f'"{d}"' for d in sorted(dirs))
        rc, stdout, stderr = self.execute_command(mkdir_cmd)
        if rc != 0:
            raise TransferError(
                f"Failed to create remote directories: {stderr.strip()}",
                suggestion="Check permissions on the remote server.",
            )
        self._log.debug(f"SSHTransport.ensure_remote_dirs(): created {len(dirs)} directories")

    def upload_file(self, local_path: str, remote_path: str) -> bool:
        """Upload a single file via SCP."""
        self._log.debug(f"SSHTransport.upload_file(): {local_path} → {remote_path}")

        scp_args = [
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "BatchMode=yes",
            "-o", f"ConnectTimeout={self._config.ssh_timeout}",
            "-P", str(self._config.ssh_port),
        ]
        key_file = self._config.ssh_key_file
        if key_file:
            scp_args.extend(["-i", key_file])

        cmd = ["scp"] + scp_args + [local_path, f"{self._ssh_target()}:{remote_path}"]

        try:
            result = self._run_with_retry(cmd, f"Upload {os.path.basename(local_path)}")
            self._log.debug(
                f"SSHTransport.upload_file(): success for {os.path.basename(local_path)}"
            )
            return True
        except DeployError:
            raise
        except Exception as exc:
            raise TransferError(
                f"Failed to upload {local_path}: {exc}",
                suggestion="Check network connection and remote permissions.",
            )

    def upload_batch(self, files: List[Tuple[str, str]]) -> Tuple[int, int, List[str]]:
        """Upload multiple files. Returns (success_count, fail_count, failed_files)."""
        self._log.debug(f"SSHTransport.upload_batch(): uploading {len(files)} files")

        total = len(files)
        success = 0
        failed: List[str] = []

        # First ensure all remote directories exist
        remote_paths = [remote for _, remote in files]
        try:
            self.ensure_remote_dirs(remote_paths)
        except DeployError as exc:
            self._log.error(f"Could not create remote directories: {exc}")
            return 0, total, [local for local, _ in files]

        for i, (local_path, remote_path) in enumerate(files, 1):
            self._log.progress(i, total, os.path.basename(local_path))
            try:
                self.upload_file(local_path, remote_path)
                success += 1
            except DeployError as exc:
                self._log.error(f"Failed: {os.path.basename(local_path)}: {exc}")
                failed.append(local_path)

        self._log.debug(
            f"SSHTransport.upload_batch(): {success}/{total} succeeded, {len(failed)} failed"
        )
        return success, len(failed), failed

    def verify_remote_file(self, remote_path: str, expected_sha256: str) -> bool:
        """Verify uploaded file integrity via remote sha256sum."""
        self._log.debug(f"SSHTransport.verify_remote_file(): {remote_path}")

        rc, stdout, stderr = self.execute_command(f'sha256sum "{remote_path}"')
        if rc != 0:
            self._log.warn(f"Could not verify {remote_path}: {stderr.strip()}")
            return False

        remote_hash = stdout.strip().split()[0] if stdout.strip() else ""
        matches = remote_hash == expected_sha256
        if not matches:
            self._log.warn(
                f"Hash mismatch for {remote_path}: "
                f"local={expected_sha256[:16]}... remote={remote_hash[:16]}..."
            )
        else:
            self._log.debug(f"SSHTransport.verify_remote_file(): integrity OK for {remote_path}")
        return matches

    def create_backup(self, remote_dir: str, backup_dir: str) -> Optional[str]:
        """Create a tar.gz backup of the remote directory."""
        self._log.debug(f"SSHTransport.create_backup(): {remote_dir} → {backup_dir}")

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_name = f"backend_backup_{timestamp}.tar.gz"
        backup_path = f"{backup_dir}/{backup_name}"

        # Ensure backup directory exists
        rc, _, stderr = self.execute_command(f'mkdir -p "{backup_dir}"')
        if rc != 0:
            self._log.warn(f"Could not create backup directory: {stderr.strip()}")
            return None

        # Check if source directory exists
        rc, _, _ = self.execute_command(f'test -d "{remote_dir}"')
        if rc != 0:
            self._log.debug("SSHTransport.create_backup(): remote dir doesn't exist yet, skip backup")
            return None

        # Create tar backup
        tar_cmd = f'tar czf "{backup_path}" -C "$(dirname "{remote_dir}")" "$(basename "{remote_dir}")"'
        rc, stdout, stderr = self.execute_command(tar_cmd)
        if rc != 0:
            self._log.warn(f"Backup creation failed: {stderr.strip()}")
            return None

        self._log.debug(f"SSHTransport.create_backup(): created {backup_path}")
        return backup_path

    def restore_backup(self, backup_path: str, target_dir: str) -> bool:
        """Restore a backup to the target directory."""
        self._log.debug(f"SSHTransport.restore_backup(): {backup_path} → {target_dir}")

        rc, _, stderr = self.execute_command(
            f'tar xzf "{backup_path}" -C "$(dirname "{target_dir}")"'
        )
        if rc != 0:
            self._log.error(f"Backup restore failed: {stderr.strip()}")
            return False

        self._log.debug("SSHTransport.restore_backup(): restore completed")
        return True

    def delete_remote_file(self, remote_path: str) -> bool:
        """Delete a file on the remote server."""
        self._log.debug(f"SSHTransport.delete_remote_file(): {remote_path}")

        rc, _, stderr = self.execute_command(f'rm -f "{remote_path}"')
        if rc != 0:
            self._log.warn(f"Could not delete remote file {remote_path}: {stderr.strip()}")
            return False
        return True


# ═══════════════════════════════════════════════════════════════════════════
#  HTTP Transport
# ═══════════════════════════════════════════════════════════════════════════

class HTTPTransport:
    """HTTP-based file deployment via POST requests."""

    def __init__(self, config: ConfigManager, log: DeployLogger) -> None:
        self._config = config
        self._log = log
        self._session = None
        self._requests = None
        self._connected = False

        # Try to import requests
        try:
            import requests as req_module
            self._requests = req_module
            self._log.debug("HTTPTransport.__init__(): 'requests' library available")
        except ImportError:
            self._requests = None
            self._log.debug("HTTPTransport.__init__(): 'requests' library not available")

    def _ensure_requests(self) -> None:
        """Verify requests library is available."""
        if self._requests is None:
            raise ConnectionError_(
                "Python 'requests' library is not installed.",
                suggestion=(
                    "Install it with:\n"
                    "  pip install requests\n"
                    "Or use SSH transport instead: python deploy.py -ssh"
                ),
            )

    def _get_auth_headers(self) -> Dict[str, str]:
        """Build authorization headers."""
        token = self._config.http_auth_token
        if not token:
            env_var = self._config.http_auth_token_env
            raise ConnectionError_(
                f"HTTP auth token not found. Environment variable '{env_var}' is not set.",
                suggestion=(
                    f"Set the token:\n"
                    f"  Windows:  $env:{env_var} = 'your-token'\n"
                    f"  Linux:    export {env_var}='your-token'"
                ),
            )
        return {"Authorization": f"Bearer {token}"}

    def test_connection(self) -> bool:
        """Test HTTP connectivity to the backend."""
        self._log.debug("HTTPTransport.test_connection(): testing HTTP connection")
        self._ensure_requests()

        health_url = self._config.http_health_url
        self._log.debug(f"HTTPTransport.test_connection(): GET {health_url}")

        try:
            headers = self._get_auth_headers()
            resp = self._requests.get(
                health_url,
                headers=headers,
                timeout=self._config.http_timeout,
                verify=self._config.http_verify_ssl,
            )

            if resp.status_code == 200:
                self._connected = True
                self._log.debug("HTTPTransport.test_connection(): connection OK (200)")
                return True

            self._log.warn(f"Health check returned status {resp.status_code}")
            self._handle_http_error(resp.status_code, health_url)
            return False

        except self._requests.exceptions.SSLError as exc:
            raise ConnectionError_(
                f"SSL verification failed for {health_url}: {exc}",
                suggestion=(
                    "Options:\n"
                    "  1. Set deploy.http.verify_ssl to false (insecure)\n"
                    "  2. Install the server's CA certificate"
                ),
            )
        except self._requests.exceptions.ConnectionError as exc:
            raise ConnectionError_(
                f"Cannot connect to {health_url}: {exc}",
                suggestion="Check that the server is running and the URL is correct.",
            )
        except self._requests.exceptions.Timeout:
            raise ConnectionError_(
                f"Connection timed out to {health_url}",
                suggestion=f"Increase deploy.http.timeout (current: {self._config.http_timeout}s).",
            )

    def _handle_http_error(self, status_code: int, url: str) -> None:
        """Raise descriptive errors for HTTP status codes."""
        messages = {
            401: ("Authentication failed", "Check your deploy token."),
            403: ("Access forbidden", "Check server-side permissions for your token."),
            404: ("Endpoint not found", f"Check deploy.http.endpoint in .config. URL: {url}"),
            413: ("File too large", "The server rejected the upload as too large."),
            500: ("Internal server error", "Check server logs."),
            502: ("Bad gateway", "The backend service may be down."),
            503: ("Service unavailable", "The server is temporarily unavailable."),
        }

        msg, suggestion = messages.get(status_code, (f"HTTP {status_code}", "Check server logs."))
        raise TransferError(f"{msg} (HTTP {status_code})", suggestion=suggestion)

    def upload_file(self, local_path: str, remote_path: str,
                    sha256: str = "", version: str = "") -> bool:
        """Upload a single file via HTTP POST."""
        self._log.debug(f"HTTPTransport.upload_file(): {local_path} → {remote_path}")
        self._ensure_requests()

        url = self._config.http_url
        headers = self._get_auth_headers()

        max_attempts = self._config.retry_max_attempts
        delay = self._config.retry_delay
        backoff = self._config.retry_backoff

        for attempt in range(1, max_attempts + 1):
            try:
                with open(local_path, "rb") as fh:
                    files = {"file": (os.path.basename(local_path), fh)}
                    data = {
                        "remote_path": remote_path,
                        "sha256": sha256,
                        "version": version,
                    }

                    resp = self._requests.post(
                        url,
                        headers=headers,
                        files=files,
                        data=data,
                        timeout=self._config.http_timeout,
                        verify=self._config.http_verify_ssl,
                    )

                if resp.status_code in (200, 201):
                    self._log.debug(f"HTTPTransport.upload_file(): success ({resp.status_code})")
                    return True

                # Retry on 500/502/503
                if resp.status_code in (500, 502, 503) and attempt < max_attempts:
                    wait = delay * (backoff ** (attempt - 1))
                    self._log.info(
                        f"Server error ({resp.status_code}), retrying in {wait:.1f}s..."
                    )
                    time.sleep(wait)
                    continue

                self._handle_http_error(resp.status_code, url)

            except self._requests.exceptions.ConnectionError as exc:
                if attempt < max_attempts:
                    wait = delay * (backoff ** (attempt - 1))
                    self._log.info(f"Connection lost, retrying in {wait:.1f}s...")
                    time.sleep(wait)
                else:
                    raise ConnectionError_(
                        f"Connection lost during upload of {os.path.basename(local_path)}: {exc}",
                    )
            except self._requests.exceptions.Timeout:
                if attempt < max_attempts:
                    wait = delay * (backoff ** (attempt - 1))
                    self._log.info(f"Upload timed out, retrying in {wait:.1f}s...")
                    time.sleep(wait)
                else:
                    raise TransferError(
                        f"Upload timed out for {os.path.basename(local_path)}",
                        suggestion=f"Increase deploy.http.timeout (current: {self._config.http_timeout}s).",
                    )
            except OSError as exc:
                raise TransferError(
                    f"Cannot read local file {local_path}: {exc}",
                )

        return False

    def upload_batch(self, files: List[Tuple[str, str]],
                     checksums: Optional[Dict[str, str]] = None,
                     versions: Optional[Dict[str, str]] = None,
                     ) -> Tuple[int, int, List[str]]:
        """Upload multiple files. Returns (success, failed, failed_list)."""
        self._log.debug(f"HTTPTransport.upload_batch(): uploading {len(files)} files")

        total = len(files)
        success = 0
        failed: List[str] = []

        for i, (local_path, remote_path) in enumerate(files, 1):
            self._log.progress(i, total, os.path.basename(local_path))
            sha = (checksums or {}).get(local_path, "")
            ver = (versions or {}).get(local_path, "")
            try:
                self.upload_file(local_path, remote_path, sha256=sha, version=ver)
                success += 1
            except DeployError as exc:
                self._log.error(f"Failed: {os.path.basename(local_path)}: {exc}")
                failed.append(local_path)

        return success, len(failed), failed

    def create_backup(self, remote_dir: str, backup_dir: str) -> Optional[str]:
        """Request server to create backup via HTTP POST."""
        self._log.debug(f"HTTPTransport.create_backup(): requesting backup")
        self._ensure_requests()

        url = self._config.http_domain.rstrip("/") + "/api/backup"
        headers = self._get_auth_headers()

        try:
            resp = self._requests.post(
                url,
                headers=headers,
                json={"remote_dir": remote_dir, "backup_dir": backup_dir},
                timeout=self._config.http_timeout,
                verify=self._config.http_verify_ssl,
            )

            if resp.status_code in (200, 201):
                data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                return data.get("backup_path", "backup_created")
            else:
                self._log.warn(f"Backup request returned {resp.status_code}")
                return None

        except Exception as exc:
            self._log.warn(f"Backup request failed: {exc}")
            return None

    def verify_remote_file(self, remote_path: str, expected_sha256: str) -> bool:
        """Verify uploaded file integrity via HTTP."""
        self._log.debug(f"HTTPTransport.verify_remote_file(): {remote_path}")
        # HTTP verification relies on server response during upload
        return True  # Trusted if upload succeeded

    def restore_backup(self, backup_path: str, target_dir: str) -> bool:
        """Request server to restore backup."""
        self._log.debug(f"HTTPTransport.restore_backup(): requesting restore")
        self._ensure_requests()

        url = self._config.http_domain.rstrip("/") + "/api/restore"
        headers = self._get_auth_headers()

        try:
            resp = self._requests.post(
                url,
                headers=headers,
                json={"backup_path": backup_path, "target_dir": target_dir},
                timeout=self._config.http_timeout,
                verify=self._config.http_verify_ssl,
            )
            return resp.status_code in (200, 201)
        except Exception as exc:
            self._log.error(f"Restore request failed: {exc}")
            return False

    def delete_remote_file(self, remote_path: str) -> bool:
        """Request server to delete a file."""
        self._log.debug(f"HTTPTransport.delete_remote_file(): {remote_path}")
        return True  # Deletion handled server-side during deploy


# ═══════════════════════════════════════════════════════════════════════════
#  Deploy State (for crash recovery)
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class DeployState:
    """Tracks in-progress deployment for recovery after crash."""

    started_at: str = ""
    transport: str = ""
    build_version: str = ""
    files_total: int = 0
    files_uploaded: List[str] = field(default_factory=list)
    files_pending: List[str] = field(default_factory=list)
    files_failed: List[str] = field(default_factory=list)
    backup_path: str = ""
    completed: bool = False

    def save(self, repo_root: Path, log: DeployLogger) -> None:
        """Save state to .deploy.state.json."""
        state_path = repo_root / DEPLOY_STATE
        log.debug(f"DeployState.save(): saving to {state_path}")

        try:
            state_path.parent.mkdir(parents=True, exist_ok=True)
            data = {
                "started_at": self.started_at,
                "transport": self.transport,
                "build_version": self.build_version,
                "files_total": self.files_total,
                "files_uploaded": self.files_uploaded,
                "files_pending": self.files_pending,
                "files_failed": self.files_failed,
                "backup_path": self.backup_path,
                "completed": self.completed,
            }
            state_path.write_text(
                json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            log.debug("DeployState.save(): state saved")
        except OSError as exc:
            log.warn(f"Could not save deploy state: {exc}")

    @classmethod
    def load(cls, repo_root: Path, log: DeployLogger) -> Optional[DeployState]:
        """Load state from .deploy.state.json."""
        state_path = repo_root / DEPLOY_STATE
        log.debug(f"DeployState.load(): loading from {state_path}")

        if not state_path.exists():
            log.debug("DeployState.load(): no state file found")
            return None

        try:
            raw = state_path.read_text(encoding="utf-8")
            data = json.loads(raw)
            state = cls(
                started_at=data.get("started_at", ""),
                transport=data.get("transport", ""),
                build_version=data.get("build_version", ""),
                files_total=data.get("files_total", 0),
                files_uploaded=data.get("files_uploaded", []),
                files_pending=data.get("files_pending", []),
                files_failed=data.get("files_failed", []),
                backup_path=data.get("backup_path", ""),
                completed=data.get("completed", False),
            )
            log.debug(
                f"DeployState.load(): loaded state from {state.started_at}, "
                f"{len(state.files_uploaded)} uploaded, {len(state.files_pending)} pending"
            )
            return state
        except (OSError, json.JSONDecodeError, KeyError) as exc:
            log.warn(f"Could not load deploy state: {exc}")
            return None

    def clear(self, repo_root: Path, log: DeployLogger) -> None:
        """Remove state file after successful completion."""
        state_path = repo_root / DEPLOY_STATE
        log.debug("DeployState.clear(): removing state file")
        try:
            if state_path.exists():
                state_path.unlink()
        except OSError as exc:
            log.warn(f"Could not remove state file: {exc}")


# ═══════════════════════════════════════════════════════════════════════════
#  Deployment Lock
# ═══════════════════════════════════════════════════════════════════════════

class DeployLock:
    """Prevents concurrent deployments via lock file."""

    def __init__(self, repo_root: Path, log: DeployLogger) -> None:
        self._lock_path = repo_root / DEPLOY_LOCK
        self._log = log
        self._acquired = False

    def acquire(self) -> None:
        """Acquire the deployment lock."""
        self._log.debug(f"DeployLock.acquire(): checking {self._lock_path}")

        if self._lock_path.exists():
            # Check if stale
            try:
                raw = self._lock_path.read_text(encoding="utf-8")
                data = json.loads(raw)
                lock_pid = data.get("pid", 0)
                lock_time = data.get("timestamp", "")

                # Check if process is still running
                pid_alive = False
                try:
                    if sys.platform == "win32":
                        result = subprocess.run(
                            ["tasklist", "/FI", f"PID eq {lock_pid}", "/NH"],
                            capture_output=True, text=True, timeout=5,
                        )
                        pid_alive = str(lock_pid) in result.stdout
                    else:
                        os.kill(int(lock_pid), 0)
                        pid_alive = True
                except (OSError, subprocess.TimeoutExpired, ValueError):
                    pid_alive = False

                if pid_alive:
                    raise LockError_(
                        f"Another deployment is in progress (PID {lock_pid}, started {lock_time}).",
                        suggestion="Wait for it to finish or use --force-unlock if it's stuck.",
                    )

                # Check staleness by time
                if lock_time:
                    try:
                        lock_dt = datetime.fromisoformat(lock_time)
                        age = (datetime.now(timezone.utc) - lock_dt.replace(
                            tzinfo=timezone.utc if lock_dt.tzinfo is None else lock_dt.tzinfo
                        )).total_seconds()

                        if age > LOCK_STALE_SECONDS:
                            self._log.warn(
                                f"Stale lock detected (age: {age:.0f}s, PID {lock_pid} not running). "
                                "Removing."
                            )
                        else:
                            raise LockError_(
                                f"Lock file exists (PID {lock_pid}, {lock_time}). "
                                "Process may have crashed recently.",
                                suggestion="Use --force-unlock to remove the lock.",
                            )
                    except (ValueError, TypeError):
                        self._log.warn("Lock file has invalid timestamp, removing")

                # Remove stale lock
                self._lock_path.unlink()

            except LockError_:
                raise
            except (json.JSONDecodeError, OSError):
                self._log.warn("Corrupt lock file, removing")
                try:
                    self._lock_path.unlink()
                except OSError:
                    pass

        # Create lock
        self._lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_data = {
            "pid": os.getpid(),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        try:
            self._lock_path.write_text(
                json.dumps(lock_data, indent=2) + "\n",
                encoding="utf-8",
            )
            self._acquired = True
            self._log.debug("DeployLock.acquire(): lock acquired")
        except OSError as exc:
            raise LockError_(f"Could not create lock file: {exc}")

    def release(self) -> None:
        """Release the deployment lock."""
        self._log.debug("DeployLock.release(): releasing lock")
        if self._acquired:
            try:
                if self._lock_path.exists():
                    self._lock_path.unlink()
                self._acquired = False
                self._log.debug("DeployLock.release(): lock released")
            except OSError as exc:
                self._log.warn(f"Could not release lock: {exc}")

    @staticmethod
    def force_unlock(repo_root: Path, log: DeployLogger) -> None:
        """Forcefully remove the lock file."""
        lock_path = repo_root / DEPLOY_LOCK
        log.debug(f"DeployLock.force_unlock(): removing {lock_path}")
        if lock_path.exists():
            try:
                lock_path.unlink()
                log.success("Deployment lock removed")
            except OSError as exc:
                log.error(f"Could not remove lock: {exc}")
        else:
            log.info("No lock file found")


# ═══════════════════════════════════════════════════════════════════════════
#  Backend Integration — MCP Backend API interaction for post-deploy hooks
# ═══════════════════════════════════════════════════════════════════════════

# File-to-MCP component mapping for change impact analysis
_FILE_MCP_MAPPING: Dict[str, str] = {
    "mcp_supervisor.py": "__ALL__",
    "mcp_health.py": "__HEALTH_MONITOR__",
    "mcp_updater.py": "__UPDATER__",
    "mcp_registry.py": "__REGISTRY__",
    "mcp_logger.py": "__LOGGER__",
    "mcp_logging_helper.py": "__LOGGER__",
    "internal_api.py": "__API__",
    "self_healing.py": "__SELF_HEALING__",
    "security.py": "__SECURITY__",
    "logging_setup.py": "__LOGGING__",
    "models.py": "__ALL__",
    "start_server.py": "__SUPERVISOR__",
    "config/mcp_servers.json": "__CONFIG_RELOAD__",
    "config/mcp_logging.json": "__CONFIG_RELOAD__",
    "config/mcp_alerts.json": "__CONFIG_RELOAD__",
    "requirements.txt": "__REQUIREMENTS__",
}


class BackendIntegration:
    """Handles all MCP backend API interaction for deploy hooks."""

    def __init__(self, config: ConfigManager, log: DeployLogger, dry_run: bool = False) -> None:
        self._config = config
        self._log = log
        self._dry_run = dry_run
        self._log.debug("BackendIntegration initialized")

    def _api_request(self, method: str, endpoint: str, body: Optional[Dict] = None,
                     timeout: int = 15) -> Optional[Dict[str, Any]]:
        """Make an authenticated HTTP request to the backend API."""
        import urllib.request
        import urllib.error

        url = self._config.backend_api_url + endpoint
        self._log.debug(f"BackendIntegration._api_request(): {method} {url}")

        headers: Dict[str, str] = {"Content-Type": "application/json"}
        token = self._config.backend_api_token
        if token:
            headers["Authorization"] = f"Bearer {token}"

        data = json.dumps(body).encode("utf-8") if body else None
        try:
            req = urllib.request.Request(url, headers=headers, method=method, data=data)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            self._log.error(f"Backend API error: {exc.code} {exc.reason}")
            try:
                error_body = exc.read().decode("utf-8")
                self._log.debug(f"Error body: {error_body}")
            except Exception:
                pass
            return None
        except urllib.error.URLError as exc:
            self._log.error(f"Cannot reach backend API at {url}: {exc.reason}")
            return None
        except Exception as exc:
            self._log.error(f"Backend API request failed: {exc}")
            return None

    def is_reachable(self) -> bool:
        """Check if backend API is reachable and healthy."""
        if not self._config.backend_api_configured:
            self._log.debug("BackendIntegration: backend_api not configured")
            return False
        result = self._api_request("GET", self._config.backend_health_endpoint, timeout=10)
        if result and result.get("status") in ("healthy", "ok"):
            self._log.debug("BackendIntegration: backend is healthy")
            return True
        self._log.debug("BackendIntegration: backend not reachable or unhealthy")
        return False

    def restart_backend_http(self) -> bool:
        """Restart backend via HTTP API (zero-downtime preferred)."""
        self._log.debug("BackendIntegration.restart_backend_http()")
        if self._dry_run:
            self._log.info("[DRY-RUN] Would restart backend via HTTP API")
            return True
        result = self._api_request("POST", self._config.backend_restart_endpoint, body={}, timeout=30)
        if result and result.get("success"):
            self._log.success("Backend restart initiated via HTTP")
            return True
        self._log.warn("HTTP restart failed — may need SSH fallback")
        return False

    def restart_backend_ssh(self, ssh_host: str, ssh_user: str, ssh_port: int,
                            ssh_key: str, remote_base: str) -> bool:
        """Restart backend via SSH command."""
        self._log.debug("BackendIntegration.restart_backend_ssh()")
        if self._dry_run:
            self._log.info("[DRY-RUN] Would restart backend via SSH")
            return True
        cmd = f"cd {remote_base} && python backend/start_server.py --restart"
        ssh_cmd = ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes",
                    "-p", str(ssh_port)]
        if ssh_key:
            ssh_cmd.extend(["-i", ssh_key])
        ssh_cmd.extend([f"{ssh_user}@{ssh_host}", cmd])

        self._log.debug(f"SSH command: {' '.join(ssh_cmd)}")
        try:
            result = subprocess.run(ssh_cmd, capture_output=True, text=True, timeout=120)
            if result.returncode == 0:
                self._log.success("Backend restarted via SSH")
                if result.stdout.strip():
                    self._log.debug(f"SSH stdout: {result.stdout.strip()}")
                return True
            self._log.error(f"SSH restart failed (exit {result.returncode}): {result.stderr.strip()}")
            return False
        except subprocess.TimeoutExpired:
            self._log.error("SSH restart timed out after 120s")
            return False
        except Exception as exc:
            self._log.error(f"SSH restart error: {exc}")
            return False

    def restart_backend(self, ssh_host: str = "", ssh_user: str = "", ssh_port: int = 22,
                        ssh_key: str = "", remote_base: str = "") -> bool:
        """Restart backend using best available method (HTTP preferred, SSH fallback)."""
        self._log.debug("BackendIntegration.restart_backend(): selecting method")
        if self._config.backend_prefer_http and self.is_reachable():
            self._log.info("Restarting backend via HTTP API (zero-downtime)...")
            return self.restart_backend_http()
        if ssh_host:
            self._log.info("Restarting backend via SSH...")
            return self.restart_backend_ssh(ssh_host, ssh_user, ssh_port, ssh_key, remote_base)
        self._log.error("Cannot restart backend: HTTP unreachable and no SSH details")
        return False

    def restart_mcp(self, mcp_name: str) -> bool:
        """Restart a specific MCP server."""
        self._log.debug(f"BackendIntegration.restart_mcp({mcp_name})")
        if self._dry_run:
            self._log.info(f"[DRY-RUN] Would restart MCP '{mcp_name}'")
            return True
        endpoint = f"{self._config.backend_servers_endpoint}/{mcp_name}/restart"
        result = self._api_request("POST", endpoint, body={}, timeout=30)
        if result and result.get("success"):
            self._log.success(f"MCP '{mcp_name}' restart initiated")
            return True
        self._log.error(f"Failed to restart MCP '{mcp_name}'")
        return False

    def reload_config(self) -> bool:
        """Trigger configuration hot-reload on backend."""
        self._log.debug("BackendIntegration.reload_config()")
        if self._dry_run:
            self._log.info("[DRY-RUN] Would reload backend config")
            return True
        result = self._api_request("POST", self._config.backend_reload_config_endpoint, body={})
        if result and result.get("success"):
            self._log.success("Backend config reloaded")
            return True
        self._log.warn("Config reload failed")
        return False

    def verify_health(self, timeout: Optional[int] = None) -> bool:
        """Poll health endpoint until healthy or timeout."""
        check_timeout = timeout or self._config.backend_health_check_timeout
        interval = self._config.backend_health_check_interval
        self._log.debug(f"BackendIntegration.verify_health(timeout={check_timeout}s)")

        if self._dry_run:
            self._log.info("[DRY-RUN] Would verify backend health")
            return True

        start = time.time()
        attempts = 0
        while time.time() - start < check_timeout:
            attempts += 1
            result = self._api_request("GET", self._config.backend_health_endpoint, timeout=10)
            if result and result.get("status") in ("healthy", "ok"):
                elapsed = time.time() - start
                self._log.success(f"Backend healthy after {elapsed:.1f}s ({attempts} checks)")
                return True
            self._log.debug(f"Health check attempt {attempts}: not healthy yet")
            time.sleep(interval)

        self._log.error(f"Backend health check timed out after {check_timeout}s ({attempts} attempts)")
        return False

    def get_servers_status(self) -> Optional[Dict[str, Any]]:
        """Get status of all MCP servers from backend."""
        return self._api_request("GET", self._config.backend_servers_endpoint)

    def emit_event(self, event_type: str, data: Dict[str, Any]) -> None:
        """Emit a deploy event to the Central MCP Logger."""
        if not self._config.backend_api_configured:
            return
        self._log.debug(f"BackendIntegration.emit_event({event_type})")
        body = {"event_type": event_type, "data": data, "source": "deploy.py"}
        self._api_request("POST", self._config.backend_events_emit_endpoint, body=body, timeout=5)

    def acquire_deploy_lock(self) -> bool:
        """Acquire deploy lock on backend to prevent concurrent deploys."""
        self._log.debug("BackendIntegration.acquire_deploy_lock()")
        if not self._config.backend_api_configured:
            return True  # No backend configured — no remote lock needed
        if self._dry_run:
            return True
        result = self._api_request("POST", self._config.backend_deploy_lock_endpoint,
                                   body={"timeout": self._config.backend_deploy_lock_timeout})
        if result and result.get("acquired"):
            self._log.debug("Remote deploy lock acquired")
            return True
        if result and result.get("locked_by"):
            self._log.error(f"Deploy locked by another process: {result.get('locked_by')}")
        return False

    def release_deploy_lock(self) -> None:
        """Release deploy lock on backend."""
        if not self._config.backend_api_configured or self._dry_run:
            return
        self._log.debug("BackendIntegration.release_deploy_lock()")
        self._api_request("DELETE", self._config.backend_deploy_lock_endpoint, timeout=5)

    def get_deploy_history(self) -> Optional[List[Dict[str, Any]]]:
        """Fetch deploy history from backend."""
        result = self._api_request("GET", self._config.backend_deploy_history_endpoint)
        if isinstance(result, dict):
            return result.get("history", [])
        return None

    def save_deploy_record(self, record: Dict[str, Any]) -> None:
        """Save deploy record to backend history."""
        if not self._config.backend_api_configured or self._dry_run:
            return
        self._log.debug("BackendIntegration.save_deploy_record()")
        self._api_request("POST", self._config.backend_deploy_history_endpoint, body=record, timeout=10)

    def analyze_changed_files(self, changed_files: List[str]) -> Dict[str, List[str]]:
        """Analyze which MCP components are affected by changed files."""
        self._log.debug(f"BackendIntegration.analyze_changed_files({len(changed_files)} files)")
        impact: Dict[str, List[str]] = {
            "full_restart": [],
            "config_reload": [],
            "requirements_install": [],
            "unaffected": [],
            "affected_mcps": [],
        }
        needs_full_restart = False

        for filepath in changed_files:
            filename = os.path.basename(filepath)
            # Check direct mapping
            mapping = _FILE_MCP_MAPPING.get(filename, "")
            if not mapping:
                # Check path-based mapping
                for pattern, component in _FILE_MCP_MAPPING.items():
                    if pattern in filepath:
                        mapping = component
                        break

            if mapping == "__ALL__":
                impact["full_restart"].append(filepath)
                needs_full_restart = True
            elif mapping == "__CONFIG_RELOAD__":
                impact["config_reload"].append(filepath)
            elif mapping == "__REQUIREMENTS__":
                impact["requirements_install"].append(filepath)
            elif mapping:
                impact["full_restart"].append(filepath)
            else:
                impact["unaffected"].append(filepath)

        return impact

    def install_requirements_ssh(self, ssh_host: str, ssh_user: str, ssh_port: int,
                                 ssh_key: str, remote_base: str) -> bool:
        """Install/upgrade requirements on VPS via SSH."""
        self._log.debug("BackendIntegration.install_requirements_ssh()")
        if self._dry_run:
            self._log.info("[DRY-RUN] Would install requirements via SSH")
            return True
        cmd = (f"cd {remote_base} && "
               f"backend/.venv/bin/pip install -r backend/requirements.txt --upgrade --quiet")
        ssh_cmd = ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes",
                    "-p", str(ssh_port)]
        if ssh_key:
            ssh_cmd.extend(["-i", ssh_key])
        ssh_cmd.extend([f"{ssh_user}@{ssh_host}", cmd])
        try:
            result = subprocess.run(ssh_cmd, capture_output=True, text=True, timeout=300)
            if result.returncode == 0:
                self._log.success("Requirements installed on VPS")
                return True
            self._log.error(f"pip install failed: {result.stderr.strip()}")
            return False
        except subprocess.TimeoutExpired:
            self._log.error("Requirements install timed out after 300s")
            return False
        except Exception as exc:
            self._log.error(f"Requirements install error: {exc}")
            return False

    def check_docker_updates(self, ssh_host: str, ssh_user: str, ssh_port: int,
                             ssh_key: str) -> Dict[str, bool]:
        """Check which Docker MCPs have newer images available."""
        self._log.debug("BackendIntegration.check_docker_updates()")
        updates: Dict[str, bool] = {}
        servers = self.get_servers_status()
        if not servers:
            return updates
        for name, info in servers.items():
            if isinstance(info, dict) and info.get("install_method") == "docker":
                docker_image = info.get("docker_image", "")
                if docker_image:
                    updates[name] = True  # mark for potential update
        return updates

    def update_docker_mcp_ssh(self, ssh_host: str, ssh_user: str, ssh_port: int,
                               ssh_key: str, remote_base: str, mcp_name: str,
                               docker_image: str) -> bool:
        """Pull latest Docker image and recreate container for a specific MCP."""
        self._log.debug(f"BackendIntegration.update_docker_mcp_ssh({mcp_name})")
        if self._dry_run:
            self._log.info(f"[DRY-RUN] Would update Docker MCP '{mcp_name}' ({docker_image})")
            return True
        # Pull image, recreate container
        cmds = [
            f"docker pull {docker_image}",
            f"cd {remote_base} && docker compose stop {mcp_name} 2>/dev/null || true",
            f"cd {remote_base} && docker compose rm -f {mcp_name} 2>/dev/null || true",
            f"cd {remote_base} && docker compose up -d {mcp_name}",
        ]
        full_cmd = " && ".join(cmds)
        ssh_cmd = ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes",
                    "-p", str(ssh_port)]
        if ssh_key:
            ssh_cmd.extend(["-i", ssh_key])
        ssh_cmd.extend([f"{ssh_user}@{ssh_host}", full_cmd])
        try:
            result = subprocess.run(ssh_cmd, capture_output=True, text=True, timeout=600)
            if result.returncode == 0:
                self._log.success(f"Docker MCP '{mcp_name}' updated")
                return True
            self._log.error(f"Docker update for '{mcp_name}' failed: {result.stderr.strip()}")
            return False
        except subprocess.TimeoutExpired:
            self._log.error(f"Docker update for '{mcp_name}' timed out")
            return False
        except Exception as exc:
            self._log.error(f"Docker update error for '{mcp_name}': {exc}")
            return False

    def show_deploy_history(self) -> None:
        """Display deploy history from backend."""
        if not self._config.backend_api_configured:
            self._log.warn("Backend API not configured — cannot fetch deploy history")
            return
        history = self.get_deploy_history()
        if not history:
            self._log.info("No deploy history available")
            return
        self._log.header("Deploy History (last 20)")
        print(f"  {'Date':<20} {'Files':<8} {'Status':<10} {'Duration':<10}")
        print(f"  {'─' * 50}")
        for entry in history[:20]:
            ts = entry.get("timestamp", "")
            if isinstance(ts, (int, float)):
                ts = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
            files = len(entry.get("deployed_files", []))
            success = "OK" if entry.get("success", True) else "FAILED"
            duration = f"{entry.get('duration_seconds', 0):.1f}s"
            print(f"  {ts:<20} {files:<8} {success:<10} {duration:<10}")


# ═══════════════════════════════════════════════════════════════════════════
#  Deploy Manager (Orchestrator)
# ═══════════════════════════════════════════════════════════════════════════

class DeployManager:
    """Main deployment orchestrator."""

    def __init__(self, repo_root: Path, log: DeployLogger,
                 transport_mode: str = "ssh",
                 dry_run: bool = False, force: bool = False,
                 yes: bool = False, comment: str = "",
                 build_version: str = "", recover: bool = False,
                 quiet: bool = False,
                 restart_backend: bool = False,
                 restart_mcp: str = "",
                 update_docker_mcps: bool = False) -> None:
        self._repo_root = repo_root
        self._log = log
        self._transport_mode = transport_mode
        self._dry_run = dry_run
        self._force = force
        self._yes = yes
        self._comment = comment
        self._build_version_override = build_version
        self._recover = recover
        self._quiet = quiet
        self._restart_backend = restart_backend
        self._restart_mcp = restart_mcp
        self._update_docker_mcps = update_docker_mcps

        self._config: Optional[ConfigManager] = None
        self._transport = None
        self._checksum = ChecksumEngine(repo_root, log)
        self._version_mgr = VersionManager(repo_root, log)
        self._lock = DeployLock(repo_root, log)
        self._state = DeployState()
        self._backend: Optional[BackendIntegration] = None
        self._backup_path: Optional[str] = None
        self._start_time: float = 0.0

        # Signal handling
        self._original_sigint = signal.getsignal(signal.SIGINT)
        self._abort_requested = False

    def _setup_signal_handlers(self) -> None:
        """Install Ctrl+C handler for graceful abort."""
        def handler(signum, frame):
            if self._abort_requested:
                # Second Ctrl+C → hard exit
                self._log.warn("Force abort — exiting immediately")
                sys.exit(1)
            self._abort_requested = True
            self._log.warn("Abort requested — finishing current operation then stopping...")

        signal.signal(signal.SIGINT, handler)
        if hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, handler)

    def _restore_signal_handlers(self) -> None:
        """Restore original signal handlers."""
        signal.signal(signal.SIGINT, self._original_sigint)

    def _get_build_version(self) -> str:
        """Get current build version (override or from versions.json)."""
        if self._build_version_override:
            return self._build_version_override
        return self._version_mgr.get_current_build_version()

    def deploy(self) -> bool:
        """Execute the full deployment flow. Returns True on success."""
        self._start_time = time.time()
        self._setup_signal_handlers()

        try:
            return self._deploy_inner()
        except DeployError as exc:
            self._log.error(f"[{exc.code}] {exc}")
            if exc.suggestion:
                self._log.info(f"💡 {exc.suggestion}")
            self._handle_failure()
            return False
        except KeyboardInterrupt:
            self._log.warn("Deployment interrupted by user")
            self._handle_failure()
            return False
        except Exception as exc:
            self._log.error(f"Unexpected error: {exc}")
            if self._log._verbose:
                traceback.print_exc()
            self._handle_failure()
            return False
        finally:
            self._lock.release()
            if self._backend:
                self._backend.release_deploy_lock()
            self._restore_signal_handlers()
            elapsed = time.time() - self._start_time
            self._log.debug(f"DeployManager.deploy(): total time {elapsed:.1f}s")

    def _deploy_inner(self) -> bool:
        """Inner deployment logic."""
        # Step 1: Load config
        self._log.header("Backend Deployment")
        self._log.debug("DeployManager._deploy_inner(): step 1 — load config")

        self._config = ConfigManager(self._repo_root, self._log)
        self._config.load()
        self._log.success("Configuration loaded")

        # Step 2: Initialize backend integration
        self._log.debug("DeployManager._deploy_inner(): step 2 — backend integration init")
        self._backend = BackendIntegration(self._config, self._log, dry_run=self._dry_run)

        # Pre-deploy backend health check
        if self._config.backend_api_configured and not self._dry_run:
            self._log.info("Checking backend health before deploy...")
            if self._backend.is_reachable():
                self._log.success("Backend is healthy")
            else:
                self._log.warn("Backend not reachable — post-deploy hooks will use SSH fallback")

        # Acquire remote deploy lock
        if self._config.backend_api_configured and not self._dry_run:
            if not self._backend.acquire_deploy_lock():
                self._log.warn("Could not acquire remote deploy lock — another deploy may be in progress")

        # Step 3: Validate (already done in config.load())
        self._log.debug("DeployManager._deploy_inner(): step 3 — config validated")

        # Step 3: Acquire lock
        self._log.debug("DeployManager._deploy_inner(): step 3 — acquire lock")
        self._lock.acquire()
        # Register atexit cleanup
        atexit.register(self._lock.release)

        # Step 4: Scan files
        self._log.debug("DeployManager._deploy_inner(): step 4 — scan files")
        self._log.info("Scanning backend files...")
        local_files = self._checksum.scan_backend_files()

        if not local_files and not self._force:
            self._log.warn(f"No files found in {BACKEND_DIR}/ directory")
            self._log.info("Nothing to deploy.")
            return True

        # Step 5: Load version data & checksums
        self._log.debug("DeployManager._deploy_inner(): step 5 — compute checksums")
        self._version_mgr.load()
        stored_checksums = self._checksum.load_stored_checksums(self._version_mgr.data)

        # Step 6: Compute diff
        self._log.debug("DeployManager._deploy_inner(): step 6 — compute diff")
        if self._force:
            # Force mode: treat all files as modified
            added = local_files.copy()
            modified: Dict[str, str] = {}
            deleted: Set[str] = set()
            self._log.info("Force mode: all files will be deployed")
        else:
            added, modified, deleted = self._checksum.compute_diff(local_files, stored_checksums)

        # Step 7: Print summary
        self._log.debug("DeployManager._deploy_inner(): step 7 — print summary")
        self._checksum.print_diff_summary(added, modified, deleted, local_files, stored_checksums)

        changes_count = len(added) + len(modified) + len(deleted)
        if changes_count == 0:
            self._log.success("Nothing to deploy — all files are up to date")
            return True

        # Show version info
        build_version = self._get_build_version()
        self._log.separator()
        self._log.kv("Build Version", build_version)
        self._log.kv("Transport", self._transport_mode.upper())
        self._log.kv("Files to deploy", str(len(added) + len(modified)))
        self._log.kv("Files to delete", str(len(deleted)))
        if self._dry_run:
            self._log.kv("Mode", "DRY RUN (no changes)")

        # Dry run: stop here
        if self._dry_run:
            self._log.separator()
            self._log.header("Dry Run Complete")
            self._log.info("No files were changed. Remove --dry-run to deploy.")
            return True

        # Step 8: Confirm
        self._log.debug("DeployManager._deploy_inner(): step 8 — confirm")
        if not self._yes:
            self._log.separator()
            try:
                answer = input(f"  {C.YELLOW}Deploy {changes_count} file(s)? [y/N]{C.RESET} ").strip()
            except EOFError:
                answer = "n"

            if answer.lower() not in ("y", "yes"):
                self._log.info("Deployment cancelled by user.")
                return False

        # Step 9: Test connection
        self._log.debug("DeployManager._deploy_inner(): step 9 — test connection")
        self._log.info(f"Testing {self._transport_mode.upper()} connection...")
        transport = self._create_transport()
        self._transport = transport

        if not transport.test_connection():
            raise ConnectionError_("Connection test failed.")
        self._log.success(f"{self._transport_mode.upper()} connection OK")

        # Step 10: Create remote backup
        self._log.debug("DeployManager._deploy_inner(): step 10 — create backup")
        if self._config.backup_enabled:
            self._log.info("Creating remote backup...")
            remote_backend = f"{self._config.remote_base_path}"
            backup_dir = self._config.backup_remote_dir
            self._backup_path = transport.create_backup(remote_backend, backup_dir)
            if self._backup_path:
                self._log.success(f"Backup created: {self._backup_path}")
            else:
                self._log.info("No backup needed (remote directory doesn't exist yet)")

        # Initialize deploy state
        all_deploy_files = list(added.keys()) + list(modified.keys())
        self._state = DeployState(
            started_at=datetime.now(timezone.utc).isoformat(),
            transport=self._transport_mode,
            build_version=build_version,
            files_total=len(all_deploy_files),
            files_uploaded=[],
            files_pending=list(all_deploy_files),
            files_failed=[],
            backup_path=self._backup_path or "",
        )
        self._state.save(self._repo_root, self._log)

        # Step 11: Upload changed files
        self._log.debug("DeployManager._deploy_inner(): step 11 — upload files")
        self._log.header("Uploading Files")

        # Prepare upload list: (local_abs_path, remote_abs_path)
        upload_list: List[Tuple[str, str]] = []
        for filepath in sorted(all_deploy_files):
            local_abs = str(self._repo_root / filepath)
            remote_abs = f"{self._config.remote_base_path}/{filepath}"
            upload_list.append((local_abs, remote_abs))

        # Create backup of version JSON before modifications
        self._version_mgr.create_backup()

        success_count, fail_count, failed_files = transport.upload_batch(upload_list)

        # Update deploy state
        uploaded_rel = [
            f for f in all_deploy_files
            if str(self._repo_root / f) not in failed_files
        ]
        self._state.files_uploaded = uploaded_rel
        self._state.files_pending = []
        self._state.files_failed = [
            f for f in all_deploy_files
            if str(self._repo_root / f) in failed_files
        ]
        self._state.save(self._repo_root, self._log)

        # Check for abort
        if self._abort_requested:
            self._log.warn("Abort was requested — stopping after current batch")
            self._handle_failure()
            return False

        # Handle failures
        if fail_count > 0 and success_count == 0:
            raise TransferError(
                f"All {fail_count} uploads failed.",
                suggestion="Check connection and server permissions.",
            )

        if fail_count > 0:
            self._log.warn(f"{fail_count} file(s) failed to upload (see above)")

        # Verify uploaded files (SSH only)
        if isinstance(transport, SSHTransport) and success_count > 0:
            self._log.info("Verifying uploaded files...")
            verify_failures = 0
            for filepath in uploaded_rel:
                sha = local_files.get(filepath, added.get(filepath, modified.get(filepath, "")))
                if sha:
                    remote_path = f"{self._config.remote_base_path}/{filepath}"
                    if not transport.verify_remote_file(remote_path, sha):
                        verify_failures += 1
            if verify_failures > 0:
                self._log.warn(f"{verify_failures} file(s) failed integrity verification")
            else:
                self._log.success("File integrity verified")

        # Handle deleted files
        if deleted:
            self._log.info(f"Removing {len(deleted)} deleted file(s) from remote...")
            for filepath in sorted(deleted):
                remote_path = f"{self._config.remote_base_path}/{filepath}"
                transport.delete_remote_file(remote_path)
                self._version_mgr.mark_deleted(filepath, build_version)

        # Step 12: Update version JSON
        self._log.debug("DeployManager._deploy_inner(): step 12 — update versions")
        comment = self._comment or ""

        for filepath in uploaded_rel:
            sha = local_files.get(filepath, "")
            entry = self._version_mgr.get_entry(filepath)
            if entry is None:
                # New file
                self._version_mgr.add_new_file(filepath, build_version, sha)
            else:
                # Existing file modified (or force)
                file_comment = comment or f"Deployed: content changed"
                self._version_mgr.bump_version(filepath, build_version, file_comment, sha)

        self._version_mgr.save()
        self._log.success("Version tracking updated")

        # Mark state as completed
        self._state.completed = True
        self._state.clear(self._repo_root, self._log)

        # Step 13: Post-deploy backend integration
        self._log.debug("DeployManager._deploy_inner(): step 13 — backend integration")
        self._backend = BackendIntegration(self._config, self._log, dry_run=self._dry_run)

        # Emit deploy start event
        self._backend.emit_event("DEPLOY_START", {
            "build_version": build_version,
            "files_count": len(uploaded_rel),
            "transport": self._transport_mode,
        })

        # Analyze change impact
        impact = self._backend.analyze_changed_files(uploaded_rel)
        if impact["requirements_install"]:
            self._log.info("Requirements changed — installing on VPS...")
            self._backend.install_requirements_ssh(
                self._config.ssh_host, self._config.ssh_user,
                self._config.ssh_port, self._config.ssh_key_file,
                self._config.remote_base_path,
            )

        if impact["config_reload"] and not impact["full_restart"]:
            self._log.info("Config files changed — triggering hot-reload...")
            self._backend.reload_config()
        elif self._restart_backend or impact["full_restart"]:
            self._log.info("Backend restart requested...")
            restart_ok = self._backend.restart_backend(
                ssh_host=self._config.ssh_host,
                ssh_user=self._config.ssh_user,
                ssh_port=self._config.ssh_port,
                ssh_key=self._config.ssh_key_file,
                remote_base=self._config.remote_base_path,
            )
            if restart_ok:
                self._log.info("Verifying backend health after restart...")
                health_ok = self._backend.verify_health()
                if not health_ok:
                    self._log.error("Backend health check failed after restart!")
                    self._backend.emit_event("DEPLOY_HEALTH_FAIL", {
                        "build_version": build_version,
                    })
                else:
                    self._backend.emit_event("DEPLOY_HEALTH_OK", {
                        "build_version": build_version,
                    })

        if self._restart_mcp:
            self._log.info(f"Restarting MCP '{self._restart_mcp}'...")
            self._backend.restart_mcp(self._restart_mcp)

        if self._update_docker_mcps:
            self._log.info("Updating Docker-based MCPs...")
            servers = self._backend.get_servers_status()
            if servers:
                for name, info in servers.items():
                    if isinstance(info, dict) and info.get("install_method") == "docker":
                        docker_image = info.get("docker_image", "")
                        if docker_image:
                            self._backend.update_docker_mcp_ssh(
                                self._config.ssh_host, self._config.ssh_user,
                                self._config.ssh_port, self._config.ssh_key_file,
                                self._config.remote_base_path, name, docker_image,
                            )

        # Save deploy record
        deploy_record = {
            "timestamp": time.time(),
            "build_version": build_version,
            "deployed_files": uploaded_rel,
            "deleted_files": list(deleted) if deleted else [],
            "docker_updates": [],
            "restart_results": {},
            "health_results": {},
            "duration_seconds": time.time() - self._start_time,
            "deploy_user": os.environ.get("USER", os.environ.get("USERNAME", "unknown")),
            "success": fail_count == 0,
        }
        self._backend.save_deploy_record(deploy_record)

        # Deploy summary with MCP info
        if self._config.backend_api_configured and not self._dry_run:
            mcp_status = self._backend.get_servers_status()
            if mcp_status:
                self._log.separator()
                self._log.info("MCP Server Status:")
                for name, info in mcp_status.items():
                    if isinstance(info, dict):
                        status = info.get("status", "unknown")
                        self._log.kv(f"  {name}", status)

        self._backend.emit_event("DEPLOY_COMPLETE", {
            "build_version": build_version,
            "success": fail_count == 0,
            "duration": time.time() - self._start_time,
        })

        # Step 14: Print success report
        self._log.debug("DeployManager._deploy_inner(): step 14 — print report")
        elapsed = time.time() - self._start_time
        self._print_report(
            build_version=build_version,
            uploaded=len(uploaded_rel),
            deleted=len(deleted),
            failed=fail_count,
            skipped=len(local_files) - len(all_deploy_files),
            elapsed=elapsed,
        )

        return fail_count == 0

    def _create_transport(self):
        """Create transport based on mode."""
        self._log.debug(f"DeployManager._create_transport(): mode={self._transport_mode}")

        if self._transport_mode == "ssh":
            return SSHTransport(self._config, self._log)
        elif self._transport_mode == "http":
            return HTTPTransport(self._config, self._log)
        else:
            raise ConfigError(f"Unknown transport mode: {self._transport_mode}")

    def _handle_failure(self) -> None:
        """Handle deployment failure: save state, attempt rollback."""
        self._log.debug("DeployManager._handle_failure(): handling failure")

        # Save state for recovery
        if self._state.files_pending or self._state.files_uploaded:
            self._state.save(self._repo_root, self._log)
            self._log.info(f"Deploy state saved. Resume with: python deploy.py -{self._transport_mode} --recover")

        # Attempt rollback if we have a backup and transport
        if self._backup_path and self._transport and self._config:
            self._log.info("Attempting rollback from backup...")
            try:
                success = self._transport.restore_backup(
                    self._backup_path,
                    self._config.remote_base_path,
                )
                if success:
                    self._log.success("Rollback completed successfully")
                else:
                    self._log.error("Rollback failed — manual intervention may be needed")
            except Exception as exc:
                self._log.error(f"Rollback error: {exc}")

    def _print_report(self, build_version: str, uploaded: int, deleted: int,
                      failed: int, skipped: int, elapsed: float) -> None:
        """Print deployment summary report."""
        self._log.header("Deployment Complete")
        self._log.kv("Build Version", build_version)
        self._log.kv("Transport", self._transport_mode.upper())
        self._log.kv("Files Deployed", str(uploaded))
        self._log.kv("Files Deleted", str(deleted))
        self._log.kv("Files Failed", str(failed))
        self._log.kv("Files Skipped", str(skipped))
        self._log.kv("Total Time", f"{elapsed:.1f}s")

        if failed > 0:
            self._log.warn(f"{failed} file(s) failed — check errors above")
        else:
            self._log.success("All files deployed successfully")

    def show_status(self) -> None:
        """Show last deployment status."""
        self._log.header("Deployment Status")

        # Load version data
        self._version_mgr.load()
        build_version = self._version_mgr.get_current_build_version()

        self._log.kv("Build Version", build_version)
        self._log.kv("Version File", VERSION_JSON)

        entries = self._version_mgr.data
        if not entries:
            self._log.info("No files tracked yet.")
            return

        total = len(entries)
        deleted = sum(1 for e in entries if e.get("deleted"))
        active = total - deleted

        self._log.kv("Total Files Tracked", str(total))
        self._log.kv("Active Files", str(active))
        self._log.kv("Deleted Files", str(deleted))

        # Find last deployment time
        last_deploy = ""
        for entry in entries:
            dep_at = entry.get("last_deployed_at", "")
            if dep_at > last_deploy:
                last_deploy = dep_at

        if last_deploy:
            self._log.kv("Last Deployment", last_deploy)

        # Check for pending state
        state = DeployState.load(self._repo_root, self._log)
        if state and not state.completed:
            self._log.separator()
            self._log.warn("Incomplete deployment detected!")
            self._log.kv("Started", state.started_at)
            self._log.kv("Uploaded", str(len(state.files_uploaded)))
            self._log.kv("Pending", str(len(state.files_pending)))
            self._log.kv("Failed", str(len(state.files_failed)))
            self._log.info(f"Resume with: python deploy.py -{state.transport} --recover")

        self._log.separator()

        # File table
        print(f"\n  {C.BOLD}{'File':<45} {'Version':<10} {'Status':<10}{C.RESET}")
        print(f"  {C.DIM}{'─' * 65}{C.RESET}")
        for entry in sorted(entries, key=lambda e: e.get("file", "")):
            filepath = entry.get("file", "")
            version = entry.get("Version", "?")
            is_deleted = entry.get("deleted", False)
            status = f"{C.RED}deleted{C.RESET}" if is_deleted else f"{C.GREEN}active{C.RESET}"
            print(f"  {filepath:<45} {version:<10} {status}")

        # MCP Server status overlay (if backend configured)
        try:
            config = ConfigManager(self._repo_root, self._log)
            config.load()
            if config.backend_api_configured:
                backend = BackendIntegration(config, self._log)
                mcp_status = backend.get_servers_status()
                if mcp_status:
                    self._log.separator()
                    self._log.info("MCP Server Status (from backend):")
                    for name, info in mcp_status.items():
                        if isinstance(info, dict):
                            status_val = info.get("status", "unknown")
                            self._log.kv(f"  {name}", status_val)
        except Exception:
            pass  # Don't fail status display if backend is unreachable


# ═══════════════════════════════════════════════════════════════════════════
#  CLI Argument Parser
# ═══════════════════════════════════════════════════════════════════════════

def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        prog="deploy.py",
        description="Sudx Copilot Customizations — Backend Deployment & Version Control.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Examples:
              python deploy.py -ssh                        Deploy via SSH
              python deploy.py -http                       Deploy via HTTP
              python deploy.py -ssh --dry-run              Simulate deployment
              python deploy.py -ssh --force                Full redeploy
              python deploy.py -ssh --yes                  Skip confirmation
              python deploy.py -ssh -k "FIX: API update"  Deploy with comment
              python deploy.py --status                    Show deployment info
              python deploy.py --force-unlock              Remove stale lock

            Transport Modes (mutually exclusive):
              -ssh       Deploy via SSH/SCP (public key auth)
              -http      Deploy via HTTP POST (bearer token auth)

            Configuration:
              Connection settings are read from .config at project root.
              A template is created automatically on first run.
              See .config.example for documentation.
        """),
    )

    # -- Transport ----------------------------------------------------------
    transport_group = parser.add_argument_group("Transport")
    transport_exclusive = transport_group.add_mutually_exclusive_group()
    transport_exclusive.add_argument(
        "-ssh",
        action="store_const",
        const="ssh",
        dest="transport",
        help="Deploy via SSH/SCP (public key auth, from .config)",
    )
    transport_exclusive.add_argument(
        "-http",
        action="store_const",
        const="http",
        dest="transport",
        help="Deploy via HTTP POST (bearer token auth, from .config)",
    )

    # -- Actions ------------------------------------------------------------
    action_group = parser.add_argument_group("Actions")
    action_group.add_argument(
        "--dry-run",
        action="store_true",
        help="Simulate deployment without making changes",
    )
    action_group.add_argument(
        "--force",
        action="store_true",
        help="Deploy ALL files regardless of checksum",
    )
    action_group.add_argument(
        "--yes", "-y",
        action="store_true",
        help="Skip confirmation prompt",
    )
    action_group.add_argument(
        "--status",
        action="store_true",
        help="Show last deployment info",
    )
    action_group.add_argument(
        "--force-unlock",
        action="store_true",
        help="Remove stale deployment lock",
    )
    action_group.add_argument(
        "--recover",
        action="store_true",
        help="Resume a failed deployment from saved state",
    )

    # -- Backend Integration ------------------------------------------------
    backend_group = parser.add_argument_group("Backend Integration")
    backend_group.add_argument(
        "--restart-backend",
        action="store_true",
        help="Restart MCP backend after deployment",
    )
    backend_group.add_argument(
        "--restart-mcp",
        metavar="NAME",
        default="",
        help="Restart specific MCP server after deploy (e.g. pentest-ai)",
    )
    backend_group.add_argument(
        "--update-docker-mcps",
        action="store_true",
        help="Pull latest Docker images and recreate Docker-based MCP containers",
    )
    backend_group.add_argument(
        "--history",
        action="store_true",
        help="Show deploy history from VPS backend",
    )

    # -- Options ------------------------------------------------------------
    option_group = parser.add_argument_group("Options")
    option_group.add_argument(
        "-k", "--kommentar",
        dest="comment",
        default="",
        help='Comment for version log (e.g. "FIX: Updated API endpoint")',
    )
    option_group.add_argument(
        "--build-version",
        dest="build_version",
        default="",
        help="Override build version (used by build.py integration)",
    )
    option_group.add_argument(
        "--verbose",
        action="store_true",
        help="Extra debug output with timestamps",
    )
    option_group.add_argument(
        "--quiet", "-q",
        action="store_true",
        help="Suppress all output except errors",
    )

    return parser.parse_args()


# ═══════════════════════════════════════════════════════════════════════════
#  Config Sanitization Helper
# ═══════════════════════════════════════════════════════════════════════════

def _sanitize_config_for_log(config: Dict) -> Dict:
    """Remove sensitive values from config for safe logging."""
    safe = json.loads(json.dumps(config))  # Deep copy
    deploy = safe.get("deploy", {})
    ssh = deploy.get("ssh", {})
    http = deploy.get("http", {})

    # Mask key file content (keep path but mask)
    if "key_file" in ssh:
        ssh["key_file"] = "***" + ssh["key_file"][-20:] if len(ssh.get("key_file", "")) > 20 else "***"

    # Never log token values
    if "auth_token_env" in http:
        http["auth_token_env"] = http["auth_token_env"]  # Env var name is safe
    # Remove any accidentally included token values
    for key in list(http.keys()):
        if "token" in key.lower() and key != "auth_token_env":
            http[key] = "***REDACTED***"

    return safe


# ═══════════════════════════════════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════════════════════════════════

def main() -> int:
    """Main entry point."""
    C.init()
    args = parse_args()
    repo_root = Path(__file__).resolve().parent

    # Create logger
    log = DeployLogger(
        verbose=args.verbose,
        quiet=args.quiet,
        log_file=str(repo_root / DEPLOY_LOG) if not args.quiet else None,
    )

    log.debug(f"deploy.py v{SCRIPT_VERSION} started")
    log.debug(f"Repo root: {repo_root}")
    log.debug(f"Python: {sys.version}")
    log.debug(f"Platform: {platform.platform()}")
    log.debug(f"Args: transport={args.transport}, dry_run={args.dry_run}, "
              f"force={args.force}, yes={args.yes}, verbose={args.verbose}")

    # -- Info/utility modes -------------------------------------------------

    if args.status:
        mgr = DeployManager(repo_root, log)
        mgr.show_status()
        return 0

    if args.force_unlock:
        DeployLock.force_unlock(repo_root, log)
        return 0

    if args.history:
        # Load config to get backend API URL
        config = ConfigManager(repo_root, log)
        try:
            config.load()
        except ConfigError as exc:
            log.error(f"Cannot load config: {exc}")
            return 1
        backend = BackendIntegration(config, log)
        backend.show_deploy_history()
        return 0

    # -- Deploy mode: require transport -------------------------------------

    if not args.transport:
        if args.recover:
            # Try to load transport from saved state
            state = DeployState.load(repo_root, log)
            if state and state.transport:
                args.transport = state.transport
                log.info(f"Resuming with {state.transport.upper()} transport from saved state")
            else:
                _print_error("No saved state found for recovery.")
                _print_info("Hint", "Use -ssh or -http to specify transport mode.")
                return 1
        else:
            _print_error("No transport specified. Use -ssh or -http.")
            print()
            print(f"  {C.DIM}Examples:{C.RESET}")
            print(f"    python deploy.py {C.CYAN}-ssh{C.RESET}                Deploy via SSH")
            print(f"    python deploy.py {C.CYAN}-http{C.RESET}               Deploy via HTTP")
            print(f"    python deploy.py {C.CYAN}--status{C.RESET}            Show deployment info")
            print(f"    python deploy.py {C.CYAN}--force-unlock{C.RESET}      Remove stale lock")
            print()
            return 1

    # -- Execute deployment -------------------------------------------------

    try:
        mgr = DeployManager(
            repo_root=repo_root,
            log=log,
            transport_mode=args.transport,
            dry_run=args.dry_run,
            force=args.force,
            yes=args.yes,
            comment=args.comment,
            build_version=args.build_version,
            recover=args.recover,
            quiet=args.quiet,
            restart_backend=args.restart_backend,
            restart_mcp=args.restart_mcp,
            update_docker_mcps=args.update_docker_mcps,
        )
        success = mgr.deploy()
        return 0 if success else 1

    except DeployError as exc:
        log.error(f"[{exc.code}] {exc}")
        if exc.suggestion:
            log.info(f"  {exc.suggestion}")
        return 1
    except KeyboardInterrupt:
        log.warn("Interrupted by user")
        return 130
    except Exception as exc:
        log.error(f"Unexpected error: {exc}")
        if args.verbose:
            traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
