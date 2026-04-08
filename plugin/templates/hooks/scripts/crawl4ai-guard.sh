#!/bin/bash
# PreToolUse Hook: Crawl4ai MCP Tool Guard
# Enforces safety guardrails for web crawling:
# - Warns when crawl depth > 3 (excessive crawling)
# - Blocks crawling of internal/private IPs (SSRF prevention)
# - Warns when crawl target is not HTTPS
# - Warns when max_pages is unset or > 50

INPUT="$(cat)"

if command -v python3 &> /dev/null; then
    echo "$INPUT" | python3 -c "
import json, sys, re

decision = 'allow'
reason = ''

try:
    hook_input = json.load(sys.stdin)

    tool_name = hook_input.get('tool_name', hook_input.get('toolName', ''))
    is_crawl = tool_name.startswith('crawl4ai_') or tool_name.startswith('crawl_')

    if is_crawl:
        tool_input = hook_input.get('tool_input', hook_input.get('toolInput', hook_input.get('input', {})))
        if not isinstance(tool_input, dict):
            tool_input = {}

        url = tool_input.get('url', '')

        # Guard: SSRF prevention - block internal/private IPs
        if url:
            internal_patterns = [
                r'localhost', r'127\.0\.0\.', r'\[::1\]',
                r'://10\.', r'://192\.168\.',
                r'://172\.(1[6-9]|2[0-9]|3[01])\.'
            ]
            is_internal = any(re.search(p, url) for p in internal_patterns)
            if is_internal:
                decision = 'deny'
                reason = f'BLOCKED: Crawling internal/private IP addresses is not allowed (SSRF prevention). Target: {url}. Only crawl public URLs.'

        # Guard: Non-HTTPS warning
        if decision != 'deny' and url and not url.startswith('https://'):
            reason = f'WARNING: Crawling non-HTTPS URL: {url}. Non-HTTPS connections may expose data. Ensure this is intentional.'

        # Guard: Crawl depth > 3
        if decision != 'deny':
            depth = tool_input.get('depth')
            if isinstance(depth, (int, float)) and depth > 3:
                reason = f'WARNING: Crawl depth is {depth} (> 3). Deep crawls can take a very long time and generate large amounts of data. Consider reducing depth or using max_pages to limit scope.'

        # Guard: max_pages unset or > 50
        if decision != 'deny':
            max_pages = tool_input.get('max_pages')
            if max_pages is None or (isinstance(max_pages, (int, float)) and max_pages > 50):
                pages_val = 'unset (unlimited)' if max_pages is None else str(max_pages)
                if not reason:
                    reason = f'WARNING: max_pages is {pages_val}. Large crawl operations can be resource-intensive. Consider setting max_pages to a reasonable limit (e.g., 10-50).'

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
