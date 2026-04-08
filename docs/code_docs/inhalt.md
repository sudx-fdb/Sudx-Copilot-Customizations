# Code Docs — Table of Contents

| Path | Description |
|------|-------------|
| docs/code_docs/webview-ui.md | Webview UI Architecture: CSS Stack, JS Stack, TypeScript Backend, Design System, Provider Modularization, RateLimiter, Settings, StatusBar |
| docs/code_docs/build-script.md | Build Script (build.py): Version dataclass, BuildManager class, 10-step build pipeline, validation, CLI, version history, VSIX packaging |
| docs/code_docs/mcp-integration.md | MCP Integration: McpDeployer architecture, merge algorithm, types & interfaces, constants, guard hooks, scanner filtering, webview UI, deployment flow, rollback |

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
