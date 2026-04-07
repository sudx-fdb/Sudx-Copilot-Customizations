# UserPromptSubmit Hook: Workflow Selector
# Injects a system message on EVERY prompt reminding the AI to select
# the appropriate workflow and follow agent rules before executing.

$ErrorActionPreference = "SilentlyContinue"

# Consume stdin (required by hook contract)
$null = [Console]::In.ReadToEnd()

$msg = "WORKFLOW SELECTION (mandatory for every task):`n"
$msg += "`nBEFORE working on this prompt, determine the correct workflow:`n"
$msg += "`n"
$msg += "1. CHECK the agent mode instructions (.github/agents/sudx.agent.md)`n"
$msg += "2. IDENTIFY the task type from the user's request:`n"
$msg += "   - Implementation/Overhaul/Audit/Hardening -> CREATE A PLAN first (mandatory!)`n"
$msg += "   - Security issue -> security-plan-* (highest priority)`n"
$msg += "   - Bug/Stability -> debug-plan-*`n"
$msg += "   - Feature/Refactoring -> feature-plan-*`n"
$msg += "   - UI/Design -> ui-plan-*`n"
$msg += "   - Documentation only -> doc skill (no plan needed)`n"
$msg += "   - Explain/Review/Analyze -> execute directly (no plan needed)`n"
$msg += "   - Quick single-line fix -> execute directly`n"
$msg += "3. READ the matching skill BEFORE starting: .github/skills/{skill-name}/SKILL.md`n"
$msg += "4. READ the relevant instructions BEFORE starting: .github/instructions/*.md`n"
$msg += "`n"
$msg += "AGENT RULES:`n"
$msg += "- No Plan = No Work (for implementation tasks)`n"
$msg += "- One checkmark per edit (enforced by protect-workflow hook)`n"
$msg += "- Execute plans WITHOUT interruption - never ask 'Should I continue?'`n"
$msg += "- Maximum code quality, crash-resistant, production-ready`n"
$msg += "- Non-project files go to .ai_workfolder/"

$out = @{ systemMessage = $msg } | ConvertTo-Json -Compress
Write-Output $out
exit 0
