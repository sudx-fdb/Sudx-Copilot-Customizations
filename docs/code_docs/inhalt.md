# Code Docs — Table of Contents

| Path | Description |
|------|-------------|
| docs/code_docs/webview-ui.md | Webview UI Architecture: CSS Stack, JS Stack, TypeScript Backend, Design System, Provider Modularization, RateLimiter, Settings, StatusBar |
| docs/code_docs/build-script.md | Build Script (build.py): Version dataclass, BuildManager class, 10-step build pipeline, validation, CLI, version history, VSIX packaging |
| docs/code_docs/deploy-script.md | Deploy Script (deploy.py): DeployManager, ConfigManager, ChecksumEngine, VersionManager, SSHTransport, HTTPTransport, DeployState, DeployLock, crash recovery, build.py integration |
| docs/code_docs/mcp-integration.md | MCP Integration: McpDeployer architecture, merge algorithm, types & interfaces, constants, guard hooks, scanner filtering, webview UI, deployment flow, rollback |
| docs/code_docs/backend-mcp-manager.md | Backend MCP Server Manager: models, registry, supervisor, health monitor, updater, internal API, security, logging, event bus, metrics, self-healing, bootstrap CLI |
| docs/code_docs/vscode-logger-bridge.md | VS Code Logger Bridge: mcpLoggerTypes (enums, interfaces, message protocols), mcpLoggerClient (SSE client, reconnection, heartbeat), mcpDebugBridge (metrics aggregation, event buffering, offline mode), mockSseServer |

## v0.3.2 Bug Fixes (Internal Improvements)

| File | Change |
|------|--------|
| plugin/src/utils/logger.ts | Singleton re-entrancy guard (`isCreating` flag), `safeStringify()` with WeakSet circular reference detection |
| plugin/src/utils/paths.ts | `isInsideWorkspace()` uses `fs.realpathSync()` for symlink-aware path traversal check |
| plugin/src/utils/fileOps.ts | `walkDirectory()` with `visitedPaths` Set and `MAX_RECURSION_DEPTH=20` for symlink loop protection |
| plugin/src/deployment/engine.ts | Promise-based deploy lock (`deployPromise`), `DEPLOY_TIMEOUT_MS=120s` with Promise.race |
| plugin/src/webview/provider.ts | `escapeHtml()` with null-check and backtick escaping |
| plugin/src/config/state.ts | History truncation logging, migration with documented fire-and-forget |

## Bughunt Fixes (Debug Plan)

| File | Change |
|------|--------|
| plugin/src/statusBar.ts | `resetTimer` property with `clearTimeout` in `setState()` and `dispose()` — prevents multiple concurrent timers and post-dispose callback |
| plugin/media/scripts/main.js | `formatDate()` NaN guard: `if (isNaN(date.getTime())) return TIME_STRINGS.UNKNOWN` — prevents Invalid Date string output |
| plugin/media/scripts/animations.js | `_entranceAnimClass` updated on every `observeEntrance()` call — fixes singleton observer ignoring different animation classes on subsequent calls |
| plugin/media/scripts/deploy.js | `formatFilePath()` type guard: `if (typeof fullPath !== 'string') return ''` — prevents TypeError on non-string input |
| plugin/src/webview/provider.ts | `initTimer` property with cleanup in `dispose()` and `onDidDispose` — prevents timer firing after panel close |
| plugin/src/utils/paths.ts | UNC path blocking in `sanitizePath()`: `/^\/\//.test(normalized) \|\| /^\\\\/.test(rawPath)` — rejects `\\server\share` and `//server/share` |

## Quality Audit Fixes (Feature Plan)

| File | Change |
|------|--------|
| plugin/src/deployment/engine.ts | Fixed broken `this.fileOps.readFile()` call — `fileOps` was not a declared property. Replaced with `this.mcpDeployer.readExistingMcpConfig()` with null check and serverCount logging |
| plugin/src/deployment/agent.ts | Made `.then()` callback async, added `await` on `setAutoActivateAgent()`, added `.catch()` for unhandled rejection guard |
| plugin/src/deployment/copier.ts | Added debug logging to `computeDirectories()` (fileCount, targetRoot) and summary log (uniqueDirs, totalFiles) |
| plugin/src/deployment/scanner.ts | Added debug logging to `resolveCategory()` (dirName, category) and `isExcluded()` (fileName on exclusion) |
| plugin/src/deployment/hooks.ts | Added summary debug log in `getAvailableHooks()` — total, enabled, disabled hook counts |
| plugin/src/deployment/mcpDeployer.ts | Added serverCount to `generateMcpContextFile()` success log |
| plugin/src/mcp/lifecycleManager.ts | Extracted Docker image to `MCP_CRAWL4AI_DOCKER_IMAGE` and port to `MCP_CRAWL4AI_PORT` constants. Added `_disposed` flag with guards in `startServer`/`stopServer` |
| plugin/src/mcp/healthMonitor.ts | Replaced hardcoded `5_000` with `MCP_NPX_CHECK_TIMEOUT_MS` constant import |
| plugin/src/mcp/configValidator.ts | Added `validateArgsAndEnv()` method: validates args entries are strings, env values are strings, logs issue count per server |
| plugin/src/mcp/networkSecurity.ts | Fixed IPv6 false positives: added `isIpv6` guard (hostname must contain `:` or be bracketed) before checking `fc`/`fd`/`fe80` prefixes |
| plugin/src/constants.ts | Added `MCP_CRAWL4AI_DOCKER_IMAGE`, `MCP_CRAWL4AI_PORT`, `MCP_HEALTH_CHECK_INTERVAL` to CONFIG_KEYS |
| plugin/src/config/settings.ts | Updated `getMcpHealthCheckInterval()` to use `CONFIG_KEYS.MCP_HEALTH_CHECK_INTERVAL` instead of string literal |
| plugin/media/scripts/main.js | Extracted magic numbers to named constants: `SECTION_FADE_MS`, `SECTION_CLEANUP_MS`, `COUNT_UP_DURATION_MS`, `HOOK_STAGGER_MS` |
| plugin/media/scripts/deploy.js | Added `VALID_TRANSITIONS` map and transition guard in `setState()` — rejects invalid state transitions with warning log |

