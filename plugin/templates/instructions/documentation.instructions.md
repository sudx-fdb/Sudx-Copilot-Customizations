---
description: "Use when writing, updating, or reviewing any documentation. Use when: writing docs, updating documentation, README, code docs, usage docs, inhalt.md, docs/ folder, changelog, contributing."
applyTo: "**"
---

# Documentation Rules

These rules ALWAYS apply when documentation is created, updated, or reviewed — whether as a standalone task or as part of plan execution.

---

## Documentation Skills — When to Use Which

| Situation | Skill |
|-----------|-------|
| Technical code documentation (how does the code work internally?) | `documentation-code` |
| User documentation (how do you use the project?) | `documentation-usage` |
| Complete GitHub docs (README + Code-Docs + Usage-Docs + Contributing) | `documentation-full` |

### Use `documentation-code` when:
- Documenting functions, classes, modules, or data flows
- Populating or updating `docs/code_docs/`
- Technical changes from a plan need to be documented
- Someone asks: "How does X work in the code?"

### Use `documentation-usage` when:
- Writing usage guides, setup guides, or feature descriptions
- Populating or updating `docs/usage_docs/`
- Creating or updating end-user documentation
- Someone asks: "How do you use X?"

### Use `documentation-full` when:
- The entire project needs to be documented (README, all docs)
- The project is being prepared for GitHub publication
- A comprehensive docs update after major changes is needed
- Someone says: "Document the project completely"

---

## Code Docs Rules (`docs/code_docs/`)

- ONLY code-related information — no usage hints for end users
- Keep entries short, unambiguous, and path-related
- Code examples only where they are needed for technical reproducibility
- No duplicate entries — check if the entry already exists before writing
- `inhalt.md` format: `{relative file path} | {short description}`

## Usage Docs Rules (`docs/usage_docs/`)

- ONLY usage, behavior, and function from the program's or user's perspective
- NO code examples
- NO implementation details
- NO technical references to internal code structures (function names, variables, file paths to source files)
- Describe what a function does and how it affects users
- No duplicate entries
- `inhalt.md` format: `{relative file path} | {short description}`

---

## Mandatory During Plan Execution

Within the final tasklist of every plan, there are mandatory documentation tasks:
- Update Code Docs and Usage Docs with additions / changes / removals
- Read both docs fully after update and clean up duplicates or outdated entries
- Update `docs/code_docs/inhalt.md`
- Update `docs/usage_docs/inhalt.md`

These items are processed following the same rules above.
