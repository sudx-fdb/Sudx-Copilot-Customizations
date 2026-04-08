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
