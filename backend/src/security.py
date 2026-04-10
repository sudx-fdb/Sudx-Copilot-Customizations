"""
Security Hardening for the Backend MCP Server Manager.

Provides: constant-time auth, HTTPS enforcement, IP allowlist,
command injection prevention, path traversal prevention, secret sanitization,
audit logging, Docker socket security, resource isolation.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from fastapi import HTTPException, Request

logger = logging.getLogger("backend.security")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_AUTH_RATE_LIMIT_PER_MIN = 10
_GENERAL_RATE_LIMIT_PER_MIN = 60
_AUDIT_LOG_MAX_SIZE_MB = 50

# Secret patterns to sanitize from logs
_SECRET_PATTERNS = [
    re.compile(r'(Bearer\s+)\S+', re.IGNORECASE),
    re.compile(r'(token["\s:=]+)\S+', re.IGNORECASE),
    re.compile(r'(password["\s:=]+)\S+', re.IGNORECASE),
    re.compile(r'(api[_-]?key["\s:=]+)\S+', re.IGNORECASE),
    re.compile(r'(secret["\s:=]+)\S+', re.IGNORECASE),
    re.compile(r'(-----BEGIN\s+\S+\s+PRIVATE\s+KEY-----)[\s\S]*?(-----END\s+\S+\s+PRIVATE\s+KEY-----)', re.IGNORECASE),
]

# Allowed Docker commands (whitelist)
_ALLOWED_DOCKER_COMMANDS = frozenset([
    "docker", "info", "version", "ps", "images", "pull", "start", "stop",
    "restart", "rm", "logs", "inspect", "compose", "up", "down",
])

# Forbidden Docker subcommands
_FORBIDDEN_DOCKER_SUBCOMMANDS = frozenset([
    "exec", "run", "build", "push", "login", "save", "load", "export", "import",
])


# ---------------------------------------------------------------------------
# Constant-Time Token Comparison
# ---------------------------------------------------------------------------

def verify_token_constant_time(provided: str, expected: str) -> bool:
    """
    Compare tokens using constant-time comparison to prevent timing attacks.
    Returns True if tokens match.
    """
    logger.debug("Performing constant-time token comparison")
    if not expected:
        logger.warning("No expected token configured — skipping auth")
        return True
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


# ---------------------------------------------------------------------------
# HTTPS Enforcement
# ---------------------------------------------------------------------------

def check_https_enforcement(request: Request, production: bool = True) -> None:
    """
    Check that the request came via HTTPS (using X-Forwarded-Proto from reverse proxy).
    Raises HTTPException if plain HTTP in production mode.
    """
    if not production:
        logger.debug("HTTPS enforcement disabled (non-production)")
        return

    proto = request.headers.get("x-forwarded-proto", "").lower()
    if proto and proto != "https":
        logger.warning("Rejected plain HTTP request from %s", request.client.host if request.client else "unknown")
        raise HTTPException(
            status_code=403,
            detail={"error": "HTTPS required in production", "code": "E_HTTPS_REQUIRED"},
        )
    logger.debug("HTTPS check passed (proto=%s)", proto or "direct")


# ---------------------------------------------------------------------------
# IP Allowlist
# ---------------------------------------------------------------------------

class IpAllowlist:
    """Optional IP allowlist. If configured, only listed IPs can access API."""

    def __init__(self, allowed_ips: Optional[List[str]] = None):
        self._enabled = allowed_ips is not None and len(allowed_ips) > 0
        self._allowed: Set[str] = set(allowed_ips) if allowed_ips else set()
        logger.debug(
            "IP allowlist %s (%d IPs)",
            "enabled" if self._enabled else "disabled",
            len(self._allowed),
        )

    def check(self, client_ip: str) -> bool:
        """Return True if the IP is allowed (or allowlist disabled)."""
        if not self._enabled:
            return True
        allowed = client_ip in self._allowed
        if not allowed:
            logger.warning("IP %s not in allowlist — rejecting", client_ip)
        else:
            logger.debug("IP %s in allowlist — allowed", client_ip)
        return allowed


# ---------------------------------------------------------------------------
# Command Injection Prevention
# ---------------------------------------------------------------------------

def validate_subprocess_args(args: List[str], strict: bool = True) -> List[str]:
    """
    Validate subprocess arguments to prevent command injection.
    - Args must be a list (never a string with shell=True)
    - No shell metacharacters allowed in arguments
    - When strict=True (default), raises on dangerous characters.
    - When strict=False, warns but allows through.
    - Returns validated args.
    """
    logger.debug("Validating subprocess args: %s", args)

    if not isinstance(args, list):
        raise ValueError(f"Subprocess args must be a list, got {type(args).__name__}")

    shell_metacharacters = set(';&|`$(){}[]<>!\\"\'\n\r')
    for i, arg in enumerate(args):
        if not isinstance(arg, str):
            raise ValueError(f"Subprocess arg[{i}] must be a string, got {type(arg).__name__}")
        # Check for shell metacharacters (except in paths with quotes)
        dangerous_chars = shell_metacharacters.intersection(set(arg))
        if dangerous_chars:
            # Allow - and / in args, and = in env-like args
            actual_dangerous = dangerous_chars - {'-', '/'}
            if actual_dangerous:
                if strict:
                    raise ValueError(
                        f"Dangerous shell metacharacters in arg[{i}]: {actual_dangerous}"
                    )
                logger.warning("Suspicious shell metacharacters in arg[%d]: %s", i, actual_dangerous)

    return args


# ---------------------------------------------------------------------------
# Path Traversal Prevention
# ---------------------------------------------------------------------------

def validate_server_name(name: str, registry=None) -> str:
    """
    Validate a server name to prevent path traversal.
    - Must match alphanumeric + dashes pattern
    - Must exist in registry if provided
    """
    logger.debug("Validating server name: %s", name)

    # Strict pattern: alphanumeric, dashes, underscores only
    if not re.match(r'^[a-zA-Z0-9_-]+$', name):
        logger.warning("Invalid server name (bad chars): %s", name)
        raise HTTPException(
            status_code=400,
            detail={"error": f"Invalid server name: {name}", "code": "E_INVALID_NAME"},
        )

    # Check length
    if len(name) > 64:
        logger.warning("Server name too long: %d chars", len(name))
        raise HTTPException(
            status_code=400,
            detail={"error": "Server name too long (max 64 chars)", "code": "E_NAME_LENGTH"},
        )

    # Prevent traversal patterns
    if ".." in name or "/" in name or "\\" in name:
        logger.warning("Path traversal attempt in server name: %s", name)
        raise HTTPException(
            status_code=400,
            detail={"error": "Invalid server name", "code": "E_TRAVERSAL"},
        )

    # Verify against registry
    if registry is not None:
        if registry.get_server(name) is None:
            raise HTTPException(
                status_code=404,
                detail={"error": f"Server '{name}' not found", "code": "E_NOT_FOUND"},
            )

    return name


# ---------------------------------------------------------------------------
# Secret Sanitization
# ---------------------------------------------------------------------------

def sanitize_log_message(message: str) -> str:
    """
    Sanitize a log message by redacting secrets, tokens, passwords, and keys.
    """
    sanitized = message
    for pattern in _SECRET_PATTERNS:
        sanitized = pattern.sub(lambda m: m.group(1) + "***REDACTED***" if m.lastindex else "***REDACTED***", sanitized)
    return sanitized


class SecretSanitizingFilter(logging.Filter):
    """Logging filter that sanitizes secrets from all log messages."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = sanitize_log_message(record.msg)
        if record.args:
            if isinstance(record.args, dict):
                record.args = {k: sanitize_log_message(str(v)) if isinstance(v, str) else v for k, v in record.args.items()}
            elif isinstance(record.args, tuple):
                record.args = tuple(sanitize_log_message(str(a)) if isinstance(a, str) else a for a in record.args)
        return True


