"""MCP Logging Helper — Utility functions for standardized log emission.

Provides helper functions that MCP server code can import for consistent,
structured logging. These helpers standardize the format across all MCPs
and ensure all tool calls, external API calls, and errors are captured
by the Central MCP Logger event bus.

Usage (from within MCP server code):
    from mcp_logging_helper import log_tool_start, log_tool_end, log_tool_error
    log_tool_start("nmap_scan", {"target": "10.0.0.1"})
    # ... do work ...
    log_tool_end("nmap_scan", result, duration_ms=1234)
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger("mcp.logging_helper")


# ---------------------------------------------------------------------------
# Sensitive field redaction
# ---------------------------------------------------------------------------

_DEFAULT_SENSITIVE_PATTERNS: List[str] = [
    r"password",
    r"secret",
    r"token",
    r"api_?key",
    r"auth_?key",
    r"access_?key",
    r"secret_?key",
    r"private_?key",
    r"ssh_?key",
    r"credential",
]

_compiled_sensitive: List[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE) for p in _DEFAULT_SENSITIVE_PATTERNS
]


def set_sensitive_patterns(patterns: List[str]) -> None:
    """Replace the default sensitive field patterns with custom ones."""
    global _compiled_sensitive
    _compiled_sensitive = [re.compile(p, re.IGNORECASE) for p in patterns]
    logger.debug("Updated sensitive patterns: %d patterns", len(patterns))


def redact_sensitive(data: Any, patterns: Optional[List[re.Pattern[str]]] = None) -> Any:
    """Recursively redact sensitive fields from data structures.

    Args:
        data: Dict, list, or primitive value to redact.
        patterns: Optional list of compiled regex patterns. Uses defaults if None.

    Returns:
        Copy of data with sensitive values replaced by '[REDACTED]'.
    """
    if patterns is None:
        patterns = _compiled_sensitive

    if isinstance(data, dict):
        result = {}
        for key, value in data.items():
            is_sensitive = any(p.search(str(key)) for p in patterns)
            if is_sensitive and isinstance(value, (str, int, float)):
                result[key] = "[REDACTED]"
            else:
                result[key] = redact_sensitive(value, patterns)
        return result
    elif isinstance(data, (list, tuple)):
        return [redact_sensitive(item, patterns) for item in data]
    else:
        return data


# ---------------------------------------------------------------------------
# Output preview truncation
# ---------------------------------------------------------------------------

_DEFAULT_PREVIEW_MAX_BYTES: int = 4096


def truncate_output(data: Any, max_bytes: int = _DEFAULT_PREVIEW_MAX_BYTES) -> Dict[str, Any]:
    """Truncate tool output to a preview length.

    Args:
        data: The tool output (will be JSON-serialized for size check).
        max_bytes: Maximum bytes for preview (default 4096).

    Returns:
        Dict with 'preview', 'full_size', 'truncated' fields.
    """
    try:
        serialized = json.dumps(data, default=str)
    except (TypeError, ValueError):
        serialized = str(data)

    full_size = len(serialized.encode("utf-8", errors="replace"))

    if full_size <= max_bytes:
        return {
            "preview": serialized,
            "full_size": full_size,
            "truncated": False,
        }

    # Truncate at byte boundary, ensuring valid UTF-8
    truncated_str = serialized.encode("utf-8", errors="replace")[:max_bytes].decode(
        "utf-8", errors="ignore"
    )
    return {
        "preview": truncated_str,
        "full_size": full_size,
        "truncated": True,
    }


# ---------------------------------------------------------------------------
# Structured log message format
# ---------------------------------------------------------------------------

@dataclass
class LogMessage:
    """Structured log message format — both human-readable and JSON-parseable."""

    timestamp: str
    mcp_name: str
    tool_name: str
    event: str
    data: Dict[str, Any] = field(default_factory=dict)

    def to_text(self) -> str:
        """Human-readable format."""
        data_str = ""
        if self.data:
            data_str = " " + " ".join(f"{k}={v}" for k, v in self.data.items())
        return f"[{self.timestamp}] [{self.mcp_name}] [{self.tool_name}] [{self.event}]{data_str}"

    def to_json(self) -> str:
        """Machine-parseable JSON format."""
        return json.dumps(
            {
                "timestamp": self.timestamp,
                "mcp_name": self.mcp_name,
                "tool_name": self.tool_name,
                "event": self.event,
                "data": self.data,
            },
            default=str,
        )


# ---------------------------------------------------------------------------
# Tool lifecycle logging helpers
# ---------------------------------------------------------------------------

# Global reference to event bus, set by McpLogger during init
_event_bus = None
_mcp_name: str = "unknown"


def configure(mcp_name: str, event_bus: Any = None) -> None:
    """Configure the logging helper with MCP context.

    Args:
        mcp_name: Name of the MCP server using this helper.
        event_bus: Optional reference to McpEventBus for direct emission.
    """
    global _mcp_name, _event_bus
    _mcp_name = mcp_name
    _event_bus = event_bus
    logger.debug("Configured logging helper for MCP: %s", mcp_name)


def _get_timestamp() -> str:
    """ISO 8601 timestamp with milliseconds."""
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int(time.time() * 1000) % 1000:03d}Z"


def log_tool_start(
    tool_name: str,
    params: Optional[Dict[str, Any]] = None,
    request_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Log the start of a tool call.

    Args:
        tool_name: Name of the MCP tool being invoked.
        params: Input parameters (will be redacted).
        request_id: JSON-RPC request ID for correlation.

    Returns:
        Dict with tool_name, start_time, request_id for passing to log_tool_end.
    """
    safe_params = redact_sensitive(params or {})
    input_size = len(json.dumps(params or {}, default=str))

    msg = LogMessage(
        timestamp=_get_timestamp(),
        mcp_name=_mcp_name,
        tool_name=tool_name,
        event="TOOL_START",
        data={
            "params": safe_params,
            "input_size": input_size,
            "request_id": request_id or "",
        },
    )

    logger.info(msg.to_text())

    return {
        "tool_name": tool_name,
        "start_time": time.monotonic(),
        "request_id": request_id,
    }


