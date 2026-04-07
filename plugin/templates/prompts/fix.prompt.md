---
description: "Fix a bug. Use when: fix error, resolve bug, solve exception, resolve error, fix crash, diagnose problem."
agent: "agent"
argument-hint: "Error description, stacktrace or affected file"
---

Diagnose and fix the described bug:

1. **Reproduce**: Understand the error condition -- when does the bug occur?
2. **Find Root Cause**: Trace the data flow back to the root cause
3. **Implement Fix**: Fix the cause, not just the symptom
4. **Regression Check**: Can the fix affect other parts?
5. **Debug Logging**: Ensure relevant debug logs are in place

**Rules:**
- Analyze first, then implement -- don't guess
- Fix explanation: What was the cause? Why does the fix resolve the problem?
- Defensive programming: Could the bug have been prevented by validation?
- Similar patterns: Does the same bug exist elsewhere?
