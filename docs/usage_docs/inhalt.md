# Usage Docs — Table of Contents

| Path | Description |
|------|-------------|
| docs/usage_docs/webview-ui.md | Webview UI Usage: Main View, Log View, Settings, Accessibility, Error Handling, Performance |
| docs/usage_docs/build-script.md | Build Script Usage: Version types, comment prefixes, CLI examples, version info commands, build output, error recovery |
| docs/usage_docs/deploy-script.md | Deploy Script Usage: SSH/HTTP transport, CLI commands, configuration, .deployignore, version tracking, crash recovery, build.py integration |
| docs/usage_docs/mcp-integration.md | MCP Integration Usage: Server configuration, deploy modes, webview MCP section, guard hooks, Crawl4ai setup, rollback, troubleshooting |
| docs/usage_docs/backend-mcp-manager.md | Backend MCP Manager Usage: Installation, configuration, CLI commands, API endpoints, monitoring, auto-recovery, hot-reload, disaster recovery, security |
| docs/usage_docs/vscode-logger-bridge.md | VS Code Logger Bridge Usage: Connecting to backend, settings, Debug Panel features, connection states, offline mode, troubleshooting, commands |

## Integration Stability Improvements

Internal quality pass across 48 confirmed bugs in the Backend MCP Server Manager and VS Code Logger Bridge. No new user-facing features, but improved reliability:

- Backend configuration validation (`start_server.py --validate`) now works reliably
- Backend health checks and shutdown commands use consistent protocol headers
- MCP server deployment correctly handles both `servers` and `mcpServers` config key formats
- Windows compatibility verified across all backend modules (no `AttributeError` on missing Unix APIs)
- SSE event streaming uses correct paired START/END events with correlation tracking
- Extension cleanup on deactivation is now synchronous and non-blocking
