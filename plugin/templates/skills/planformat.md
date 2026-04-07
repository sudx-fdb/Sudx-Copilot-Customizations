# Plan File for Keyword: Entire Project / Entire Codebase
When the entire codebase needs to be scanned or overhauled, use this plan schema. Make sure to list EVERY SINGLE FILE.

## Format:
```md
> # Implementation Rules:
> When implementing the plan, it is ABSOLUTELY CRITICAL to work through the plan CLEANLY CATEGORY BY CATEGORY!
> IT IS EXTREMELY IMPORTANT to ALWAYS keep the [ ] checkmarks up to date. As soon as you complete a task, mark it as done. THIS IS AN EXTREMELY IMPORTANT WORKFLOW INSTRUCTION AND MUST ALWAYS BE FOLLOWED!
> It is important that you ALSO TAKE THE LAST 2 CHECKPOINTS SERIOUSLY AND DOUBLE-CHECK THEM BEFORE MARKING THEM OFF.
> In this project you simulate the BEST code you can simulate. Maximum quality in efficiency and bug resistance.

> # Planning Rules:
> When planning, it is absolutely critical that these 2 checkpoints "- [ ] Verified ALL previous tasks at HIGHEST detail and production quality", "- [ ] All checkmarks of THIS category verified and correctly set with [x] IF THEY REALLY APPLY" ALWAYS appear IN EVERY CATEGORY!
> At the bottom of the plan, the Final Tasklist must appear exactly: "- [ ] Full implementation of this plan verified", "- [ ] All checkmarks CORRECTLY set", "- [ ] Code Docs and Usage Docs updated with additions / changes / removals", "- [ ] Code Docs and Usage Docs fully read after update and revised / summarized for duplicates or outdated entries", "- [ ] docs\code_docs\inhalt.md updated", "- [ ] docs\usage_docs\inhalt.md updated" and "- [ ] version.py executed AFTER RE-READING RULES"

# Files
1. - [x] {full file path}           | Line [N] to [N]
2. - [ ] {full file path}           | Line [N] to [N]
3. - [ ] Final Tasks                | Line [N] to [N]

# Plans

## 1. {full file path}
### Description
Here goes a detailed description of the tasks/findings for this file

### TaskList
- [x] Task 1
- [x] Task 2
- [x] Task 3
- [x] Extremely detailed DEBUG logging FOR EVERY SINGLE FUNCTION implemented
- [x] Entire file checked for configurable values and externalized to ~/example.config and ~/.config, cleanly sorted by category
- [x] All language keys (language-specific outputs in terminal and other output methods placed in the central language pack)
- [x] All temporary storage registered in cache (cleanly sorted) instead of in RAM. Important for autorecovery and state restoration.
- [x] All new code made fully crash-resistant, states that can be saved should be saved for autorecovery.
- [x] Autorecovery integrated as deeply as possible
- [x] Verified ALL previous tasks at HIGHEST detail and production quality
- [x] All checkmarks of THIS category verified and correctly set with [x] IF THEY REALLY APPLY

## 2. {full file path}
### Description
Here goes a detailed description of the tasks/findings for this file

### TaskList
- [x] Task 1
- [x] Task 2
- [x] Task 3
- [x] Extremely detailed DEBUG logging FOR EVERY SINGLE FUNCTION implemented
- [x] Entire file checked for configurable values and externalized to ~/example.config and ~/.config, cleanly sorted by category
- [x] All language keys (language-specific outputs in terminal and other output methods placed in the central language pack)
- [x] All temporary storage registered in cache (cleanly sorted) instead of in RAM. Important for autorecovery and state restoration.
- [ ] All new code made fully crash-resistant, states that can be saved should be saved for autorecovery.
- [ ] Autorecovery integrated as deeply as possible
- [ ] Verified ALL previous tasks at HIGHEST detail and production quality
- [ ] All checkmarks of THIS category verified and correctly set with [x] IF THEY REALLY APPLY

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


# Plan File for Keyword: Function Overhaul / Individual Fixes
Plan format for all cases where a full codebase overhaul or review is not expected.

## Format:
```md
# ALWAYS READ
> # Implementation Rules:
> When implementing the plan, it is ABSOLUTELY CRITICAL to work through the plan CLEANLY CATEGORY BY CATEGORY!
> IT IS EXTREMELY IMPORTANT to ALWAYS keep the [ ] checkmarks up to date. As soon as you complete a task, mark it as done. THIS IS AN EXTREMELY IMPORTANT WORKFLOW INSTRUCTION AND MUST ALWAYS BE FOLLOWED!
> It is important that you ALSO TAKE THE LAST 2 CHECKPOINTS SERIOUSLY AND DOUBLE-CHECK THEM BEFORE MARKING THEM OFF.

