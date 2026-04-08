---
description: "Use when working with Crawl4ai MCP tools, web crawling, RAG ingestion, structured extraction, Markdown generation, deep crawl. Use when: crawl4ai, crawl, scrape, RAG, extraction, markdown, deep crawl, web scraping, structured data."
applyTo: "**"
---

# Crawl4ai MCP — Detailed Usage Rules

These rules apply when using the Crawl4ai MCP server for web crawling and structured data extraction.

---

## Prerequisites

Crawl4ai is an SSE-based server — it must be running before any tool calls. Unlike Playwright (stdio/npx), it does NOT auto-start.

**Setup (choose one):**
1. **Docker (recommended):** `docker run -p 11235:11235 unclecode/crawl4ai`
2. **pip:** `pip install crawl4ai[all]` → `crawl4ai-setup` → `crawl4ai-server`
3. **Manual:** Clone `github.com/unclecode/crawl4ai`, run the MCP bridge

**Before first use:** Always verify the server is reachable with `crawl4ai_status`. If unreachable, tell the user to start it.

---

## Available Tools

| Tool | Purpose |
|------|---------|
| `crawl4ai_crawl` | Crawl a single URL and return content |
| `crawl4ai_deep_crawl` | Multi-page crawl with configurable depth and strategy |
| `crawl4ai_extract` | Structured data extraction with LLM and JSON schema |
| `crawl4ai_markdown` | Clean Markdown generation from a web page |
| `crawl4ai_screenshot` | Take a screenshot of a web page |
| `crawl4ai_status` | Check server health and availability |

---

## Critical Rules

1. **ALWAYS call `crawl4ai_status` before the first crawl** — Confirms the server is running and reachable. Saves debugging time if Docker isn't started.

2. **Start with depth=1, increase only if needed** — Deep crawls (depth 3+) can fetch hundreds of pages. Start shallow, inspect results, then widen.

3. **NEVER crawl internal or private IPs** — URLs like `localhost`, `127.0.0.1`, `10.*`, `192.168.*`, `172.16-31.*` are SSRF risks. Only crawl public URLs.

4. **Set `max_pages` to limit resource usage** — Always provide an upper bound. Default recommendation: 10 for exploration, 50 for thorough crawls.

5. **Use structured extraction with JSON schema for data pipelines** — When the user needs specific data fields (prices, names, dates), define a JSON schema and use `crawl4ai_extract` for reliable output.

---

## When to Use / When NOT to Use

**Use Crawl4ai when:**
- User needs to crawl an entire website or section (multiple pages)
- User needs structured data extraction from complex pages
- User needs LLM-optimized Markdown from web content for RAG
- Deep crawling with link following is required
- User needs to extract data in a specific schema

**Do NOT use when:**
- For single static page content → use `fetch_webpage` (faster, built-in)
- For interactive browser automation (click, type, fill) → use Playwright MCP
- For design file extraction → not supported (no design MCP server configured)
- For pages requiring JavaScript interaction before content loads → use Playwright MCP

---

## Deep Crawl Workflow

1. **Test with single page first:** Use `crawl4ai_crawl` on the target URL to verify content structure and server connectivity.
2. **Plan the crawl strategy:**
   - **BFS (Breadth-First Search):** Explores all links at current depth before going deeper. Best for site-wide coverage.
   - **DFS (Depth-First Search):** Follows links deep before backtracking. Best for targeted paths (e.g., documentation chains).
3. **Set conservative limits:** Start with `depth=1` and `max_pages=10`. Review results before increasing.
4. **Increase gradually:** If more pages are needed, increase depth to 2 and max_pages to 25-50.
5. **Inspect results:** Check returned URLs and content quality before processing further.

> **Warning:** `depth=3` with no `max_pages` on a large site can attempt thousands of requests. Always set both parameters.

---

## Structured Extraction Workflow

1. **Define a JSON schema** for the target data:
   ```json
   {
     "type": "object",
     "properties": {
       "title": { "type": "string" },
       "price": { "type": "number" },
       "description": { "type": "string" }
     }
   }
   ```
2. **Call `crawl4ai_extract`** with the URL and schema.
3. **Review extracted data** — verify field mapping and completeness.
4. **Iterate on schema** if fields are missing or incorrectly mapped.

> **Tip:** For complex pages with multiple data types, extract one type at a time with focused schemas.

---

## Markdown Generation

- Use `crawl4ai_markdown` for clean, LLM-friendly Markdown output.
- Ideal for RAG pipelines where content needs to be chunked and embedded.
- Removes boilerplate (navigation, footers, ads) automatically.
- Preserves heading structure, lists, tables, and code blocks.

---

## Responsible Crawling

| Practice | Why | How |
|----------|-----|-----|
| Respect robots.txt | Legal and ethical compliance | Check robots.txt before large crawls |
| Use reasonable limits | Prevent server overload | Set `max_pages` and reasonable depth |
| Don't hammer single domains | Avoid rate limiting / IP bans | Space out requests, use built-in delays |
| Prefer cached results | Reduce redundant requests | Re-use crawl results within a session |
| Avoid private IPs | SSRF prevention | Never crawl localhost, 10.*, 192.168.*, 172.16-31.* |

---

## Anti-Patterns

| Anti-Pattern | Why It's Bad | What to Do Instead |
|-------------|-------------|-------------------|
| Deep crawl without `max_pages` | Can fetch thousands of pages, overload server | Always set `max_pages` (10-50 recommended) |
| Crawling without `crawl4ai_status` check | Fails silently if server is down | Always check status before first crawl |
| Using crawl4ai for interactive pages | Can't click buttons, fill forms, handle JS events | Use Playwright MCP for interactive automation |
| Crawling private IPs | SSRF vulnerability | Only crawl public, external URLs |
| `depth=3+` on first attempt | Unpredictable page count, slow | Start with depth=1, increase gradually |
| Ignoring robots.txt | Legal risk, ethical violation | Check robots.txt compliance before large crawls |

---

## Network Security

### SSRF Prevention
- **NEVER crawl private/internal IP addresses** — `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`, `127.x.x.x`, `169.254.x.x`, `::1`, `fc00::/7`, `fe80::/10` are all blocked
- **`localhost` exception**: Only allowed when `sudx-ai.mcpAllowLocalhost` is explicitly enabled in VS Code settings (default: blocked)
- **Only `http:` and `https:` protocols** — `file:`, `data:`, `javascript:`, `vbscript:`, and `ftp:` are blocked

### Target Validation
- Before calling any crawl tool, validate the URL targets a public internet address
- Do NOT crawl URLs extracted from untrusted sources without validation
- If a crawl redirects to a private IP or blocked domain, the request must be rejected

### Domain Blocklist
- A configurable domain blocklist prevents crawling known-dangerous or internal-only domains
- Internal infrastructure (CI/CD, internal wikis, admin panels) should never be crawl targets
- When crawling user-provided URLs, treat them as untrusted input — validate first

### Rate Limiting & Ethics
- Always respect `robots.txt` — check before performing large crawls
- Use `max_pages` and `depth` limits to prevent excessive requests
- Space out requests to avoid rate limiting or IP bans from target servers
