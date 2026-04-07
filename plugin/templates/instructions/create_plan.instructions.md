---
description: "Use when planning tasks, creating plans, deciding which plan type to use, starting any implementation work, debugging, security audits, UI changes, feature development, code reviews, or any task that requires structured execution. ALWAYS loaded for task planning decisions."
applyTo: "**"
---

# Plan Instructions — Mandatory Planning Rules

## Core Rule: EVERY Task Needs a Plan

Before any implementation, overhaul, bugfix, audit, or change to the project is carried out, a plan file MUST be created first. There are NO exceptions to this rule.

**No Plan = No Work.**

This applies to:
- Feature development and extension
- Bug fixing and debug analysis
- Security audits and hardening
- UI overhauls and improvements
- Refactoring and code quality improvements
- Any other structural change to the project

## Plan Types Overview

There are **4 plan types**, each in **2 variants** (Full / Selective):

| Plan Type | Full (Entire Codebase) | Selective (Specific Areas) |
|-----------|------------------------|----------------------------|
| **Feature** | `feature-plan-full` | `feature-plan-selective` |
| **Debug** | `debug-plan-full` | `debug-plan-selective` |
| **Security** | `security-plan-full` | `security-plan-selective` |
| **UI** | `ui-plan-full` | `ui-plan-selective` |

---

## Decision Logic: Which Plan Type to Use?

### Step 1: Full or Selective?

| Question | Answer → Variant |
|----------|------------------|
| Does the task affect the ENTIRE project / ENTIRE codebase? | → **Full** |
| Should EVERY file in the project be checked? | → **Full** |
| Does the task only affect specific files, functions, or modules? | → **Selective** |
| Is the scope clearly limited to a subset? | → **Selective** |

**When in doubt:** If unclear whether Full or Selective → ask the user.

### Step 2: Which Plan Type?

#### Feature Plan (`feature-plan-full` / `feature-plan-selective`)
**Use when:**
- New features need to be implemented
- Existing features need to be overhauled or extended
- Code quality needs to be improved (refactoring)
- Architecture changes are planned
- General code improvements are needed
- A full code review / audit needs to be performed
- The user uses terms like "overhaul", "improve", "extend", "implement", "add", "feature", "refactoring" or similar

**Typical Trigger Phrases:**
- "Overhaul the entire codebase"
- "Implement feature X"
- "Improve the code quality of module Y"
- "Perform a code review"
- "Refactor the authentication"

#### Debug Plan (`debug-plan-full` / `debug-plan-selective`)
**Use when:**
- Bugs need to be found and fixed (bughunting)
- Error handling needs to be hardened
- Debug logging needs to be added or improved
- Crash resistance needs to be checked and improved
- Stability issues are being investigated
- The user uses terms like "bug", "error", "crash", "debug", "logging", "stability", "exception" or similar

**Typical Trigger Phrases:**
- "Find all bugs in the project"
- "Add debug logging to all functions"
- "Why does the app crash at X?"
- "Harden the error handling in module Y"
- "Make the code crash-resistant"

#### Security Plan (`security-plan-full` / `security-plan-selective`)
**Use when:**
- Security vulnerabilities need to be identified and fixed
- A security audit is being performed
- Input validation needs to be checked or implemented
- Authentication/Authorization is being hardened
- Injection attack vectors need to be checked
- Sensitive data needs to be protected
- The user uses terms like "security", "vulnerability", "audit", "OWASP", "injection", "XSS", "authentication" or similar

**Typical Trigger Phrases:**
- "Perform a security audit"
- "Check the project for security vulnerabilities"
- "Harden the input validation"
- "Are our API endpoints secure?"
- "Check for SQL injection and XSS"

#### UI Plan (`ui-plan-full` / `ui-plan-selective`)
**Use when:**
- UI elements need to be created, overhauled, or improved
- UX improvements are being made
- Design consistency needs to be checked or established
- Accessibility is being improved
- Responsiveness needs to be optimized
- The user uses terms like "UI", "design", "UX", "interface", "layout", "theme", "styling", "frontend", "display" or similar

**Typical Trigger Phrases:**
- "Overhaul the entire UI"
- "Improve the design of component X"
- "Make the interface responsive"
- "The UI should look more modern"
- "Adjust the theme"

### Step 3: Combined Tasks

When a task involves multiple plan types, **separate plans** are created:

**Example:** "Overhaul feature X and find all bugs along the way"
→ 1x `feature-plan-selective` + 1x `debug-plan-selective`

**Example:** "Complete project audit with security and code review"
→ 1x `feature-plan-full` + 1x `security-plan-full`

**Order for multiple plans:**
1. Security plan first (security takes priority)
2. Debug plan (stability before new features)
3. Feature plan (functionality)
4. UI plan (interface last)

When multiple plans are active: **Always work on only one plan at a time.**

---

## Plan File Creation Rules

### Plan Format
- ALWAYS use the schema from `.github/skills/planformat.md`
- Full plans → Section "Entire Codebase"
- Selective plans → Section "Function Overhaul / Individual Fixes"

### Size Limit
- If a plan could be longer than 400 lines → first create an empty file, then populate with multiple individual edit calls (max 400 lines per edit)

### Language
- Plans are written in **English**
- Descriptions are concrete and actionable

### Mandatory Checkpoints
Every category in the plan MUST contain these two checkpoints at the end:
```md
- [ ] Verified ALL previous tasks at HIGHEST detail and production quality
- [ ] All checkmarks of THIS category verified and correctly set with [x] IF THEY REALLY APPLY
```

### Final Tasklist
At the end of EVERY plan, this exact tasklist MUST appear:
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

### Standard Tasks per Category
Every category in a plan MUST contain these standard checks as tasks:
- Extremely detailed DEBUG logging FOR EVERY SINGLE FUNCTION implemented
- Entire file checked for configurable values and externalized to Config, cleanly sorted by category
- All language keys (language-specific outputs) placed in the central language pack
- All temporary storage registered in cache (cleanly sorted)
- All new code made fully crash-resistant, states saved for autorecovery
- Autorecovery integrated as deeply as possible

---

## Decision Summary

```
User provides task
    │
    ├─ Does it affect the ENTIRE project?
    │   ├─ Yes → *-plan-full
    │   └─ No → *-plan-selective
    │
    └─ Which area?
        ├─ Security → security-plan-*
        ├─ Bugs/Stability → debug-plan-*
        ├─ UI/Design → ui-plan-*
        └─ Features/Refactoring/General → feature-plan-*
```
