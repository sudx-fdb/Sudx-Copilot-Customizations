"""
Structured Logging for the Backend MCP Server Manager.

Provides: JSON file logging, colored console output, per-component loggers,
per-server log files with rotation, main log aggregation, runtime log level
adjustment.
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import os
import sys
import time
from pathlib import Path
from typing import Dict, Optional

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_DEFAULT_LOG_LEVEL = "DEBUG"
_LOG_ROTATION_MAX_BYTES = 10 * 1024 * 1024  # 10 MB
_LOG_ROTATION_BACKUP_COUNT = 5
_CONSOLE_FORMAT = "%(asctime)s %(levelname)-8s [%(name)s] %(message)s"
_CONSOLE_DATE_FORMAT = "%H:%M:%S"

# Component logger names
COMPONENTS = [
    "backend.supervisor",
    "backend.health",
    "backend.updater",
    "backend.api",
    "backend.registry",
    "backend.security",
    "backend.self_healing",
    "backend.models",
    "backend.logger",
]


# ---------------------------------------------------------------------------
# JSON Formatter for file logs
# ---------------------------------------------------------------------------

class JsonFormatter(logging.Formatter):
    """Format log records as JSON lines for structured logging."""

    def format(self, record: logging.LogRecord) -> str:
        log_entry = {
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
        }
        if record.exc_info and record.exc_info[0]:
            log_entry["exception"] = self.formatException(record.exc_info)
        if hasattr(record, "server_name"):
            log_entry["server_name"] = record.server_name
        return json.dumps(log_entry, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Colored Console Formatter
# ---------------------------------------------------------------------------

class ColoredFormatter(logging.Formatter):
    """Colored console output for human-readable logs."""

    COLORS = {
        "DEBUG": "\033[36m",     # Cyan
        "INFO": "\033[32m",      # Green
        "WARNING": "\033[33m",   # Yellow
        "ERROR": "\033[31m",     # Red
        "CRITICAL": "\033[41m",  # Red background
    }
    RESET = "\033[0m"

    def format(self, record: logging.LogRecord) -> str:
        color = self.COLORS.get(record.levelname, "")
        record.levelname = f"{color}{record.levelname}{self.RESET}"
        return super().format(record)


# ---------------------------------------------------------------------------
# Logging Setup
# ---------------------------------------------------------------------------

_log_dir: Optional[Path] = None
_server_loggers: Dict[str, logging.Logger] = {}
_initialized: bool = False


def setup_logging(
    log_dir: str = "logs",
    console_level: str = "INFO",
    file_level: str = "DEBUG",
) -> None:
    """
    Initialize the structured logging system.

    - Console: colored human-readable
    - Main file: backend.log (JSON, rotated)
    - Per-component loggers with individual levels
    """
    global _log_dir, _initialized

    _log_dir = Path(log_dir)
    _log_dir.mkdir(parents=True, exist_ok=True)

    # Root logger config
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)  # Allow all, filter at handler level

    # Clear existing handlers from root to prevent duplicates
    root.handlers.clear()

    # Console handler — colored, human-readable
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(getattr(logging, console_level.upper(), logging.INFO))
    console_handler.setFormatter(ColoredFormatter(_CONSOLE_FORMAT, datefmt=_CONSOLE_DATE_FORMAT))
    root.addHandler(console_handler)

    # Main file handler — JSON, rotated
    main_log_path = _log_dir / "backend.log"
    file_handler = logging.handlers.RotatingFileHandler(
        str(main_log_path),
        maxBytes=_LOG_ROTATION_MAX_BYTES,
        backupCount=_LOG_ROTATION_BACKUP_COUNT,
        encoding="utf-8",
    )
    file_handler.setLevel(getattr(logging, file_level.upper(), logging.DEBUG))
    file_handler.setFormatter(JsonFormatter())
    root.addHandler(file_handler)

    # Initialize per-component loggers
    for component in COMPONENTS:
        comp_logger = logging.getLogger(component)
        comp_logger.setLevel(logging.DEBUG)

    _initialized = True
    logging.getLogger("backend.logger").info(
        "Logging initialized: console=%s, file=%s, dir=%s",
        console_level, file_level, log_dir,
    )


# ---------------------------------------------------------------------------
# Per-Server Log Files
# ---------------------------------------------------------------------------

def get_server_logger(server_name: str) -> logging.Logger:
    """
    Get or create a per-server logger with its own rotating file handler.
    Writes to: logs/{server_name}.log
    """
    if server_name in _server_loggers:
        return _server_loggers[server_name]

    logger_name = f"backend.server.{server_name}"
    srv_logger = logging.getLogger(logger_name)
    srv_logger.setLevel(logging.DEBUG)

    if _log_dir is not None:
        log_path = _log_dir / f"{server_name}.log"
        handler = logging.handlers.RotatingFileHandler(
            str(log_path),
            maxBytes=_LOG_ROTATION_MAX_BYTES,
            backupCount=_LOG_ROTATION_BACKUP_COUNT,
            encoding="utf-8",
        )
        handler.setFormatter(JsonFormatter())
        srv_logger.addHandler(handler)

    _server_loggers[server_name] = srv_logger
    logging.getLogger("backend.logger").debug(
        "Created per-server logger: %s → %s",
        server_name, _log_dir / f"{server_name}.log" if _log_dir else "no-dir",
    )
    return srv_logger


# ---------------------------------------------------------------------------
# Runtime Log Level Adjustment
# ---------------------------------------------------------------------------

_VALID_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}


def set_log_level(component: str, level: str) -> bool:
    """
    Adjust log level of a component at runtime.
    Returns True if successful.
    """
    level_upper = level.upper()
    if level_upper not in _VALID_LEVELS:
        logging.getLogger("backend.logger").warning(
            "Invalid log level '%s' — valid: %s", level, _VALID_LEVELS,
        )
        return False

    target_logger = logging.getLogger(component)
    old_level = logging.getLevelName(target_logger.level)
    target_logger.setLevel(getattr(logging, level_upper))
    logging.getLogger("backend.logger").info(
        "Log level changed: %s %s → %s", component, old_level, level_upper,
    )
    return True


def get_log_levels() -> Dict[str, str]:
    """Return current log levels for all components."""
    levels = {}
    for component in COMPONENTS:
        comp_logger = logging.getLogger(component)
        levels[component] = logging.getLevelName(comp_logger.level)
    # Include server loggers
    for name, srv_logger in _server_loggers.items():
        levels[f"backend.server.{name}"] = logging.getLevelName(srv_logger.level)
    return levels
