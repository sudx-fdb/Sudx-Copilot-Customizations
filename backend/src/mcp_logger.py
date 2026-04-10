"""
Central MCP Logger — Backend Event Bus.

Captures EVERY tool call, server event, error, and metric across ALL active
MCP servers. Provides a unified event stream consumed by VS Code extension
via SSE for the Debug Panel.

Components:
    - McpLogEvent: Core event dataclass
    - McpEventType / McpSeverity: Event classification enums
    - McpEventBus: In-memory ring buffer + subscriber dispatch
    - McpProcessProxy: MCP server I/O interceptor (stdio, Docker, SSE)
    - McpMetricsCollector: Per-MCP rolling statistics + token estimation
    - McpAlertEngine: Threshold-based + anomaly detection alerting
"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import os
import sys
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Deque, Dict, List, Optional, Set, Tuple

logger = logging.getLogger("backend.mcp_logger")


# ---------------------------------------------------------------------------
# 13a. Event Types & Severity
# ---------------------------------------------------------------------------

class McpEventType(str, Enum):
    """All event types emitted by the Central MCP Logger."""
    # Generic events
    TOOL_CALL_START = "TOOL_CALL_START"
    TOOL_CALL_END = "TOOL_CALL_END"
    TOOL_CALL_ERROR = "TOOL_CALL_ERROR"
    TOOL_CALL_TIMEOUT = "TOOL_CALL_TIMEOUT"
    SERVER_START = "SERVER_START"
    SERVER_STOP = "SERVER_STOP"
    SERVER_CRASH = "SERVER_CRASH"
    SERVER_RESTART = "SERVER_RESTART"
    SERVER_LOG = "SERVER_LOG"
    HEALTH_CHECK_OK = "HEALTH_CHECK_OK"
    HEALTH_CHECK_FAIL = "HEALTH_CHECK_FAIL"
    CONFIG_RELOAD = "CONFIG_RELOAD"
    DESTRUCTIVE_ACTION = "DESTRUCTIVE_ACTION"
    DEPLOY_EVENT = "DEPLOY_EVENT"
    LOGGER_ERROR = "LOGGER_ERROR"
    SYSTEM_WARNING = "SYSTEM_WARNING"
    # MCP protocol-aware events
    MCP_INITIALIZE = "MCP_INITIALIZE"
    MCP_TOOLS_LIST = "MCP_TOOLS_LIST"
    MCP_RESOURCE_READ = "MCP_RESOURCE_READ"
    MCP_PROMPT_GET = "MCP_PROMPT_GET"
    MCP_NOTIFICATION = "MCP_NOTIFICATION"
    MCP_CANCEL = "MCP_CANCEL"
    MCP_SAMPLING_REQUEST = "MCP_SAMPLING_REQUEST"
    # Alert events
    ALERT_TRIGGERED = "ALERT_TRIGGERED"
    ALERT_RESOLVED = "ALERT_RESOLVED"


class McpSeverity(str, Enum):
    """Severity levels for MCP log events."""
    DEBUG = "DEBUG"
    INFO = "INFO"
    WARN = "WARN"
    ERROR = "ERROR"
    CRITICAL = "CRITICAL"


# Default severity per event type
_DEFAULT_SEVERITY: Dict[McpEventType, McpSeverity] = {
    McpEventType.TOOL_CALL_START: McpSeverity.INFO,
    McpEventType.TOOL_CALL_END: McpSeverity.INFO,
    McpEventType.TOOL_CALL_ERROR: McpSeverity.ERROR,
    McpEventType.TOOL_CALL_TIMEOUT: McpSeverity.WARN,
    McpEventType.SERVER_START: McpSeverity.INFO,
    McpEventType.SERVER_STOP: McpSeverity.INFO,
    McpEventType.SERVER_CRASH: McpSeverity.CRITICAL,
    McpEventType.SERVER_RESTART: McpSeverity.WARN,
    McpEventType.SERVER_LOG: McpSeverity.DEBUG,
    McpEventType.HEALTH_CHECK_OK: McpSeverity.DEBUG,
    McpEventType.HEALTH_CHECK_FAIL: McpSeverity.WARN,
    McpEventType.CONFIG_RELOAD: McpSeverity.INFO,
    McpEventType.DESTRUCTIVE_ACTION: McpSeverity.CRITICAL,
    McpEventType.DEPLOY_EVENT: McpSeverity.INFO,
    McpEventType.LOGGER_ERROR: McpSeverity.ERROR,
    McpEventType.SYSTEM_WARNING: McpSeverity.WARN,
    McpEventType.MCP_INITIALIZE: McpSeverity.INFO,
    McpEventType.MCP_TOOLS_LIST: McpSeverity.DEBUG,
    McpEventType.MCP_RESOURCE_READ: McpSeverity.DEBUG,
    McpEventType.MCP_PROMPT_GET: McpSeverity.DEBUG,
    McpEventType.MCP_NOTIFICATION: McpSeverity.INFO,
    McpEventType.MCP_CANCEL: McpSeverity.WARN,
    McpEventType.MCP_SAMPLING_REQUEST: McpSeverity.INFO,
    McpEventType.ALERT_TRIGGERED: McpSeverity.CRITICAL,
    McpEventType.ALERT_RESOLVED: McpSeverity.INFO,
}


# ---------------------------------------------------------------------------
# 13a. McpLogEvent Dataclass
# ---------------------------------------------------------------------------

@dataclass
class McpLogEvent:
    """Core event data structure for the Central MCP Logger."""
    event_id: str = field(default_factory=lambda: uuid.uuid4().hex[:16])
    timestamp: float = field(default_factory=time.time)
    mcp_name: str = ""
    event_type: str = McpEventType.SERVER_LOG.value
    severity: str = McpSeverity.INFO.value
    data: Dict[str, Any] = field(default_factory=dict)
    correlation_id: Optional[str] = None
    repeat_count: int = 1
    schema_version: int = 1

    def to_dict(self) -> Dict[str, Any]:
        """Convert to JSON-serializable dict."""
        return asdict(self)

    def to_json(self) -> str:
        """Convert to JSON string."""
        return json.dumps(self.to_dict(), default=str)


# ---------------------------------------------------------------------------
# 13a. Event Filter
# ---------------------------------------------------------------------------

@dataclass
class EventFilter:
    """Server-side filter for SSE subscribers."""
    mcp_names: Optional[Set[str]] = None
    event_types: Optional[Set[str]] = None
    min_severity: Optional[McpSeverity] = None

    _SEVERITY_ORDER = {
        McpSeverity.DEBUG: 0, McpSeverity.INFO: 1,
        McpSeverity.WARN: 2, McpSeverity.ERROR: 3,
        McpSeverity.CRITICAL: 4,
    }

    def matches(self, event: McpLogEvent) -> bool:
        """Check if event passes this filter."""
        if self.mcp_names and event.mcp_name not in self.mcp_names:
            return False
        if self.event_types and event.event_type not in self.event_types:
            return False
        if self.min_severity:
            event_sev = McpSeverity(event.severity) if event.severity in McpSeverity.__members__ else McpSeverity.DEBUG
            if self._SEVERITY_ORDER.get(event_sev, 0) < self._SEVERITY_ORDER.get(self.min_severity, 0):
                return False
        return True


# ---------------------------------------------------------------------------
# 13a. McpEventBus — Ring Buffer + Subscriber Dispatch
# ---------------------------------------------------------------------------

# Configurable defaults
_DEFAULT_RING_BUFFER_SIZE = 10000
_DEFAULT_MAX_MEMORY_MB = 50
_DEFAULT_SUBSCRIBER_QUEUE_SIZE = 500
_DEFAULT_DEDUP_WINDOW_SECONDS = 1.0
_DEFAULT_MAX_SSE_CLIENTS = 10
_DEFAULT_ARCHIVE_MAX_SIZE_MB = 50
_DEFAULT_ARCHIVE_MAX_ROTATIONS = 10


class McpEventBus:
    """
    Central event bus with in-memory ring buffer and async subscriber dispatch.

    Thread-safe: emit() can be called from any thread. Internal dispatch
    runs on the main asyncio event loop.
    """

    def __init__(
        self,
        max_events: int = _DEFAULT_RING_BUFFER_SIZE,
        max_memory_mb: int = _DEFAULT_MAX_MEMORY_MB,
        archive_path: Optional[Path] = None,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ) -> None:
        self._max_events = max_events
        self._max_memory_bytes = max_memory_mb * 1024 * 1024
        self._archive_path = archive_path
        self._loop = loop

        # Ring buffer (thread-safe deque with maxlen)
        self._buffer: Deque[McpLogEvent] = collections.deque(maxlen=max_events)
        self._buffer_lock = threading.Lock()
        self._evicted_count = 0

        # Subscribers: callback -> (queue, filter)
        self._subscribers: Dict[int, Tuple[asyncio.Queue, Optional[EventFilter]]] = {}
        self._subscriber_lock = threading.Lock()
        self._next_sub_id = 0

        # Deduplication
        self._dedup_cache: Dict[str, Tuple[float, McpLogEvent]] = {}
        self._dedup_lock = threading.Lock()
        self._dedup_window = _DEFAULT_DEDUP_WINDOW_SECONDS

        # Stats
        self._total_emitted = 0
        self._total_evicted = 0
        self._started = False

        logger.debug(
            "McpEventBus initialized: max_events=%d, max_memory_mb=%d, archive=%s",
            max_events, max_memory_mb, archive_path,
        )

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Set the asyncio event loop for async dispatch."""
        self._loop = loop
        logger.debug("Event bus loop set")

    def start(self) -> None:
        """Start the event bus."""
        self._started = True
        logger.info("McpEventBus started")

    def stop(self) -> None:
        """Stop the event bus, flush pending events."""
        self._started = False
        # Flush archive
        if self._archive_path:
            self._flush_archive()
        logger.info("McpEventBus stopped (total emitted: %d, evicted: %d)", self._total_emitted, self._total_evicted)

    def emit(self, event: McpLogEvent) -> None:
        """
        Thread-safe event emission.

        Stores in ring buffer, dispatches to subscribers, appends to archive.
        Can be called from any thread.
        """
        if not self._started:
            logger.debug("Event bus not started, dropping event: %s", event.event_type)
            return

        # Deduplication check
        dedup_key = f"{event.mcp_name}:{event.event_type}:{event.data.get('message', '')}"
        with self._dedup_lock:
            now = time.time()
            if dedup_key in self._dedup_cache:
                last_time, last_event = self._dedup_cache[dedup_key]
                if now - last_time < self._dedup_window:
                    last_event.repeat_count += 1
                    logger.debug("Deduplicated event: %s (count: %d)", dedup_key, last_event.repeat_count)
                    return
            self._dedup_cache[dedup_key] = (now, event)
            # Clean old dedup entries
            expired = [k for k, (t, _) in self._dedup_cache.items() if now - t > self._dedup_window * 2]
            for k in expired:
                del self._dedup_cache[k]

        # Apply default severity if not set
        if event.severity == McpSeverity.INFO.value and event.event_type in [e.value for e in McpEventType]:
            try:
                et = McpEventType(event.event_type)
                default_sev = _DEFAULT_SEVERITY.get(et)
                if default_sev:
                    event.severity = default_sev.value
            except ValueError:
                pass

        # Store in ring buffer
        with self._buffer_lock:
            if len(self._buffer) >= self._max_events:
                self._total_evicted += 1
                self._evicted_count += 1
            self._buffer.append(event)
            self._total_emitted += 1

        # Memory check (periodic, every 100 events)
        if self._total_emitted % 100 == 0:
            self._check_memory()

        # Disk append (async-safe)
        if self._archive_path:
            self._append_to_archive(event)

        # Dispatch to subscribers
        self._dispatch_to_subscribers(event)

        logger.debug("Event emitted: %s/%s [%s]", event.mcp_name, event.event_type, event.severity)

    def _dispatch_to_subscribers(self, event: McpLogEvent) -> None:
        """Dispatch event to all matching subscribers."""
        with self._subscriber_lock:
            subs = list(self._subscribers.items())

        for sub_id, (queue, evt_filter) in subs:
            if evt_filter and not evt_filter.matches(event):
                continue
            try:
                if self._loop and self._loop.is_running():
                    self._loop.call_soon_threadsafe(self._enqueue_event, queue, event, sub_id)
                else:
                    # Fallback: direct enqueue (may lose events if queue full)
                    try:
                        queue.put_nowait(event)
                    except asyncio.QueueFull:
                        logger.warning("Subscriber %d queue full, dropping event", sub_id)
            except Exception as exc:
                logger.error("Error dispatching to subscriber %d: %s", sub_id, exc)

    def _enqueue_event(self, queue: asyncio.Queue, event: McpLogEvent, sub_id: int) -> None:
        """Enqueue event into subscriber queue (called on event loop thread)."""
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            # Backpressure: drop oldest
            try:
                queue.get_nowait()
                queue.put_nowait(event)
                logger.warning("Subscriber %d backpressure: dropped oldest event", sub_id)
            except (asyncio.QueueEmpty, asyncio.QueueFull):
                pass

    def subscribe(self, evt_filter: Optional[EventFilter] = None) -> Tuple[int, asyncio.Queue]:
        """
        Register a subscriber.

        Returns:
            Tuple of (subscriber_id, asyncio.Queue to consume events from).
        """
        with self._subscriber_lock:
            sub_id = self._next_sub_id
            self._next_sub_id += 1
            queue: asyncio.Queue = asyncio.Queue(maxsize=_DEFAULT_SUBSCRIBER_QUEUE_SIZE)
            self._subscribers[sub_id] = (queue, evt_filter)
            logger.info("Subscriber %d registered (filter: %s)", sub_id, evt_filter)
            return sub_id, queue

    def unsubscribe(self, sub_id: int) -> None:
        """Remove a subscriber."""
        with self._subscriber_lock:
            if sub_id in self._subscribers:
                del self._subscribers[sub_id]
                logger.info("Subscriber %d unsubscribed", sub_id)

    def get_subscriber_count(self) -> int:
        """Return number of active subscribers."""
        with self._subscriber_lock:
            return len(self._subscribers)

    def get_history(
        self,
        mcp_name: Optional[str] = None,
        event_type: Optional[str] = None,
        since: Optional[float] = None,
        limit: int = 100,
    ) -> List[McpLogEvent]:
        """Query ring buffer with optional filters, return sorted by timestamp."""
        with self._buffer_lock:
            events = list(self._buffer)

        results = []
        for evt in events:
            if mcp_name and evt.mcp_name != mcp_name:
                continue
            if event_type and evt.event_type != event_type:
                continue
            if since and evt.timestamp < since:
                continue
            results.append(evt)

        results.sort(key=lambda e: e.timestamp)
        return results[-limit:] if len(results) > limit else results

    def get_event_by_id(self, event_id: str) -> Optional[McpLogEvent]:
        """Find an event in the ring buffer by ID."""
        with self._buffer_lock:
            for evt in self._buffer:
                if evt.event_id == event_id:
                    return evt
        return None

    def get_events_after_id(self, event_id: str) -> List[McpLogEvent]:
        """Get all events after a given event ID (for SSE reconnection replay)."""
        with self._buffer_lock:
            events = list(self._buffer)

        found = False
        result = []
        for evt in events:
            if found:
                result.append(evt)
            elif evt.event_id == event_id:
                found = True
        return result

    def get_stats(self) -> Dict[str, Any]:
        """Return event bus statistics."""
        with self._buffer_lock:
            buf_size = len(self._buffer)
        return {
            "buffer_size": buf_size,
            "buffer_capacity": self._max_events,
            "total_emitted": self._total_emitted,
            "total_evicted": self._total_evicted,
            "subscriber_count": self.get_subscriber_count(),
            "started": self._started,
        }

    def _check_memory(self) -> None:
        """Check memory usage and trigger emergency eviction if needed."""
        try:
            estimated_size = sys.getsizeof(self._buffer) + sum(
                sys.getsizeof(e) for e in list(self._buffer)[:100]
            ) * (len(self._buffer) / max(min(len(self._buffer), 100), 1))
            if estimated_size > self._max_memory_bytes:
                with self._buffer_lock:
                    evict_count = len(self._buffer) // 4
                    for _ in range(evict_count):
                        if self._buffer:
                            self._buffer.popleft()
                            self._total_evicted += 1
                logger.warning(
                    "Emergency memory eviction: removed %d events (estimated %dMB > %dMB limit)",
                    evict_count, estimated_size // (1024 * 1024), self._max_memory_bytes // (1024 * 1024),
                )
        except Exception as exc:
            logger.error("Memory check failed: %s", exc)

    def _append_to_archive(self, event: McpLogEvent) -> None:
        """Append event to disk archive (JSONL format)."""
        if not self._archive_path:
            return
        try:
            self._archive_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self._archive_path, "a", encoding="utf-8") as f:
                f.write(event.to_json() + "\n")
            # Check rotation
            if self._archive_path.exists() and self._archive_path.stat().st_size > _DEFAULT_ARCHIVE_MAX_SIZE_MB * 1024 * 1024:
                self._rotate_archive()
        except Exception as exc:
            logger.error("Archive append failed: %s", exc)

    def _rotate_archive(self) -> None:
        """Rotate archive file."""
        try:
            for i in range(_DEFAULT_ARCHIVE_MAX_ROTATIONS - 1, 0, -1):
                old = self._archive_path.with_suffix(f".{i}.jsonl")
                new = self._archive_path.with_suffix(f".{i + 1}.jsonl")
                if old.exists():
                    old.rename(new)
            if self._archive_path.exists():
                self._archive_path.rename(self._archive_path.with_suffix(".1.jsonl"))
            logger.info("Archive rotated")
        except Exception as exc:
            logger.error("Archive rotation failed: %s", exc)

    def _flush_archive(self) -> None:
        """Flush any buffered archive data (no-op for synchronous writes)."""
        logger.debug("Archive flushed")

    def get_archived_events(
        self,
        mcp_name: Optional[str] = None,
        event_type: Optional[str] = None,
        start_time: Optional[float] = None,
        end_time: Optional[float] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Read events from disk archive with filters."""
        if not self._archive_path or not self._archive_path.exists():
            return []

        results = []
        try:
            with open(self._archive_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        evt = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if mcp_name and evt.get("mcp_name") != mcp_name:
                        continue
                    if event_type and evt.get("event_type") != event_type:
                        continue
                    ts = evt.get("timestamp", 0)
                    if start_time and ts < start_time:
                        continue
                    if end_time and ts > end_time:
                        continue
                    results.append(evt)
                    if len(results) >= limit:
                        break
        except Exception as exc:
            logger.error("Archive read failed: %s", exc)

        return results


# ---------------------------------------------------------------------------
# 13b. MCP Process I/O Interceptor
# ---------------------------------------------------------------------------

class PendingRequest:
    """Tracks an in-flight MCP JSON-RPC request."""
    __slots__ = ("request_id", "method", "tool_name", "start_time", "correlation_id")

    def __init__(self, request_id: str, method: str, tool_name: str, correlation_id: str) -> None:
        self.request_id = request_id
        self.method = method
        self.tool_name = tool_name
        self.start_time = time.time()
        self.correlation_id = correlation_id


class McpProcessProxy:
    """
    Wraps MCP server subprocess I/O for event capture.

    Passive interceptor — does NOT alter or delay any data flowing to/from
    the MCP server. Logging is strictly observational.
    """

    _DEFAULT_TIMEOUT = 300  # seconds for tool call timeout
    _MAX_PROXY_RETRIES = 3
    _PROXY_RETRY_DELAY = 5.0

    def __init__(
        self,
        mcp_name: str,
        event_bus: McpEventBus,
        tool_timeout: float = _DEFAULT_TIMEOUT,
    ) -> None:
        self._mcp_name = mcp_name
        self._event_bus = event_bus
        self._tool_timeout = tool_timeout

        # Pending requests (concurrent, keyed by JSON-RPC id)
        self._pending: Dict[str, PendingRequest] = {}
        self._pending_lock = threading.Lock()

        # Cached tool schemas from tools/list
        self._tool_schemas: Dict[str, Dict[str, Any]] = {}
        self._capabilities: Dict[str, Any] = {}
        self._protocol_version: Optional[str] = None

        # Proxy threads
        self._stdout_thread: Optional[threading.Thread] = None
        self._stderr_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._running = False
        self._retry_count = 0

        # Output forwarding queues (for transparent pass-through)
        self.stdout_queue: asyncio.Queue = asyncio.Queue()
        self.stderr_queue: asyncio.Queue = asyncio.Queue()

        logger.debug("McpProcessProxy created for %s (timeout=%ds)", mcp_name, tool_timeout)

    def start(self, stdout_stream, stderr_stream) -> None:
        """Start capture threads for stdout and stderr streams."""
        self._stop_event.clear()
        self._running = True

        if stdout_stream:
            self._stdout_thread = threading.Thread(
                target=self._capture_stream,
                args=(stdout_stream, "stdout"),
                daemon=True,
                name=f"proxy-stdout-{self._mcp_name}",
            )
            self._stdout_thread.start()

        if stderr_stream:
            self._stderr_thread = threading.Thread(
                target=self._capture_stream,
                args=(stderr_stream, "stderr"),
                daemon=True,
                name=f"proxy-stderr-{self._mcp_name}",
            )
            self._stderr_thread.start()

        logger.info("ProcessProxy started for %s", self._mcp_name)

    def stop(self) -> None:
        """Stop capture threads, drain remaining output, flush events."""
        logger.debug("Stopping ProcessProxy for %s", self._mcp_name)
        self._stop_event.set()
        self._running = False

        for thread in [self._stdout_thread, self._stderr_thread]:
            if thread and thread.is_alive():
                thread.join(timeout=5.0)
                if thread.is_alive():
                    logger.warning("Proxy thread %s did not stop in time", thread.name)

        # Flush pending requests as timeouts
        with self._pending_lock:
            for req_id, pending in list(self._pending.items()):
                self._emit_timeout(pending)
            self._pending.clear()

        logger.info("ProcessProxy stopped for %s", self._mcp_name)

    def _capture_stream(self, stream, stream_name: str) -> None:
        """Capture lines from stdout/stderr, parse JSON-RPC, emit events."""
        logger.debug("Capture thread started: %s/%s", self._mcp_name, stream_name)
        retry_count = 0
        while retry_count <= self._MAX_PROXY_RETRIES:
            try:
                for raw_line in iter(stream.readline, b""):
                    if self._stop_event.is_set():
                        break
                    line = raw_line.decode("utf-8", errors="replace").rstrip("\n\r")
                    if not line:
                        continue

                    if stream_name == "stdout":
                        self._parse_stdout_line(line)
                    else:
                        self._parse_stderr_line(line)
                break  # Normal exit — stream ended cleanly
            except Exception as exc:
                if not self._running:
                    break
                logger.error("Capture thread %s/%s crashed: %s", self._mcp_name, stream_name, exc)
                self._event_bus.emit(McpLogEvent(
                    mcp_name=self._mcp_name,
                    event_type=McpEventType.LOGGER_ERROR.value,
                    severity=McpSeverity.ERROR.value,
                    data={"error": str(exc), "stream": stream_name},
                ))
                retry_count += 1
                if retry_count <= self._MAX_PROXY_RETRIES:
                    logger.info("Attempting proxy thread restart %d/%d for %s/%s",
                                retry_count, self._MAX_PROXY_RETRIES, self._mcp_name, stream_name)
                    time.sleep(self._PROXY_RETRY_DELAY)
                    if self._stop_event.is_set():
                        break
                else:
                    logger.error("Max proxy retries exceeded for %s/%s — disabling logging", self._mcp_name, stream_name)
                    self._event_bus.emit(McpLogEvent(
                        mcp_name=self._mcp_name,
                        event_type=McpEventType.SYSTEM_WARNING.value,
                        severity=McpSeverity.WARN.value,
                        data={"message": f"Logging disabled for {stream_name} after {self._MAX_PROXY_RETRIES} retries"},
                    ))
                    break
        finally:
            logger.debug("Capture thread ended: %s/%s", self._mcp_name, stream_name)

    def _parse_stdout_line(self, line: str) -> None:
        """Parse stdout line — detect JSON-RPC messages and MCP protocol."""
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            # Non-JSON output — log as server output
            self._event_bus.emit(McpLogEvent(
                mcp_name=self._mcp_name,
                event_type=McpEventType.SERVER_LOG.value,
                severity=McpSeverity.DEBUG.value,
                data={"level": "stdout", "message": line},
            ))
            return

        if not isinstance(msg, dict):
            self._event_bus.emit(McpLogEvent(
                mcp_name=self._mcp_name,
                event_type=McpEventType.SERVER_LOG.value,
                severity=McpSeverity.DEBUG.value,
                data={"level": "stdout_json", "message": line},
            ))
            return

        # Detect message type
        if "method" in msg and "id" in msg:
            # JSON-RPC request (from client or server-initiated)
            self._handle_jsonrpc_request(msg)
        elif "method" in msg and "id" not in msg:
            # JSON-RPC notification
            self._handle_jsonrpc_notification(msg)
        elif "result" in msg and "id" in msg:
            # JSON-RPC success response
            self._handle_jsonrpc_response(msg)
        elif "error" in msg and "id" in msg:
            # JSON-RPC error response
            self._handle_jsonrpc_error(msg)
        else:
            # Valid JSON but not JSON-RPC
            self._event_bus.emit(McpLogEvent(
                mcp_name=self._mcp_name,
                event_type=McpEventType.SERVER_LOG.value,
                severity=McpSeverity.DEBUG.value,
                data={"level": "stdout_json", "message": line},
            ))

    def _handle_jsonrpc_request(self, msg: Dict[str, Any]) -> None:
        """Handle JSON-RPC request messages (tool calls, initialize, etc.)."""
        method = msg.get("method", "")
        params = msg.get("params", {})
        req_id = str(msg.get("id", ""))
        correlation_id = uuid.uuid4().hex[:12]

        if method == "tools/call":
            # MCP tool call — extract inner tool name
            tool_name = params.get("name", "unknown")
            arguments = params.get("arguments", {})
            input_size = len(json.dumps(arguments, default=str))

            with self._pending_lock:
                self._pending[req_id] = PendingRequest(req_id, method, tool_name, correlation_id)

            self._event_bus.emit(McpLogEvent(
                mcp_name=self._mcp_name,
                event_type=McpEventType.TOOL_CALL_START.value,
                correlation_id=correlation_id,
                data={
                    "tool": tool_name,
                    "input_params": arguments,
                    "request_id": req_id,
                    "input_size": input_size,
                },
            ))

        elif method == "initialize":
            self._event_bus.emit(McpLogEvent(
                mcp_name=self._mcp_name,
                event_type=McpEventType.MCP_INITIALIZE.value,
                data={
                    "protocol_version": params.get("protocolVersion"),
                    "client_info": params.get("clientInfo"),
                    "capabilities": params.get("capabilities"),
                    "request_id": req_id,
                },
            ))

        elif method == "tools/list":
            with self._pending_lock:
                self._pending[req_id] = PendingRequest(req_id, method, "tools/list", correlation_id)

        elif method == "resources/read":
            self._event_bus.emit(McpLogEvent(
                mcp_name=self._mcp_name,
                event_type=McpEventType.MCP_RESOURCE_READ.value,
                data={"uri": params.get("uri"), "request_id": req_id},
            ))

        elif method == "prompts/get":
            self._event_bus.emit(McpLogEvent(
                mcp_name=self._mcp_name,
                event_type=McpEventType.MCP_PROMPT_GET.value,
                data={"name": params.get("name"), "arguments": params.get("arguments"), "request_id": req_id},
            ))

        elif method == "sampling/createMessage":
            # Server-initiated LLM call
            self._event_bus.emit(McpLogEvent(
                mcp_name=self._mcp_name,
                event_type=McpEventType.MCP_SAMPLING_REQUEST.value,
                severity=McpSeverity.INFO.value,
                data={
                    "messages": len(params.get("messages", [])),
                    "model_hint": params.get("modelPreferences"),
                    "max_tokens": params.get("maxTokens"),
                    "request_id": req_id,
                },
            ))
        else:
            # Generic request
            with self._pending_lock:
                self._pending[req_id] = PendingRequest(req_id, method, method, correlation_id)

    def _handle_jsonrpc_response(self, msg: Dict[str, Any]) -> None:
        """Handle JSON-RPC success response."""
        req_id = str(msg.get("id", ""))
        result = msg.get("result", {})

        with self._pending_lock:
            pending = self._pending.pop(req_id, None)

        if not pending:
            logger.debug("Response for unknown request %s from %s", req_id, self._mcp_name)
            return

        duration_ms = (time.time() - pending.start_time) * 1000

        if pending.method == "tools/call":
            # Check for MCP tool-level error (isError: true in result)
            if isinstance(result, dict) and result.get("isError"):
                content = result.get("content", [])
                error_text = ""
                if content:
                    error_text = content[0].get("text", "") if isinstance(content[0], dict) else str(content[0])
                self._event_bus.emit(McpLogEvent(
                    mcp_name=self._mcp_name,
                    event_type=McpEventType.TOOL_CALL_ERROR.value,
                    severity=McpSeverity.ERROR.value,
                    correlation_id=pending.correlation_id,
                    data={
                        "tool": pending.tool_name,
                        "duration_ms": round(duration_ms, 2),
                        "error_type": "tool_error",
                        "error_message": error_text,
                        "request_id": req_id,
                    },
                ))
                return

            # Parse content types for output size
            output_size = len(json.dumps(result, default=str))
            content_types = self._analyze_content_types(result)

            self._event_bus.emit(McpLogEvent(
                mcp_name=self._mcp_name,
                event_type=McpEventType.TOOL_CALL_END.value,
                correlation_id=pending.correlation_id,
                data={
                    "tool": pending.tool_name,
                    "duration_ms": round(duration_ms, 2),
                    "output_size": output_size,
                    "content_types": content_types,
                    "status": "success",
                    "request_id": req_id,
                },
            ))

        elif pending.method == "tools/list":
            # Cache tool schemas
            tools = result.get("tools", []) if isinstance(result, dict) else []
            for tool in tools:
                name = tool.get("name", "")
                if name:
                    self._tool_schemas[name] = tool
            self._event_bus.emit(McpLogEvent(
                mcp_name=self._mcp_name,
                event_type=McpEventType.MCP_TOOLS_LIST.value,
                data={
                    "tool_count": len(tools),
                    "tools": [t.get("name") for t in tools],
                    "duration_ms": round(duration_ms, 2),
                },
            ))

        elif pending.method == "initialize":
            # Cache capabilities
            if isinstance(result, dict):
                self._capabilities = result.get("capabilities", {})
                self._protocol_version = result.get("protocolVersion")
                server_info = result.get("serverInfo", {})
                self._event_bus.emit(McpLogEvent(
                    mcp_name=self._mcp_name,
                    event_type=McpEventType.MCP_INITIALIZE.value,
                    data={
                        "response": True,
                        "protocol_version": self._protocol_version,
                        "server_info": server_info,
                        "capabilities": self._capabilities,
                        "duration_ms": round(duration_ms, 2),
                    },
                ))

    def _handle_jsonrpc_error(self, msg: Dict[str, Any]) -> None:
        """Handle JSON-RPC error response."""
        req_id = str(msg.get("id", ""))
        error = msg.get("error", {})

        with self._pending_lock:
            pending = self._pending.pop(req_id, None)

        duration_ms = (time.time() - pending.start_time) * 1000 if pending else 0

        self._event_bus.emit(McpLogEvent(
            mcp_name=self._mcp_name,
            event_type=McpEventType.TOOL_CALL_ERROR.value,
            severity=McpSeverity.ERROR.value,
            correlation_id=pending.correlation_id if pending else None,
            data={
                "tool": pending.tool_name if pending else "unknown",
                "duration_ms": round(duration_ms, 2),
                "error_type": "jsonrpc_error",
                "error_code": error.get("code"),
                "error_message": error.get("message", ""),
                "request_id": req_id,
            },
        ))

    def _handle_jsonrpc_notification(self, msg: Dict[str, Any]) -> None:
        """Handle JSON-RPC notification (no id field)."""
        method = msg.get("method", "")
        params = msg.get("params", {})

        if method == "notifications/progress":
            self._event_bus.emit(McpLogEvent(
                mcp_name=self._mcp_name,
                event_type=McpEventType.MCP_NOTIFICATION.value,
                data={
                    "notification_type": "progress",
                    "progress_token": params.get("progressToken"),
                    "progress": params.get("progress"),
                    "total": params.get("total"),
                    "message": params.get("message", ""),
                },
            ))

        elif method == "notifications/message":
            level = params.get("level", "info")
            self._event_bus.emit(McpLogEvent(
                mcp_name=self._mcp_name,
                event_type=McpEventType.MCP_NOTIFICATION.value,
                severity=self._map_mcp_log_level(level),
                data={
                    "notification_type": "message",
                    "level": level,
                    "logger": params.get("logger", ""),
                    "data": params.get("data"),
                },
            ))

        elif method == "notifications/cancelled":
            request_id = str(params.get("requestId", ""))
            with self._pending_lock:
                pending = self._pending.pop(request_id, None)
            duration_ms = (time.time() - pending.start_time) * 1000 if pending else 0
            self._event_bus.emit(McpLogEvent(
                mcp_name=self._mcp_name,
                event_type=McpEventType.MCP_CANCEL.value,
                correlation_id=pending.correlation_id if pending else None,
                data={
                    "request_id": request_id,
                    "reason": params.get("reason", ""),
                    "partial_duration_ms": round(duration_ms, 2),
                },
            ))

    def _parse_stderr_line(self, line: str) -> None:
        """Parse stderr output — emit as SERVER_LOG events."""
        self._event_bus.emit(McpLogEvent(
            mcp_name=self._mcp_name,
            event_type=McpEventType.SERVER_LOG.value,
            severity=McpSeverity.WARN.value,
            data={"level": "stderr", "message": line},
        ))

    def _analyze_content_types(self, result: Any) -> Dict[str, int]:
        """Analyze MCP response content types for metrics."""
        types: Dict[str, int] = {}
        if not isinstance(result, dict):
            return types
        content = result.get("content", [])
        if not isinstance(content, list):
            return types
        for item in content:
            if isinstance(item, dict):
                ct = item.get("type", "unknown")
                types[ct] = types.get(ct, 0) + 1
        return types

    def _emit_timeout(self, pending: PendingRequest) -> None:
        """Emit timeout event for a pending request."""
        duration_ms = (time.time() - pending.start_time) * 1000
        self._event_bus.emit(McpLogEvent(
            mcp_name=self._mcp_name,
            event_type=McpEventType.TOOL_CALL_TIMEOUT.value,
            severity=McpSeverity.WARN.value,
            correlation_id=pending.correlation_id,
            data={
                "tool": pending.tool_name,
                "duration_ms": round(duration_ms, 2),
                "request_id": pending.request_id,
                "timeout_seconds": self._tool_timeout,
            },
        ))

    @staticmethod
    def _map_mcp_log_level(level: str) -> str:
        """Map MCP log level to McpSeverity."""
        mapping = {
            "debug": McpSeverity.DEBUG.value,
            "info": McpSeverity.INFO.value,
            "warning": McpSeverity.WARN.value,
            "error": McpSeverity.ERROR.value,
            "critical": McpSeverity.CRITICAL.value,
        }
        return mapping.get(level.lower(), McpSeverity.INFO.value)

    async def check_timeouts(self) -> None:
        """Scan pending requests for timeouts. Call periodically (every 10s)."""
        now = time.time()
        timed_out = []
        with self._pending_lock:
            for req_id, pending in list(self._pending.items()):
                if now - pending.start_time > self._tool_timeout:
                    timed_out.append(pending)
                    del self._pending[req_id]

        for pending in timed_out:
            self._emit_timeout(pending)
            logger.warning("Tool call timeout: %s/%s (request %s)", self._mcp_name, pending.tool_name, pending.request_id)


# ---------------------------------------------------------------------------
# 13b. Docker Container I/O Interceptor
# ---------------------------------------------------------------------------

class DockerLogProxy:
    """
    Intercepts Docker container logs via `docker logs --follow`.

    For Docker-based MCPs, we can't capture subprocess stdout.
    Instead, follow the container logs.
    """

    def __init__(self, mcp_name: str, container_name: str, event_bus: McpEventBus) -> None:
        self._mcp_name = mcp_name
        self._container_name = container_name
        self._event_bus = event_bus
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        logger.debug("DockerLogProxy created for %s (container: %s)", mcp_name, container_name)

    def start(self) -> None:
        """Start docker logs follow thread."""
        import subprocess
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._follow_logs,
            daemon=True,
            name=f"docker-log-{self._mcp_name}",
        )
        self._thread.start()
        logger.info("DockerLogProxy started for %s", self._mcp_name)

    def stop(self) -> None:
        """Stop log following."""
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5.0)
        logger.info("DockerLogProxy stopped for %s", self._mcp_name)

    def _follow_logs(self) -> None:
        """Follow docker logs in background thread."""
        import subprocess
        try:
            proc = subprocess.Popen(
                ["docker", "logs", "--follow", "--timestamps", self._container_name],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            for raw_line in iter(proc.stdout.readline, b""):
                if self._stop_event.is_set():
                    proc.terminate()
                    break
                line = raw_line.decode("utf-8", errors="replace").rstrip("\n\r")
                if not line:
                    continue
                # Parse Docker log format: <timestamp> <message>
                parts = line.split(" ", 1)
                message = parts[1] if len(parts) > 1 else line
                self._event_bus.emit(McpLogEvent(
                    mcp_name=self._mcp_name,
                    event_type=McpEventType.SERVER_LOG.value,
                    severity=McpSeverity.DEBUG.value,
                    data={"level": "docker", "message": message, "raw": line},
                ))
            proc.wait(timeout=5)
        except Exception as exc:
            if not self._stop_event.is_set():
                logger.error("DockerLogProxy error for %s: %s", self._mcp_name, exc)


# ---------------------------------------------------------------------------
# 13c. Metrics Collector
# ---------------------------------------------------------------------------

class _SimpleTDigest:
    """
    Simplified t-digest for streaming percentile estimation.

    Uses ~100 centroids for memory-efficient P50/P95/P99 tracking.
    """

    def __init__(self, max_centroids: int = 100) -> None:
        self._centroids: List[Tuple[float, int]] = []  # (mean, count)
        self._max = max_centroids
        self._total_count = 0

    def add(self, value: float) -> None:
        """Add a value to the digest."""
        self._centroids.append((value, 1))
        self._total_count += 1
        if len(self._centroids) > self._max * 2:
            self._compress()

    def _compress(self) -> None:
        """Merge centroids to stay within budget."""
        self._centroids.sort(key=lambda c: c[0])
        if len(self._centroids) <= self._max:
            return
        merged = []
        i = 0
        while i < len(self._centroids):
            mean, count = self._centroids[i]
            while i + 1 < len(self._centroids) and len(merged) < self._max - (len(self._centroids) - i - 1):
                next_mean, next_count = self._centroids[i + 1]
                total = count + next_count
                mean = (mean * count + next_mean * next_count) / total
                count = total
                i += 1
            merged.append((mean, count))
            i += 1
        self._centroids = merged

    def percentile(self, p: float) -> float:
        """Estimate percentile (0-100)."""
        if not self._centroids:
            return 0.0
        self._centroids.sort(key=lambda c: c[0])
        target = self._total_count * p / 100.0
        cumulative = 0
        for mean, count in self._centroids:
            cumulative += count
            if cumulative >= target:
                return mean
        return self._centroids[-1][0] if self._centroids else 0.0


class McpMetricsCollector:
    """
    Per-MCP rolling statistics with token estimation.

    Thread-safe via lock for updates from multiple proxy threads.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # Per-MCP metrics
        self._mcps: Dict[str, Dict[str, Any]] = {}
        # Per-tool metrics (per MCP)
        self._tools: Dict[str, Dict[str, Dict[str, Any]]] = {}
        # Latency t-digests per MCP
        self._latency_digests: Dict[str, _SimpleTDigest] = {}
        # Team aggregates
        self._team_metrics: Dict[str, Dict[str, int]] = {"red": {}, "blue": {}, "purple": {}}
        # MCP role classification
        self._mcp_roles: Dict[str, str] = {}
        logger.debug("McpMetricsCollector initialized")

    def set_mcp_role(self, mcp_name: str, tags: List[str]) -> None:
        """Classify MCP into red/blue/purple team based on tags."""
        if any(t in tags for t in ("pentest", "red-team")):
            self._mcp_roles[mcp_name] = "red"
        elif any(t in tags for t in ("defense", "blue-team")):
            self._mcp_roles[mcp_name] = "blue"
        elif any(t in tags for t in ("intel", "threat")):
            self._mcp_roles[mcp_name] = "purple"
        else:
            self._mcp_roles[mcp_name] = "unclassified"

    def record_event(self, event: McpLogEvent) -> None:
        """Record an event for metrics tracking."""
        with self._lock:
            mcp = event.mcp_name
            if mcp not in self._mcps:
                self._mcps[mcp] = {
                    "total_calls": 0, "success_count": 0, "error_count": 0,
                    "timeout_count": 0, "total_input_tokens": 0, "total_output_tokens": 0,
                    "start_count": 0, "restart_count": 0, "health_ok": 0, "health_fail": 0,
                    "first_seen": time.time(), "last_event": time.time(),
                }
            if mcp not in self._latency_digests:
                self._latency_digests[mcp] = _SimpleTDigest()

            metrics = self._mcps[mcp]
            metrics["last_event"] = time.time()

            et = event.event_type
            data = event.data

            if et == McpEventType.TOOL_CALL_START.value:
                metrics["total_calls"] += 1
                self._record_tool_event(mcp, data.get("tool", ""), "calls", 1)
                # Estimate input tokens
                input_size = data.get("input_size", 0)
                tokens = self._estimate_tokens(input_size, is_json=True)
                metrics["total_input_tokens"] += tokens

            elif et == McpEventType.TOOL_CALL_END.value:
                metrics["success_count"] += 1
                duration = data.get("duration_ms", 0)
                self._latency_digests[mcp].add(duration)
                tool = data.get("tool", "")
                self._record_tool_event(mcp, tool, "success", 1)
                self._record_tool_event(mcp, tool, "last_duration_ms", duration)
                # Estimate output tokens
                output_size = data.get("output_size", 0)
                content_types = data.get("content_types", {})
                tokens = self._estimate_output_tokens(output_size, content_types)
                metrics["total_output_tokens"] += tokens

            elif et == McpEventType.TOOL_CALL_ERROR.value:
                metrics["error_count"] += 1
                duration = data.get("duration_ms", 0)
                if duration > 0:
                    self._latency_digests[mcp].add(duration)
                self._record_tool_event(mcp, data.get("tool", ""), "errors", 1)

            elif et == McpEventType.TOOL_CALL_TIMEOUT.value:
                metrics["timeout_count"] += 1
                self._record_tool_event(mcp, data.get("tool", ""), "timeouts", 1)

            elif et == McpEventType.SERVER_START.value:
                metrics["start_count"] += 1

            elif et == McpEventType.SERVER_RESTART.value:
                metrics["restart_count"] += 1

            elif et == McpEventType.HEALTH_CHECK_OK.value:
                metrics["health_ok"] += 1

            elif et == McpEventType.HEALTH_CHECK_FAIL.value:
                metrics["health_fail"] += 1

    def _record_tool_event(self, mcp: str, tool: str, key: str, value: Any) -> None:
        """Record per-tool metric."""
        if not tool:
            return
        if mcp not in self._tools:
            self._tools[mcp] = {}
        if tool not in self._tools[mcp]:
            self._tools[mcp][tool] = {
                "calls": 0, "success": 0, "errors": 0, "timeouts": 0,
                "last_duration_ms": 0, "last_call": 0,
            }
        tool_metrics = self._tools[mcp][tool]
        if key in ("calls", "success", "errors", "timeouts"):
            tool_metrics[key] = tool_metrics.get(key, 0) + value
        else:
            tool_metrics[key] = value
        tool_metrics["last_call"] = time.time()

    @staticmethod
    def _estimate_tokens(text_size: int, is_json: bool = False) -> int:
        """
        Estimate token consumption.

        Heuristic: tokens ≈ text_size / 4 for English.
        JSON overhead: multiply by 1.3x (keys/brackets/quotes).
        """
        if text_size <= 0:
            return 0
        base = text_size / 4
        if is_json:
            base *= 1.3
        return int(base)

    @staticmethod
    def _estimate_output_tokens(output_size: int, content_types: Dict[str, int]) -> int:
        """
        Estimate output tokens with content-type awareness.

        Base64 content tokenizes poorly: base64_tokens ≈ base64_len / 3.
        """
        if output_size <= 0:
            return 0
        image_count = content_types.get("image", 0)
        if image_count > 0:
            # Assume ~60% of output is base64 for images
            base64_portion = output_size * 0.6
            text_portion = output_size * 0.4
            return int(base64_portion / 3 + text_portion / 4)
        return int(output_size / 4 * 1.3)

    def get_snapshot(self, mcp_name: Optional[str] = None) -> Dict[str, Any]:
        """Return full metrics snapshot for one or all MCPs."""
        with self._lock:
            if mcp_name:
                metrics = self._mcps.get(mcp_name, {}).copy()
                digest = self._latency_digests.get(mcp_name)
                if digest:
                    metrics["p50_latency_ms"] = round(digest.percentile(50), 2)
                    metrics["p95_latency_ms"] = round(digest.percentile(95), 2)
                    metrics["p99_latency_ms"] = round(digest.percentile(99), 2)
                tools = self._tools.get(mcp_name, {})
                return {"mcp": mcp_name, "metrics": metrics, "tools": dict(tools), "timestamp": time.time()}

            result = {}
            for mcp, metrics in self._mcps.items():
                entry = metrics.copy()
                digest = self._latency_digests.get(mcp)
                if digest:
                    entry["p50_latency_ms"] = round(digest.percentile(50), 2)
                    entry["p95_latency_ms"] = round(digest.percentile(95), 2)
                    entry["p99_latency_ms"] = round(digest.percentile(99), 2)
                result[mcp] = entry
            return {"mcps": result, "timestamp": time.time()}

    def get_global_metrics(self) -> Dict[str, Any]:
        """Return aggregate metrics across all MCPs."""
        with self._lock:
            total_calls = sum(m.get("total_calls", 0) for m in self._mcps.values())
            total_errors = sum(m.get("error_count", 0) for m in self._mcps.values())
            total_input_tokens = sum(m.get("total_input_tokens", 0) for m in self._mcps.values())
            total_output_tokens = sum(m.get("total_output_tokens", 0) for m in self._mcps.values())

            error_rate = total_errors / max(total_calls, 1)

            # Team breakdown
            team_calls = {"red": 0, "blue": 0, "purple": 0, "unclassified": 0}
            for mcp, metrics in self._mcps.items():
                role = self._mcp_roles.get(mcp, "unclassified")
                team_calls[role] = team_calls.get(role, 0) + metrics.get("total_calls", 0)

            return {
                "total_calls": total_calls,
                "total_errors": total_errors,
                "global_error_rate": round(error_rate, 4),
                "total_input_tokens": total_input_tokens,
                "total_output_tokens": total_output_tokens,
                "total_tokens": total_input_tokens + total_output_tokens,
                "team_breakdown": team_calls,
                "mcp_count": len(self._mcps),
                "timestamp": time.time(),
            }

    def persist_to_disk(self, path: Path) -> None:
        """Persist metrics to disk as JSON."""
        with self._lock:
            snapshot = self.get_snapshot()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = path.with_suffix(".tmp")
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(snapshot, f, indent=2, default=str)
                f.flush()
                os.fsync(f.fileno())
            tmp_path.replace(path)
            logger.debug("Metrics persisted to %s", path)
        except Exception as exc:
            logger.error("Failed to persist metrics: %s", exc)

    def to_prometheus(self) -> str:
        """Export metrics in Prometheus text exposition format."""
        lines = []
        with self._lock:
            for mcp, metrics in self._mcps.items():
                safe_mcp = mcp.replace("-", "_").replace(".", "_")
                lines.append(f'mcp_tool_calls_total{{mcp="{mcp}"}} {metrics.get("total_calls", 0)}')
                lines.append(f'mcp_tool_errors_total{{mcp="{mcp}"}} {metrics.get("error_count", 0)}')
                lines.append(f'mcp_tool_timeouts_total{{mcp="{mcp}"}} {metrics.get("timeout_count", 0)}')
                lines.append(f'mcp_tokens_input_total{{mcp="{mcp}"}} {metrics.get("total_input_tokens", 0)}')
                lines.append(f'mcp_tokens_output_total{{mcp="{mcp}"}} {metrics.get("total_output_tokens", 0)}')
                digest = self._latency_digests.get(mcp)
                if digest:
                    lines.append(f'mcp_latency_p50_ms{{mcp="{mcp}"}} {round(digest.percentile(50), 2)}')
                    lines.append(f'mcp_latency_p95_ms{{mcp="{mcp}"}} {round(digest.percentile(95), 2)}')
                    lines.append(f'mcp_latency_p99_ms{{mcp="{mcp}"}} {round(digest.percentile(99), 2)}')

                # Per-tool metrics
                for tool, tm in self._tools.get(mcp, {}).items():
                    lines.append(f'mcp_tool_calls_total{{mcp="{mcp}",tool="{tool}"}} {tm.get("calls", 0)}')
                    lines.append(f'mcp_tool_errors_total{{mcp="{mcp}",tool="{tool}"}} {tm.get("errors", 0)}')

        return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# 13h. Alert Engine
# ---------------------------------------------------------------------------

@dataclass
class AlertRule:
    """Definition of an alert rule."""
    name: str
    condition_type: str  # "error_rate", "latency", "health", "token_budget", "event_match"
    threshold: float = 0.0
    window_seconds: float = 300.0  # 5 minutes
    severity: str = McpSeverity.WARN.value
    mcp_filter: str = "*"  # "*" = all MCPs
    event_type_match: Optional[str] = None
    cooldown_seconds: float = 300.0


class McpAlertEngine:
    """
    Threshold-based and anomaly detection alerting.

    Evaluates alert rules against metrics, emits ALERT_TRIGGERED / ALERT_RESOLVED
    events through the event bus.
    """

    def __init__(self, event_bus: McpEventBus, metrics: McpMetricsCollector) -> None:
        self._event_bus = event_bus
        self._metrics = metrics
        self._rules: List[AlertRule] = []
        self._active_alerts: Dict[str, Dict[str, Any]] = {}  # key -> alert info
        self._last_fired: Dict[str, float] = {}  # key -> timestamp
        self._lock = threading.Lock()

        # Z-score anomaly detection
        self._latency_history: Dict[str, List[float]] = {}
        self._call_rate_history: Dict[str, List[Tuple[float, int]]] = {}

        # Dead man's switch
        self._last_event_per_mcp: Dict[str, float] = {}
        self._dead_man_timeout = 300.0  # 5 minutes

        logger.debug("McpAlertEngine initialized")

    def load_rules(self, rules: List[Dict[str, Any]]) -> None:
        """Load alert rules from config."""
        self._rules = []
        for r in rules:
            try:
                self._rules.append(AlertRule(
                    name=r["name"],
                    condition_type=r.get("condition", "").split()[0] if " " in r.get("condition", "") else r.get("condition_type", "event_match"),
                    threshold=float(r.get("threshold", r.get("condition", "0").split(">")[-1].strip())) if ">" in r.get("condition", "") else 0,
                    window_seconds=self._parse_window(r.get("window", "5m")),
                    severity=r.get("severity", "WARN"),
                    mcp_filter=r.get("mcp", "*"),
                    event_type_match=r.get("event_type"),
                    cooldown_seconds=float(r.get("cooldown", 300)),
                ))
            except Exception as exc:
                logger.error("Failed to parse alert rule %s: %s", r.get("name"), exc)
        logger.info("Loaded %d alert rules", len(self._rules))

    @staticmethod
    def _parse_window(window_str: str) -> float:
        """Parse time window string like '5m', '1h', '30s'."""
        if window_str.endswith("m"):
            return float(window_str[:-1]) * 60
        elif window_str.endswith("h"):
            return float(window_str[:-1]) * 3600
        elif window_str.endswith("s"):
            return float(window_str[:-1])
        return float(window_str)

    def record_event(self, event: McpLogEvent) -> None:
        """Process an event for alerting (called from event bus subscriber)."""
        self._last_event_per_mcp[event.mcp_name] = time.time()

        # Check event-match rules
        for rule in self._rules:
            if rule.event_type_match and event.event_type == rule.event_type_match:
                if rule.mcp_filter == "*" or event.mcp_name in rule.mcp_filter.split(","):
                    self._fire_alert(rule, event.mcp_name, {"event": event.to_dict()})

    def evaluate_metrics(self) -> None:
        """Evaluate metric-based alert rules. Call periodically."""
        with self._lock:
            snapshot = self._metrics.get_snapshot()
            mcps = snapshot.get("mcps", {})

            for rule in self._rules:
                for mcp_name, metrics in mcps.items():
                    if rule.mcp_filter != "*" and mcp_name not in rule.mcp_filter.split(","):
                        continue

                    if rule.condition_type == "error_rate":
                        total = metrics.get("total_calls", 0)
                        errors = metrics.get("error_count", 0)
                        rate = errors / max(total, 1)
                        if rate > rule.threshold and total >= 10:
                            self._fire_alert(rule, mcp_name, {"error_rate": rate, "total_calls": total})
                        else:
                            self._resolve_alert(rule, mcp_name)

                    elif rule.condition_type == "latency":
                        p95 = metrics.get("p95_latency_ms", 0)
                        if p95 > rule.threshold:
                            self._fire_alert(rule, mcp_name, {"p95_latency_ms": p95})
                        else:
                            self._resolve_alert(rule, mcp_name)

                    elif rule.condition_type == "token_budget":
                        total_tokens = metrics.get("total_input_tokens", 0) + metrics.get("total_output_tokens", 0)
                        if total_tokens > rule.threshold:
                            self._fire_alert(rule, mcp_name, {"total_tokens": total_tokens})

            # Dead man's switch
            now = time.time()
            for mcp_name in mcps:
                last = self._last_event_per_mcp.get(mcp_name, now)
                if now - last > self._dead_man_timeout:
                    self._event_bus.emit(McpLogEvent(
                        mcp_name=mcp_name,
                        event_type=McpEventType.SYSTEM_WARNING.value,
                        severity=McpSeverity.WARN.value,
                        data={"message": f"MCP completely silent for {int(now - last)}s", "silent_since": last},
                    ))

    def _fire_alert(self, rule: AlertRule, mcp_name: str, details: Dict[str, Any]) -> None:
        """Fire an alert if not in cooldown."""
        alert_key = f"{rule.name}:{mcp_name}"
        now = time.time()

        # Cooldown check
        if alert_key in self._last_fired:
            if now - self._last_fired[alert_key] < rule.cooldown_seconds:
                return

        self._last_fired[alert_key] = now
        self._active_alerts[alert_key] = {
            "rule": rule.name, "mcp": mcp_name, "fired_at": now,
            "severity": rule.severity, "details": details,
        }

        self._event_bus.emit(McpLogEvent(
            mcp_name=mcp_name,
            event_type=McpEventType.ALERT_TRIGGERED.value,
            severity=rule.severity,
            data={"rule": rule.name, "details": details},
        ))
        logger.warning("Alert fired: %s for %s — %s", rule.name, mcp_name, details)

    def _resolve_alert(self, rule: AlertRule, mcp_name: str) -> None:
        """Resolve an active alert."""
        alert_key = f"{rule.name}:{mcp_name}"
        if alert_key in self._active_alerts:
            alert_info = self._active_alerts.pop(alert_key)
            duration = time.time() - alert_info["fired_at"]
            self._event_bus.emit(McpLogEvent(
                mcp_name=mcp_name,
                event_type=McpEventType.ALERT_RESOLVED.value,
                severity=McpSeverity.INFO.value,
                data={"rule": rule.name, "duration_seconds": round(duration, 1)},
            ))
            logger.info("Alert resolved: %s for %s (duration: %.1fs)", rule.name, mcp_name, duration)

    def get_active_alerts(self) -> List[Dict[str, Any]]:
        """Return all currently active alerts."""
        with self._lock:
            return list(self._active_alerts.values())

    def persist_alerts(self, path: Path) -> None:
        """Persist active alerts to disk."""
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._active_alerts, f, indent=2, default=str)
                f.flush()
                os.fsync(f.fileno())
            tmp.replace(path)
        except Exception as exc:
            logger.error("Failed to persist alerts: %s", exc)


