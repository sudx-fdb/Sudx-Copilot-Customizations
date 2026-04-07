# Code Docs — Table of Contents

| Path | Description |
|------|-------------|
| docs/code_docs/webview-ui.md | Webview UI Architecture: CSS Stack, JS Stack, TypeScript Backend, Design System, Provider Modularization, RateLimiter, Settings, StatusBar |
| docs/code_docs/build-script.md | Build Script (build.py): Version dataclass, BuildManager class, 10-step build pipeline, validation, CLI, version history, VSIX packaging |

## v0.3.2 Bug Fixes (Internal Improvements)

| File | Change |
|------|--------|
| plugin/src/utils/logger.ts | Singleton re-entrancy guard (`isCreating` flag), `safeStringify()` with WeakSet circular reference detection |
| plugin/src/utils/paths.ts | `isInsideWorkspace()` uses `fs.realpathSync()` for symlink-aware path traversal check |
| plugin/src/utils/fileOps.ts | `walkDirectory()` with `visitedPaths` Set and `MAX_RECURSION_DEPTH=20` for symlink loop protection |
| plugin/src/deployment/engine.ts | Promise-based deploy lock (`deployPromise`), `DEPLOY_TIMEOUT_MS=120s` with Promise.race |
| plugin/src/webview/provider.ts | `escapeHtml()` with null-check and backtick escaping |
| plugin/src/config/state.ts | History truncation logging, migration with documented fire-and-forget |
