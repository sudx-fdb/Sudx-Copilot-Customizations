---
description: "Use when working with Playwright MCP tools, browser automation, web testing, accessibility tree navigation, screenshots, form filling. Use when: Playwright, browser, automation, screenshot, accessibility, web testing, browser_navigate, browser_click, browser_snapshot."
applyTo: "**"
---

# Playwright MCP — Detailed Usage Rules

These rules apply when using the Playwright MCP server (`@playwright/mcp`) for browser automation tasks.

---

## Available Tools

| Tool | Purpose |
|------|---------|
| `browser_navigate` | Navigate to a URL |
| `browser_click` | Click an element by accessibility ref |
| `browser_type` | Type text into an input field |
| `browser_snapshot` | Get accessibility snapshot of current page |
| `browser_take_screenshot` | Take a screenshot (requires `--caps=vision`) |
| `browser_tab_list` | List open browser tabs |
| `browser_tab_new` | Open a new tab |
| `browser_tab_close` | Close a tab |
| `browser_console_messages` | Get console messages |
| `browser_pdf_save` | Save page as PDF (requires `--caps=pdf`) |
| `browser_drag` | Drag an element to another location |
| `browser_hover` | Hover over an element |
| `browser_select_option` | Select an option from a dropdown |
| `browser_handle_dialog` | Handle browser dialogs (alert, confirm, prompt) |
| `browser_file_upload` | Upload a file to a file input |
| `browser_install` | Install the browser (first-time setup) |
| `browser_press_key` | Press a keyboard key or key combination |
| `browser_resize` | Resize the browser viewport |
| `browser_wait` | Wait for a specified condition |

---

## Critical Rules

1. **ALWAYS call `browser_snapshot` before `browser_click`** — Snapshot returns the current accessibility tree with element refs. Without a fresh snapshot, element refs may be stale or incorrect.

2. **NEVER assume element refs persist across navigations** — After any `browser_navigate` or page navigation (form submit, link click), element refs become invalid. Always take a new snapshot.

3. **Use `browser_console_messages` to debug JavaScript errors** — If a page isn't behaving as expected, check the console for errors before retrying actions.

4. **Prefer accessibility tree selectors over CSS selectors** — The accessibility tree provides semantic element identification. Use the refs from `browser_snapshot` for reliable interaction.

---

## When to Use / When NOT to Use

**Use Playwright MCP when:**
- User asks to interact with a web page (fill forms, click buttons, navigate)
- Content requires JavaScript rendering (SPAs, dynamic content)
- User needs screenshots or PDFs of web pages
- User needs to test a web application interactively
- User needs to automate a multi-step web workflow

**Do NOT use when:**
- For simple static page content → use `fetch_webpage` (faster, no browser overhead)
- For reading documentation pages → use `fetch_webpage`
- For design file extraction → use Figma MCP
- For deep multi-page crawling → use Crawl4ai

---

## Multi-Tab Workflow

1. **Open new tab:** `browser_tab_new` — opens a blank tab
2. **List tabs:** `browser_tab_list` — shows all open tabs with their IDs
3. **Navigate in tab:** `browser_navigate` with the desired URL
4. **Switch context:** Each tab maintains its own state. Navigate within tabs as needed.
5. **Close tab:** `browser_tab_close` — close the current or specified tab

> **Note:** Always list tabs before closing to avoid closing the wrong one.

---

## Form Automation Workflow

1. `browser_snapshot` — identify form fields and their accessibility refs
2. `browser_click` — click/focus the target input field
3. `browser_type` — type the desired value
4. Repeat steps 2-3 for each field
5. `browser_click` — click the submit button
6. `browser_snapshot` — verify the result (success message, redirect, errors)

> **Tip:** For dropdowns, use `browser_select_option` instead of click+type.

---

## Screenshot & PDF Workflow

### Screenshots
- Requires `--caps=vision` when starting the MCP server
- Use `browser_take_screenshot` to capture the current viewport
- Screenshots are useful for visual verification and documentation
- **Do NOT use in loops** — resource intensive, use `browser_snapshot` for structure

