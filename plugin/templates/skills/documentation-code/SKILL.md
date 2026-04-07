---
name: documentation-code
description: "Creates or updates code documentation (technical function descriptions). Use when: writing code docs, updating technical documentation, populating code_docs, documenting how code works, explaining code."
argument-hint: "Optional: Specific files or modules to be documented"
---

# Code Documentation

## Purpose
Creates or updates the **technical code documentation** that describes how the code works. This documentation is ONLY for code-related information -- no end-user instructions.

## When to Use
- Code documentation needs to be created or updated
- Technical functionality needs to be documented
- After code changes, docs need to be updated
- `docs/code_docs/` needs to be populated or overhauled

## Documentation Rules

ALWAYS follow these rules from [documentation.instructions.md](../../instructions/documentation.instructions.md):
- This documentation is ONLY for code-related information
- Avoid duplicate entries
- Keep entries short, unambiguous, and path-related
- Code examples are allowed when they are useful for technical reproducibility
- Do NOT document pure usage hints for end users
- `inhalt.md` uses the format: `{relative file path} | {short description}`

## Procedure

### Step 1: Determine scope
- Were specific files/modules mentioned by the user? -> Only document those
- No specific scope? -> Go through entire codebase

### Step 2: Understand code
For each file to be documented:
1. Read file completely and understand structure
2. Identify all functions, classes, and their interactions
3. Trace data flows and dependencies
4. Capture configuration parameters and their effects

### Step 3: Write documentation
Document per file/module:
- **Purpose**: What does this file/module do?
- **Dependencies**: Which other modules are used?
- **Functions/Classes**: Each with parameters, return values, side effects
- **Data Structures**: Important objects, types, schemas
- **Configuration**: Which config values affect behavior?
- **Error Handling**: Which exceptions can occur?
- **Code Examples**: Only where needed for technical reproducibility

### Step 4: Update inhalt.md
- Update `docs/code_docs/inhalt.md` with all new/changed entries
- Format: `{relative file path} | {short description}`
- Remove duplicate entries
- Remove or update outdated entries

### Step 5: Quality check
- [ ] No duplicate entries in the documentation
- [ ] All entries are short, unambiguous, and path-related
- [ ] No end-user usage hints in the code docs
- [ ] Code examples only where technically useful
- [ ] `inhalt.md` is current and complete
- [ ] All documented functions still exist in the code
- [ ] No outdated or removed features documented

### Step 6: Review
- Read through entire created documentation again completely
- Check for duplicate entries, contradictions, and outdated content
- For duplicates: merge or remove
- Ensure documentation reflects the current code state