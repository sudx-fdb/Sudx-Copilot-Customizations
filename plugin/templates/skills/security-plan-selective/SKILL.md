---
name: security-plan-selective
description: "Creates a targeted security plan for selected files or functions. Use when: fixing security vulnerabilities in specific modules, selective security hardening, targeted vulnerability fix, auth hardening of specific endpoints."
argument-hint: "Files, functions or modules to be security-hardened"
---

# Security Plan -- Selective

## Purpose
Creates a focused security plan for **selected files, functions, or modules**. The plan covers:
- Identify all security vulnerabilities in the affected areas
- Plan best possible fix for each vulnerability
- Input validation and sanitization within scope
- Authentication/authorization weaknesses of affected endpoints
- Secure error handling

## When to Use
- Fix security vulnerabilities in specific modules
- Security hardening for selected endpoints or functions
- After a vulnerability report, plan targeted fixes
- Harden auth system or specific interfaces

## Preparation

1. **Load plan format**
   - Read [planformat.md](../planformat.md) completely
   - Use the **"Function Overhaul / Individual Fixes"** (selective) section as template
2. **Identify affected areas**
   - User input: Which files / functions / modules?
   - Determine dependencies and data flows of these areas
   - Identify all entry points (user input, API calls)
   - Include indirectly affected files
3. **Understand security context**
   - What external data flows into the affected code?
   - Which permissions/roles are relevant?
   - Where is sensitive data processed?
4. **Check existing infrastructure**
   - Central logging system -> Log security events
   - Config files -> Externalize secrets
   - Cache/state management -> Secure storage

## Procedure -- Plan Creation

### Step 1: Define scope
Clarify with the user which areas are affected. Identify data flow and all touchpoints.

### Step 2: Create categories
For each affected area, create a category:

```md
## 1. {Category Name}
### Description
Detailed description of all found security vulnerabilities. Each vulnerability with severity (Critical/High/Medium/Low), attack vector, and impact.

### TaskList
- [ ] {Concrete vulnerability and planned fix}
- [ ] {Input validation: missing sanitization, type checks}
- [ ] {Access control: missing permission checks}
- [ ] {Injection vectors: SQL, XSS, Command, Path Traversal}
- [ ] {Error handling: information leakage, secure error messages}
- [ ] Extremely detailed DEBUG logging FOR EVERY SINGLE FUNCTION implemented (security events!)
- [ ] Entire file checked for configurable values and externalized to config
- [ ] All language keys placed in the central language pack
- [ ] All temporary storage registered in cache (cleanly sorted)
- [ ] All new code made fully crash-resistant, states saved for autorecovery
- [ ] Autorecovery integrated as deeply as possible
- [ ] Verified ALL previous tasks at HIGHEST detail and production quality
- [ ] All checkmarks of THIS category verified and correctly set with [x] IF THEY REALLY APPLY
```

### Step 3: Ensure mandatory checkpoints
EVERY category MUST contain the last two checkpoints at the end:
```md
- [ ] Verified ALL previous tasks at HIGHEST detail and production quality
- [ ] All checkmarks of THIS category verified and correctly set with [x] IF THEY REALLY APPLY
```

### Step 4: Append final section
At the end of the plan, this exact final tasklist MUST appear:
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

## Quality Criteria

- [ ] All areas mentioned by the user are included in the plan
- [ ] Data flows and dependencies are fully captured
- [ ] Each vulnerability has: severity, attack vector, impact, planned fix
- [ ] OWASP Top 10 was systematically checked for affected areas
- [ ] Debug logging logs all security-relevant events
- [ ] Mandatory checkpoints are in EVERY category
- [ ] Final tasklist is complete and unmodified

## Implementation Rules (when executing the plan)

> **CRITICAL:** These rules ALWAYS apply when the plan is being executed:
> - Process tasks ONE AT A TIME and check off -- NEVER multiple simultaneously
> - Keep checkmarks LIVE up to date -- set immediately after completion
> - Check the last 2 checkpoints of each category INDIVIDUALLY and CAREFULLY
> - Only check off after actual verification -- do not auto-approve
> - When multiple plans exist: only work on one plan at a time
> - Always implement security fixes with best practice -- no quick hacks