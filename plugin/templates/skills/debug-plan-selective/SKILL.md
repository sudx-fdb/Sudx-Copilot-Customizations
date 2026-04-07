---
name: debug-plan-selective
description: "Creates a targeted debug plan for selected files or functions. Use when: fixing bug in specific function, adding debug logging selectively, hardening error handling for specific modules, targeted bughunting."
argument-hint: "Files, functions or modules to be debugged"
---

# Debug Plan -- Selective

## Purpose
Creates a focused debug and bughunting plan for **selected files, functions, or modules**. The plan covers:
- All bug possibilities in the affected areas
- Missing error handling and edge cases
- Debug logging integration in affected functions
- Crash resistance and autorecovery for the affected areas
- Bug hardening (defensive programming)

## When to Use
- A specific bug needs to be found and fixed
- Debug logging needs to be added to specific modules
- Error handling for selected functions needs hardening
- Targeted stability improvement without full project scan

## Preparation

1. **Load plan format**
   - Read [planformat.md](../planformat.md) completely
   - Use the **"Function Overhaul / Individual Fixes"** (selective) section as template
2. **Identify affected areas**
   - User input: Which files / functions / modules?
   - Determine dependencies of these areas (callers, callees, shared state)
   - Include indirectly affected files in the plan
3. **Check existing debug infrastructure**
   - Is there a central logging system? -> Use it consistently
   - Is there a language pack? -> Route all outputs through it
   - Are there config files? -> Identify configurable values
   - Is there cache/state management? -> Use for autorecovery

## Procedure -- Plan Creation

### Step 1: Define scope
Clarify with the user which areas are affected. List all relevant files and functions.

### Step 2: Create categories
For each affected area, create a category:

```md
## 1. {Category Name}
### Description
Detailed description of the task and its goal. List all bug risks, open edge cases, and missing safeguards.

### TaskList
- [ ] {Concrete bug fixes and findings}
- [ ] {Missing validations and boundary checks}
- [ ] {Unhandled exceptions and error paths}
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

- [ ] All areas mentioned by the user are included in the plan
- [ ] Indirectly affected dependencies have been identified and included
- [ ] Each category has a detailed description with concrete findings
- [ ] Debug logging is planned for every affected function
- [ ] Error handling covers all identified risks
- [ ] Mandatory checkpoints are in EVERY category
- [ ] Final tasklist is complete and unmodified

## Implementation Rules (when executing the plan)

> **CRITICAL:** These rules ALWAYS apply when the plan is being executed:
> - Process tasks ONE AT A TIME and check off -- NEVER multiple simultaneously
> - Keep checkmarks LIVE up to date -- set immediately after completion
> - Check the last 2 checkpoints of each category INDIVIDUALLY and CAREFULLY
> - Only check off after actual verification -- do not auto-approve
> - When multiple plans exist: only work on one plan at a time