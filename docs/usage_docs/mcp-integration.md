# MCP Integration — User Documentation

## Overview

The extension integrates two MCP (Model Context Protocol) servers that provide AI agents with browser automation and web crawling capabilities. MCP servers are configured via `.vscode/mcp.json` in your workspace.

### Supported MCP Servers

| Server | Purpose | Transport |
|--------|---------|----------|
| **Playwright** | Browser automation — navigate, click, type, screenshot, PDF export | Stdio (npx) |
| **Crawl4ai** | Web crawling — extract content, structured data, markdown from websites | SSE (HTTP) |

---

## MCP Server Configuration

### Enable / Disable Servers

Each MCP server can be individually enabled or disabled:

1. Open the **Sudx CC webview** panel
2. Scroll to the **MCP Servers** section
3. Toggle each server on or off using the switch

Alternatively, configure in VS Code settings:

```json
"sudx-ai.mcpServers": {
  "playwright": true,
  "crawl4ai": true
}
```

Disabled servers are excluded from deployment — their entries will not appear in `.vscode/mcp.json`.

### Deploy Mode

Controls how MCP config interacts with existing `.vscode/mcp.json`:

| Mode | Behavior |
|------|----------|
| **Merge** (default) | Preserves your existing MCP servers, adds/updates only Sudx-managed servers |
| **Overwrite** | Replaces the entire `mcp.json` with the Sudx template (backs up first) |
| **Skip** | Does not touch MCP config at all |

Configure in VS Code settings:

```json
"sudx-ai.mcpDeployMode": "merge"
```

### What Happens During Merge

- Your custom MCP servers are **preserved** (never deleted or modified)
- Sudx-managed servers (marked internally with `_sudxManaged`) are **added or updated**
- If you have a server with the same name as a Sudx server, the Sudx version takes priority
- Input entries are merged by ID — duplicates are resolved in favor of the Sudx template

---

## MCP Servers in the Webview

The webview MCP section shows each configured server with:

- **Transport badge**: `stdio` or `sse` indicating the communication protocol
- **Status indicator**: Green dot = configured and enabled, Gray = disabled
- **Toggle switch**: Enable or disable the server for future deployments

Changes made via toggles take effect on the next deployment.

---

## MCP Guard Hooks

Guard hooks run automatically before AI agent tool calls to prevent misuse:

### Playwright Guard
- Requires accessibility snapshot before interaction tools (click, type, drag)
- Warns when navigating to localhost URLs
- Prevents blind interaction without page context

### Crawl4ai Guard
- Blocks crawling of private/internal IP addresses (security: SSRF prevention)
- Warns when crawl depth exceeds 3 levels
- Rate limit awareness to prevent server overload

Guard hooks are enabled/disabled alongside other hooks in the webview or settings.

---

## Crawl4ai Setup Requirements

Crawl4ai uses SSE transport and requires a running server. Choose one setup method:

### Option A: Docker (Recommended)

```bash
docker run -d -p 11235:11235 --name crawl4ai unclecode/crawl4ai
```

The extension connects to `http://localhost:11235/mcp` by default.

### Option B: pip Install

```bash
pip install crawl4ai
crawl4ai-server --port 11235
```

### Verification

The session context hook automatically checks SSE endpoint reachability at session start. If the server is unreachable, a warning is logged but deployment proceeds.

---

## MCP Rollback

If MCP deployment causes issues, you can restore the previous configuration:

1. Open the Command Palette (`Ctrl+Shift+P`)
2. Run **Sudx CC: Rollback MCP Config**
3. Confirm the rollback in the dialog

This restores `.vscode/mcp.json` from the automatic backup created during the last deployment. The backup is stored in `.sudx-backups/` in your workspace.

---

## Troubleshooting

### Crawl4ai shows "unreachable"
- Ensure Docker is running and the container is started
- Check that port 11235 is not blocked by firewall
- Verify the endpoint with: `curl http://localhost:11235/mcp`

### Playwright tools are blocked
- The guard hook requires `browser_snapshot` before interaction tools
- Take a snapshot first, then click/type/drag

### MCP servers not appearing after deploy
- Check that the server is enabled in settings (`sudx-ai.mcpServers`)
- Verify deploy mode is not set to `skip`
- Check the output log for deployment errors
