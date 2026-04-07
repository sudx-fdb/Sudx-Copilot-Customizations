---
description: "Create security plan for specific files or modules. Use when: fix security vulnerabilities in specific modules, harden auth, targeted security hardening."
agent: "agent"
argument-hint: "Which files or modules should be security-hardened?"
---

First read the planning rules in [create_plan.instructions.md](../instructions/create_plan.instructions.md).

Use the skill `security-plan-selective` to create a targeted security plan for the areas specified by the user.

Create the plan according to the plan format in [planformat.md](../skills/planformat.md) -- section `Function Overhaul / Individual Fixes`.

Identify data flows, entry points, and indirectly affected files.
