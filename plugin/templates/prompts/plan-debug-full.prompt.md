---
description: "Create debug plan for the entire codebase. Use when: bughunting entire project, add debug logging across the board, error handling audit."
agent: "agent"
argument-hint: "Optional: Suspected bug area or symptom"
---

First read the planning rules in [create_plan.instructions.md](../instructions/create_plan.instructions.md).

Use the skill `debug-plan-full` to create a complete debug plan for the **entire codebase**.

Create the plan according to the plan format in [planformat.md](../skills/planformat.md) -- section `Entire Codebase`.

**EVERY single file** must be checked for bugs, missing error handling, and missing debug logging.
