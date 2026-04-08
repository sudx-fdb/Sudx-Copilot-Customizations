# MCP Integration — Technical Code Documentation

## Architecture Overview

The MCP (Model Context Protocol) integration enables the extension to deploy, configure, and manage MCP server definitions in the workspace `.vscode/mcp.json`. Three MCP servers are supported: **Playwright** (browser automation, stdio), **Figma** (design extraction, stdio), and **Crawl4ai** (web crawling, SSE).

### Module Map

| File | Purpose |
|------|---------|
| `plugin/src/deployment/mcpDeployer.ts` | Core MCP deployment: read, merge, write, backup, rollback of `.vscode/mcp.json` |
| `plugin/src/deployment/scanner.ts` | `scanMcpFiles()` — scans MCP template files, filters by enabled servers |
| `plugin/src/deployment/engine.ts` | Delegates MCP deployment to `McpDeployer`, integrates with main deploy flow |
| `plugin/src/types.ts` | MCP interfaces: `IMcpConfig`, `IMcpServerEntry`, `IMcpServerStatus`, `IMcpDeploymentState`, `IMcpServerConfig`, `McpTransport`, `McpDeployMode` |
| `plugin/src/constants.ts` | MCP constants: `MCP_CONFIG_FILENAME`, `SUDX_MCP_MARKER_KEY`, `DEFAULT_MCP_SERVERS`, `VALID_MCP_SERVERS`, thresholds, STRINGS |
| `plugin/src/config/settings.ts` | `getMcpDeployMode()`, `getMcpServerConfig()`, `setMcpServerConfig()` — user-facing MCP settings |
| `plugin/src/config/state.ts` | `getMcpDeploymentState()`, `setMcpDeploymentState()` — workspace state persistence for MCP |
| `plugin/src/commands.ts` | `rollbackMcp` command — restores pre-deployment MCP config from backup |
| `plugin/src/webview/provider.ts` | `buildMcpSection()` — generates MCP server cards in webview HTML |
| `plugin/src/webview/messaging.ts` | Validates `getMcpServers`, `updateMcpServer`, `updateAllMcpServers` message types |
| `plugin/media/scripts/main.js` | Frontend MCP rendering, toggle handling, status display |

---

## McpDeployer (`mcpDeployer.ts`)

### Class: `McpDeployer`

Constructor: `(logger: SudxLogger, fileOps: FileOperations, paths: PathUtils)`

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `deploy()` | `(templateFiles: ITemplateFile[], mode: McpDeployMode, serverConfig?: IMcpServerConfig) → Promise<IMcpDeployResult>` | Main entry point. Filters disabled servers, reads existing config, merges or overwrites, writes result atomically |
| `readExistingMcpConfig()` | `(targetUri: Uri) → Promise<IMcpConfig \| null>` | Reads and parses `.vscode/mcp.json`. Returns null if missing or invalid JSON |
| `mergeMcpConfigs()` | `(existing: IMcpConfig \| null, template: IMcpConfig) → IMcpMergeResult` | Preserves user servers (no `_sudxManaged` marker), overwrites Sudx servers, merges inputs by `id` |
| `writeMcpConfig()` | `(config: IMcpConfig, targetPath: string) → Promise<IFileOpResult>` | Atomic write: writes to `.tmp` then renames. Falls back to direct write on rename failure |
| `markSudxServers()` | `(config: IMcpConfig) → IMcpConfig` | Adds `_sudxManaged: true` to each server entry for tracking ownership |
| `removeSudxServers()` | `(config: IMcpConfig) → IMcpConfig` | Strips Sudx-managed servers, preserving user-defined ones |
| `rollbackMcpConfig()` | `(backupPath: string) → Promise<IFileOpResult>` | Restores `.vscode/mcp.json` from backup. Validates JSON before overwriting |
| `checkSseServerHealth()` | `(serverName: string, url: string) → Promise<boolean>` | Non-blocking HTTP HEAD with 3s timeout. Logs warning if unreachable, does not block deployment |

