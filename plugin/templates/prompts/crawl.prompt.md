---
description: "Crawl a website using Crawl4ai MCP. Use when: web crawling, deep crawl, site scraping, content extraction, RAG pipeline, structured data extraction."
agent: "agent"
argument-hint: "Target URL and optional: depth, extraction schema, output format"
---

Use the **Crawl4ai MCP server** to crawl the specified website.

**Target:** {{input}}

## Workflow

1. **Verify server**: Ensure Crawl4ai is running at `http://localhost:11235`
2. **Initial crawl**: Use `crawl4ai_crawl` on the target URL with `extract_markdown: true`
3. **Follow links**: If depth > 1, extract internal links and crawl subsequent pages
4. **Extract content**: Convert results to clean markdown
5. **Summarize**: Present key findings

## Parameters

- **Depth**: How many link levels to follow (default: 1)
- **Max pages**: Limit total pages crawled (default: 10)
- **Extract schema**: If structured data is needed, define the JSON schema

## Rules

- Always check if the server is running before crawling
- Respect rate limits — add delays between requests if needed
- Only crawl HTTPS URLs unless explicitly instructed otherwise
- Never crawl internal/private IP ranges
- Present extracted content in clean, organized markdown
