---
name: feature-plan-full
description: "Creates a complete feature audit plan for the entire codebase. Use when: full project audit, feature overhaul of all files, project-wide code improvement, complete code review, refactoring entire project."
argument-hint: "Optional: Description of feature focus or audit goal"
---

# Feature Plan -- Entire Codebase

## Purpose
Creates a complete audit and feature plan that manually checks and audits **every single file** in the project. The plan covers:
- Feature completeness and correctness
- Code quality and efficiency
- Configurability and maintainability
- Crash resistance and autorecovery
- Debug logging and observability

## When to Use
- Entire project needs to be audited and overhauled
- Comprehensive code review before a major release
- Project-wide refactoring initiative
- Feature completeness check across all files

## Preparation

1. **Load plan format**
   - Read [planformat.md](../planformat.md) completely
   - Use the **"Entire Codebase"** section as template
2. **Scan entire codebase**
   - Capture EVERY single file in the project (no exceptions)
   - Note for each file: path, relevant line ranges, file type
3. **Clarify user requirements**
   - Which features should be checked/overhauled?
   - What quality standards apply?
   - Are there specific architecture guidelines?
4. **Check existing infrastructure**
   - Identify central logging system
   - Identify language pack system
   - Understand config files and their structure
   - Identify cache/state management system

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

**Description:** Detailed description of tasks and findings for this file. What needs to be changed, improved, or added? Which patterns are inconsistent? Where is functionality missing?

**TaskList** -- the following items MUST be checked and listed as tasks for each file individually:
- Concrete feature tasks and improvements per user requirements
- Code quality: redundancies, dead code paths, inconsistent patterns
- Architecture: design problems, missing abstraction, coupling
- Extremely detailed DEBUG logging FOR EVERY SINGLE FUNCTION
- Entire file checked for configurable values -> externalize to config files, cleanly sorted by category
- All language keys (language-specific outputs) placed in the central language pack
- All temporary storage registered in cache (cleanly sorted) instead of in RAM
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
- [ ] Feature tasks are specific, actionable, and measurable
- [ ] Debug logging is planned for every single function
- [ ] Configurable values are identified and externalized
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
> - Maximum quality: most efficient and bug-resistant code