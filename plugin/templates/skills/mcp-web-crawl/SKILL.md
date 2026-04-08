---
name: mcp-web-crawl
description: "Structured web crawling using Crawl4ai MCP. Use when: web crawling, scraping, data extraction, RAG pipeline content, markdown generation, structured extraction from websites."
argument-hint: "Describe what to crawl: URL, content type, extraction goal"
---

# MCP Web Crawl — Crawl4ai

## Purpose
Guides structured web crawling using the Crawl4ai MCP server. Covers:
- Single-page and multi-page crawling with depth control
- Structured data extraction with JSON schemas
- Markdown generation for RAG pipelines
- Responsible crawling with rate awareness

## When to Use
- User needs to extract content from web pages
- Documentation scraping for RAG or analysis
- Structured data extraction (prices, listings, articles)
- Markdown generation from web content
- User says: "crawl this site", "extract data from", "scrape", "get content from URL"

## Prerequisites
1. **Crawl4ai MCP server must be running** — the plugin auto-starts it if enabled (Docker-based)
2. **Docker must be running** — Crawl4ai runs as a Docker container
3. **Target URL must be public** — private IPs are blocked (SSRF prevention)

## Workflow

### Step 1: Verify Server Health
```
crawl4ai_status → check if the server is running and responsive
```
If the server is down, it should auto-restart. If Docker is not running, notify the user.

### Step 2: Plan the Crawl Strategy
| Content Need | Strategy |
|---|---|
| Single page content | `crawl4ai_crawl` depth=0, max_pages=1 |
| Site section (e.g., docs) | `crawl4ai_crawl` depth=1, max_pages=10-20 |
| Full site structure | `crawl4ai_crawl` depth=2, max_pages=50 (max recommended) |
| Specific data extraction | `crawl4ai_extract` with JSON schema |
| Clean markdown for LLM | `crawl4ai_markdown` |

### Step 3: Execute Crawl
**CRITICAL: Always set `max_pages` to prevent runaway crawls.**

For simple content extraction:
```
crawl4ai_crawl(url, depth=0, max_pages=1)
```

For structured extraction:
```
crawl4ai_extract(url, schema={...})
```

For markdown generation:
```
crawl4ai_markdown(url)
```

### Step 4: Process Results
1. Verify the response contains expected content
2. Check for extraction errors or missing fields
3. If structured extraction: validate against schema
4. If multi-page: verify page count matches expectations

### Step 5: Iterate if Needed
- Missing content? Try a different depth or extraction schema
- Too much content? Reduce max_pages or add URL filters
- Wrong format? Switch between crawl/extract/markdown

## Responsible Crawling Checklist
- [ ] `max_pages` is set (never unlimited)
- [ ] Depth is ≤ 3 (warn on > 3)
- [ ] Target is a public URL (no private IPs)
- [ ] Target allows crawling (check robots.txt for large crawls)
- [ ] Requests are spaced appropriately (don't hammer servers)

## Anti-Patterns to Avoid
- Never crawl without `max_pages` (unlimited crawls can fetch thousands of pages)
- Never start with depth > 2 (start small, increase gradually)
- Never crawl private IPs or localhost (unless `mcpAllowLocalhost` is enabled)
- Never use crawl4ai for interactive pages — use Playwright MCP instead
- Always check `crawl4ai_status` before the first crawl in a session

## Network Security
- Only `http:` and `https:` URLs are allowed
- `file:`, `data:`, `javascript:`, `vbscript:`, `ftp:` protocols are blocked
- Private IPs are blocked unless `mcpAllowLocalhost` is enabled
- Domain blocklist prevents crawling of known-dangerous targets
- See `crawl4ai.instructions.md` → Network Security section for full rules
