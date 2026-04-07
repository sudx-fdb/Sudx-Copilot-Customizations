---
description: "Generate tests. Use when: write tests, create unit tests, generate test cases, increase test coverage."
agent: "agent"
argument-hint: "File or function for which tests should be generated"
---

Generate comprehensive tests for the specified code:

1. **Happy Path**: Normal, expected usage with valid inputs
2. **Edge Cases**: Boundary values, empty inputs, maximum values, special characters
3. **Error Cases**: Invalid inputs, missing parameters, network errors
4. **Null/Undefined**: What happens with missing or null values?
5. **Concurrency**: Race conditions, concurrent access (if relevant)

**Rules:**
- Follow existing test patterns in the project
- Use descriptive test names that describe expected behavior
- Each test tests exactly ONE thing
- Tests must run independently of each other
- Use mocks only where needed (external dependencies, I/O)
