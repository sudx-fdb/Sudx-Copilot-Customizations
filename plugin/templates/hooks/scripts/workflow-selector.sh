#!/bin/bash
# UserPromptSubmit Hook: Workflow Selector
# Injects a system message on EVERY prompt reminding the AI to select
# the appropriate workflow and follow agent rules before executing.

# Consume stdin (required by hook contract)
cat > /dev/null

if command -v python3 &> /dev/null; then
    python3 -c "
import json

msg = '''WORKFLOW SELECTION (mandatory for every task):

BEFORE working on this prompt, determine the correct workflow:

1. CHECK the agent mode instructions (.github/agents/sudx.agent.md)
2. IDENTIFY the task type from the user's request:
   - Implementation/Overhaul/Audit/Hardening -> CREATE A PLAN first (mandatory!)
   - Security issue -> security-plan-* (highest priority)
   - Bug/Stability -> debug-plan-*
   - Feature/Refactoring -> feature-plan-*
   - UI/Design -> ui-plan-*
   - Documentation only -> doc skill (no plan needed)
   - Explain/Review/Analyze -> execute directly (no plan needed)
   - Quick single-line fix -> execute directly
3. READ the matching skill BEFORE starting: .github/skills/{skill-name}/SKILL.md
4. READ the relevant instructions BEFORE starting: .github/instructions/*.md

AGENT RULES:
- No Plan = No Work (for implementation tasks)
- One checkmark per edit (enforced by protect-workflow hook)
- Execute plans WITHOUT interruption - never ask 'Should I continue?'
- Maximum code quality, crash-resistant, production-ready
- Non-project files go to .ai_workfolder/'''

print(json.dumps({'systemMessage': msg}))
" 2>/dev/null || echo '{"continue":true}'
else
    echo '{"continue":true}'
fi

exit 0
