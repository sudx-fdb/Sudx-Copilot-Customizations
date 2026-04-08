# PreToolUse Hook: Playwright MCP Tool Guard
# Enforces best practices for Playwright browser automation:
# - Warns when browser_navigate targets non-HTTPS URLs
# - Warns when browser_click is called without a preceding browser_snapshot
# - Warns when browser_take_screenshot is called (vision cap may not be set)

$ErrorActionPreference = "SilentlyContinue"

$inputText = [Console]::In.ReadToEnd()

$decision = "allow"
$reason = ""

try {
    $hookInput = $inputText | ConvertFrom-Json

    $toolName = ""
    if ($hookInput.PSObject.Properties["toolName"]) { $toolName = $hookInput.toolName }
    if ($hookInput.PSObject.Properties["tool_name"]) { $toolName = $hookInput.tool_name }

    # Only intercept Playwright/browser tools
    $isBrowserTool = $toolName -match "^browser_"

    if ($isBrowserTool) {
        $ti = $null
        if ($hookInput.PSObject.Properties["toolInput"]) { $ti = $hookInput.toolInput }
        if ($hookInput.PSObject.Properties["tool_input"]) { $ti = $hookInput.tool_input }
        if ($hookInput.PSObject.Properties["input"]) { $ti = $hookInput.input }

        # Guard: browser_navigate to non-HTTPS URL
        if ($toolName -eq "browser_navigate") {
            $url = ""
            if ($ti -and $ti.PSObject.Properties["url"]) { $url = $ti.url }

            if ($url -and $url -notmatch "^https://") {
                $decision = "allow"
                $reason = "WARNING: browser_navigate targeting non-HTTPS URL: $url. Non-HTTPS connections are insecure and may expose data. Ensure this is intentional (e.g., localhost development)."
            }
        }

        # Guard: browser_click without snapshot reminder
        if ($toolName -eq "browser_click") {
            $decision = "allow"
            $reason = "REMINDER: Ensure you called browser_snapshot before browser_click to get current accessibility refs. Element refs may become stale after navigation or page changes."
        }

        # Guard: browser_take_screenshot — vision cap warning
        if ($toolName -eq "browser_take_screenshot") {
            $decision = "allow"
            $reason = "WARNING: browser_take_screenshot requires --caps=vision to be set when starting the MCP server. Without vision capability, screenshots cannot be interpreted. Prefer browser_snapshot (accessibility tree) for element inspection."
        }

        # Guard: browser_tab_new — warn when 5+ tabs already open
        if ($toolName -eq "browser_tab_new") {
            $decision = "allow"
            $reason = "REMINDER: Limit concurrent tabs to 5. Each open tab consumes memory and CPU. Close finished tabs with browser_tab_close before opening new ones. Use browser_tab_list to audit open tabs."
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
