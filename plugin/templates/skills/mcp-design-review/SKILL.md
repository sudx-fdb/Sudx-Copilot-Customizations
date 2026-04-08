---
name: mcp-design-review
description: "Figma design review and comparison. Use when: design review, design tokens, compare design vs implementation, CSS generation from Figma, component consistency check, Figma audit."
argument-hint: "Describe what to review: Figma file URL, component name, or design aspect"
---

# MCP Design Review — Figma

## Purpose
Guides design review workflows using the Figma MCP server. Covers:
- Extracting design tokens (colors, typography, spacing)
- Comparing Figma design with code implementation
- Checking component consistency across frames
- Generating CSS from Figma styles

## When to Use
- User asks to review a Figma design against implementation
- Need to extract design tokens from Figma
- Checking if UI code matches the design
- User says: "review the design", "compare with Figma", "extract design tokens", "check design consistency"

## Prerequisites
1. **Figma MCP server must be running** — the plugin auto-starts it if enabled
2. **Figma API token must be stored** — set via the Sudx CC panel token management
3. **Figma file/node ID** — user must provide the Figma file URL or key

## Workflow

### Step 1: Parse Figma URL
Extract `fileKey` and optional `nodeId` from user-provided URL:
- `https://www.figma.com/file/{fileKey}/...` → `fileKey`
- `?node-id={nodeId}` → specific component/frame

### Step 2: Fetch File Structure (Depth-First)
```
figma_get_file(fileKey, depth=1) → get top-level structure
```
**CRITICAL: Always start at depth 1.** Deep fetches can timeout on large files.

### Step 3: Identify Target Components
From the depth-1 result:
- Identify relevant pages and frames
- Note node IDs for components to review
- If specific node requested: `figma_get_node(fileKey, nodeId, depth=1)`

### Step 4: Extract Design Tokens
From component properties, extract:
- **Colors**: fill colors, stroke colors, effect colors → map to CSS custom properties
- **Typography**: font family, size, weight, line height, letter spacing
- **Spacing**: padding, margins, gaps from Auto Layout properties
- **Border radius**: corner radius values
- **Shadows**: drop shadows, inner shadows → `box-shadow` values

### Step 5: Compare with Implementation
1. Read the corresponding source code (CSS/SCSS/styled-components)
2. Compare each design token with implemented values
3. Report mismatches: `Design: #FF5722 → Code: #ff5733` format
4. Check responsive behavior if design has multiple breakpoint frames

### Step 6: Report
Generate a structured report:
- Matched tokens (correct implementation)
- Mismatched tokens (with design vs code values)
- Missing implementations (in design but not in code)
- Orphaned styles (in code but not in design)

## Anti-Patterns to Avoid
- Never fetch at depth > 2 on initial request (timeout risk)
- Never batch-export more than 10 images at once
- Never modify Figma files through the API (read-only workflow)
- Always validate the Figma token is set before starting

## Figma Guard Rules
- Depth > 2 triggers a warning
- Batch image export > 10 triggers a warning
- See `figma.instructions.md` for full guard rules
