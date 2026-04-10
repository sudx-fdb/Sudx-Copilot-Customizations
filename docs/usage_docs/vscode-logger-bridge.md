# VS Code Logger Bridge — User Documentation

## Overview

The Logger Bridge provides real-time MCP server monitoring directly in VS Code. It connects to the Backend MCP Server Manager and displays live events, metrics, and server health in the Debug Panel.

---

## Requirements

- Backend MCP Server Manager running on VPS (see Backend MCP Manager docs)
- VS Code extension installed and activated
- Network access from VS Code to backend API endpoint

---

## Connecting to the Backend

### Automatic Connection

If `sudx-ai.autoConnectToBackend` is enabled (default), the extension automatically connects to the backend when VS Code starts.

### Manual Connection

1. Open the Command Palette (`Ctrl+Shift+P`)
2. Run **Sudx: Connect to Backend**
3. If no token is stored, you will be prompted to enter one

### Setting the Token

1. Open the Command Palette
2. Run **Sudx: Set Backend Token**
3. Enter your API token

The token is stored securely in VS Code's SecretStorage when `sudx-ai.storeTokenSecurely` is enabled (default).

### Disconnecting

1. Open the Command Palette
2. Run **Sudx: Disconnect from Backend**

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `sudx-ai.autoConnectToBackend` | `true` | Automatically connect on VS Code startup |
| `sudx-ai.storeTokenSecurely` | `true` | Use VS Code SecretStorage for token |
| `sudx-ai.debugPanelEventBufferSize` | `100` | Number of events kept in memory when panel is closed |
| `sudx-ai.debugPanelRefreshRate` | `100` | Minimum milliseconds between UI updates |
| `sudx-ai.loggerClientReconnectMaxDelay` | `60` | Maximum seconds between reconnection attempts |

---

## Debug Panel Features

### Live Event Stream

The Debug Panel shows real-time events from all managed MCP servers:
- Tool calls (start, end, error, timeout)
- Server lifecycle (start, stop, crash, restart)
- Health check results (pass, fail)
- Configuration changes
- Alerts and warnings

### Metrics Overview

Aggregated statistics per MCP server:
- Total events received
- Tool call count and error rate
- Average and 95th percentile response times
- Events per minute rate
- Server uptime

### Filtering

Use the MCP filter to focus on events from a specific server. The filter operates server-side — only matching events are streamed, reducing bandwidth.

### Detail View

Click on a server name to see detailed metrics:
- Per-tool breakdown (call count, errors, durations)
- Recent event history
- Individual tool call records

---

## Connection States

| State | Indicator | Description |
|-------|-----------|-------------|
| Connected | Green | Live SSE connection active |
| Connecting | Yellow | Establishing connection or reconnecting |
| Disconnected | Grey | Not connected (manual disconnect or not configured) |
| Error | Red | Connection failed (check backend URL and token) |

### Offline Mode

If the backend becomes unreachable:
1. The bridge retries with exponential backoff (up to configured max delay)
2. After 3 consecutive failures, the panel shows "Backend Offline"
3. Last known metrics are preserved and displayed from cache
4. When the backend becomes available again, the connection is automatically restored

### Authentication Errors

If the token is invalid or expired:
1. The panel shows "Authentication Required"
2. Use **Sudx: Set Backend Token** to update the token
3. The connection is automatically re-established

---

## Troubleshooting

### Cannot connect to backend

| Symptom | Solution |
|---------|----------|
| Connection refused | Verify backend is running (`python start_server.py --status`) |
| Timeout | Check firewall allows port 8420, verify nginx is configured |
| 401 Unauthorized | Update token via **Sudx: Set Backend Token** |
| 403 Forbidden | Verify your IP is in the backend's allowlist |

### Events not appearing

| Symptom | Solution |
|---------|----------|
| No events at all | Check backend has MCP servers running and generating events |
| Events delayed | Check `debugPanelRefreshRate` setting, lower value = faster updates |
| Missing events after reconnect | Events are replayed from backend if `Last-Event-ID` is supported |

### High memory usage

- Reduce `debugPanelEventBufferSize` to lower the number of cached events
- Close the Debug Panel when not actively monitoring (events are still buffered)

---

## Commands

| Command | Description |
|---------|-------------|
| `Sudx: Connect to Backend` | Establish connection to backend API |
| `Sudx: Disconnect from Backend` | Close backend connection |
| `Sudx: Set Backend Token` | Store authentication token |
