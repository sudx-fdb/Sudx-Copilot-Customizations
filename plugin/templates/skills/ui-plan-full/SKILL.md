---
name: ui-plan-full
description: "Creates a complete UI enhancement plan for the entire codebase. Use when: UI overhaul entire project, UX improvement of all interfaces, UI audit, design consistency check, modernize entire UI."
argument-hint: "Optional: UI style, design guidelines or specific UX focus"
---

# UI Plan -- Entire Codebase

## Purpose
Creates a complete UI enhancement plan that checks **every single file** in the project -- with or without UI elements. The plan covers:
- UI efficiency and usability
- Design consistency across the entire project
- Accessibility and responsiveness
- UI-related error handling and feedback
- Performance of UI components

## When to Use
- Entire project UI needs to be overhauled
- Design consistency audit across all interfaces
- Project-wide UX improvements planning
- UI modernization (new design system, theme change)

## Preparation

1. **Load plan format**
   - Read [planformat.md](../planformat.md) completely
   - Use the **"Entire Codebase"** section as template
2. **Scan entire codebase**
   - Capture EVERY single file in the project (no exceptions)
   - Also check files WITHOUT UI (backend files that deliver UI data, helper functions)
   - Note for each file: path, relevant line ranges, UI relevance
3. **Clarify user requirements**
   - Which UI style / design system?
   - Are there reference designs or mockups?
   - Which UX principles should apply?
   - Target platforms and minimum resolutions?
4. **Check existing UI infrastructure**
   - Identify UI framework and component library
   - Understand existing theme/styling system
   - Central logging -> Log UI errors
   - Language pack -> Route all UI texts through it
   - Config -> Externalize UI-specific settings

## Procedure -- Plan Creation

### Step 1: Create file index
List EVERY file in the project with full path:
```md
# Files
1. - [ ] {full/file/path}     | Line [N] to [N]
2. - [ ] {full/file/path}     | Line [N] to [N]
...
N. - [ ] Final Tasks           | Line [N] to [N]
```

### Step 2: UI analysis per file
For each file in the index, create a category with:

**Description:** Detailed description of UI findings. What is inconsistent? What is missing? What can be improved? Also for non-UI files: Do they deliver data correctly for the UI?

**TaskList** -- the following items MUST be checked and listed as tasks for each file individually:
- Concrete UI improvements per user requirements
- Design consistency: colors, spacing, typography, icons uniform
- UX patterns: feedback on actions, loading states, empty states
- Accessibility: contrast, keyboard navigation, screen reader
- Responsiveness: different screen sizes and orientations
- Performance: unnecessary re-renders, heavy operations on UI thread
- Error states: user-friendly error messages, retry options
- Extremely detailed DEBUG logging FOR EVERY SINGLE FUNCTION
- Entire file checked for configurable values -> externalize to config files, cleanly sorted by category
- All language keys (language-specific outputs) placed in the central language pack
- All temporary storage registered in cache (cleanly sorted)
- All new code made fully crash-resistant, states saved for autorecovery
- Autorecovery integrated as deeply as possible

### Step 3: Mandatory checkpoints per category
EVERY category MUST contain these two checkpoints at the end:
```md
- [ ] Verified ALL previous tasks at HIGHEST detail and production quality
- [ ] All checkmarks of THIS category verified and correctly set with [x] IF THEY REALLY APPLY
```

### Step 4: Final section
At the end of the plan, this exact final tasklist MUST appear:
```md
## FINAL
### TaskList
- [ ] Full implementation of this plan verified
- [ ] All checkmarks CORRECTLY set
- [ ] Code Docs and Usage Docs updated with additions / changes / removals
- [ ] Code Docs and Usage Docs fully read after update and revised / summarized for duplicates or outdated entries
- [ ] docs\code_docs\inhalt.md updated
- [ ] docs\usage_docs\inhalt.md updated
- [ ] version.py executed AFTER RE-READING RULES
```

## Quality Criteria

- [ ] EVERY file in the project is included in the plan -- including non-UI files
- [ ] Each file has a detailed description with concrete UI findings
- [ ] Design consistency was checked across all interfaces
- [ ] UI texts are fully routed through the language pack
- [ ] Mandatory checkpoints are in EVERY category
- [ ] Final tasklist is complete and unmodified
- [ ] Plan is longer than 400 lines -> written in individual steps (max 400 lines per edit)

## Implementation Rules (when executing the plan)

> **CRITICAL:** These rules ALWAYS apply when the plan is being executed:
> - Process tasks ONE AT A TIME and check off -- NEVER multiple simultaneously
> - Keep checkmarks LIVE up to date -- set immediately after completion
> - Check the last 2 checkpoints of each category INDIVIDUALLY and CAREFULLY
> - Only check off after actual verification -- do not auto-approve
> - When multiple plans exist: only work on one plan at a time
> - UI should be efficient and designed according to user requirements