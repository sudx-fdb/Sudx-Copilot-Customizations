#!/bin/bash
# PreToolUse Hook: Enforce single-checkmark-per-edit rule for plan files
# If an edit changes more than 1 checkbox from [ ] to [x] in a plan file, REJECT.
# Also detects task deletion (removing unchecked items) as a skip attempt.

INPUT="$(cat)"

if command -v python3 &> /dev/null; then
    echo "$INPUT" | python3 -c "
import json, sys, os, re, tempfile

decision = 'allow'
reason = ''

def is_plan_file(fp):
    \"\"\"Determine if a file is a plan file via content + path heuristics.\"\"\"
    if not fp:
        return False

    # Path-based detection
    norm = fp.replace(os.sep, '/')
    path_like_plan = ('plans/' in norm or '.ai_workfolder/' in norm) and norm.endswith('.md')

    # Content-based detection (primary)
    if os.path.isfile(fp):
        try:
            with open(fp, 'r', encoding='utf-8') as f:
                content = f.read()
            if '## FINAL' in content and re.search(r'- \[[ x]\]', content):
                return True
        except:
            pass

    # Fallback: path heuristic
    return path_like_plan

def get_violation_count():
    \"\"\"Read and increment violation counter from temp file.\"\"\"
    counter_file = os.path.join(tempfile.gettempdir(), 'sudx-workflow-violations.txt')
    count = 0
    if os.path.isfile(counter_file):
        try:
            with open(counter_file, 'r') as f:
                val = f.read().strip()
            if val.isdigit():
                count = int(val)
        except:
            pass
    count += 1
    try:
        with open(counter_file, 'w') as f:
            f.write(str(count))
    except:
        pass
    return count

try:
    hook_input = json.load(sys.stdin)

    tool_name = hook_input.get('tool_name', hook_input.get('toolName', ''))
    is_edit = any(k in tool_name.lower() for k in ['replace_string', 'multi_replace', 'edit_file'])

    if is_edit:
        tool_input = hook_input.get('tool_input', hook_input.get('toolInput', hook_input.get('input', {})))

        pairs = []

        # Single replacement
        if 'oldString' in tool_input and 'newString' in tool_input:
            pairs.append({
                'old': tool_input['oldString'],
                'new': tool_input['newString'],
                'path': tool_input.get('filePath', '')
            })

        # Multi replacement — collect ALL pairs
        if 'replacements' in tool_input:
            for r in tool_input['replacements']:
                if 'oldString' in r and 'newString' in r:
                    pairs.append({
                        'old': r['oldString'],
                        'new': r['newString'],
                        'path': r.get('filePath', '')
                    })

        # Aggregate across ALL pairs targeting plan files
        total_new_checks = 0
        total_tasks_removed = 0

        for pair in pairs:
            fp = pair['path']
            if not is_plan_file(fp):
                continue

            old_checked = len(re.findall(r'- \[x\]', pair['old']))
            new_checked = len(re.findall(r'- \[x\]', pair['new']))
            old_unchecked = len(re.findall(r'- \[ \]', pair['old']))
            new_unchecked = len(re.findall(r'- \[ \]', pair['new']))

            checks_added = new_checked - old_checked
            if checks_added > 0:
                total_new_checks += checks_added

            unchecked_lost = old_unchecked - new_unchecked
            if unchecked_lost > 0:
                accounted = checks_added if checks_added > 0 else 0
                unaccounted = unchecked_lost - accounted
                if unaccounted > 0:
                    total_tasks_removed += unaccounted

        # REJECT: Batch checkmark edits
        if total_new_checks > 1:
            vn = get_violation_count()
            decision = 'deny'
            reason = (
                f'VIOLATION #{vn} of execute_plan.instructions.md!\n'
                f'You attempted to check off {total_new_checks} checkmarks in a SINGLE edit. This is STRICTLY FORBIDDEN.\n\n'
                'RULES YOU MUST FOLLOW:\n'
                '1. Complete ONE task\n'
                '2. Set exactly ONE [x] in the planfile\n'
                '3. Then proceed to the next task\n\n'
                'RULES YOU VIOLATED:\n'
                '- NEVER batch-check multiple items in one edit\n'
                '- NEVER use multi_replace to mark multiple checkmarks at once\n'
                '- NEVER group completions\n\n'
                f'Go back and make {total_new_checks} SEPARATE edits, each changing exactly ONE checkbox from [ ] to [x].'
            )

        # REJECT: Task deletion
        if decision == 'allow' and total_tasks_removed > 0:
            vn = get_violation_count()
            decision = 'deny'
            reason = (
                f'VIOLATION #{vn} of execute_plan.instructions.md!\n'
                f'You attempted to REMOVE {total_tasks_removed} unchecked task(s) from a plan file. This is STRICTLY FORBIDDEN.\n\n'
                'Plan tasks MUST NOT be deleted or skipped. Every task must be completed and checked off individually.'
            )
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
