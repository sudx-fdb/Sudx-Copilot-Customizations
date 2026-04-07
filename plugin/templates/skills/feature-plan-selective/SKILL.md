---
name: feature-plan-selective
description: "Creates a targeted feature plan for selected files, functions, or modules. Use when: feature overhaul of specific areas, selective refactoring, targeted code improvement, individual fix planning."
argument-hint: "Files, features or modules to be overhauled"
---

# Feature Plan -- Selective

## Purpose
Creates a focused feature and overhaul plan for **selected files, features, or modules**. Not the entire project -- only the affected areas. The plan covers:
- Feature improvement and extension within scope
- Code quality of the affected areas
- Configurability and maintainability
- Crash resistance and autorecovery
- Debug logging and observability

## When to Use
- Specific features need to be overhauled or extended
- Selective refactoring of chosen modules
- Individual fixes affecting multiple related files
- Targeted quality improvement without full project scan

## Preparation

1. **Load plan format**
   - Read [planformat.md](../planformat.md) completely
   - Use the **"Function Overhaul / Individual Fixes"** (selective) section as template
2. **Identify affected areas**
   - User input: Which features / files / modules?
   - Determine dependencies of these areas (imports, callers, shared state)
   - Include indirectly affected files
3. **Clarify user requirements**
   - What exactly should be improved/changed?
   - What quality standards apply?
   - Are there architecture guidelines?
4. **Check existing infrastructure**
   - Identify central logging system
   - Identify language pack system
   - Understand config files and their structure
   - Identify cache/state management system

## Procedure -- Plan Creation

### Step 1: Define scope
Clarify with the user which areas are affected. Also identify indirect dependencies.

### Step 2: Create categories
For each affected area, create a category:

```md
## 1. {Category Name}
### Description
Detailed description of the task and its goal. What should be achieved? What problems exist currently?

### TaskList
- [ ] {Concrete feature tasks and improvements}
- [ ] {Code quality: redundancies, inconsistencies}
- [ ] {Architecture improvements in the affected area}
- [ ] Extremely detailed DEBUG logging FOR EVERY SINGLE FUNCTION implemented
- [ ] Entire file checked for configurable values and externalized to config, cleanly sorted by category
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
- [ ] Feature tasks are specific, actionable, and measurable
- [ ] Debug logging is planned for every affected function
- [ ] Mandatory checkpoints are in EVERY category
- [ ] Final tasklist is complete and unmodified

## Implementation Rules (when executing the plan)

> **CRITICAL:** These rules ALWAYS apply when the plan is being executed:
> - Process tasks ONE AT A TIME and check off -- NEVER multiple simultaneously
> - Keep checkmarks LIVE up to date -- set immediately after completion
> - Check the last 2 checkpoints of each category INDIVIDUALLY and CAREFULLY
> - Only check off after actual verification -- do not auto-approve
> - When multiple plans exist: only work on one plan at a time
> - Maximum quality: most efficient and bug-resistant code