### Merge Algorithm

1. Iterate existing servers: if no `_sudxManaged` marker → copy to merged (preserved)
2. Iterate template servers: overwrite into merged (deployed). If name collision with user server → log conflict
3. Merge `inputs` arrays by `id` — template wins on duplicate IDs
4. Carry over `_sudxMeta` from template if present

### Deploy Modes

| Mode | Behavior |
|------|----------|
| `merge` | Preserves user servers, updates/adds Sudx servers, merges inputs |
| `overwrite` | Replaces entire `mcp.json` with template (after backup) |
| `skip` | No MCP deployment; returns immediately |

---

## MCP Types & Interfaces (`types.ts`)

### Enums

| Enum | Values | Purpose |
|------|--------|---------|
| `McpTransport` | `Stdio`, `Sse` | Transport protocol for MCP server communication |

### Types

| Type | Definition | Purpose |
|------|------------|---------|
| `McpDeployMode` | `'merge' \| 'overwrite' \| 'skip'` | Controls MCP deploy behavior |

### Interfaces

| Interface | Key Fields | Purpose |
|-----------|------------|---------|
| `IMcpConfig` | `mcpServers`, `inputs`, `_sudxMeta` | Root structure of `.vscode/mcp.json` |
| `IMcpServerEntry` | `command`, `args`, `env`, `url`, `_sudxManaged` | Single MCP server definition (stdio or SSE) |
| `IMcpServerStatus` | `name`, `transport`, `configured`, `enabled`, `command`, `url` | Runtime server status for webview display |
| `IMcpServerConfig` | `playwright`, `figma`, `crawl4ai` | Per-server enable/disable booleans (user setting) |
| `IMcpDeploymentState` | `lastMcpDeployDate`, `deployedServers`, `mcpConfigBackupPath`, `mergeConflicts` | Persisted workspace state for MCP |
| `IMcpSudxMeta` | `version`, `deployDate`, `managedServers` | Metadata block in mcp.json for Sudx tracking |

---

## MCP Constants (`constants.ts`)

| Constant | Value | Purpose |
|----------|-------|---------|
| `MCP_CONFIG_FILENAME` | `'mcp.json'` | Target config file name |
| `MCP_DEPLOY_TARGET` | `'.vscode'` | Target directory for MCP config |
| `SUDX_MCP_MARKER_KEY` | `'_sudxManaged'` | Property key to mark Sudx-managed servers |
| `DEFAULT_MCP_SERVERS` | `{ playwright: true, figma: true, crawl4ai: true }` | Default enabled state for all servers |
| `VALID_MCP_SERVERS` | `['playwright', 'figma', 'crawl4ai']` | Allowlist for server name validation |
| `DEFAULT_MCP_DEPLOY_MODE` | `'merge'` | Default deploy mode |
| `MCP_HEALTH_CHECK_TIMEOUT_MS` | `3000` | SSE health check timeout |
| `MAX_CRAWL_DEPTH_WARNING` | `3` | Crawl4ai guard depth threshold |
| `MAX_FIGMA_DEPTH_WARNING` | `2` | Figma guard depth threshold |
| `MAX_FIGMA_BATCH_IMAGES` | `10` | Figma guard batch export threshold |
| `PLAYWRIGHT_SNAPSHOT_REQUIRED_TOOLS` | `['browser_click', 'browser_type', 'browser_drag']` | Tools that require prior snapshot |

---

## MCP Guard Hooks

### Playwright Guard (`playwright-guard.json` / `.ps1` / `.sh`)

- **Event**: `PreToolUse` — runs before Playwright MCP tools
- **Logic**: Blocks tools requiring accessibility snapshot if no snapshot was taken. Warns on `browser_navigate` to URLs matching `localhost`. Enforces `browser_snapshot` before interaction tools
- **Output**: `REJECT` with message, or `ALLOW`

