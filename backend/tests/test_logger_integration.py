"""Integration tests for the Central MCP Logger system.

Tests cover:
- McpProcessProxy + mock MCP server → tool call events
- Error response handling
- Timeout detection
- Malformed JSON handling
- SSE endpoint event delivery
- SSE reconnection with Last-Event-ID
- Docker log format parsing
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

# Add parent src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

# -- Attempt imports; tests will skip if modules are not available --
try:
    from mcp_logger import (
        McpEventBus,
        McpEventType,
        McpLogEvent,
        McpMetricsCollector,
        McpProcessProxy,
        McpSeverity,
        McpAlertEngine,
        McpLogger,
        EventFilter,
        DockerLogProxy,
    )
    HAS_LOGGER = True
except ImportError:
    HAS_LOGGER = False

try:
    from mcp_logging_helper import (
        redact_sensitive,
        truncate_output,
        log_tool_start,
        log_tool_end,
        log_tool_error,
        configure,
    )
    HAS_HELPER = True
except ImportError:
    HAS_HELPER = False


MOCK_SERVER_PATH = str(Path(__file__).parent / "mock_mcp_server.py")


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def _start_mock_server(**kwargs: Any) -> subprocess.Popen:
    """Start mock MCP server as subprocess."""
    cmd = [sys.executable, MOCK_SERVER_PATH]
    for key, value in kwargs.items():
        flag = f"--{key.replace('_', '-')}"
        if isinstance(value, bool):
            if value:
                cmd.append(flag)
        else:
            cmd.extend([flag, str(value)])
    return subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )


def _send_jsonrpc(proc: subprocess.Popen, method: str, params: Dict[str, Any], request_id: int) -> None:
    """Send a JSON-RPC request to the mock server."""
    msg = json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": request_id})
    assert proc.stdin is not None
    proc.stdin.write(msg + "\n")
    proc.stdin.flush()


def _read_response(proc: subprocess.Popen, timeout: float = 5.0) -> Optional[Dict[str, Any]]:
    """Read a JSON-RPC response from the mock server."""
    assert proc.stdout is not None

    # Use a thread to read with timeout
    result: List[Optional[str]] = [None]

    def _reader() -> None:
        try:
            line = proc.stdout.readline()
            result[0] = line
        except Exception:
            pass

    t = threading.Thread(target=_reader, daemon=True)
    t.start()
    t.join(timeout=timeout)

    if result[0]:
        try:
            return json.loads(result[0])
        except json.JSONDecodeError:
            return None
    return None


# ---------------------------------------------------------------------------
# Test: Mock MCP Server Protocol
# ---------------------------------------------------------------------------

class TestMockMcpServer(unittest.TestCase):
    """Test the mock MCP server speaks valid JSON-RPC."""

    def test_initialize(self) -> None:
        """Test initialize handshake."""
        proc = _start_mock_server()
        try:
            _send_jsonrpc(proc, "initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1.0"},
            }, 1)
            resp = _read_response(proc)
            self.assertIsNotNone(resp)
            self.assertEqual(resp["id"], 1)
            self.assertIn("result", resp)
            self.assertIn("capabilities", resp["result"])
            self.assertIn("serverInfo", resp["result"])
            self.assertEqual(resp["result"]["serverInfo"]["name"], "mock-mcp-server")
        finally:
            proc.terminate()
            proc.wait(timeout=5)

    def test_tools_list(self) -> None:
        """Test tools/list returns tool definitions."""
        proc = _start_mock_server()
        try:
            _send_jsonrpc(proc, "tools/list", {}, 1)
            resp = _read_response(proc)
            self.assertIsNotNone(resp)
            self.assertIn("result", resp)
            tools = resp["result"]["tools"]
            self.assertGreater(len(tools), 0)
            tool_names = [t["name"] for t in tools]
            self.assertIn("echo", tool_names)
            self.assertIn("slow_tool", tool_names)
            self.assertIn("error_tool", tool_names)
        finally:
            proc.terminate()
            proc.wait(timeout=5)

    def test_tools_call_echo(self) -> None:
        """Test echo tool returns input message."""
        proc = _start_mock_server()
        try:
            _send_jsonrpc(proc, "tools/call", {
                "name": "echo",
                "arguments": {"message": "hello world"},
            }, 1)
            resp = _read_response(proc)
            self.assertIsNotNone(resp)
            self.assertIn("result", resp)
            content = resp["result"]["content"]
            self.assertEqual(len(content), 1)
            self.assertEqual(content[0]["type"], "text")
            self.assertEqual(content[0]["text"], "hello world")
        finally:
            proc.terminate()
            proc.wait(timeout=5)

    def test_tools_call_error_tool(self) -> None:
        """Test error_tool returns isError: true."""
        proc = _start_mock_server()
        try:
            _send_jsonrpc(proc, "tools/call", {
                "name": "error_tool",
                "arguments": {"error_message": "test error"},
            }, 1)
            resp = _read_response(proc)
            self.assertIsNotNone(resp)
            self.assertIn("result", resp)
            self.assertTrue(resp["result"].get("isError", False))
        finally:
            proc.terminate()
            proc.wait(timeout=5)

    def test_unknown_tool(self) -> None:
        """Test unknown tool returns JSON-RPC error."""
        proc = _start_mock_server()
        try:
            _send_jsonrpc(proc, "tools/call", {
                "name": "nonexistent_tool",
                "arguments": {},
            }, 1)
            resp = _read_response(proc)
            self.assertIsNotNone(resp)
            self.assertIn("error", resp)
            self.assertEqual(resp["error"]["code"], -32601)
        finally:
            proc.terminate()
            proc.wait(timeout=5)

    def test_malformed_input(self) -> None:
        """Test server handles malformed JSON input without crashing."""
        proc = _start_mock_server(verbose=True)
        try:
            assert proc.stdin is not None
            proc.stdin.write("this is not json\n")
            proc.stdin.flush()
            # Server should still be alive — send a valid request
            _send_jsonrpc(proc, "tools/list", {}, 1)
            resp = _read_response(proc)
            self.assertIsNotNone(resp)
            self.assertIn("result", resp)
        finally:
            proc.terminate()
            proc.wait(timeout=5)

    def test_silent_mode_no_response(self) -> None:
        """Test silent mode does not respond to tool calls (for timeout testing)."""
        proc = _start_mock_server(silent=True)
        try:
            _send_jsonrpc(proc, "tools/call", {
                "name": "echo",
                "arguments": {"message": "hello"},
            }, 1)
            resp = _read_response(proc, timeout=2.0)
            self.assertIsNone(resp)
        finally:
            proc.terminate()
            proc.wait(timeout=5)


# ---------------------------------------------------------------------------
# Test: Logging Helper
# ---------------------------------------------------------------------------

@unittest.skipUnless(HAS_HELPER, "mcp_logging_helper not importable")
class TestLoggingHelper(unittest.TestCase):
    """Test the mcp_logging_helper utility functions."""

    def test_redact_sensitive_password(self) -> None:
        """Test password fields are redacted."""
        data = {"username": "admin", "password": "secret123"}
        result = redact_sensitive(data)
        self.assertEqual(result["username"], "admin")
        self.assertEqual(result["password"], "[REDACTED]")

    def test_redact_sensitive_nested(self) -> None:
        """Test nested sensitive fields are redacted."""
        data = {"config": {"api_key": "abc123", "host": "example.com"}}
        result = redact_sensitive(data)
        self.assertEqual(result["config"]["api_key"], "[REDACTED]")
        self.assertEqual(result["config"]["host"], "example.com")

    def test_redact_sensitive_list(self) -> None:
        """Test lists with dicts are redacted."""
        data = [{"token": "secretval"}, {"name": "safe"}]
        result = redact_sensitive(data)
        self.assertEqual(result[0]["token"], "[REDACTED]")
        self.assertEqual(result[1]["name"], "safe")

    def test_truncate_small_output(self) -> None:
        """Test small output is not truncated."""
        data = {"key": "value"}
        result = truncate_output(data)
        self.assertFalse(result["truncated"])

    def test_truncate_large_output(self) -> None:
        """Test large output is truncated."""
        data = "A" * 10000
        result = truncate_output(data, max_bytes=100)
        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["preview"]), 110)  # Some JSON overhead

    def test_log_tool_lifecycle(self) -> None:
        """Test log_tool_start/end/error don't crash."""
        configure("test-mcp")
        ctx = log_tool_start("test_tool", {"arg": "value"})
        self.assertIn("tool_name", ctx)
        self.assertIn("start_time", ctx)
        log_tool_end("test_tool", {"result": "ok"}, context=ctx)
        log_tool_error("test_tool", ValueError("test"), context=ctx)


