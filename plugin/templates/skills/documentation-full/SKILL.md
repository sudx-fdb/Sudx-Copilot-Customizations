---
name: documentation-full
description: "Creates or updates complete project documentation for GitHub. Use when: writing README, creating GitHub docs, overhauling project documentation, creating complete docs, updating README, contributing guide."
argument-hint: "Optional: Specific documentation focus (e.g., README, Contributing, Changelog)"
---

# Full Documentation -- GitHub-Ready

## Purpose
Creates or updates the **complete project documentation** for GitHub and external users. Includes README, Contributing Guide, and all other docs relevant for a GitHub repository. Both code docs and usage docs are covered.

## When to Use
- README needs to be created or completely overhauled
- Project documentation for GitHub publication preparation
- Complete documentation of all types needs updating
- All docs need to be updated after major changes

## Documentation Rules

### Code Docs (from [documentation.instructions.md](../../instructions/documentation.instructions.md)):
- ONLY code-related information
- Avoid duplicate entries
- Short, unambiguous, and path-related
- Code examples where technically useful
- No end-user usage hints
- `inhalt.md` format: `{relative file path} | {short description}`

### Usage Docs (from [documentation.instructions.md](../../instructions/documentation.instructions.md)):
- ONLY usage, behavior, and function from the program/user perspective
- NO code examples
- NO implementation details
- Describe what a function does and how it affects users
- `inhalt.md` format: `{relative file path} | {short description}`
- No technical references to internal code structures

## Procedure

### Step 1: Understand project
1. Scan entire codebase and capture project structure
2. Identify main functionality and purpose of the project
3. List technology stack and dependencies
4. Read and evaluate existing documentation

### Step 2: Create/update README
A complete README must contain:
- **Project name and description**: What does the project do?
- **Features**: Main functionalities as a list
- **Requirements**: System requirements, dependencies
- **Installation**: Step-by-step setup guide
- **Configuration**: What config options exist?
- **Usage**: How to use the project? (Basic examples)
- **Project Structure**: Folder structure with explanations
- **Contributing**: How to contribute? (or reference to CONTRIBUTING.md)
- **License**: Which license applies?

### Step 3: Update code docs
For each file/module in the project:
1. Document technical functionality
2. Functions, classes, parameters, return values
3. Dependencies and data flows
4. Configuration parameters and error handling
5. Update `docs/code_docs/inhalt.md`

### Step 4: Update usage docs
For each user-visible functionality:
1. What does the function do from a user perspective?
2. How is it called/used?
3. What effects does it have?
4. What options/parameters exist?
5. Update `docs/usage_docs/inhalt.md`

### Step 5: Check additional GitHub docs
- CONTRIBUTING.md -- if present, update
- CHANGELOG.md -- if present, update
- LICENSE -- check presence
- .github/ templates (Issue, PR) -- if present, check

### Step 6: Quality check
- [ ] README is complete and current
- [ ] No duplicate entries in code docs or usage docs
- [ ] Code docs contain no end-user hints
- [ ] Usage docs contain no code examples or implementation details
- [ ] Both `inhalt.md` files are current
- [ ] All links in the documentation work
- [ ] No outdated features documented
- [ ] Project structure in README matches the actual project

### Step 7: Review
- Read through entire documentation completely
- Find and clean up duplicates between code docs and usage docs
- Identify and fix contradictions between README and detail docs
- Remove outdated information
- Update `docs/code_docs/inhalt.md` final
- Update `docs/usage_docs/inhalt.md` final