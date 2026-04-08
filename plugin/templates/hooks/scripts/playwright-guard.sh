#!/bin/bash
# PreToolUse Hook: Playwright MCP Tool Guard
# Enforces best practices for Playwright browser automation:
# - Warns when browser_navigate targets non-HTTPS URLs
# - Warns when browser_click is called without a preceding browser_snapshot
# - Warns when browser_take_screenshot is called (vision cap may not be set)

INPUT="$(cat)"

if command -v python3 &> /dev/null; then
    echo "$INPUT" | python3 -c "
import json, sys, re

decision = 'allow'
reason = ''

try:
    hook_input = json.load(sys.stdin)

    tool_name = hook_input.get('tool_name', hook_input.get('toolName', ''))
    is_browser = tool_name.startswith('browser_')

    if is_browser:
        tool_input = hook_input.get('tool_input', hook_input.get('toolInput', hook_input.get('input', {})))

        # Guard: browser_navigate to non-HTTPS URL
        if tool_name == 'browser_navigate':
            url = tool_input.get('url', '') if isinstance(tool_input, dict) else ''
            if url and not url.startswith('https://'):
                reason = f'WARNING: browser_navigate targeting non-HTTPS URL: {url}. Non-HTTPS connections are insecure and may expose data. Ensure this is intentional (e.g., localhost development).'

        # Guard: browser_click without snapshot reminder
        if tool_name == 'browser_click':
            reason = 'REMINDER: Ensure you called browser_snapshot before browser_click to get current accessibility refs. Element refs may become stale after navigation or page changes.'

        # Guard: browser_take_screenshot — vision cap warning
        if tool_name == 'browser_take_screenshot':
            reason = 'WARNING: browser_take_screenshot requires --caps=vision to be set when starting the MCP server. Without vision capability, screenshots cannot be interpreted. Prefer browser_snapshot (accessibility tree) for element inspection.'

        # Guard: browser_tab_new — warn about tab limit
        if tool_name == 'browser_tab_new':
            reason = 'REMINDER: Limit concurrent tabs to 5. Each open tab consumes memory and CPU. Close finished tabs with browser_tab_close before opening new ones. Use browser_tab_list to audit open tabs.'

except:
    decision = 'allow'

output = {
    'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': decision,
        'permissionDecisionReason': reason
    }
}
print(json.dumps(output))
" 2>/dev/null || echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":""}}'
else
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":""}}'
fi

exit 0
