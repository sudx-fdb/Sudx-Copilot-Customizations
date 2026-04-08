---
description: "Use when working with MCP tools, browser automation, web scraping, Figma design extraction, or Playwright. Use when: MCP, browser, web scraping, crawling, automation, Playwright, Figma, crawl4ai."
applyTo: "**"
---

# MCP Tools — Usage Instructions

These rules apply when using Model Context Protocol (MCP) tools for browser automation, web crawling, and design integration.

---

## Available MCP Servers

### Playwright MCP (`@playwright/mcp`)
Browser automation via accessibility tree — no vision models needed.

→ See [playwright.instructions.md](playwright.instructions.md) for detailed usage rules.

**Key Tools:**
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

**When to use:**
- User asks to interact with a web page (fill forms, click buttons)
- User needs to test a web application
- User asks to scrape dynamic content that requires JavaScript
- User needs screenshots or PDFs of web pages

**When NOT to use:**
- For simple static page content → use `fetch_webpage` instead
- For reading documentation → use `fetch_webpage` instead
- When the content doesn't require JavaScript rendering

### Figma MCP (`@thirdstrandstudio/mcp-figma`)
Full Figma API access for design data extraction.

→ See [figma.instructions.md](figma.instructions.md) for detailed usage rules.

### Crawl4ai
LLM-friendly web crawler for RAG, deep crawling, and structured data extraction.

→ See [crawl4ai.instructions.md](crawl4ai.instructions.md) for detailed usage rules.

> **IMPORTANT:** Crawl4ai requires a running server — it is NOT auto-started like Playwright/Figma.
> Start it before use with one of the methods below.

**Server Setup (choose one):**
1. **Docker (recommended):** `docker run -p 11235:11235 unclecode/crawl4ai`
2. **pip install:** `pip install crawl4ai[all]` then `crawl4ai-setup` then `crawl4ai-server`
3. **Manual Python:** Clone `github.com/unclecode/crawl4ai`, run the MCP bridge

**Transport:** SSE (Server-Sent Events) at `http://localhost:11235/mcp` — NOT stdio.

**Capabilities:**
- Deep web crawling with configurable depth (BFS/DFS strategies)
- Structured data extraction with LLM integration
- Clean Markdown generation from web pages
- Anti-bot detection and proxy support

**When to use:**
- User needs to crawl an entire website or multiple pages
- User needs structured data extraction from complex web pages
- User needs LLM-optimized Markdown from web content
- Deep crawling with link following is required

**When NOT to use:**
- For single page content → use `fetch_webpage`
- For interactive browser automation → use Playwright MCP
- For Figma design data → use Figma MCP

**Prerequisite Check:** Before calling crawl4ai tools, verify the server is running. If unreachable, tell the user: "Start crawl4ai server first: `docker run -p 11235:11235 unclecode/crawl4ai`"

---

## Decision Tree

```
User needs web/browser/design interaction
    │
    ├─ Figma design file?
    │   └─ Yes → Figma MCP tools
    │
    ├─ Interactive browser automation (click, type, navigate)?
    │   └─ Yes → Playwright MCP tools
    │
    ├─ Deep crawl of multiple pages / structured extraction?
    │   └─ Yes → Is crawl4ai server running?
    │       ├─ Yes → Crawl4ai
    │       └─ No → Start it first (docker run -p 11235:11235 unclecode/crawl4ai)
    │
    ├─ Single page content reading?
    │   └─ Yes → fetch_webpage (built-in, fastest)
    │
    └─ Screenshot / PDF of a web page?
        └─ Yes → Playwright MCP with vision/pdf caps
```

---

## MCP Server Configuration

MCP servers are configured in `.vscode/mcp.json` at the workspace root:

```json
{
  "servers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    },
    "figma": {
      "command": "npx",
      "args": ["@thirdstrandstudio/mcp-figma", "--figma-token", "YOUR_TOKEN"]
    },
    "crawl4ai": {
      "url": "http://localhost:11235/mcp"
    }
  }
}
```

> **Note:** Playwright and Figma use stdio transport (auto-started by VS Code). Crawl4ai uses SSE transport (requires a running server).

Verify MCP server availability before calling tools. If a server is not configured, suggest the user set it up.
