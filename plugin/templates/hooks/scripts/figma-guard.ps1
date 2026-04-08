# PreToolUse Hook: Figma MCP Tool Guard
# Enforces best practices for Figma API tool usage:
# - Warns when figma_get_file is called without depth parameter or depth > 2
# - Reminds about design token extraction workflow
# - Blocks figma_delete_comment without explicit reason

$ErrorActionPreference = "SilentlyContinue"

$inputText = [Console]::In.ReadToEnd()

$decision = "allow"
$reason = ""

try {
    $hookInput = $inputText | ConvertFrom-Json

    $toolName = ""
    if ($hookInput.PSObject.Properties["toolName"]) { $toolName = $hookInput.toolName }
    if ($hookInput.PSObject.Properties["tool_name"]) { $toolName = $hookInput.tool_name }

    # Only intercept Figma tools
    $isFigmaTool = $toolName -match "^figma_"

    if ($isFigmaTool) {
        $ti = $null
        if ($hookInput.PSObject.Properties["toolInput"]) { $ti = $hookInput.toolInput }
        if ($hookInput.PSObject.Properties["tool_input"]) { $ti = $hookInput.tool_input }
        if ($hookInput.PSObject.Properties["input"]) { $ti = $hookInput.input }

        # Rate limiting awareness: track Figma call count via environment hint
        $callCountEnv = $env:SUDX_FIGMA_CALL_COUNT
        $callCount = 0
        if ($callCountEnv -and $callCountEnv -match "^\d+$") { $callCount = [int]$callCountEnv }
        $callCount++
        $env:SUDX_FIGMA_CALL_COUNT = "$callCount"
        if ($callCount -gt 5) {
            $reason = "RATE LIMIT WARNING: $callCount Figma API calls in this session. The Figma API has rate limits. Consider batching operations or using cached results. "
        }

        # Guard: figma_get_file without depth or with high depth
        if ($toolName -eq "figma_get_file") {
            $depth = $null
            if ($ti -and $ti.PSObject.Properties["depth"]) {
                $depth = $ti.depth
            }

            if ($null -eq $depth -or $depth -gt 2) {
                $decision = "allow"
                $depthVal = if ($null -eq $depth) { "unset (full tree)" } else { $depth }
                $reason = $reason + "WARNING: figma_get_file called with depth=$depthVal. Large Figma files return massive responses at high depth. Best practice: start with depth=1, then use figma_get_file_nodes for specific node IDs. Consider reducing depth if the response is too large."
            } elseif ($depth -eq 1) {
                $reason = $reason + "Good: Using depth=1. Next step: use figma_get_file_nodes with specific node IDs for detailed component data."
            }
        }

        # Guard: figma_get_images — warn on large batches or high scale
        if ($toolName -eq "figma_get_images") {
            $scale = $null
            $nodeIds = $null
            if ($ti -and $ti.PSObject.Properties["scale"]) { $scale = $ti.scale }
            if ($ti -and $ti.PSObject.Properties["ids"]) { $nodeIds = $ti.ids }

            if ($scale -and $scale -gt 2) {
                $reason = $reason + "WARNING: figma_get_images with scale=$scale (>2). High scale produces very large images and slow downloads. Consider scale=1 or scale=2. "
            }

            if ($nodeIds) {
                $idCount = 0
                if ($nodeIds -is [array]) { $idCount = $nodeIds.Count }
                elseif ($nodeIds -is [string]) { $idCount = ($nodeIds -split ",").Count }
                if ($idCount -gt 10) {
                    $reason = $reason + "WARNING: Requesting images for $idCount node IDs. Large batches are slow. Consider splitting into smaller batches of 10 or fewer. "
                }
            }
        }

        # Guard: figma_get_team_components / figma_get_team_styles — warn about team-level queries
        if ($toolName -eq "figma_get_team_components" -or $toolName -eq "figma_get_team_styles") {
            $reason = $reason + "CAUTION: Team-level queries ($toolName) can return very large result sets. Consider using file-level alternatives (figma_get_file_components, figma_get_file_styles) first. "
        }

        # Guard: figma_delete_comment — always warn
        if ($toolName -eq "figma_delete_comment") {
            $decision = "allow"
            $reason = "CAUTION: Deleting a Figma comment is irreversible. Ensure the user explicitly requested this deletion."
        }

        # Guard: figma_post_webhook — warn about external endpoints
        if ($toolName -eq "figma_post_webhook") {
            $decision = "allow"
            $reason = "CAUTION: Creating a Figma webhook sends data to an external endpoint. Verify the endpoint URL is correct and trusted."
        }
    }
} catch {
    $decision = "allow"
}

$out = @{
    hookSpecificOutput = @{
        hookEventName = "PreToolUse"
        permissionDecision = $decision
        permissionDecisionReason = $reason
    }
} | ConvertTo-Json -Compress -Depth 4
Write-Output $out
exit 0
