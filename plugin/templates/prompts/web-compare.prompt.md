---
description: "Compare live website with Figma designs using Playwright + Figma MCP. Use when: design review, visual comparison, implementation check, design audit, live vs design."
agent: "agent"
argument-hint: "Live URL and Figma file URL to compare"
---

Use **Playwright MCP** and **Figma MCP** together to compare a live website implementation against its Figma design source.

**Target:** {{input}}

## Workflow

1. **Extract Figma design**: Use Figma MCP to get design tokens (colors, typography, spacing) from the Figma file
2. **Capture live site**: Use Playwright MCP to navigate to the live URL and take a screenshot
3. **Inspect live implementation**: Use Playwright `browser_snapshot` to extract the DOM structure
4. **Compare**: Analyze differences between:
   - Figma colors vs. computed CSS colors
   - Figma typography (font family, size, weight) vs. live CSS
   - Figma spacing vs. live margins/padding
   - Figma layout (flexbox/grid) vs. live layout
5. **Report**: Present a comparison table with matches, mismatches, and suggestions

## Parameters

- **Live URL**: The deployed website page to inspect
- **Figma URL**: The source design file in Figma
- **Focus area**: Specific component or section to compare (optional)

## Rules

- Extract Figma data first, then inspect the live site (Figma is the source of truth)
- Use accessibility snapshots for structural comparison, screenshots for visual comparison
- Map Figma RGBA values to CSS hex for accurate color comparison
- Report both exact matches and approximate matches (within tolerance)
- Suggest CSS fixes for any mismatches found