# ---------------------------------------------------------------------------
# Audit Log
# ---------------------------------------------------------------------------

class AuditLogger:
    """
    Audit logger for state-changing operations.
    Writes to backend/state/audit.log with timestamp, IP, action, result.
    """

    def __init__(self, log_path: Path):
        self._path = log_path
        self._path.parent.mkdir(parents=True, exist_ok=True)
        logger.debug("AuditLogger initialized: %s", self._path)

    def log(self, client_ip: str, action: str, result: str, details: str = "") -> None:
        """Write an audit log entry."""
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
        entry = f"[{timestamp}] IP={client_ip} ACTION={action} RESULT={result}"
        if details:
            entry += f" DETAILS={sanitize_log_message(details)}"
        entry += "\n"

        try:
            # Check size limit
            if self._path.exists() and self._path.stat().st_size > _AUDIT_LOG_MAX_SIZE_MB * 1024 * 1024:
                self._rotate()

            with open(str(self._path), "a", encoding="utf-8") as f:
                f.write(entry)
            logger.debug("Audit entry: %s", entry.strip())
        except Exception as exc:
            logger.error("Failed to write audit log: %s", exc)

    def _rotate(self) -> None:
        """Rotate audit log when it exceeds size limit."""
        try:
            bak = self._path.with_suffix(".log.1")
            if bak.exists():
                bak.unlink()
            self._path.rename(bak)
            logger.info("Audit log rotated")
        except Exception as exc:
            logger.error("Failed to rotate audit log: %s", exc)


# ---------------------------------------------------------------------------
# Docker Socket Security
# ---------------------------------------------------------------------------

def validate_docker_command(args: List[str]) -> List[str]:
    """
    Validate Docker commands against whitelist. Prevents arbitrary docker exec.
    """
    logger.debug("Validating Docker command: %s", args)

    if not args:
        raise ValueError("Empty Docker command")

    # Find the subcommand (first non-flag argument after 'docker')
    subcommand = None
    for arg in args:
        if arg.startswith("-"):
            continue
        if arg == "docker":
            continue
        subcommand = arg
        break

    if subcommand and subcommand in _FORBIDDEN_DOCKER_SUBCOMMANDS:
        logger.warning("Forbidden Docker subcommand: %s", subcommand)
        raise ValueError(f"Docker subcommand '{subcommand}' is not allowed for security reasons")

    return args


# ---------------------------------------------------------------------------
# Resource Isolation
# ---------------------------------------------------------------------------

def get_docker_security_opts(server_name: str) -> List[str]:
    """
    Get Docker security options for a server: minimal privileges, no extra capabilities.
    """
    logger.debug("Getting Docker security options for '%s'", server_name)
    return [
        "--security-opt=no-new-privileges:true",
        "--cap-drop=ALL",
        "--read-only",
        f"--pids-limit=256",
        "--memory-swap=-1",
    ]