### Crawl4ai Guard (`crawl4ai-guard.json` / `.ps1` / `.sh`)

- **Event**: `PreToolUse` — runs before Crawl4ai MCP tools
- **Logic**: SSRF prevention — blocks URLs targeting private IP ranges (`10.x`, `172.16-31.x`, `192.168.x`, `127.x`, `169.254.x`). Warns on excessive depth. Rate limit awareness
- **Output**: `REJECT` for private IPs, `WARN` for depth > threshold, or `ALLOW`

### Figma Guard (`figma-guard.json` / `.ps1` / `.sh`)

- **Event**: `PreToolUse` — runs before Figma MCP tools
- **Logic**: Rate limiting awareness, batch image export guard (>10 images triggers warning), depth guard (>2 levels), team-level query guard
- **Output**: `WARN` or `ALLOW`

---

## MCP Scanner Filtering (`scanner.ts`)

### `scanMcpFiles(context, enabledServers)`

- Scans `templates/mcp/` directory for MCP template files
- Filters files based on `enabledServers` config (per-server boolean in `IMcpServerConfig`)
- Returns `ITemplateFile[]` with `category: TemplateCategory.Mcp`
- Logs MCP breakdown in scan summary (server count, transport types)

---

## MCP in Webview (`provider.ts`, `main.js`)

### Backend: `buildMcpSection()`

- Generates HTML card for each configured MCP server
- Shows transport badge (stdio/sse), health indicator dot, toggle switch
- Reads `.vscode/mcp.json` via `readMcpServerStatus()` to get live state

### Frontend: `main.js`

- Requests MCP data via `getMcpServers` message on page load
- Renders server status cards with transport badges and toggle controls
- `handleMcpServerToggle(serverName, enabled)` sends `updateMcpServer` message
- Toggle state syncs back to `settings.ts` via `messaging.ts` validation pipeline

### Message Flow

```
main.js → getMcpServers → messaging.ts → provider.ts → readMcpServerStatus()
                                                       → responds mcpServersData
main.js → updateMcpServer { serverName, enabled } → messaging.ts (validates)
                                                   → settings.setMcpServerConfig()
```

---

## MCP Deployment Flow (engine.ts)

```
DeploymentEngine.deploy()
  ├── scanner.scanTemplateFiles() → all templates
  ├── scanner.scanMcpFiles() → MCP templates (filtered by enabled servers)
  ├── copier.copyFiles() → deploy non-MCP templates
  ├── McpDeployer.deploy(mcpFiles, mode, serverConfig)
  │   ├── readTemplateMcpConfig() → parse mcp/mcp.json
  │   ├── Filter disabled servers from template
  │   ├── mode=skip? → return immediately
  │   ├── mode=overwrite? → backup + write template directly
  │   └── mode=merge?
  │       ├── readExistingMcpConfig() → parse .vscode/mcp.json
  │       ├── backupExistingConfig() → .sudx-backups/
  │       ├── markSudxServers() → add _sudxManaged
  │       ├── mergeMcpConfigs() → preserve user, deploy Sudx
  │       └── writeMcpConfig() → atomic write
  └── StateManager.setMcpDeploymentState() → persist
```

---

## MCP Session Context (`inject-context.ps1` / `.sh`)

The session context hook reads `.vscode/mcp.json` at session start and injects:
- List of configured MCP servers with transport types
- Crawl4ai SSE reachability check (HTTP HEAD)
- npx availability check for Playwright/Figma

---

## Rollback Command

**Command**: `sudx-ai.rollbackMcp`

1. Reads `IMcpDeploymentState.mcpConfigBackupPath` from workspace state
2. Shows confirmation dialog
3. Calls `McpDeployer.rollbackMcpConfig(backupPath)`
4. Validates backup JSON before restoring
5. Clears MCP deployment state on success
