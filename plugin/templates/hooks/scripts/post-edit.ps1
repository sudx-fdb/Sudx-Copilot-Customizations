# PostToolUse Hook: Auto-format after edits + .ai_workfolder content.md reminder
# Only acts on file-editing tools, silently passes through for everything else.
# MUST always exit 0 — any other exit code causes VS Code to show a warning.

$ErrorActionPreference = "SilentlyContinue"

# Known file-editing tool names in VS Code
$editTools = @("create_file", "replace_string_in_file", "multi_replace_string_in_file", "edit_notebook_file")

try {
    # Read stdin safely — can fail in PS5.1 if stdin is not connected
    $inputText = ""
    try { $inputText = [Console]::In.ReadToEnd() } catch { }
    if (-not $inputText -or $inputText.Trim().Length -eq 0) {
        Write-Output '{"continue":true}'
        exit 0
    }

    # Parse JSON safely
    $hookInput = $null
    try { $hookInput = $inputText | ConvertFrom-Json } catch { }
    if (-not $hookInput) {
        Write-Output '{"continue":true}'
        exit 0
    }

    # Extract tool name (VS Code uses tool_name)
    $toolName = ""
    if ($hookInput.PSObject.Properties["tool_name"]) { $toolName = $hookInput.tool_name }

    # Quick exit for non-edit tools
    if ($editTools -notcontains $toolName) {
        Write-Output '{"continue":true}'
        exit 0
    }

    # Extract file path from tool_input (VS Code uses camelCase)
    $filePath = ""
    if ($hookInput.PSObject.Properties["tool_input"]) {
        $ti = $hookInput.tool_input
        if ($ti -and $ti.PSObject.Properties["filePath"]) { $filePath = $ti.filePath }
    }
    if (-not $filePath -or -not (Test-Path $filePath)) {
        Write-Output '{"continue":true}'
        exit 0
    }

    $messages = @()

    # Check: .ai_workfolder content.md reminder
    $normalPath = $filePath -replace "\\", "/"
    if ($normalPath -match "\.ai_workfolder/" -and $normalPath -notmatch "content\.md") {
        $messages += "REMINDER: Update .ai_workfolder/content.md"
    }

    # Check: .vscode/mcp.json manual edit warning
    if ($normalPath -match "\.vscode/mcp\.json$") {
        $messages += "WARNING: MCP config (.vscode/mcp.json) was manually edited. Run Sudx CC deploy to restore managed servers if needed."
    }

    # Auto-format if formatter available
    $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
    $root = Split-Path (Split-Path (Split-Path $PSScriptRoot))

    $prettierExts = @(".js",".ts",".jsx",".tsx",".css",".scss",".html",".json",".md",".yaml",".yml")
    if ($prettierExts -contains $ext) {
        if ((Test-Path (Join-Path $root ".prettierrc")) -or (Test-Path (Join-Path $root ".prettierrc.json"))) {
            $npx = Get-Command npx -ErrorAction SilentlyContinue
            if ($npx) { & npx prettier --write $filePath 2>$null | Out-Null }
        }
    }

    if ($ext -eq ".py") {
        $black = Get-Command black -ErrorAction SilentlyContinue
        if ($black) { & black --quiet $filePath 2>$null | Out-Null }
    }

    if ($messages.Count -gt 0) {
        $msg = $messages -join "`n"
        Write-Output (@{ hookSpecificOutput = @{ hookEventName = "PostToolUse"; additionalContext = $msg } } | ConvertTo-Json -Compress -Depth 3)
    } else {
        Write-Output '{"continue":true}'
    }
} catch {
    Write-Output '{"continue":true}'
}
exit 0