### PDF Export
- Requires `--caps=pdf` when starting the MCP server
- Use `browser_pdf_save` to save the current page as PDF
- Useful for generating reports or archiving web content

---

## Anti-Patterns

| Anti-Pattern | Why It's Bad | What to Do Instead |
|-------------|-------------|-------------------|
| `browser_click` without `browser_snapshot` first | Element refs may be stale or wrong | Always snapshot → then click |
| Navigating to untrusted URLs | Security risk, potential data exposure | Only navigate to known, trusted URLs |
| `browser_take_screenshot` in loops | Resource intensive, slow | Use `browser_snapshot` for structural checks |
| Assuming refs persist after navigation | Refs become invalid on page change | Take a new `browser_snapshot` after every navigation |
| Using screenshot for text extraction | Vision parsing is unreliable for text | Use `browser_snapshot` for accessible text content |

---

## Network Security

### URL Validation Rules
- **ONLY navigate to `http:` and `https:` URLs** — `file:`, `data:`, `javascript:`, `vbscript:`, and `ftp:` protocols are blocked
- **Never navigate to private/internal IP addresses** — `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`, `127.x.x.x`, `169.254.x.x`, `::1`, `fc00::/7`, `fe80::/10` are all blocked
- **`localhost` exception**: Only allowed when `sudx-ai.mcpAllowLocalhost` is explicitly enabled in VS Code settings (default: blocked)

### SSRF Prevention
- Before using `browser_navigate`, validate the target URL is a public internet address
- **Do NOT follow redirects to private IPs** — if a page redirects to an internal address, stop and report
- Be cautious with user-provided URLs — validate before navigating

### Domain Trust
- Only interact with domains relevant to the current task
- Do not navigate to arbitrary URLs from untrusted input (e.g., URLs extracted from web content)
- When testing web applications, limit navigation to the application's own domain and known dependencies

---

## Browser Session Lifecycle

- The Playwright browser instance **persists across tool calls** within the same session
- Tabs remain open until explicitly closed with `browser_tab_close`
- All browser state (cookies, localStorage, session) is **lost on server restart**
- The plugin auto-starts Playwright MCP — the browser launches when the first tool is called
- If the server crashes or is restarted, all existing tabs and navigation state are lost

---

## Tab Management Best Practices

- **Close tabs after extracting data** — don't leave finished pages open
- **Audit open tabs** with `browser_tab_list` before opening new ones
- **Limit concurrent tabs to 5** — each tab consumes memory and CPU
- **Use existing tabs** — navigate within a tab rather than opening a new one for each URL
- The Playwright guard warns when opening a 6th+ tab

---

## Navigation State Tracking

- After every `browser_navigate`, **always call `browser_snapshot`** to confirm the page loaded
- **Check for redirects** — the final URL may differ from what you navigated to
- **Verify the page content** matches expectations before interacting
- If a navigation produces an error page (404, 500), detect it via the accessibility tree before proceeding
- After form submissions or link clicks, take a new snapshot to confirm the navigation result

---

## Resource-Conscious Screenshot Strategy

- **Prefer `browser_snapshot` over `browser_take_screenshot`** for most tasks
- `browser_snapshot` returns the accessibility tree (lightweight, text-based, fast)
- `browser_take_screenshot` captures a full viewport image (heavy, requires `--caps=vision`)
- **Only use screenshots for visual verification** — layout checks, visual regression, UI appearance
- **NEVER use screenshots in loops** — each screenshot is resource-intensive
- For text extraction, always use `browser_snapshot` (more reliable than OCR on screenshots)

---

## Session Cleanup

- After completing a browser task, **close all tabs** you opened
- Verify cleanup with `browser_tab_list` — ensure no orphaned tabs remain
- If you opened multiple tabs during a workflow, close them in reverse order
- A clean session reduces memory usage and prevents stale state in future tool calls
