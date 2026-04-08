---
name: mcp-design-to-code
description: "Figma-to-code pipeline: extract design data and generate code. Use when: Figma to code, design to CSS, design to HTML, generate component from Figma, implement design, convert Figma to code."
argument-hint: "Provide Figma file URL or component node ID and target framework (CSS, React, Vue, etc.)"
---

# MCP Design to Code — Figma Pipeline

## Purpose
Guides the Figma-to-code conversion pipeline. Covers:
- Extracting component structure and styles from Figma
- Mapping Figma properties to CSS/framework code
- Generating production-ready component code
- Maintaining design-code consistency

## When to Use
- User wants to implement a Figma design in code
- Convert Figma component to CSS/HTML/React/Vue
- Generate CSS custom properties from Figma styles
- User says: "implement this design", "Figma to code", "generate CSS from Figma", "build this component from the design"

## Prerequisites
1. **Figma MCP server must be running** — the plugin auto-starts it if enabled
2. **Figma API token must be stored** — set via the Sudx CC panel
3. **Figma file URL or node ID** — user provides the design reference
4. **Target framework** — CSS, React, Vue, Svelte, etc.

## Workflow

### Step 1: Fetch File at Depth 1
```
figma_get_file(fileKey, depth=1) → top-level structure
```
**CRITICAL: Start at depth 1. Never go deeper on initial fetch.**

### Step 2: Extract Target Node IDs
From the depth-1 response:
- Identify the target page/frame
- Note the node IDs of components to convert
- If user provided a specific node-id URL, use that directly

### Step 3: Fetch Component Details
```
figma_get_node(fileKey, nodeId, depth=1) → component structure
```
For each target component, get:
- Layout properties (Auto Layout → flexbox)
- Fill/stroke styles → colors
- Typography styles → font properties
- Effect styles → shadows, blur
- Corner radius → border-radius
- Constraints → responsive behavior

### Step 4: Extract Styles
Map Figma properties to CSS:

| Figma Property | CSS Property |
|---|---|
| Fill color | `background-color` / `color` |
| Stroke | `border` |
| Corner radius | `border-radius` |
| Drop shadow | `box-shadow` |
| Inner shadow | `box-shadow: inset` |
| Auto Layout direction | `flex-direction` |
| Auto Layout spacing | `gap` |
| Auto Layout padding | `padding` |
| Text font | `font-family` |
| Text size | `font-size` |
| Text weight | `font-weight` |
| Line height | `line-height` |
| Letter spacing | `letter-spacing` |

### Step 5: Generate Code
Based on the target framework:

**CSS/HTML**: Generate semantic HTML with CSS custom properties
```css
:root {
  --color-primary: #value;
  --font-heading: value;
  --spacing-md: value;
  --radius-sm: value;
}
```

**React/Vue/Svelte**: Generate component files with:
- Correct component structure matching Figma layers
- Styled with CSS modules, styled-components, or scoped CSS
- Props for dynamic values
- Responsive behavior from Figma constraints

### Step 6: Export Images (if needed)
```
figma_get_images(fileKey, nodeIds=[...], format='svg')
```
- Use SVG for icons and illustrations
- Use PNG for raster graphics
- **Max 10 images per batch** (guard rule)

### Step 7: Verify Output
1. Compare generated code visually with Figma design
2. Check all design tokens are correctly mapped
3. Verify responsive behavior matches constraints
4. Ensure accessibility (semantic HTML, ARIA labels)

## Anti-Patterns to Avoid
- Never fetch at depth > 2 (timeout risk on large files)
- Never batch-export more than 10 images at once
- Never hardcode pixel values — use CSS custom properties for design tokens
- Never skip the depth-1 initial fetch (direct deep fetches can timeout)
- Always validate the Figma token is set before starting

## Figma Guard Rules
- Depth > 2 triggers a warning
- Batch image export > 10 triggers a warning
- See `figma.instructions.md` for full guard rules
