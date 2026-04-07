---
description: "Refactor and improve code. Use when: clean up code, refactoring, improve code quality, remove redundancies, increase readability."
agent: "agent"
argument-hint: "File or code area to be refactored"
---

Refactor the specified code with focus on:

1. **Readability**: Clear naming, logical structure, comments where needed
2. **DRY**: Identify and extract redundancies
3. **Single Responsibility**: Split functions that do too much
4. **Defensive Programming**: Input validation, null checks, edge cases
5. **Performance**: Fix obvious performance issues

**Rules:**
- Functionality MUST NOT change (unless user explicitly requests it)
- Preserve debug logging and improve if needed
- Existing tests must still pass
- Externalize configurable values to config if not already done