# ---------------------------------------------------------------------------
# 13f. McpLogger — Top-Level Integration Facade
# ---------------------------------------------------------------------------

class McpLogger:
    """
    Top-level facade integrating event bus, metrics, and alerting.

    Created by start_server.py, passed to supervisor and API for integration.
    """

    def __init__(
        self,
        state_dir: Path,
        logs_dir: Path,
        ring_buffer_size: int = _DEFAULT_RING_BUFFER_SIZE,
        max_memory_mb: int = _DEFAULT_MAX_MEMORY_MB,
        metrics_persist_interval: float = 60.0,
        alert_config_path: Optional[Path] = None,
    ) -> None:
        self._state_dir = state_dir
        self._logs_dir = logs_dir
        self._metrics_persist_interval = metrics_persist_interval

        # Core components
        self.event_bus = McpEventBus(
            max_events=ring_buffer_size,
            max_memory_mb=max_memory_mb,
            archive_path=logs_dir / "mcp_events.jsonl",
        )
        self.metrics = McpMetricsCollector()
        self.alerts = McpAlertEngine(self.event_bus, self.metrics)

        # Process proxies keyed by MCP name
        self._proxies: Dict[str, McpProcessProxy] = {}
        self._docker_proxies: Dict[str, DockerLogProxy] = {}

        # Background tasks
        self._metrics_task: Optional[asyncio.Task] = None
        self._alert_task: Optional[asyncio.Task] = None
        self._timeout_task: Optional[asyncio.Task] = None
        self._running = False

        # Load alert rules
        if alert_config_path and alert_config_path.exists():
            try:
                with open(alert_config_path, "r", encoding="utf-8") as f:
                    alert_config = json.load(f)
                self.alerts.load_rules(alert_config.get("rules", []))
            except Exception as exc:
                logger.error("Failed to load alert config from %s: %s", alert_config_path, exc)

        logger.info(
            "McpLogger initialized: ring_buffer=%d, max_memory=%dMB, metrics_interval=%.0fs",
            ring_buffer_size, max_memory_mb, metrics_persist_interval,
        )

    async def start(self, loop: Optional[asyncio.AbstractEventLoop] = None) -> None:
        """Start the Central MCP Logger."""
        event_loop = loop or asyncio.get_event_loop()
        self.event_bus.set_loop(event_loop)
        self.event_bus.start()
        self._running = True

        # Subscribe metrics collector to event bus
        _, metrics_queue = self.event_bus.subscribe()
        asyncio.create_task(self._metrics_consumer(metrics_queue))

        # Start background tasks
        self._metrics_task = asyncio.create_task(self._periodic_metrics_persist())
        self._alert_task = asyncio.create_task(self._periodic_alert_eval())
        self._timeout_task = asyncio.create_task(self._periodic_timeout_check())

        logger.info("McpLogger started")

    async def stop(self) -> None:
        """Stop the Central MCP Logger."""
        self._running = False

        # Cancel background tasks
        for task in [self._metrics_task, self._alert_task, self._timeout_task]:
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        # Stop all proxies
        for proxy in self._proxies.values():
            proxy.stop()
        for proxy in self._docker_proxies.values():
            proxy.stop()

        # Final persist
        self.metrics.persist_to_disk(self._state_dir / "mcp_metrics.json")
        self.alerts.persist_alerts(self._state_dir / "active_alerts.json")

        self.event_bus.stop()
        logger.info("McpLogger stopped")

    def create_proxy(self, mcp_name: str, tool_timeout: float = 300) -> McpProcessProxy:
        """Create a process proxy for an MCP server."""
        proxy = McpProcessProxy(mcp_name, self.event_bus, tool_timeout)
        self._proxies[mcp_name] = proxy
        logger.debug("Created process proxy for %s", mcp_name)
        return proxy

    def create_docker_proxy(self, mcp_name: str, container_name: str) -> DockerLogProxy:
        """Create a Docker log proxy for a Docker-based MCP."""
        proxy = DockerLogProxy(mcp_name, container_name, self.event_bus)
        self._docker_proxies[mcp_name] = proxy
        logger.debug("Created Docker proxy for %s (container: %s)", mcp_name, container_name)
        return proxy

    async def _metrics_consumer(self, queue: asyncio.Queue) -> None:
        """Consume events from event bus and feed to metrics + alerts."""
        while self._running:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=1.0)
                self.metrics.record_event(event)
                self.alerts.record_event(event)
            except asyncio.TimeoutError:
                continue
            except Exception as exc:
                logger.error("Metrics consumer error: %s", exc)

    async def _periodic_metrics_persist(self) -> None:
        """Persist metrics to disk periodically."""
        while self._running:
            try:
                await asyncio.sleep(self._metrics_persist_interval)
                self.metrics.persist_to_disk(self._state_dir / "mcp_metrics.json")
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Metrics persist error: %s", exc)

    async def _periodic_alert_eval(self) -> None:
        """Evaluate metric-based alerts periodically."""
        while self._running:
            try:
                await asyncio.sleep(30)  # Every 30 seconds
                self.alerts.evaluate_metrics()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Alert evaluation error: %s", exc)

    async def _periodic_timeout_check(self) -> None:
        """Check for tool call timeouts periodically."""
        while self._running:
            try:
                await asyncio.sleep(10)
                for proxy in self._proxies.values():
                    await proxy.check_timeouts()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Timeout check error: %s", exc)
