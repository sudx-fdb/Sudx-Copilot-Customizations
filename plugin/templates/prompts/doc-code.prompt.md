---
description: "Create or update technical code documentation. Use when: write code docs, document how code works, populate docs/code_docs."
agent: "agent"
argument-hint: "Optional: Specific files or modules to be documented"
---

First read the documentation rules in [documentation.instructions.md](../instructions/documentation.instructions.md).

Use the skill `documentation-code` to create or update the technical code documentation.

**Rules:**
- ONLY code-related information -- no end-user usage hints
- Keep entries short, unambiguous, and path-related
- Code examples only where technically useful
- No duplicate entries
- Update `docs/code_docs/inhalt.md` with format: `{relative file path} | {short description}`
