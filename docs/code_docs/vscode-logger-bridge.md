# VS Code Logger Bridge — Technical Code Documentation

## Overview

The Logger Bridge connects the VS Code extension to the Backend MCP Server Manager's SSE event stream. It receives real-time MCP events, aggregates metrics locally, and forwards them to the Debug Panel webview.

**Stack:** TypeScript, Node.js `https`/`http` modules (no npm dependencies for SSE)

---

## Architecture

### File Structure

```
plugin/src/mcp/
├── mcpLoggerTypes.ts      ← TypeScript interfaces, enums, message types
├── mcpLoggerClient.ts     ← Node.js SSE client with manual protocol parser
└── mcpDebugBridge.ts      ← SSE→webview bridge with metrics aggregation

plugin/src/test/
└── mockSseServer.ts       ← Configurable mock SSE server for testing
```

### Data Flow

```
Backend SSE Stream → McpLoggerClient → McpDebugDataBridge → Webview postMessage()
                         ↑                    ↓
                    reconnect +          LocalMcpMetrics
                    heartbeat            (aggregation)
```

---

## Module Reference

### `mcpLoggerTypes.ts` — Type Definitions

All TypeScript types mirroring the Python backend's data structures.

#### Enums

| Enum | Values | Python Equivalent |
|------|--------|-------------------|
| `McpEventType` | 15 types (TOOL_CALL_START, SERVER_CRASH, HEALTH_CHECK_OK, etc.) | `mcp_logger.McpEventType` |
| `McpSeverity` | `DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL` | `mcp_logger.McpSeverity` |

#### Core Interfaces

| Interface | Fields | Description |
|-----------|--------|-------------|
| `McpLogEvent` | `id`, `timestamp`, `event_type`, `severity`, `mcp_name`, `tool_name`, `message`, `data`, `duration_ms` | Single event from backend |
| `ToolMetrics` | `tool_name`, `call_count`, `error_count`, `avg_duration_ms`, `p95_duration_ms`, `last_call` | Per-tool statistics |
| `McpServerMetrics` | `mcp_name`, `total_events`, `tool_calls`, `errors`, `tools`, `events_per_minute`, `uptime_seconds` | Per-MCP aggregate metrics |
| `MetricsSnapshot` | `timestamp`, `servers`, `total_events`, `active_servers` | Full metrics state |

#### Connection Types

| Type | Values | Description |
|------|--------|-------------|
| `ConnectionStatus` | `connected`, `connecting`, `disconnected`, `error` | SSE connection state |
| `ConnectionMode` | `live`, `cached`, `offline` | Data source mode |

#### Message Protocols

**`WebviewInboundMessage`** — Messages FROM webview TO bridge (discriminated union):

| `type` | Fields | Purpose |
|--------|--------|---------|
| `requestSnapshot` | — | Request current metrics |
| `requestMcpDetail` | `mcpName` | Request detailed per-MCP data |
| `requestHistory` | `mcpName`, `count` | Request event history |
| `setFilter` | `mcpName` | Set SSE filter to specific MCP |
| `connectBackend` | `url`, `token` | Connect to backend |
| `disconnectBackend` | — | Disconnect |

**`WebviewOutboundMessage`** — Messages FROM bridge TO webview:

| `type` | Fields | Purpose |
|--------|--------|---------|
| `mcpEvent` | `event` | Single real-time event |
| `mcpEventBatch` | `events` | Batched events (rate limited) |
| `metricsSnapshot` | `snapshot` | Full metrics update |
| `connectionStatus` | `status`, `mode`, `reconnectCount`, `uptime` | Connection state change |
| `mcpDetailResponse` | `mcpName`, `metrics`, `recentEvents`, `toolRecords` | Detailed MCP response |
| `authRequired` | `url` | Backend returned 401/403 |
| `backendOffline` | `lastSeen` | Backend unreachable |

#### Configuration Interfaces

| Interface | Fields | Description |
|-----------|--------|-------------|
| `SseClientConfig` | `url`, `token`, `reconnectBaseDelay`, `reconnectMaxDelay`, `heartbeatTimeout` | SSE client settings |
| `DataBridgeConfig` | `eventBufferSize`, `refreshRateMs`, `offlineThreshold` | Bridge behavior settings |
| `BridgeTelemetry` | `eventsReceived`, `eventsDropped`, `reconnectCount`, `lastEventTime` | Bridge diagnostics |

---

### `mcpLoggerClient.ts` — SSE Client

Node.js SSE client built on raw `https.request()`/`http.request()` (no npm SSE library needed).

