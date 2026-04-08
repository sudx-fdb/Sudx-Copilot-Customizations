# UserPromptSubmit Hook: Remind about open plan files with unchecked tasks
# Scans for .md files that look like plan files and reports open checkmarks

$ErrorActionPreference = "SilentlyContinue"

# Consume stdin
$null = [Console]::In.ReadToEnd()

$root = Split-Path (Split-Path (Split-Path $PSScriptRoot))

# Common plan file locations to scan
$scanDirs = @(
    (Join-Path $root ".ai_workfolder"),
    (Join-Path $root "plans"),
    (Join-Path (Join-Path $root ".2.ai_workspace") "plans")
)

$openPlans = New-Object System.Collections.ArrayList

foreach ($dir in $scanDirs) {
    if (-not (Test-Path $dir)) { continue }

    $mdFiles = Get-ChildItem -Path $dir -Filter "*.md" -Recurse -File
    foreach ($f in $mdFiles) {
        $content = Get-Content $f.FullName -Raw
        if ($null -eq $content) { continue }

        # Detect plan files: must contain FINAL section and checkmark pattern
        $hasFinal = $content -match "## FINAL"
        $hasCheckmarks = $content -match "\- \[ \]"

        if ($hasFinal -and $hasCheckmarks) {
            # Count open checkmarks
            $openCount = ([regex]::Matches($content, "\- \[ \]")).Count
            $doneCount = ([regex]::Matches($content, "\- \[x\]")).Count
            $total = $openCount + $doneCount
            $percent = if ($total -gt 0) { [int](($doneCount / $total) * 100) } else { 0 }

            # Get relative path
            $relPath = $f.FullName.Substring($root.Length + 1) -replace "\\", "/"

            # Check time since last modification (proxy for last checkmark)
            $lastMod = $f.LastWriteTime
            $minutesAgo = [int]((Get-Date) - $lastMod).TotalMinutes
            $staleness = ""
            if ($doneCount -gt 0 -and $minutesAgo -gt 5) {
                $staleness = "  |  STALE: no edit for ${minutesAgo}min!"
            }

            $null = $openPlans.Add("- $relPath  |  $doneCount of $total done ($percent%)  |  $openCount open$staleness")
        }
    }
}

if ($openPlans.Count -gt 0) {
    $planList = $openPlans -join "`n"
    $msg = "OPEN PLANS found! Complete these FULLY before starting new tasks:`n`n" + $planList

    # MCP status context
    $mcpConfigPath = Join-Path (Join-Path $root ".vscode") "mcp.json"
    if (Test-Path $mcpConfigPath) {
        try {
            $mcpContent = Get-Content $mcpConfigPath -Raw
            $mcpJson = $mcpContent | ConvertFrom-Json
            $mcpServerCount = 0
            if ($mcpJson.PSObject.Properties["mcpServers"]) {
                $mcpServerCount = ($mcpJson.mcpServers.PSObject.Properties | Measure-Object).Count
            }
            $msg += "`n`nMCP: $mcpServerCount servers configured in .vscode/mcp.json"
        } catch {
            $msg += "`n`nMCP: .vscode/mcp.json exists but could not be parsed"
        }
    }

    $msg += "`n`nBEFORE WORKING: Read .github/skills/{plan-type}/SKILL.md AND .github/instructions/execute_plan.instructions.md"
    $msg += "`n`nCRITICAL RULES FOR PLAN EXECUTION:`n"
    $msg += "`nYOU MUST:`n"
    $msg += "1. Work through the plan from start to finish WITHOUT INTERRUPTION`n"
    $msg += "2. Check off EVERY checkpoint IMMEDIATELY and individually once implemented`n"
    $msg += "3. AUTOMATICALLY proceed to the next task after each completion`n"
    $msg += "4. Only inform the user AFTER the entire plan (including FINAL) is complete`n"
    $msg += "`nYOU MUST NEVER:`n"
    $msg += "- Pause mid-plan and ask 'Should I continue?'`n"
    $msg += "- Give status updates and wait for user confirmation`n"
    $msg += "- Interrupt a plan - either complete it fully or don't start`n"
    $msg += "- Stop working before all categories + FINAL are done`n"
    $msg += "`nENFORCEMENT: The protect-workflow hook WILL REJECT any edit that checks off more than 1 item at once. You MUST make ONE edit per checkmark.`n"
    $msg += "`nA plan is an assignment. You execute it. Completely. Without asking."
    $out = @{ systemMessage = $msg } | ConvertTo-Json -Compress
    Write-Output $out
} else {
    $out = @{ continue = $true } | ConvertTo-Json -Compress
    Write-Output $out
}
exit 0