## Integration Debug Plan Fixes (debug-plan-integration-v7)

| File | Change |
|------|--------|
| backend/src/models.py | Fixed Pydantic v2 validators: `@field_validator` replaces `@validator`, `model_validator(mode='after')` replaces `@root_validator`, `model_dump()` replaces `.dict()`, `ConfigDict` replaces `class Config` |
| backend/src/mcp_registry.py | Fixed `@model_validator(mode='after')` return self, Pydantic v2 field declarations, `model_dump()` calls, SHA-256 hash on raw bytes |
| backend/src/security.py | Fixed `check_origin()` return type to `Optional[str]`, added `_is_private_ip()` with comprehensive RFC 1918/4193/5737 checks, IPv6 loopback/ULA/link-local detection, `SECURITY_DEFAULTS` dict for configurable limits |
| backend/src/mcp_supervisor.py | Fixed `os.geteuid` / `signal.SIGKILL` / `os.waitpid` with platform guards (hasattr/sys.platform), Pydantic v2 migration, `asyncio.create_subprocess_exec` error handling |
| backend/src/internal_api.py | Fixed `BackendError` import from models, endpoint parameter types, response model consistency, CORS middleware configuration |
| backend/src/mcp_health.py | Fixed `HealthStatus` enum serialization, health check timeout handling, `asyncio.wait_for` with per-server timeout |
| backend/src/mcp_logger.py | Fixed SSE event format (`event: message\ndata: <json>\n\n`), `McpLogEvent` Pydantic v2 migration, correlation ID tracking |
| backend/src/logging_setup.py | Fixed structured formatter, `QueueHandler`/`QueueListener` lifecycle, configurable log levels |
| backend/src/self_healing.py | Fixed `os.kill` platform guard, `psutil.Process` error handling, exponential backoff with jitter, max restart attempts |
| backend/src/mcp_updater.py | Fixed `subprocess.run` with `sys.executable` for pip, `shutil.which` for Docker, platform-aware `bin/pip` vs `Scripts/pip` |
| backend/src/mcp_logging_helper.py | Fixed event bus singleton pattern, `asyncio.Queue` producer/consumer lifecycle, `BackendError` import |
| backend/start_server.py | Fixed `--validate` / `--dry-run` CLI modes, `X-Confirm-Shutdown: yes` header match, dotenv loading with manual fallback |
| backend/deploy.py | Fixed health check `result.get("success")` (not "status"), configurable timeouts, error message propagation |
| backend/config/nginx.conf | Fixed proxy_pass target to `127.0.0.1:8420`, health check path `/health`, WebSocket upgrade headers for SSE |
| plugin/src/extension.ts | Fixed `deactivate()` calling synchronous `dispose()`, lifecycle cleanup order, command registration guards |
| plugin/src/constants.ts | Fixed `COMMANDS` object to match all 12 package.json command IDs, added `MCP_RETRYABLE_ERRORS` array |
| plugin/src/commands.ts | Fixed command handler parameter types, token prompt flow, backend connection state management |
| plugin/src/config/settings.ts | Added 8 missing getters for package.json settings: `getMcpCrawl4aiPort()`, `getMcpPlaywrightArgs()`, etc. |
| plugin/src/statusBar.ts | Fixed StatusBar text truncation, timer cleanup in dispose |
| plugin/src/mcp/mcpDebugBridge.ts | Fixed metrics aggregation: `TOOL_CALL_START`/`TOOL_CALL_END` paired tracking, duration calculation, error rate computation |
| plugin/src/mcp/mcpLoggerClient.ts | Fixed SSE reconnection with exponential backoff, heartbeat timeout detection, `EventSource` cleanup on dispose |
| plugin/src/mcp/mcpLoggerTypes.ts | Verified enum values match backend SSE event types, `McpLogEvent` interface fields consistent |
| plugin/src/mcp/lifecycleManager.ts | Fixed async `dispose()` → synchronous with fire-and-forget stops, added `shutdown()` for explicit async cleanup, static `child_process` import |
| plugin/src/mcp/healthMonitor.ts | Fixed hardcoded crawl4ai URL to use `MCP_CRAWL4AI_PORT` constant, static `child_process` import |
| plugin/src/mcp/configValidator.ts | Fixed dynamic `require('child_process')` → static `import { exec }` |
| plugin/src/mcp/networkSecurity.ts | Removed unused `MCP_PRIVATE_IP_RANGES` import (inline checks used instead) |
| plugin/src/test/mockSseServer.ts | Rewrote `_generateEvent()`: paired START→END events via `_pendingStarts` Map, matching correlation IDs, correct `HEALTH_CHECK_OK` enum |
| plugin/src/deployment/engine.ts | Fixed `deployedConfig.servers` → `.mcpServers`, stale timeout timer cleared in `finally` block via `createTimeoutPromise` callback |
| plugin/src/deployment/mcpDeployer.ts | Fixed transport detection `!!command` (not `.type`), removed fabricated EBUSY error codes, preserves original error codes |
| backend/.env.example | Updated python-dotenv comment to note manual fallback and systemd `EnvironmentFile=` alternative |
