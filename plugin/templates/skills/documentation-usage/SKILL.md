---
name: documentation-usage
description: "Creates or updates usage documentation (user-facing). Use when: writing usage docs, creating user manual, updating user documentation, writing setup guide, feature description for end users."
argument-hint: "Optional: Specific features or functions to be documented"
---

# Usage Documentation

## Purpose
Creates or updates the **usage documentation** that describes how the project works from a user perspective. No code, no implementation details -- only setup, purpose, functionality, and usage.

## When to Use
- Usage documentation needs to be created or updated
- Writing a user manual for end users
- Creating or overhauling a setup guide
- Documenting feature descriptions from a user perspective
- `docs/usage_docs/` needs to be populated or overhauled

## Documentation Rules

ALWAYS follow these rules from [documentation.instructions.md](../../instructions/documentation.instructions.md):
- This documentation describes ONLY usage, behavior, and function from the program/user perspective
- NO code examples
- NO implementation details
- Describe what a function does and how it affects users
- `inhalt.md` uses the format: `{relative file path} | {short description}`
- Avoid duplicate entries and technical references to internal code structures

## Procedure

### Step 1: Determine scope
- Were specific features/functions mentioned by the user? -> Only document those
- No specific scope? -> Go through entire project functionality

### Step 2: Understand functionality
For each feature to be documented:
1. Read code to fully understand the functionality
2. Identify all usage scenarios
3. Capture configuration options that affect the user
4. Walk through typical workflows and use cases

### Step 3: Write documentation
Document per feature/functionality:
- **What does it do?** -- Clear, non-technical description
- **Why?** -- What problem does it solve for the user?
- **How to use it?** -- Step-by-step instructions
- **Configuration** -- What settings can the user adjust?
- **Behavior** -- What happens with certain actions / in certain situations?
- **Known limitations** -- What is currently not (yet) possible?

**FORBIDDEN in usage docs:**
- Code examples or code snippets
- Function names, variable names, class names
- File paths to source files
- Technical implementation details
- References to internal code structures

### Step 4: Check setup guide
If the project requires setup:
1. Requirements (operating system, software, versions)
2. Installation step by step
3. Initial configuration
4. First start / first test
5. Common problems and solutions

### Step 5: Update inhalt.md
- Update `docs/usage_docs/inhalt.md` with all new/changed entries
- Format: `{relative file path} | {short description}`
- Remove duplicate entries
- Remove or update outdated entries

### Step 6: Quality check
- [ ] No code examples in the usage docs
- [ ] No implementation details or function names
- [ ] No references to internal code structures
- [ ] Every feature is described from a user perspective
- [ ] Setup guide is complete and comprehensible
- [ ] No duplicate entries
- [ ] `inhalt.md` is current and complete
- [ ] No outdated features documented

### Step 7: Review
- Read through entire created documentation again completely
- Perspective shift: Read as an end user -- is everything understandable WITHOUT code knowledge?
- Identify duplicates and merge
- Clean up contradictions and outdated content
- Ensure documentation reflects the current feature set