def log_tool_end(
    tool_name: str,
    result: Any = None,
    duration_ms: Optional[float] = None,
    context: Optional[Dict[str, Any]] = None,
    preview_max_bytes: int = _DEFAULT_PREVIEW_MAX_BYTES,
) -> None:
    """Log the successful completion of a tool call.

    Args:
        tool_name: Name of the MCP tool.
        result: Tool output (will be truncated and redacted).
        duration_ms: Duration in milliseconds. Calculated from context if not provided.
        context: Context dict returned by log_tool_start.
        preview_max_bytes: Max bytes for output preview.
    """
    if duration_ms is None and context and "start_time" in context:
        duration_ms = (time.monotonic() - context["start_time"]) * 1000

    output_info = truncate_output(result, max_bytes=preview_max_bytes)
    safe_preview = redact_sensitive(output_info.get("preview", ""))

    msg = LogMessage(
        timestamp=_get_timestamp(),
        mcp_name=_mcp_name,
        tool_name=tool_name,
        event="TOOL_END",
        data={
            "duration_ms": round(duration_ms or 0, 2),
            "output_size": output_info.get("full_size", 0),
            "truncated": output_info.get("truncated", False),
            "status": "success",
        },
    )

    logger.info(msg.to_text())


def log_tool_error(
    tool_name: str,
    error: Exception | str,
    duration_ms: Optional[float] = None,
    context: Optional[Dict[str, Any]] = None,
    error_code: Optional[int] = None,
) -> None:
    """Log a tool call error.

    Args:
        tool_name: Name of the MCP tool.
        error: Exception or error message string.
        duration_ms: Duration in milliseconds.
        context: Context dict returned by log_tool_start.
        error_code: Optional JSON-RPC error code.
    """
    if duration_ms is None and context and "start_time" in context:
        duration_ms = (time.monotonic() - context["start_time"]) * 1000

    error_type = type(error).__name__ if isinstance(error, Exception) else "Error"
    error_message = str(error)

    msg = LogMessage(
        timestamp=_get_timestamp(),
        mcp_name=_mcp_name,
        tool_name=tool_name,
        event="TOOL_ERROR",
        data={
            "duration_ms": round(duration_ms or 0, 2),
            "error_type": error_type,
            "error_message": error_message,
            "error_code": error_code,
        },
    )

    logger.error(msg.to_text())


def log_external_call(
    service: str,
    url: str,
    method: str = "GET",
    duration_ms: float = 0,
    status: int = 0,
    error: Optional[str] = None,
) -> None:
    """Log an external API/service call made by the MCP tool.

    Args:
        service: Name of the external service (e.g., 'shodan_api', 'nessus_api').
        url: URL called (sensitive params will be redacted).
        method: HTTP method used.
        duration_ms: Duration of the external call.
        status: HTTP status code returned.
        error: Error message if the call failed.
    """
    # Redact query params that might contain secrets
    safe_url = _redact_url_params(url)

    msg = LogMessage(
        timestamp=_get_timestamp(),
        mcp_name=_mcp_name,
        tool_name=f"external:{service}",
        event="EXTERNAL_CALL",
        data={
            "url": safe_url,
            "method": method,
            "duration_ms": round(duration_ms, 2),
            "status": status,
            "error": error,
        },
    )

    if error:
        logger.warning(msg.to_text())
    else:
        logger.debug(msg.to_text())


def log_destructive_action(
    tool_name: str,
    target: str,
    parameters: Dict[str, Any],
    confirmation_required: bool = True,
) -> None:
    """Log a destructive action with enhanced metadata.

    Used for tools like block_ip, isolate_host, firewall_iptables that
    modify system state in potentially dangerous ways.

    Args:
        tool_name: Name of the destructive tool.
        target: Target of the action (IP, host, resource).
        parameters: Full parameters (will be redacted).
        confirmation_required: Whether user confirmation was required.
    """
    safe_params = redact_sensitive(parameters)

    msg = LogMessage(
        timestamp=_get_timestamp(),
        mcp_name=_mcp_name,
        tool_name=tool_name,
        event="DESTRUCTIVE_ACTION",
        data={
            "target": target,
            "parameters": safe_params,
            "confirmation_required": confirmation_required,
        },
    )

    logger.critical(msg.to_text())


def _redact_url_params(url: str) -> str:
    """Redact sensitive query parameters from URLs."""
    try:
        if "?" not in url:
            return url
        base, query = url.split("?", 1)
        parts = query.split("&")
        safe_parts = []
        for part in parts:
            if "=" in part:
                key, value = part.split("=", 1)
                is_sensitive = any(p.search(key) for p in _compiled_sensitive)
                if is_sensitive:
                    safe_parts.append(f"{key}=[REDACTED]")
                else:
                    safe_parts.append(part)
            else:
                safe_parts.append(part)
        return f"{base}?{'&'.join(safe_parts)}"
    except Exception:
        return url
