---
description: "Dependency check and update review. Use when: check dependencies, find outdated packages, security vulnerabilities in dependencies, dependency update."
agent: "agent"
argument-hint: "Optional: Specific dependency or package manager"
---

Check the project dependencies comprehensively:

1. **Outdated Packages**: Which dependencies have newer versions?
2. **Security**: Are there known CVEs in the used versions?
3. **Breaking Changes**: Which updates contain breaking changes?
4. **Unused Dependencies**: Are there dependencies that are no longer used?
5. **Compatibility**: Are all dependencies compatible with each other?

For each finding:
- Package name and current version
- Recommended version
- Risk assessment (Critical/High/Medium/Low)
- Required actions (drop-in update, migration, removal)
