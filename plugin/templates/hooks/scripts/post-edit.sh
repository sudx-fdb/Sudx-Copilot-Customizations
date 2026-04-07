#!/bin/bash
# PostToolUse Hook: Auto-format after edits + .ai_workfolder content.md reminder
# Only acts on file-editing tools, silently passes through for everything else.
# MUST always exit 0 — any other exit code causes VS Code to show a warning.

INPUT="$(cat 2>/dev/null || true)"

if [ -z "$INPUT" ]; then
    echo '{"continue":true}'
    exit 0
fi

if command -v python3 &> /dev/null; then
    echo "$INPUT" | python3 -c "
import json, os, subprocess, sys

EDIT_TOOLS = {'create_file', 'replace_string_in_file', 'multi_replace_string_in_file', 'edit_notebook_file'}
messages = []

try:
    hook_input = json.load(sys.stdin)
    tool_name = hook_input.get('tool_name', '')

    if tool_name not in EDIT_TOOLS:
        print(json.dumps({'continue': True}))
        sys.exit(0)

    tool_input = hook_input.get('tool_input', {})
    file_path = tool_input.get('filePath', '')

    if not file_path or not os.path.isfile(file_path):
        print(json.dumps({'continue': True}))
        sys.exit(0)

    norm_path = file_path.replace(chr(92), '/')
    if '.ai_workfolder/' in norm_path and 'content.md' not in norm_path:
        messages.append('REMINDER: Update .ai_workfolder/content.md')

    ext = os.path.splitext(file_path)[1].lower()
    script_dir = os.path.dirname(os.path.abspath('__file__'))

    prettier_exts = {'.js','.ts','.jsx','.tsx','.css','.scss','.html','.json','.md','.yaml','.yml'}
    if ext in prettier_exts:
        root = os.environ.get('HOOK_CWD', os.getcwd())
        if os.path.exists(os.path.join(root, '.prettierrc')) or os.path.exists(os.path.join(root, '.prettierrc.json')):
            try:
                subprocess.run(['npx', 'prettier', '--write', file_path], capture_output=True, timeout=10)
            except Exception:
                pass

    if ext == '.py':
        try:
            subprocess.run(['black', '--quiet', file_path], capture_output=True, timeout=10)
        except Exception:
            pass
except Exception:
    pass

if messages:
    print(json.dumps({'systemMessage': chr(10).join(messages)}))
else:
    print(json.dumps({'continue': True}))
" 2>/dev/null || echo '{"continue":true}'
else
    echo '{"continue":true}'
fi

exit 0
