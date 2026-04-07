---
description: "Use when creating scripts, helper files, JSON configs, context files, or any AI-generated files that don't belong to the project source code. Use when: creating scripts, helper files, AI workspace, storing context, work files, temporary files, ai_workfolder."
applyTo: "**"
---

# AI Workfolder Rules

All files that do NOT belong directly to the project source code are managed in `.ai_workfolder/`. This includes: scripts, helper files, JSONs, configurations, AI context files and other work files.

---

## Folder Structure

```
.ai_workfolder/
├── content.md              ← Index of all files (mandatory)
├── scripts/                ← All scripts not belonging to the project
│   ├── {category}/         ← Cleanly sorted into subfolders
│   │   └── {script.ext}
│   └── {category}/
│       └── {script.ext}
├── files/                  ← JSONs, configs and other non-project files
│   └── {file.ext}
└── context_files/          ← Permanent AI context for the project
    └── {topic}.md
```

---

## Rules

### Basic Rule: Check Setup
Before creating any file in `.ai_workfolder/`:

1. **Check if `.ai_workfolder/` exists** — if not, create folder
2. **Check if `content.md` exists** — if not, create with template (see below)
3. **Check if `.gitignore` exists** — if yes, check if `.ai_workfolder/` is listed. If not, add it. If no `.gitignore` exists, create one with `.ai_workfolder/` as entry.

### Before Each File Creation: Duplicate Check
Before creating a new script or file:
1. Read `content.md`
2. Check if a script/file with the same or similar purpose already exists
3. If yes → use or extend existing file, DO NOT create new
4. If no → create new file and register in `content.md`

### Scripts (`scripts/`)
- Scripts not directly related to project functionality (build helpers, migration tools, analysis scripts, etc.)
- MUST be sorted into thematic subfolders (e.g., `scripts/migration/`, `scripts/analysis/`, `scripts/setup/`)
- No script directly in `scripts/` without subfolder

### Files (`files/`)
- JSONs, configuration files, data dumps and other non-project files
- Everything that doesn't belong to project function but is also not a script

### Context Files (`context_files/`)
- Permanent AI context that should persist across sessions
- Project-specific insights, decisions, architecture notes
- Everything the AI needs to remember permanently for this project
- Split thematically into separate files (e.g., `architecture.md`, `decisions.md`, `conventions.md`)

---

## content.md Template

```md
# AI Workfolder — Table of Contents

## Scripts
| Path | Description |
|------|-------------|

## Files
| Path | Description |
|------|-------------|

## Context Files
| Path | Description |
|------|-------------|
```

### content.md Rules
- EVERY file in `.ai_workfolder/` MUST be registered in `content.md`
- Format: `| {relative path from .ai_workfolder/} | {short description} |`
- Update `content.md` immediately after each file creation or deletion
- No duplicate entries
- Remove outdated entries (deleted files)
