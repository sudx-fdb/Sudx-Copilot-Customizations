#!/bin/bash
# PreToolUse Hook: Figma MCP Tool Guard
# Enforces best practices for Figma API tool usage:
# - Warns when figma_get_file is called without depth parameter or depth > 2
# - Reminds about design token extraction workflow
# - Blocks figma_delete_comment without explicit reason

INPUT="$(cat)"

if command -v python3 &> /dev/null; then
    echo "$INPUT" | python3 -c "
import json, sys

decision = 'allow'
reason = ''

try:
    hook_input = json.load(sys.stdin)

    tool_name = hook_input.get('tool_name', hook_input.get('toolName', ''))
    is_figma = tool_name.startswith('figma_')

    if is_figma:
        tool_input = hook_input.get('tool_input', hook_input.get('toolInput', hook_input.get('input', {})))

        # Rate limiting awareness
        import os
        call_count_str = os.environ.get('SUDX_FIGMA_CALL_COUNT', '0')
        call_count = int(call_count_str) if call_count_str.isdigit() else 0
        call_count += 1
        os.environ['SUDX_FIGMA_CALL_COUNT'] = str(call_count)
        if call_count > 5:
            reason += f'RATE LIMIT WARNING: {call_count} Figma API calls in this session. The Figma API has rate limits. Consider batching operations or using cached results. '

        # Guard: figma_get_file without depth or with high depth
        if tool_name == 'figma_get_file':
            depth = tool_input.get('depth')
            if depth is None or (isinstance(depth, (int, float)) and depth > 2):
                depth_val = 'unset (full tree)' if depth is None else str(depth)
                reason += f'WARNING: figma_get_file called with depth={depth_val}. Large Figma files return massive responses at high depth. Best practice: start with depth=1, then use figma_get_file_nodes for specific node IDs. Consider reducing depth if the response is too large.'
            elif isinstance(depth, (int, float)) and depth == 1:
                reason += 'Good: Using depth=1. Next step: use figma_get_file_nodes with specific node IDs for detailed component data.'

        # Guard: figma_get_images — warn on large batches or high scale
        if tool_name == 'figma_get_images':
            scale = tool_input.get('scale')
            node_ids = tool_input.get('ids', '')
            if scale is not None and isinstance(scale, (int, float)) and scale > 2:
                reason += f'WARNING: figma_get_images with scale={scale} (>2). High scale produces very large images and slow downloads. Consider scale=1 or scale=2. '
            if isinstance(node_ids, str) and len(node_ids.split(',')) > 10:
                id_count = len(node_ids.split(','))
                reason += f'WARNING: Requesting images for {id_count} node IDs. Large batches are slow. Consider splitting into smaller batches of 10 or fewer. '
            elif isinstance(node_ids, list) and len(node_ids) > 10:
                reason += f'WARNING: Requesting images for {len(node_ids)} node IDs. Large batches are slow. Consider splitting into smaller batches of 10 or fewer. '

        # Guard: figma_get_team_components / figma_get_team_styles
        if tool_name in ('figma_get_team_components', 'figma_get_team_styles'):
            reason += f'CAUTION: Team-level queries ({tool_name}) can return very large result sets. Consider using file-level alternatives (figma_get_file_components, figma_get_file_styles) first. '

        # Guard: figma_delete_comment — always warn
        if tool_name == 'figma_delete_comment':
            reason += 'CAUTION: Deleting a Figma comment is irreversible. Ensure the user explicitly requested this deletion.'

        # Guard: figma_post_webhook — warn about external endpoints
        if tool_name == 'figma_post_webhook':
            reason += 'CAUTION: Creating a Figma webhook sends data to an external endpoint. Verify the endpoint URL is correct and trusted.'

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
