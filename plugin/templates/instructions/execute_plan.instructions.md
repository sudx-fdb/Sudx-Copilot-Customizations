---
description: "Use when executing, working through, or implementing plan files. Use when: executing plans, implementing planfiles, setting checkmarks, completing categories, plan progress, implementation by plan."
applyTo: "**"
---

# Plan Execution Rules

These rules apply WITHOUT EXCEPTION when working through any plan file. They are inviolable.

---

## Workflow: One Task at a Time

1. **Select ONE task** — the next open `- [ ]` in the current category
2. **Complete task fully** — at the highest level of detail and production quality
3. **Set checkmark IMMEDIATELY** — `- [ ]` → `- [x]` directly in the plan file
4. **Next task** — back to step 1

**FORBIDDEN:**
- Working on multiple tasks simultaneously
- Setting checkmarks before the task is fully completed
- Setting checkmarks in advance or in batches
- Skipping a category or a checkmark

---

## Plan Continuity — UNINTERRUPTED Execution

**MANDATORY (what you MUST do):**
- Work through a plan from start to finish without interruption
- Process all categories sequentially until the FINAL section
- Automatically proceed to the next task after each completion
- Only inform the user after complete plan completion

**FORBIDDEN (what you must NEVER do):**
- Pause mid-plan and ask "Should I continue?"
- Give status updates and wait for user confirmation
- "Interrupt" a plan — either complete it fully or don't start
- Ask the user if they want to proceed
- Report intermediate states before the plan is complete
- Stop working before all categories + FINAL are done

**A plan is an assignment. You execute it. Completely. Without asking.**

---

## Checkmark Rules

- Checkmarks are kept **LIVE** up to date — update in the plan file immediately after EVERY completed task
- `- [ ]` = Task still open
- `- [x]` = Task fully completed and verified
- There is no intermediate status — either done or not

---

## Mandatory Checkpoints per Category

Every category ends with two mandatory checkpoints:
```md
- [ ] Verified ALL previous tasks at HIGHEST detail and production quality
- [ ] All checkmarks of THIS category verified and correctly set with [x] IF THEY REALLY APPLY
```

**Rules for these checkpoints:**
- Process INDIVIDUALLY and CAREFULLY — do not check off together
- Before checking off: Review each previous task of the category again
- Only check off when the review was ACTUALLY performed and ALL tasks are truly implemented at the highest quality
- If deficiencies are found: Go back and fix them BEFORE checking off the checkpoint
- These checkpoints are NOT a formality — they are quality assurance

---

## Final Tasklist

At the end of every plan there is a final tasklist. This is only processed when ALL categories are fully completed.

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

**Rules for the final tasklist:**
- Content NEVER to be modified — the items are fixed
- Process and check off each item INDIVIDUALLY
- "Full implementation verified" means: Actually go through the entire plan again
- "All checkmarks CORRECTLY set" means: Verify every single checkbox in the plan
- Docs updates are mandatory — no shortcuts
- `version.py` is only executed AFTER re-reading rules

---

## Multiple Plans Simultaneously

When multiple plan files are pending:
- **Always work on only ONE plan at a time** — never jump between plans
- Keep checkmarks in ALL plans up to date at all times
- Order for multiple plans: Security → Debug → Feature → UI (as defined in `create_plan.instructions.md`)
- Only begin the next plan when one is fully completed (including final tasklist)

---

## Quality Standard

For the implementation of every single task:
- **Maximum quality** — the best possible code you can write
- **Highest efficiency** — performant and resource-efficient
- **Bug resistance** — defensive programming, catch edge cases
- **Production ready** — no "good enough for now", no quick hacks, no TODOs left behind