#### Class: `McpLoggerClient`

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor()` | `(config: SseClientConfig)` | Initialize with URL and token |
| `connect()` | `() → void` | Open SSE connection |
| `disconnect()` | `() → void` | Close connection and clear timers |
| `setFilter()` | `(mcpName?: string) → void` | Set MCP filter (debounced 300ms) |
| `dispose()` | `() → void` | Full cleanup |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `isConnected` | `boolean` | Current connection state |
| `lastEventTime` | `number` | Timestamp of last received event |
| `reconnectCount` | `number` | Total reconnection attempts |
| `connectionUptime` | `number` | Current connection duration (ms) |
| `eventsReceived` | `number` | Total events received |

#### Events (via `on()`)

| Event | Payload | Description |
|-------|---------|-------------|
| `event` | `McpLogEvent` | Parsed MCP event |
| `connected` | — | Connection established |
| `disconnected` | `{ reason }` | Connection lost |
| `error` | `Error` | Connection or parse error |

#### SSE Protocol Parser

Manual implementation of the SSE specification:

| Line Prefix | Handling |
|-------------|----------|
| `data:` | Append to current event data buffer |
| `event:` | Set event type field |
| `id:` | Set last event ID (used for reconnect) |
| `retry:` | Override reconnect delay from server |
| `:` (comment) | Treated as heartbeat, resets timeout |
| Empty line | Dispatch accumulated event |

#### Reconnection Logic

- **Base delay:** 2 seconds (configurable via `reconnectBaseDelay`)
- **Max delay:** 60 seconds (configurable via `reconnectMaxDelay`)
- **Backoff:** Exponential (`delay * 2^attempt`)
- **Reset:** After 30 seconds of stable connection
- **Server override:** Respects `retry:` field from SSE stream
- **Replay:** Sends `Last-Event-ID` header on reconnect for event replay

#### Heartbeat Monitoring

- Timeout: 90 seconds without data or heartbeat comment
- On timeout: force disconnect → trigger reconnect

#### Connection Details

- **Auth:** `Authorization: Bearer <token>` header
- **Keep-alive:** `Connection: keep-alive` header for proxy environments
- **Abort:** Uses `AbortController` for clean disconnect (no dangling sockets)
- **Filter:** Appends `?mcp=<name>` query parameter when filter is set

---

### `mcpDebugBridge.ts` — Data Bridge

Transforms SSE events into webview messages with metrics aggregation.

#### Class: `McpDebugDataBridge`

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor()` | `(config: DataBridgeConfig, globalState)` | Initialize with settings and state storage |
| `attachWebview()` | `(webview: Webview) → void` | Connect to webview panel for message passing |
| `detachWebview()` | `() → void` | Disconnect webview, buffer events for replay |
| `connect()` | `(url: string, token: string) → void` | Connect to backend SSE |
| `disconnect()` | `() → void` | Disconnect from backend |
| `handleWebviewMessage()` | `(msg: WebviewInboundMessage) → void` | Process messages from webview |
| `dispose()` | `() → void` | Full cleanup |

#### Event Buffering

- **Buffer size:** Configurable (default 100, from `debugPanelEventBufferSize` setting)
- **Eviction:** Oldest events removed when buffer is full
- **Replay:** On `attachWebview()`, all buffered events are replayed to new panel

#### Rate Limiting

- **Batch window:** Configurable (default 100ms, from `debugPanelRefreshRate` setting)
- **Single events:** Sent immediately if no batch pending
- **Batch events:** Accumulated events sent as `mcpEventBatch` message at end of window

#### Metrics Aggregation

**Class: `LocalMcpMetrics`** — TypeScript port of Python `McpMetricsCollector`:

| Metric | Calculation | Description |
|--------|-------------|-------------|
| `total_events` | Counter | All events for this MCP |
| `tool_calls` | Counter | TOOL_CALL_START events |
| `errors` | Counter | ERROR/CRITICAL severity |
| `events_per_minute` | `count / (elapsed / 60)` | Event rate |
| `tools` | `Map<string, LocalToolMetrics>` | Per-tool breakdowns |

**Class: `LocalToolMetrics`** — Per-tool statistics:

| Metric | Calculation |
|--------|-------------|
| `call_count` | Counter |
| `error_count` | Counter |
| `avg_duration_ms` | Running average |
| `p95_duration_ms` | Sorted durations, 95th percentile index |

#### Offline Mode

- **Detection:** 3 consecutive SSE connection failures
- **Behavior:** Sends `backendOffline` message to webview
- **Cache:** Persists last known metrics to `globalState` for recovery
- **Restore:** On reconnect, loads cached metrics and merges with live data

#### Auth Handling

- On 401/403 from SSE or API: sends `authRequired` message to webview
- Webview shows token input dialog

#### Backend API Calls

`_apiGet(path)`: HTTP GET to backend API for non-SSE data (metrics detail, history):
- Adds `Authorization` header
- Returns parsed JSON or `null` on failure
- Used by `requestMcpDetail` and `requestHistory` handlers

---

### `mockSseServer.ts` — Test Server

Configurable mock SSE server for testing the logger bridge.

#### Class: `MockSseServer`

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor()` | `(config: MockConfig)` | Configure behavior |
| `start()` | `async () → void` | Start HTTP server |
| `stop()` | `async () → void` | Stop server |
| `emitEvent()` | `(event: Partial<McpLogEvent>) → void` | Push custom event to all SSE clients |
| `emitMalformed()` | `() → void` | Send malformed SSE data |
| `dropConnections()` | `() → void` | Force disconnect all clients |
| `sendRetryField()` | `(ms: number) → void` | Send `retry:` directive |

#### Configuration

| Field | Default | Description |
|-------|---------|-------------|
| `port` | `19876` | Server port |
| `authToken` | `"test-token"` | Expected bearer token |
| `eventIntervalMs` | `500` | Auto-generated event interval |
| `malformedRate` | `0` | Fraction of events sent malformed |
| `dropAfterEvents` | `0` | Drop connection after N events (0 = never) |
| `heartbeatIntervalMs` | `30000` | Heartbeat interval |

#### Endpoints

| Path | Description |
|------|-------------|
| `/health` | Returns `{"status": "ok"}` |
| `/api/v1/events/stream` | SSE event stream with auth |
| `/api/v1/events/metrics` | Mock metrics snapshot |

Auto-generates diverse events across 4 MCP names (`playwright`, `crawl4ai`, `nmap`, `custom-mcp`) and 4 tool names.
