---
name: security-plan-full
description: "Creates a complete security audit plan for the entire codebase. Use when: security audit entire project, vulnerability scan, OWASP check, penetration test preparation, security hardening all files."
argument-hint: "Optional: Specific security focus (e.g., auth, input validation, injection)"
---

# Security Plan -- Entire Codebase

## Purpose
Creates a complete security audit plan that checks **every single file** in the project for security vulnerabilities. The plan covers:
- Identify EVERY security vulnerability in EVERY file
- Plan best possible fix for each vulnerability
- Input validation and sanitization
- Authentication and authorization weaknesses
- Injection attack vectors (SQL, XSS, Command, Path Traversal)
- Sensitive data exposure and secrets management
- Crash resistance and secure error handling

## When to Use
- Full security audit of the entire project
- Before a security review or penetration test
- OWASP Top 10 compliance check
- Project-wide security hardening

## Preparation

1. **Load plan format**
   - Read [planformat.md](../planformat.md) completely
   - Use the **"Entire Codebase"** section as template
2. **Scan entire codebase**
   - Capture EVERY single file in the project (no exceptions)
   - Note for each file: path, relevant line ranges, file type
3. **Understand security context**
   - What external interfaces exist? (APIs, user input, file I/O)
   - What authentication/authorization is used?
   - Where is sensitive data processed? (credentials, tokens, PII)
   - Which dependencies have known CVEs?
4. **Check existing infrastructure**
   - Central logging system -> Log security events
   - Config files -> Externalize secrets
   - Cache/state management -> Secure storage

## Procedure -- Plan Creation

### Step 1: Create file index
List EVERY file in the project with full path:
```md
# Files
1. - [ ] {full/file/path}     | Line [N] to [N]
2. - [ ] {full/file/path}     | Line [N] to [N]
...
N. - [ ] Final Tasks           | Line [N] to [N]
```

### Step 2: Security analysis per file
For each file in the index, create a category with:

**Description:** Detailed description of ALL found security vulnerabilities. Each vulnerability with severity (Critical/High/Medium/Low), attack vector, and impact.

**TaskList** -- the following security checks MUST be performed for each file:
- **Injection**: SQL, NoSQL, OS Command, LDAP, XPath, XSS (Reflected/Stored/DOM)
- **Broken Auth**: Hardcoded credentials, weak token generation, missing session invalidation
- **Sensitive Data**: Unencrypted transmission, plaintext storage, missing masking in logs
- **Input Validation**: Missing type checks, boundary checks, whitelist validation
- **Access Control**: Missing permission checks, IDOR, privilege escalation
- **Path Traversal**: Unsafe file path construction, missing path normalization
- **Error Handling**: Information leakage through error messages, stack traces in responses
- **Dependencies**: Outdated packages with known vulnerabilities
- Extremely detailed DEBUG logging FOR EVERY SINGLE FUNCTION (security events!)
- Entire file checked for configurable values -> externalize to config files
- All language keys placed in the central language pack
- All temporary storage registered in cache (cleanly sorted)
- All new code made fully crash-resistant, states saved for autorecovery
- Autorecovery integrated as deeply as possible

### Step 3: Mandatory checkpoints per category
EVERY category MUST contain these two checkpoints at the end:
```md
- [ ] Verified ALL previous tasks at HIGHEST detail and production quality
- [ ] All checkmarks of THIS category verified and correctly set with [x] IF THEY REALLY APPLY
```

### Step 4: Final section
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

- [ ] EVERY file in the project is included in the plan -- no exceptions
- [ ] Each vulnerability has: severity, attack vector, impact, planned fix
- [ ] OWASP Top 10 was systematically checked for each file
- [ ] Secrets and credentials are nowhere hardcoded
- [ ] Debug logging logs all security-relevant events
- [ ] Mandatory checkpoints are in EVERY category
- [ ] Final tasklist is complete and unmodified
- [ ] Plan is longer than 400 lines -> written in individual steps (max 400 lines per edit)

## Implementation Rules (when executing the plan)

> **CRITICAL:** These rules ALWAYS apply when the plan is being executed:
> - Process tasks ONE AT A TIME and check off -- NEVER multiple simultaneously
> - Keep checkmarks LIVE up to date -- set immediately after completion
> - Check the last 2 checkpoints of each category INDIVIDUALLY and CAREFULLY
> - Only check off after actual verification -- do not auto-approve
> - When multiple plans exist: only work on one plan at a time
> - Always implement security fixes with best practice -- no quick hacks