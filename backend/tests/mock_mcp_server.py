"""Mock MCP Server for integration testing.

A simple Python script that speaks JSON-RPC 2.0 over stdio, responding to
predefined tool calls with configurable responses, delays, and errors.

Usage:
    python mock_mcp_server.py                    # Normal mode
    python mock_mcp_server.py --delay 2.0        # Add 2s delay to responses
    python mock_mcp_server.py --error-rate 0.3   # 30% chance of tool errors
    python mock_mcp_server.py --malformed         # Occasionally send malformed JSON
    python mock_mcp_server.py --silent            # Don't respond (test timeout detection)
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger("mock_mcp_server")

# ---------------------------------------------------------------------------
# Mock tool definitions
# ---------------------------------------------------------------------------

MOCK_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "echo",
        "description": "Echo back the input parameters",
        "inputSchema": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "Message to echo"},
            },
            "required": ["message"],
        },
    },
    {
        "name": "slow_tool",
        "description": "A tool that takes a configurable amount of time",
        "inputSchema": {
            "type": "object",
            "properties": {
                "delay_seconds": {"type": "number", "description": "Seconds to wait"},
            },
            "required": ["delay_seconds"],
        },
    },
    {
        "name": "error_tool",
        "description": "A tool that always returns an error",
        "inputSchema": {
            "type": "object",
            "properties": {
                "error_message": {"type": "string", "description": "Error to produce"},
            },
        },
    },
    {
        "name": "large_output",
        "description": "Returns a large output payload",
        "inputSchema": {
            "type": "object",
            "properties": {
                "size_kb": {"type": "integer", "description": "Output size in KB"},
            },
        },
    },
    {
        "name": "destructive_action",
        "description": "Simulates a destructive action",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": {"type": "string"},
                "action": {"type": "string"},
            },
            "required": ["target", "action"],
        },
    },
]

# ---------------------------------------------------------------------------
# Server capabilities
# ---------------------------------------------------------------------------

SERVER_INFO = {
    "name": "mock-mcp-server",
    "version": "1.0.0",
}

SERVER_CAPABILITIES = {
    "tools": {},
    "resources": {},
    "prompts": {},
    "logging": {},
}


# ---------------------------------------------------------------------------
# JSON-RPC helpers
# ---------------------------------------------------------------------------

def write_response(data: Dict[str, Any]) -> None:
    """Write a JSON-RPC response to stdout."""
    line = json.dumps(data)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def make_result(request_id: Any, result: Any) -> Dict[str, Any]:
    """Create a JSON-RPC success response."""
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "result": result,
    }


def make_error(request_id: Any, code: int, message: str, data: Any = None) -> Dict[str, Any]:
    """Create a JSON-RPC error response."""
    error: Dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": error,
    }


def send_notification(method: str, params: Dict[str, Any]) -> None:
    """Send a JSON-RPC notification (no id)."""
    write_response({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    })


# ---------------------------------------------------------------------------
# Request handlers
# ---------------------------------------------------------------------------

def handle_initialize(request_id: Any, params: Dict[str, Any]) -> None:
    """Handle initialize request."""
    logger.debug("Initialize request: %s", params)
    write_response(make_result(request_id, {
        "protocolVersion": params.get("protocolVersion", "2024-11-05"),
        "capabilities": SERVER_CAPABILITIES,
        "serverInfo": SERVER_INFO,
    }))


def handle_tools_list(request_id: Any) -> None:
    """Handle tools/list request."""
    logger.debug("Tools/list request")
    write_response(make_result(request_id, {"tools": MOCK_TOOLS}))


def handle_tools_call(
    request_id: Any,
    params: Dict[str, Any],
    config: ServerConfig,
) -> None:
    """Handle tools/call request."""
    tool_name = params.get("name", "unknown")
    arguments = params.get("arguments", {})

    logger.debug("Tools/call: %s(%s)", tool_name, arguments)

    # Apply configured delay
    if config.delay > 0:
        time.sleep(config.delay)

    # Silent mode — don't respond (test timeout)
    if config.silent:
        logger.debug("Silent mode — not responding to %s", tool_name)
        return

    # Random error injection
    if config.error_rate > 0 and random.random() < config.error_rate:
        write_response(make_result(request_id, {
            "content": [{"type": "text", "text": f"Random error in {tool_name}"}],
            "isError": True,
        }))
        return

    # Occasionally send malformed JSON
    if config.malformed and random.random() < 0.1:
        sys.stdout.write('{"jsonrpc": "2.0", "id": ' + str(request_id) + ', "result": {BROKEN}\n')
        sys.stdout.flush()
        return

    # Handle specific tools
    if tool_name == "echo":
        message = arguments.get("message", "")
        write_response(make_result(request_id, {
            "content": [{"type": "text", "text": message}],
        }))

    elif tool_name == "slow_tool":
        delay = float(arguments.get("delay_seconds", 1.0))
        # Send progress notifications
        steps = max(1, int(delay))
        for i in range(steps):
            send_notification("notifications/progress", {
                "progressToken": f"progress-{request_id}",
                "progress": i + 1,
                "total": steps,
                "message": f"Processing step {i + 1}/{steps}",
            })
            time.sleep(delay / steps)
        write_response(make_result(request_id, {
            "content": [{"type": "text", "text": f"Completed after {delay}s"}],
        }))

    elif tool_name == "error_tool":
        error_msg = arguments.get("error_message", "Intentional test error")
        write_response(make_result(request_id, {
            "content": [{"type": "text", "text": error_msg}],
            "isError": True,
        }))

    elif tool_name == "large_output":
        size_kb = int(arguments.get("size_kb", 10))
        large_text = "A" * (size_kb * 1024)
        write_response(make_result(request_id, {
            "content": [{"type": "text", "text": large_text}],
        }))

    elif tool_name == "destructive_action":
        target = arguments.get("target", "unknown")
        action = arguments.get("action", "unknown")
        write_response(make_result(request_id, {
            "content": [{"type": "text", "text": f"Executed {action} on {target}"}],
        }))

    else:
        write_response(make_error(request_id, -32601, f"Unknown tool: {tool_name}"))


# ---------------------------------------------------------------------------
# Server config
# ---------------------------------------------------------------------------

class ServerConfig:
    """Server configuration from CLI args."""

    def __init__(self, args: argparse.Namespace) -> None:
        self.delay: float = args.delay
        self.error_rate: float = args.error_rate
        self.malformed: bool = args.malformed
        self.silent: bool = args.silent


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    """Main server loop — read JSON-RPC from stdin, write responses to stdout."""
    parser = argparse.ArgumentParser(description="Mock MCP Server for testing")
    parser.add_argument("--delay", type=float, default=0.0, help="Response delay in seconds")
    parser.add_argument("--error-rate", type=float, default=0.0, help="Random error probability (0-1)")
    parser.add_argument("--malformed", action="store_true", help="Occasionally send malformed JSON")
    parser.add_argument("--silent", action="store_true", help="Don't respond to tool calls (test timeout)")
    parser.add_argument("--verbose", action="store_true", help="Enable debug logging to stderr")
    args = parser.parse_args()

    if args.verbose:
        logging.basicConfig(level=logging.DEBUG, stream=sys.stderr, format="%(levelname)s: %(message)s")
    else:
        logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

    config = ServerConfig(args)

    logger.debug("Mock MCP server started: delay=%.1f error_rate=%.1f malformed=%s silent=%s",
                 config.delay, config.error_rate, config.malformed, config.silent)

    # Write server log to stderr (captured by ProcessProxy)
    sys.stderr.write("Mock MCP server ready\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("Received non-JSON input: %s", line[:100])
            continue

        if not isinstance(msg, dict):
            logger.warning("Received non-object JSON: %s", type(msg))
            continue

        method = msg.get("method", "")
        request_id = msg.get("id")
        params = msg.get("params", {})

        # Notifications (no id) — acknowledge silently
        if request_id is None:
            logger.debug("Received notification: %s", method)
            continue

        # Handle requests
        if method == "initialize":
            handle_initialize(request_id, params)
        elif method == "tools/list":
            handle_tools_list(request_id)
        elif method == "tools/call":
            handle_tools_call(request_id, params, config)
        elif method == "notifications/initialized":
            logger.debug("Client initialized notification")
        else:
            write_response(make_error(request_id, -32601, f"Method not found: {method}"))

    logger.debug("Mock MCP server shutting down (stdin closed)")


if __name__ == "__main__":
    main()
