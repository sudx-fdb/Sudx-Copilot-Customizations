---
description: "Use when working with Figma designs, extracting design tokens, colors, typography, components, or implementing UI from Figma files. Use when: Figma, design tokens, design system, components, styles, UI implementation from design."
applyTo: "**"
---

# Figma MCP — Tool Usage Instructions

These rules apply when using the Figma MCP server tools to interact with Figma files and design systems.

---

## Available Tools

| Tool | Purpose |
|------|---------|
| `figma_get_me` | Get current authenticated user |
| `figma_get_file` | Get a Figma file by key — **use `depth: 1` first on large files** |
| `figma_get_file_nodes` | Get specific nodes from a Figma file |
| `figma_get_images` | Render images/exports from a Figma file |
| `figma_get_image_fills` | Get image fills in a Figma file |
| `figma_get_file_versions` | Get version history of a Figma file |
| `figma_get_comments` | Get comments (use `as_md: true` for readable output) |
| `figma_post_comment` | Add a comment to a Figma file |
| `figma_get_team_projects` | List projects in a team |
| `figma_get_project_files` | List files in a project |
| `figma_get_team_components` | Get shared components in a team library |
| `figma_get_file_components` | Get components in a specific file |
| `figma_get_component` | Get a single component by key |
| `figma_get_team_component_sets` | Get component sets in a team |
| `figma_get_file_component_sets` | Get component sets in a file |
| `figma_get_team_styles` | Get styles in a team library |
| `figma_get_file_styles` | Get styles in a file |
| `figma_get_style` | Get a single style by key |

---

## When to Use Figma Tools

**USE** Figma tools when:
- The user references a Figma file URL or file key
- The user asks to implement a UI based on a Figma design
- The user asks about design tokens, colors, typography, spacing
- The user wants to extract component structures from Figma
- The user asks to match a design or check design consistency
- The user asks about comments or feedback on a design

**DO NOT USE** Figma tools when:
- The user is discussing UI without referencing any Figma file
- The task is pure CSS/styling without a Figma reference
- The user is working on backend code

---

## Critical Rules

### 1. Always Start with Low Depth
When fetching a Figma file for the first time:
```
figma_get_file(fileKey: "...", depth: 1)
```
Large Figma files can return massive JSON responses. **Always start with `depth: 1`**, then increase depth for specific nodes using `figma_get_file_nodes` with targeted IDs.

### 2. Extract Figma File Keys from URLs
Figma URLs follow this pattern:
```
https://www.figma.com/file/{fileKey}/{fileName}
https://www.figma.com/design/{fileKey}/{fileName}
```
Extract the `fileKey` from the URL before making API calls.

### 3. Use Node IDs for Targeted Access
After getting the file structure at depth 1, identify specific node IDs and use `figma_get_file_nodes` with those IDs. This is more efficient than fetching the entire file at high depth.

### 4. Design Token Extraction Workflow
When extracting design tokens:
1. `figma_get_file_styles` — Get all styles in the file
2. `figma_get_file_components` — Get all components
3. `figma_get_file_nodes` with specific style/component node IDs — Get details
4. Map Figma values to CSS/code variables

### 5. Image Export Workflow
When exporting images from Figma:
1. Get file structure: `figma_get_file` with `depth: 1`
2. Identify node IDs for export targets
3. `figma_get_images` with `ids`, `scale` (1-4), `format` (png/svg/jpg/pdf)

### 6. Comment Workflow
- Use `as_md: true` when fetching comments for readable output
- When posting comments, always include meaningful context
- Never delete comments without explicit user approval

---

## Response Handling

- Figma API responses can be very large — summarize key findings for the user
- Extract only relevant design properties (colors, sizes, typography, spacing)
- When implementing UI from Figma, map Figma properties to CSS:
  - Figma colors (RGBA 0-1) → CSS hex/rgba values
  - Figma font sizes (px) → CSS rem/px values
  - Figma spacing → CSS margin/padding
  - Figma effects → CSS box-shadow, filter
  - Figma constraints → CSS flexbox/grid

---

## Guard Hook Warnings

The `figma-guard` hook automatically monitors Figma tool usage and issues warnings:

| Trigger | Warning |
|---------|---------|
| `figma_get_file` without depth or depth > 2 | Warns about massive response size; suggests depth=1 first |
| `figma_get_file` with depth=1 | Positive hint: suggests using `figma_get_file_nodes` next |
| `figma_get_images` with scale > 2 | Warns about large image sizes; suggests scale=1 or 2 |
| `figma_get_images` with > 10 node IDs | Warns about slow batch; suggests splitting |
| `figma_get_team_components` / `figma_get_team_styles` | Warns about large team queries; suggests file-level alternatives |
| `figma_delete_comment` | Irreversible action warning |
| `figma_post_webhook` | External endpoint verification reminder |
| 6+ Figma API calls in session | Rate limit awareness warning |

These warnings do NOT block the operation — they add context to help you make better decisions. A `"decision": "allow"` is always returned.
