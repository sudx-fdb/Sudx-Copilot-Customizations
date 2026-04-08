---
name: mcp-browser-test
description: "Browser-based testing using Playwright MCP. Use when: browser testing, web testing, form filling, accessibility audit, visual regression, screenshot testing, browser automation for QA."
argument-hint: "Describe what to test: URL, form, workflow, or component"
---

# MCP Browser Test — Playwright

## Purpose
Guides browser-based testing using the Playwright MCP server. Covers:
- Interactive web page testing (navigation, form submission, link verification)
- Accessibility tree inspection and audit
- Visual regression via screenshots
- Multi-step workflow automation

## When to Use
- User asks to test a web application or page interactively
- Need to verify forms, buttons, navigation flows
- Accessibility audit via the accessibility tree
- Visual comparison via screenshots
- User says: "test this page", "check this form", "browser test", "screenshot"

## Prerequisites
1. **Playwright MCP server must be running** — the plugin auto-starts it if enabled
2. **Target URL must be accessible** — public internet or localhost (if `mcpAllowLocalhost` is enabled)
3. **For screenshots**: server must have been started with `--caps=vision`

## Workflow

### Step 1: Verify Server Health
```
Call browser_snapshot — if it returns an accessibility tree, the server is ready.
If it fails, check MCP status in the Sudx CC panel.
```

### Step 2: Navigate to Target
```
browser_navigate → target URL
browser_snapshot → get initial accessibility tree
```

### Step 3: Test Pattern — Snapshot First
**CRITICAL: Always call `browser_snapshot` before ANY interaction.**
- `browser_snapshot` → identify element refs
- `browser_click` / `browser_type` / `browser_select_option` → interact using refs from snapshot
- `browser_snapshot` → verify result

### Step 4: Form Testing
1. `browser_snapshot` — identify all form fields
2. For each field: `browser_click` → `browser_type` with test data
3. For dropdowns: `browser_select_option`
4. `browser_click` on submit button
5. `browser_snapshot` — verify success/error messages

### Step 5: Accessibility Audit
1. `browser_snapshot` — get full accessibility tree
2. Check for: missing labels, empty buttons, unclear link text, missing headings hierarchy
3. Report findings with element refs and suggested fixes

### Step 6: Visual Regression
1. `browser_take_screenshot` — capture current state
2. Compare with expected layout (user provides reference or description)
3. Report differences

## Anti-Patterns to Avoid
- Never `browser_click` without a preceding `browser_snapshot`
- Never assume element refs persist after navigation
- Never navigate to private IPs (unless `mcpAllowLocalhost` is enabled)
- Never use `browser_take_screenshot` in loops — use `browser_snapshot` for structure

## Network Security
- Only navigate to `http:` and `https:` URLs
- `file:`, `data:`, `javascript:`, `vbscript:` protocols are blocked
- Private IPs are blocked unless `mcpAllowLocalhost` is enabled
- See `playwright.instructions.md` → Network Security section for full rules
