# Logger Integration Guide

Step-by-step instructions for adding detailed logging to MCP server source code for maximum visibility via the Central MCP Logger.

## Overview

The Central MCP Logger (Cat 13) operates in **3 phases**:

1. **Phase 1 — Process Proxy (automatic, no code changes):** `McpProcessProxy` passively intercepts stdout/stderr JSON-RPC messages. This captures all tool call start/end/error events, health checks, and protocol messages without modifying MCP source code. **This is the default and works out of the box.**

2. **Phase 2 — Source Code Instrumentation (manual, per-MCP):** Add explicit logging calls inside MCP server code for deeper visibility: internal function timing, external API calls, database queries, subprocess spawns. Requires MCP source access and import of `mcp_logging_helper`.

3. **Phase 3 — MCP SDK with Built-in Logging (future):** Long-term goal of standardized logging as part of the MCP SDK itself, requiring upstream cooperation.

---

## Phase 1: Process Proxy (No Code Changes)

Already implemented by Cat 13b. The `McpProcessProxy` wraps each MCP server's subprocess and captures:

- `tools/call` requests → `TOOL_CALL_START` events
- `tools/call` responses → `TOOL_CALL_END` events
- JSON-RPC errors → `TOOL_CALL_ERROR` events
- Timeout detection → `TOOL_CALL_TIMEOUT` events
- `initialize` handshake → `MCP_INITIALIZE` events
- `notifications/progress` → `MCP_NOTIFICATION` events
- stderr output → `SERVER_LOG` events

**No action required per MCP.** Just start the backend and all MCPs are automatically instrumented.

---

## Phase 2: Source Code Instrumentation

### Prerequisites

- Access to the MCP server's Python source code
- The MCP server runs inside the managed backend environment

### Step 1: Import the helper

```python
from mcp_logging_helper import (
    configure,
    log_tool_start,
    log_tool_end,
    log_tool_error,
    log_external_call,
    log_destructive_action,
)

# Call once during MCP server initialization
configure(mcp_name="your-mcp-name")
```

### Step 2: Instrument tool entry points

At the beginning of each tool handler function:

```python
def handle_nmap_scan(params: dict) -> dict:
    ctx = log_tool_start("nmap_scan", params)
    try:
        result = _do_nmap_scan(params["target"], params.get("flags", "-sV"))
        log_tool_end("nmap_scan", result, context=ctx)
        return result
    except Exception as e:
        log_tool_error("nmap_scan", e, context=ctx)
        raise
```

### Step 3: Instrument external API calls

When the MCP tool calls external services (Shodan API, Nessus API, etc.):

```python
import time

start = time.monotonic()
try:
    response = requests.get(f"https://api.shodan.io/shodan/host/{ip}", params={"key": api_key})
    duration = (time.monotonic() - start) * 1000
    log_external_call("shodan_api", f"https://api.shodan.io/shodan/host/{ip}", "GET", duration, response.status_code)
except Exception as e:
    duration = (time.monotonic() - start) * 1000
    log_external_call("shodan_api", f"https://api.shodan.io/shodan/host/{ip}", "GET", duration, 0, str(e))
    raise
```

### Step 4: Instrument destructive actions

For tools that modify system state:

```python
def handle_block_ip(params: dict) -> dict:
    log_destructive_action(
        tool_name="block_ip",
        target=params["ip"],
        parameters=params,
        confirmation_required=True,
    )
    # ... proceed with blocking
```

### Logging Injection Points per MCP Type

| Injection Point | What to Log | Why |
|----------------|-------------|-----|
| Tool entry | `log_tool_start()` | Track tool invocation with params |
| Tool exit (success) | `log_tool_end()` | Track duration, output size |
| Tool exit (error) | `log_tool_error()` | Track error type, message, duration |
| External API call | `log_external_call()` | Track external dependencies |
| Database query | `log_external_call("db", ...)` | Track data access patterns |
| File I/O | `log_external_call("file", path, ...)` | Track file access |
| Subprocess spawn | `log_external_call("subprocess", cmd, ...)` | Track shell commands |
| Destructive action | `log_destructive_action()` | Enhanced audit trail |

---

## Phase 3: MCP SDK Integration (Future)

Long-term goal: contribute logging hooks to the MCP specification/SDK so all MCP servers emit structured events natively. This requires:

1. Standardized logging event format in the MCP spec
2. SDK support for logging transport (stdout sideband, dedicated logging channel)
3. Upstream adoption by MCP server implementations

Until Phase 3 is available, Phases 1 and 2 provide full coverage.

---

## Per-MCP Configuration

Logging verbosity, field redaction, and output preview are configured in `backend/config/mcp_logging.json`. See that file for current per-MCP settings.

Protocol quirks and transport strategies are documented in `backend/config/mcp_protocol_quirks.json`.