> # Planning Rules:
> When planning, it is absolutely critical that these 2 checkpoints "- [ ] Verified ALL previous tasks at HIGHEST detail and production quality", "- [ ] All checkmarks of THIS category verified and correctly set with [x] IF THEY REALLY APPLY" ALWAYS appear IN EVERY CATEGORY!
> At the bottom of the plan, the Final Tasklist must appear exactly: "- [ ] Full implementation of this plan verified", "- [ ] All checkmarks CORRECTLY set", "- [ ] Code Docs and Usage Docs updated with additions / changes / removals", "- [ ] Code Docs and Usage Docs fully read after update and revised / summarized for duplicates or outdated entries", "- [ ] docs\code_docs\inhalt.md updated", "- [ ] docs\usage_docs\inhalt.md updated" and "- [ ] version.py executed AFTER RE-READING RULES"


# Plan

## 1. {Category Name}
### Description
Here goes a detailed description of the task and its goal

### TaskList
- [x] Task 1
- [x] Task 2
- [x] Task 3
- [x] Extremely detailed DEBUG logging FOR EVERY SINGLE FUNCTION implemented
- [x] Entire file checked for configurable values and externalized to ~/example.config and ~/.config, cleanly sorted by category
- [x] All language keys (language-specific outputs in terminal and other output methods placed in the central language pack)
- [x] All temporary storage registered in cache (cleanly sorted) instead of in RAM. Important for autorecovery and state restoration.
- [x] All new code made fully crash-resistant, states that can be saved should be saved for autorecovery.
- [x] Autorecovery integrated as deeply as possible
- [x] Verified ALL previous tasks at HIGHEST detail and production quality
- [x] All checkmarks of THIS category verified and correctly set with [x] IF THEY REALLY APPLY

## 2. {Category Name}
### Description
Here goes a detailed description of the tasks/findings for this file

### TaskList
- [x] Task 1
- [x] Task 2
- [x] Task 3
- [x] Extremely detailed DEBUG logging FOR EVERY SINGLE FUNCTION implemented
- [x] Entire file checked for configurable values and externalized to ~/example.config and ~/.config, cleanly sorted by category
- [x] All language keys (language-specific outputs in terminal and other output methods placed in the central language pack)
- [x] All temporary storage registered in cache (cleanly sorted) instead of in RAM. Important for autorecovery and state restoration.
- [ ] All new code made fully crash-resistant, states that can be saved should be saved for autorecovery.
- [ ] Autorecovery integrated as deeply as possible
- [ ] Verified ALL previous tasks at HIGHEST detail and production quality
- [ ] All checkmarks of THIS category verified and correctly set with [x] IF THEY REALLY APPLY

## FINAL
### TaskList
- [ ] Full implementation of this plan verified
- [ ] All checkmarks CORRECTLY set
- [ ] Code Docs and Usage Docs updated with additions / changes / removals
- [ ] Code Docs and Usage Docs fully read after update and revised / summarized for duplicates or outdated entries
- [ ] docs\code_docs\inhalt.md updated
- [ ] docs\usage_docs\inhalt.md updated
- [ ] version.py executed AFTER RE-READING RULES