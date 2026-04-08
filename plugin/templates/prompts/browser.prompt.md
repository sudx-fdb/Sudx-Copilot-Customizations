---
description: "Automate browser interaction using Playwright MCP. Use when: browser automation, web testing, form filling, screenshot, interactive page, JavaScript rendering."
agent: "agent"
argument-hint: "Target URL and optional: action sequence, screenshot preference"
---

Use the **Playwright MCP server** to interact with the specified website.

**Target:** {{input}}

## Workflow

1. **Navigate**: Use `browser_navigate` to open the target URL
2. **Snapshot**: Take an accessibility snapshot with `browser_snapshot` to understand page structure
3. **Interact**: Click elements, fill forms, or scroll as needed using accessibility refs
4. **Screenshot**: If visual verification is needed, use `browser_screenshot`
5. **Report**: Summarize findings and any extracted data

## Parameters

- **URL**: The target page to navigate to (must be HTTPS)
- **Actions**: Sequence of interactions (click, type, select, scroll)
- **Screenshot**: Whether to capture visual screenshots (default: only if needed)

## Rules

- Always use HTTPS URLs unless explicitly instructed otherwise
- Always take a snapshot before clicking — use accessibility refs, not coordinates
- Wait for network idle after navigation before interacting
- Screenshots count toward the vision message cap — use sparingly
- Close tabs when done to avoid resource leaks
- Never fill sensitive credentials unless the user explicitly provides them
