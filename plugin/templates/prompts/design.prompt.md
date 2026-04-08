---
description: "Extract design data from Figma using Figma MCP. Use when: design tokens, Figma extraction, component inspection, style extraction, design system."
agent: "agent"
argument-hint: "Figma file URL and optional: extraction type (tokens/components/styles/images)"
---

Use the **Figma MCP server** to extract design data from the specified Figma file.

**Target:** {{input}}

## Workflow

1. **Extract file key**: Parse the Figma URL to get the file key
2. **Overview fetch**: Use `figma_get_file` with `depth: 1` to get the file structure
3. **Targeted extraction**: Based on the extraction type:
   - **Tokens**: `figma_get_file_styles` → map to CSS variables
   - **Components**: `figma_get_file_components` → extract component structure
   - **Styles**: `figma_get_file_styles` → extract colors, typography, effects
   - **Images**: `figma_get_images` with target node IDs → export as PNG/SVG
4. **Deep inspect**: Use `figma_get_file_nodes` with specific node IDs for details
5. **Present**: Format extracted data as usable code (CSS variables, design tokens, etc.)

## Parameters

- **Figma URL**: `https://www.figma.com/file/{fileKey}/{fileName}` or `https://www.figma.com/design/{fileKey}/{fileName}`
- **Extraction type**: `tokens`, `components`, `styles`, `images`, or `all`
- **Output format**: CSS variables, JSON tokens, or structured markdown

## Rules

- Always start with `depth: 1` — never fetch the full file tree initially
- Use `figma_get_file_nodes` for specific nodes after identifying IDs at depth 1
- Map Figma values to CSS: RGBA (0-1) → hex/rgba, font sizes (px) → rem/px
- For image exports, use `scale: 2` for retina, `format: svg` for icons
- Never use team-level queries when file-level alternatives exist
