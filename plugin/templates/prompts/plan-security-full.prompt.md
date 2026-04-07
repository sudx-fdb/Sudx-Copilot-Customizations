---
description: "Create security audit plan for the entire codebase. Use when: full security audit, OWASP check, vulnerability scan, project-wide security hardening."
agent: "agent"
argument-hint: "Optional: Specific security focus (e.g., auth, injection, input validation)"
---

First read the planning rules in [create_plan.instructions.md](../instructions/create_plan.instructions.md).

Use the skill `security-plan-full` to create a complete security audit plan for the **entire codebase**.

Create the plan according to the plan format in [planformat.md](../skills/planformat.md) -- section `Entire Codebase`.

**EVERY single file** must be systematically checked for OWASP Top 10 and all other security vulnerabilities.
