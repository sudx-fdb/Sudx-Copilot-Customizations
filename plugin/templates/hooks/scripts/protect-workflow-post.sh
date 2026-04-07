#!/bin/bash
# PostToolUse Hook: Inject execution rules reminder when AI reads a plan file
# Also warns when reading non-plan files while open plans exist
# Fires after read_file

INPUT="$(cat 2>/dev/null || true)"

if [ -z "$INPUT" ]; then
    echo '{"continue":true}'
    exit 0
fi

if command -v python3 &> /dev/null; then
    echo "$INPUT" | python3 -c "
import json, sys, os, re

def find_open_plans(root):
    \"\"\"Find open plan files in workspace.\"\"\"
    plans = []
    scan_dirs = [
        os.path.join(root, '.ai_workfolder'),
        os.path.join(root, 'plans'),
        os.path.join(root, '.2.ai_workspace', 'plans')
    ]
    for scan_dir in scan_dirs:
        if not os.path.isdir(scan_dir):
            continue
        for dirpath, _, filenames in os.walk(scan_dir):
            for fname in filenames:
                if not fname.endswith('.md'):
                    continue
                fpath = os.path.join(dirpath, fname)
                try:
                    with open(fpath, 'r', encoding='utf-8') as f:
                        content = f.read()
                    if '## FINAL' in content and re.search(r'- \[ \]', content):
                        plans.append({'path': fpath, 'content': content})
                except:
                    pass
    return plans

def get_current_task(content):
    \"\"\"Extract the first open task from plan content.\"\"\"
    match = re.search(r'- \[ \] (.+)', content)
    return match.group(1) if match else None

try:
    hook_input = json.load(sys.stdin)
    tool_name = hook_input.get('tool_name', '')

    if tool_name != 'read_file':
        print(json.dumps({'continue': True}))
        sys.exit(0)

    tool_input = hook_input.get('tool_input', {})
    file_path = tool_input.get('filePath', '')

    if not file_path or not os.path.isfile(file_path):
        print(json.dumps({'continue': True}))
        sys.exit(0)

    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    is_plan = '## FINAL' in content and re.search(r'- \[[ x]\]', content)

    if is_plan:
        current_task = get_current_task(content)
        task_hint = f'\\n\\nYOUR CURRENT TASK: {current_task}' if current_task else ''

        msg = (
            f'PLAN FILE DETECTED - EXECUTION RULES NOW ACTIVE!{task_hint}\\n\\n'
            '=== YOU MUST (MANDATORY) ===\\n'
            '1. Process tasks ONE AT A TIME - complete one, check it off, then next\\n'
            '2. Set EXACTLY ONE checkmark per edit: - [ ] to - [x]\\n'
            '3. Work through the plan from start to finish WITHOUT interruption\\n'
            '4. Automatically proceed to the next task after each completion\\n'
            '5. Only report to the user AFTER the entire plan (including FINAL) is complete\\n'
            '6. Mark the file index entry AFTER all tasks in that category are done\\n'
            '\\n=== YOU MUST NEVER (FORBIDDEN - ENFORCED BY HOOK) ===\\n'
            '1. Check off multiple items in a single edit (WILL BE REJECTED BY HOOK)\\n'
            '2. Use multi_replace to batch-mark checkboxes (WILL BE REJECTED BY HOOK)\\n'
            '3. Pause mid-plan and ask Should I continue?\\n'
            '4. Give status updates and wait for user confirmation\\n'
            '5. Interrupt a plan - either complete it fully or don\\'t start\\n'
            '6. Stop working before all categories + FINAL are done\\n'
            '7. Set checkmarks before the task is actually completed\\n'
            '\\nA plan is an assignment. Execute it. Completely. Without asking.\\n'
            'The protect-workflow hook WILL REJECT any edit that checks off more than 1 item at once.'
        )
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': msg}}))
    else:
        # Non-plan file — check for open plans
        script_dir = os.path.dirname(os.path.abspath(__file__)) if '__file__' in dir() else os.getcwd()
        # Derive root from SCRIPT_DIR (3 levels up from hooks/scripts/)
        root = os.environ.get('HOOK_CWD', os.path.dirname(os.path.dirname(os.path.dirname(script_dir))))
        # Better approach: use the file_path's workspace root
        # Walk up from file_path to find .ai_workfolder or .github
        test_root = file_path
        for _ in range(10):
            test_root = os.path.dirname(test_root)
            if os.path.isdir(os.path.join(test_root, '.ai_workfolder')) or os.path.isdir(os.path.join(test_root, '.github')):
                root = test_root
                break

        open_plans = find_open_plans(root)
        if open_plans:
            plan = open_plans[0]
            rel_path = os.path.relpath(plan['path'], root).replace(os.sep, '/')
            current_task = get_current_task(plan['content'])
            msg = f'WARNING: You are reading a non-plan file while an open plan exists ({rel_path}). Return to plan execution immediately unless this read is required for a plan task.'
            if current_task:
                msg += f'\\nYour current task is: {current_task}'
            print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': msg}}))
        else:
            print(json.dumps({'continue': True}))
except:
    print(json.dumps({'continue': True}))
" 2>/dev/null || echo '{"continue":true}'
else
    echo '{"continue":true}'
fi

exit 0
