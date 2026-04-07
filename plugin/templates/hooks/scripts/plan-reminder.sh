#!/bin/bash
# UserPromptSubmit Hook: Remind about open plan files with unchecked tasks

# Consume stdin
cat > /dev/null

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if command -v python3 &> /dev/null; then
    python3 -c "
import os, json, re, time

root = '$ROOT_DIR'
scan_dirs = [
    os.path.join(root, '.ai_workfolder'),
    os.path.join(root, 'plans'),
    os.path.join(root, '.2.ai_workspace', 'plans')
]

open_plans = []

for scan_dir in scan_dirs:
    if not os.path.isdir(scan_dir):
        continue
    for dirpath, dirnames, filenames in os.walk(scan_dir):
        for fname in filenames:
            if not fname.endswith('.md'):
                continue
            fpath = os.path.join(dirpath, fname)
            try:
                with open(fpath, 'r', encoding='utf-8') as f:
                    content = f.read()
            except:
                continue

            has_final = '## FINAL' in content
            open_count = len(re.findall(r'- \[ \]', content))

            if has_final and open_count > 0:
                done_count = len(re.findall(r'- \[x\]', content))
                total = open_count + done_count
                percent = int((done_count / total) * 100) if total > 0 else 0
                rel_path = os.path.relpath(fpath, root).replace(chr(92), '/')

                # Check staleness via file modification time
                staleness = ''
                if done_count > 0:
                    mtime = os.path.getmtime(fpath)
                    minutes_ago = int((time.time() - mtime) / 60)
                    if minutes_ago > 5:
                        staleness = f'  |  STALE: no edit for {minutes_ago}min!'

                open_plans.append(f'- {rel_path}  |  {done_count} of {total} done ({percent}%)  |  {open_count} open{staleness}')

if open_plans:
    plan_list = chr(10).join(open_plans)
    msg = 'OPEN PLANS found! Complete these FULLY before starting new tasks:\\n\\n' + plan_list
    msg += '\\n\\nBEFORE WORKING: Read .github/skills/{plan-type}/SKILL.md AND .github/instructions/execute_plan.instructions.md'
    msg += '\\n\\nCRITICAL RULES FOR PLAN EXECUTION:\\n'
    msg += '\\nYOU MUST:\\n'
    msg += '1. Work through the plan from start to finish WITHOUT INTERRUPTION\\n'
    msg += '2. Check off EVERY checkpoint IMMEDIATELY and individually once implemented\\n'
    msg += '3. AUTOMATICALLY proceed to the next task after each completion\\n'
    msg += '4. Only inform the user AFTER the entire plan (including FINAL) is complete\\n'
    msg += '\\nYOU MUST NEVER:\\n'
    msg += '- Pause mid-plan and ask Should I continue?\\n'
    msg += '- Give status updates and wait for user confirmation\\n'
    msg += '- Interrupt a plan - either complete it fully or don\\'t start\\n'
    msg += '- Stop working before all categories + FINAL are done\\n'
    msg += '\\nENFORCEMENT: The protect-workflow hook WILL REJECT any edit that checks off more than 1 item at once. You MUST make ONE edit per checkmark.\\n'
    msg += '\\nA plan is an assignment. You execute it. Completely. Without asking.'
    print(json.dumps({'systemMessage': msg, 'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': msg}}))
else:
    print(json.dumps({'continue': True}))
" 2>/dev/null || echo '{"continue":true}'
else
    echo '{"continue":true}'
fi

exit 0
