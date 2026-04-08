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
import os, json, subprocess, urllib.request, socket

context_dir = '$CONTEXT_DIR'
root_dir = '$ROOT_DIR'
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

    # MCP Server Status Injection
    mcp_path = os.path.join(root_dir, '.vscode', 'mcp.json')
    if os.path.isfile(mcp_path):
        try:
            with open(mcp_path, 'r', encoding='utf-8') as mf:
                mcp_config = json.load(mf)
            servers = mcp_config.get('mcpServers', {})
            if servers:
                mcp_lines = []
                for name, entry in servers.items():
                    transport = 'unknown'
                    status = 'configured'
                    if 'url' in entry:
                        transport = 'SSE'
                        url = entry['url']
                        if url.startswith('\${input:'):
                            url = 'http://localhost:11235/mcp'
                        try:
                            req = urllib.request.Request(url, method='HEAD')
                            urllib.request.urlopen(req, timeout=2)
                            status = 'reachable'
                        except:
                            status = 'unreachable (server may need to be started)'
                    elif 'command' in entry:
                        cmd = entry['command']
                        transport = f'stdio/{cmd}'
                        try:
                            subprocess.run(['which', cmd], capture_output=True, timeout=2, check=True)
                            status = f'{cmd} available'
                        except:
                            status = f'{cmd} not found'
                    mcp_lines.append(f'  - {name} ({transport}): {status}')
                if mcp_lines:
                    msg += '\n\nMCP Servers Configured:\n' + '\n'.join(mcp_lines)
                    msg += '\nIf crawl4ai is unreachable, start it with: docker run -p 11235:11235 unclecode/crawl4ai'
        except:
            pass

    msg += '\n\nREMINDER: If open plans exist, execute them first. Read skills + instructions before any implementation. One checkmark per edit.'
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': msg}}))
" 2>/dev/null || echo '{"continue":true}'
else
    echo '{"continue":true}'
fi

exit 0
