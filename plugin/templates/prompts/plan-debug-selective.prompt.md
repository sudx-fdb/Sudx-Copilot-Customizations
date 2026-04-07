---
description: "Create debug plan for specific files or functions. Use when: targeted bughunting, add debug logging selectively, harden specific error handling."
agent: "agent"
argument-hint: "Which files or functions should be debugged?"
---

First read the planning rules in [create_plan.instructions.md](../instructions/create_plan.instructions.md).

Use the skill `debug-plan-selective` to create a targeted debug plan for the areas specified by the user.

Create the plan according to the plan format in [planformat.md](../skills/planformat.md) -- section `Function Overhaul / Individual Fixes`.

Also identify dependencies and indirectly affected files.
