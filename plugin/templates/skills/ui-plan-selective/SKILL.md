---
name: ui-plan-selective
description: "Creates a targeted UI enhancement plan for selected files or UI sections. Use when: UI improvement of specific views, selective UX fix, design adjustment of selected components, fix UI bug."
argument-hint: "Files, views or UI components to be improved"
---

# UI Plan -- Selective

## Purpose
Creates a focused UI enhancement plan for **selected files or UI sections**. The plan also checks all files related to the selected part -- even without direct UI. The plan covers:
- UI improvement and UX optimization within scope
- Design consistency within the affected area
- UI-related error handling and feedback
- Performance optimization of affected components

## When to Use
- Specific views or components need UI improvement
- Fix UX bug in a specific area
- Design adjustment of selected interfaces
- Integrate new UI component and align existing ones

## Preparation

1. **Load plan format**
   - Read [planformat.md](../planformat.md) completely
   - Use the **"Function Overhaul / Individual Fixes"** (selective) section as template
2. **Identify affected areas**
   - User input: Which views / components / files?
   - Check EVERY file related to the selected part -- including files without direct UI (data providers, helpers, state management)
   - Determine dependencies and data flows between UI components
3. **Clarify user requirements**
   - Which UI style / design system?
   - Are there reference designs or mockups?
   - Specific UX problems to be fixed?
4. **Check existing UI infrastructure**
   - UI framework and component library
   - Theme/styling system
   - Language pack -> Route all UI texts through it
   - Config -> Externalize UI-specific settings

## Procedure -- Plan Creation

### Step 1: Define scope
Clarify with the user which UI areas are affected. Identify ALL files related to them.

### Step 2: Create categories
For each affected area, create a category:

```md
## 1. {Category Name}
### Description
Detailed description of the UI task and its goal. What should be improved? Which UX problems exist? What does the target state look like?

### TaskList
- [ ] {Concrete UI improvements per user requirements}
- [ ] {Design consistency: colors, spacing, typography}
- [ ] {UX patterns: feedback, loading states, empty states}
- [ ] {Error states: user-friendly error messages}
- [ ] {Responsiveness and performance}
- [ ] Extremely detailed DEBUG logging FOR EVERY SINGLE FUNCTION implemented
- [ ] Entire file checked for configurable values and externalized to config
- [ ] All language keys placed in the central language pack
- [ ] All temporary storage registered in cache (cleanly sorted)
- [ ] All new code made fully crash-resistant, states saved for autorecovery
- [ ] Autorecovery integrated as deeply as possible
- [ ] Verified ALL previous tasks at HIGHEST detail and production quality
- [ ] All checkmarks of THIS category verified and correctly set with [x] IF THEY REALLY APPLY
```

### Step 3: Ensure mandatory checkpoints
EVERY category MUST contain the last two checkpoints at the end:
```md
- [ ] Verified ALL previous tasks at HIGHEST detail and production quality
- [ ] All checkmarks of THIS category verified and correctly set with [x] IF THEY REALLY APPLY
```

### Step 4: Append final section
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

- [ ] All UI areas mentioned by the user are included in the plan
- [ ] Indirectly involved files (data providers, helpers) are included
- [ ] Each category has a detailed description with concrete UI findings
- [ ] Design consistency was checked within scope
- [ ] UI texts are routed through the language pack
- [ ] Mandatory checkpoints are in EVERY category
- [ ] Final tasklist is complete and unmodified

## Implementation Rules (when executing the plan)

> **CRITICAL:** These rules ALWAYS apply when the plan is being executed:
> - Process tasks ONE AT A TIME and check off -- NEVER multiple simultaneously
> - Keep checkmarks LIVE up to date -- set immediately after completion
> - Check the last 2 checkpoints of each category INDIVIDUALLY and CAREFULLY
> - Only check off after actual verification -- do not auto-approve
> - When multiple plans exist: only work on one plan at a time
> - UI should be efficient and designed according to user requirements