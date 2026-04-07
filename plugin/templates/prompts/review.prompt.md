---
description: "Perform code review. Use when: review code, check pull request, evaluate code quality, check best practices."
agent: "agent"
argument-hint: "File or area to be reviewed"
---

Perform a thorough code review. Check for:

1. **Correctness**: Does the logic work? Are there off-by-one, null references, race conditions?
2. **Error Handling**: Are all error cases caught? Are exceptions handled properly?
3. **Security**: Input validation, injection risks, sensitive data exposure?
4. **Performance**: Unnecessary operations, N+1 problems, memory leaks?
5. **Maintainability**: Readability, naming, complexity, DRY principle?
6. **Robustness**: Crash resistance, edge cases, defensive programming?

Summarize findings as a list. Priority: Critical > High > Medium > Low.
For each finding: problem, line/location, suggested fix.