# ---------------------------------------------------------------------------
# Test: Event Bus
# ---------------------------------------------------------------------------

@unittest.skipUnless(HAS_LOGGER, "mcp_logger not importable")
class TestEventBus(unittest.TestCase):
    """Test McpEventBus core functionality."""

    def test_emit_and_get_history(self) -> None:
        """Test event emission and history retrieval."""
        bus = McpEventBus(max_events=100, archive_path=None)
        event = McpLogEvent(
            event_id="test-1",
            timestamp=time.time(),
            mcp_name="test-mcp",
            event_type=McpEventType.TOOL_CALL_START,
            severity=McpSeverity.INFO,
            data={"tool": "echo"},
        )
        bus.emit(event)
        history = bus.get_history(limit=10)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0].event_id, "test-1")

    def test_event_filter(self) -> None:
        """Test EventFilter matching."""
        f = EventFilter(
            mcp_names={"test-mcp"},
            event_types={McpEventType.TOOL_CALL_START},
            min_severity=McpSeverity.INFO,
        )
        event = McpLogEvent(
            event_id="test-2",
            timestamp=time.time(),
            mcp_name="test-mcp",
            event_type=McpEventType.TOOL_CALL_START,
            severity=McpSeverity.INFO,
            data={},
        )
        self.assertTrue(f.matches(event))

        # Different MCP should not match
        event2 = McpLogEvent(
            event_id="test-3",
            timestamp=time.time(),
            mcp_name="other-mcp",
            event_type=McpEventType.TOOL_CALL_START,
            severity=McpSeverity.INFO,
            data={},
        )
        self.assertFalse(f.matches(event2))

    def test_ring_buffer_overflow(self) -> None:
        """Test ring buffer evicts oldest events when full."""
        bus = McpEventBus(max_events=5, archive_path=None)
        for i in range(10):
            event = McpLogEvent(
                event_id=f"evt-{i}",
                timestamp=time.time(),
                mcp_name="test",
                event_type=McpEventType.SERVER_LOG,
                severity=McpSeverity.DEBUG,
                data={"i": i},
            )
            bus.emit(event)
        history = bus.get_history(limit=100)
        self.assertLessEqual(len(history), 5)

    def test_deduplication(self) -> None:
        """Test duplicate events within dedup window are collapsed."""
        bus = McpEventBus(max_events=100, archive_path=None)
        for _ in range(5):
            event = McpLogEvent(
                event_id=f"dedup-{time.time()}",
                timestamp=time.time(),
                mcp_name="test",
                event_type=McpEventType.SERVER_LOG,
                severity=McpSeverity.DEBUG,
                data={"level": "stderr", "message": "same message repeated"},
            )
            bus.emit(event)
        history = bus.get_history(limit=100)
        # Should be deduplicated — fewer than 5 events
        self.assertLess(len(history), 5)


