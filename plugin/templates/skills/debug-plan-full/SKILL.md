---
name: debug-plan-full
description: "Creates a complete debug plan for the entire codebase. Use when: bug-hunting entire project, adding debug logging, error-handling audit, crash-resistance check, debugging entire codebase."
argument-hint: "Optional: Description of suspected bug area or symptom"
---

# Debug Plan -- Entire Codebase

## Purpose
Creates a complete debug and bughunting plan that covers **every single file** in the project. The plan covers:
- Possible bugs and their root causes
- Missing or insufficient error handling
- Missing or incomplete debug logging integration
- Crash resistance and autorecovery options
- Bug hardening (defensive programming)

## When to Use
- Entire project needs to be checked for bugs and instabilities
- Debug logging needs to be added across the board
- Error handling needs to be hardened project-wide
- Before a major release as a stability audit

## Preparation

1. **Load plan format**
   - Read [planformat.md](../planformat.md) completely
   - Use the **"Entire Codebase"** section as template
2. **Scan entire codebase**
   - Capture EVERY single file in the project (no exceptions)
   - Note for each file: path, relevant line ranges, file type
3. **Check existing debug infrastructure**
   - Is there a central logging system? -> Use it consistently
   - Is there a language pack? -> Route all outputs through it
   - Are there config files? -> Identify configurable values
   - Is there cache/state management? -> Use for autorecovery

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

### Step 2: Analyze per file
For each file in the index, create a category with:

**Description:** Detailed description of all found bug risks, missing error handling, and debug logging gaps.

**TaskList** -- the following items MUST be checked and listed as tasks for each file individually:
- Concrete bug risks and their fixes
- Race conditions, null references, off-by-one, type errors
- Unhandled exceptions / missing try-catch blocks
- Missing input validation
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

- [ ] EVERY file in the project is included in the plan -- no exceptions
- [ ] Each file has a detailed description with concrete findings
- [ ] Debug logging is planned for every single function
- [ ] Error handling covers all identified risks
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