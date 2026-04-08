# PreToolUse Hook: Crawl4ai MCP Tool Guard
# Enforces safety guardrails for web crawling:
# - Warns when crawl depth > 3 (excessive crawling)
# - Blocks crawling of internal/private IPs (SSRF prevention)
# - Warns when crawl target is not HTTPS
# - Warns when max_pages is unset or > 50

$ErrorActionPreference = "SilentlyContinue"

$inputText = [Console]::In.ReadToEnd()

$decision = "allow"
$reason = ""

try {
    $hookInput = $inputText | ConvertFrom-Json

    $toolName = ""
    if ($hookInput.PSObject.Properties["toolName"]) { $toolName = $hookInput.toolName }
    if ($hookInput.PSObject.Properties["tool_name"]) { $toolName = $hookInput.tool_name }

    # Only intercept crawl4ai/crawl tools
    $isCrawlTool = $toolName -match "^(crawl4ai_|crawl_)"

    if ($isCrawlTool) {
        $ti = $null
        if ($hookInput.PSObject.Properties["toolInput"]) { $ti = $hookInput.toolInput }
        if ($hookInput.PSObject.Properties["tool_input"]) { $ti = $hookInput.tool_input }
        if ($hookInput.PSObject.Properties["input"]) { $ti = $hookInput.input }

        $url = ""
        if ($ti -and $ti.PSObject.Properties["url"]) { $url = $ti.url }

        # Guard: SSRF prevention — block internal/private IP addresses
        if ($url) {
            $isInternal = $false
            if ($url -match "localhost" -or $url -match "127\.0\.0\." -or $url -match "\[::1\]") {
                $isInternal = $true
            }
            if ($url -match "://10\." -or $url -match "://192\.168\.") {
                $isInternal = $true
            }
            if ($url -match "://172\.(1[6-9]|2[0-9]|3[01])\.") {
                $isInternal = $true
            }

            if ($isInternal) {
                $decision = "deny"
                $reason = "BLOCKED: Crawling internal/private IP addresses is not allowed (SSRF prevention). Target: $url. Only crawl public URLs."
            }
        }

        # Guard: Non-HTTPS warning (only if not already blocked)
        if ($decision -ne "deny" -and $url -and $url -notmatch "^https://") {
            $decision = "allow"
            $reason = "WARNING: Crawling non-HTTPS URL: $url. Non-HTTPS connections may expose data. Ensure this is intentional."
        }

        # Guard: Crawl depth > 3
        if ($decision -ne "deny" -and $ti -and $ti.PSObject.Properties["depth"]) {
            $depth = $ti.depth
            if ($depth -gt 3) {
                $decision = "allow"
                $reason = "WARNING: Crawl depth is $depth (> 3). Deep crawls can take a very long time and generate large amounts of data. Consider reducing depth or using max_pages to limit scope."
            }
        }

        # Guard: max_pages unset or > 50
        if ($decision -ne "deny" -and $ti) {
            $maxPages = $null
            if ($ti.PSObject.Properties["max_pages"]) { $maxPages = $ti.max_pages }
            if ($null -eq $maxPages -or $maxPages -gt 50) {
                $pagesVal = if ($null -eq $maxPages) { "unset (unlimited)" } else { $maxPages }
                if (-not $reason) {
                    $decision = "allow"
                    $reason = "WARNING: max_pages is $pagesVal. Large crawl operations can be resource-intensive. Consider setting max_pages to a reasonable limit (e.g., 10-50)."
                }
            }
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