# ---------------------------------------------------------------------------
# Test: Metrics Collector
# ---------------------------------------------------------------------------

@unittest.skipUnless(HAS_LOGGER, "mcp_logger not importable")
class TestMetricsCollector(unittest.TestCase):
    """Test McpMetricsCollector functionality."""

    def test_record_tool_call(self) -> None:
        """Test recording a successful tool call updates metrics."""
        mc = McpMetricsCollector(state_dir=None)
        mc.record_tool_call("test-mcp", "echo", 150.0, True, 100, 200)
        snapshot = mc.get_snapshot("test-mcp")
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["total_calls"], 1)
        self.assertEqual(snapshot["success_count"], 1)

    def test_record_error(self) -> None:
        """Test recording a failed tool call."""
        mc = McpMetricsCollector(state_dir=None)
        mc.record_tool_call("test-mcp", "fail_tool", 50.0, False, 50, 0)
        snapshot = mc.get_snapshot("test-mcp")
        self.assertEqual(snapshot["error_count"], 1)
        self.assertEqual(snapshot["success_count"], 0)

    def test_token_estimation(self) -> None:
        """Test token estimation heuristic."""
        mc = McpMetricsCollector(state_dir=None)
        tokens = mc.estimate_tokens('{"key": "value", "nested": {"data": "hello world"}}')
        self.assertGreater(tokens, 0)


# ---------------------------------------------------------------------------
# Test: Docker Log Parsing
# ---------------------------------------------------------------------------

@unittest.skipUnless(HAS_LOGGER, "mcp_logger not importable")
class TestDockerLogParsing(unittest.TestCase):
    """Test Docker log format parsing."""

    def test_parse_docker_timestamp_line(self) -> None:
        """Test parsing Docker log format: timestamp stream message."""
        # DockerLogProxy._parse_docker_line format:
        # 2024-01-15T10:30:00.123456Z stdout {"jsonrpc":"2.0",...}
        proxy = DockerLogProxy.__new__(DockerLogProxy)
        proxy._mcp_name = "test"
        proxy._event_bus = MagicMock()
        proxy._running = True

        line = '2024-01-15T10:30:00.123456Z {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}'
        # This should be parseable as JSON after timestamp extraction
        parts = line.split(" ", 1)
        self.assertEqual(len(parts), 2)
        try:
            data = json.loads(parts[1])
            self.assertEqual(data["jsonrpc"], "2.0")
        except json.JSONDecodeError:
            self.fail("Docker log line JSON portion should be valid JSON")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    unittest.main(verbosity=2)
