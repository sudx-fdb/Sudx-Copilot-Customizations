#!/bin/bash
# PreToolUse Hook: Protect plan Final-Tasklist from content changes
# Allows checkmark changes but blocks structural edits to FINAL section
# Detects both English and German plan files

# Read hook input from stdin
INPUT="$(cat)"

if command -v python3 &> /dev/null; then
    python3 -c "
import json, sys, os, re

decision = 'allow'
reason = ''

try:
    hook_input = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else json.loads('$INPUT' if '$INPUT'.strip() else '{}')
except:
    try:
        hook_input = json.loads('''$INPUT''') if '''$INPUT'''.strip() else {}
    except:
        hook_input = {}

try:
    tool_name = hook_input.get('toolName', hook_input.get('tool_name', ''))

    # Try multiple possible input field names
    tool_input = hook_input.get('toolInput', hook_input.get('tool_input', hook_input.get('input', {})))
    file_path = tool_input.get('filePath', tool_input.get('file_path', ''))
    old_string = tool_input.get('oldString', tool_input.get('old_string', ''))
    new_string = tool_input.get('newString', tool_input.get('new_string', ''))

    is_edit = any(k in tool_name.lower() for k in ['edit', 'replace', 'write', 'str_replace'])

    if is_edit and file_path and os.path.isfile(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()

        # Detect plan file: generic (## FINAL + ### TaskList) or language-specific markers
        has_final_section = '## FINAL' in content and '### TaskList' in content
        has_german_marker = 'Gesamte Implementation dieses Plans' in content
        has_english_marker = 'Full implementation of this plan verified' in content

        is_plan = has_final_section or has_german_marker or has_english_marker

        if is_plan and old_string:
            # Check if edit touches FINAL section
            final_markers = [
                '## FINAL',
                'Gesamte Implementation dieses Plans',
                'Full implementation of this plan verified',
                'version.py ausge',
                'version.py executed',
                'Code Docs und Usage Docs',
                'Code Docs and Usage Docs'
            ]
            touches_final = any(m in old_string for m in final_markers)

            if touches_final:
                # Validate: only checkmark changes allowed
                old_stripped = re.sub(r'\[[ x]\]', '[_]', old_string)
                new_stripped = re.sub(r'\[[ x]\]', '[_]', new_string)

                if old_stripped != new_stripped:
                    decision = 'deny'
                    reason = 'WARNING: Edit affects the Final-Tasklist of a plan. Its content MUST NOT be changed structurally. Only checkmarks ([ ] to [x]) may be set.'
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
" <<< "$INPUT" 2>/dev/null || echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":""}}'
else
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":""}}'
fi

exit 0
