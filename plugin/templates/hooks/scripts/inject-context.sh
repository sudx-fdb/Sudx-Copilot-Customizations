#!/bin/bash
# SessionStart Hook: Inject permanent AI context from .ai_workfolder/context_files/
# Reads all context files and returns them as hookSpecificOutput.additionalContext

# Consume stdin (required by hook contract)
cat > /dev/null

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CONTEXT_DIR="$ROOT_DIR/.ai_workfolder/context_files"

if [ ! -d "$CONTEXT_DIR" ] || [ -z "$(ls -A "$CONTEXT_DIR" 2>/dev/null)" ]; then
    echo '{"continue":true}'
    exit 0
fi

# Use python3 for safe JSON encoding
if command -v python3 &> /dev/null; then
    python3 -c "
import os, json

context_dir = '$CONTEXT_DIR'
parts = []
for f in sorted(os.listdir(context_dir)):
    fp = os.path.join(context_dir, f)
    if os.path.isfile(fp):
        try:
            with open(fp, 'r', encoding='utf-8') as fh:
                parts.append(f'=== {f} ===\n{fh.read()}')
        except:
            pass

if not parts:
    print(json.dumps({'continue': True}))
else:
    msg = 'Permanent project context from .ai_workfolder/context_files/:\n\n' + '\n\n'.join(parts)
    msg += '\n\nREMINDER: If open plans exist, execute them first. Read skills + instructions before any implementation. One checkmark per edit.'
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': msg}}))
" 2>/dev/null || echo '{"continue":true}'
else
    echo '{"continue":true}'
fi

exit 0
