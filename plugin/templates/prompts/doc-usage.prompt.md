---
description: "Create or update user documentation. Use when: write usage docs, user manual, setup guide, feature description for end users."
agent: "agent"
argument-hint: "Optional: Specific features or functions to be documented"
---

First read the documentation rules in [documentation.instructions.md](../instructions/documentation.instructions.md).

Use the skill `documentation-usage` to create or update the user documentation.

**Rules:**
- ONLY usage, behavior, and function from the user's perspective
- NO code examples, NO implementation details, NO function names
- No technical references to internal code structures
- No duplicate entries
- Update `docs/usage_docs/inhalt.md` with format: `{relative file path} | {short description}`
