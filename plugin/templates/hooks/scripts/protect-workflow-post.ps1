# PostToolUse Hook: Inject execution rules reminder when AI reads a plan file
# Also warns when reading non-plan files while open plans exist
# Fires after read_file

$ErrorActionPreference = "SilentlyContinue"

# Helper: Find open plan files in workspace
function Find-OpenPlans {
    param([string]$Root)

    $plans = @()
    $scanDirs = @(
        (Join-Path $Root ".ai_workfolder"),
        (Join-Path $Root "plans"),
        (Join-Path (Join-Path $Root ".2.ai_workspace") "plans")
    )

    foreach ($dir in $scanDirs) {
        if (-not (Test-Path $dir)) { continue }
        $mdFiles = Get-ChildItem -Path $dir -Filter "*.md" -Recurse -File
        foreach ($f in $mdFiles) {
            $c = Get-Content $f.FullName -Raw
            if ($null -eq $c) { continue }
            if ($c -match "## FINAL" -and $c -match "\- \[ \]") {
                $plans += @{ Path = $f.FullName; Content = $c }
            }
        }
    }
    return $plans
}

# Helper: Extract first open task from plan content
function Get-CurrentTask {
    param([string]$Content)

    $match = [regex]::Match($Content, "- \[ \] (.+)")
    if ($match.Success) {
        return $match.Groups[1].Value
    }
    return $null
}

try {
    $inputText = ""
    try { $inputText = [Console]::In.ReadToEnd() } catch { }
    if (-not $inputText -or $inputText.Trim().Length -eq 0) {
        Write-Output '{"continue":true}'
        exit 0
    }

    $hookInput = $null
    try { $hookInput = $inputText | ConvertFrom-Json } catch { }
    if (-not $hookInput) {
        Write-Output '{"continue":true}'
        exit 0
    }

    # Extract tool name
    $toolName = ""
    if ($hookInput.PSObject.Properties["tool_name"]) { $toolName = $hookInput.tool_name }

    # Only act on read_file
    if ($toolName -ne "read_file") {
        Write-Output '{"continue":true}'
        exit 0
    }

    # Get file path
    $filePath = ""
    if ($hookInput.PSObject.Properties["tool_input"]) {
        $ti = $hookInput.tool_input
        if ($ti -and $ti.PSObject.Properties["filePath"]) { $filePath = $ti.filePath }
    }

    if (-not $filePath -or -not (Test-Path $filePath)) {
        Write-Output '{"continue":true}'
        exit 0
    }

    # Check if the read file is itself a plan file
    $content = Get-Content $filePath -Raw
    $isPlan = ($content -match "## FINAL") -and ($content -match "\- \[[ x]\]")

    if ($isPlan) {
        # Plan file read — inject full execution rules + current task hint
        $currentTask = Get-CurrentTask -Content $content
        $taskHint = ""
        if ($currentTask) {
            $taskHint = "`n`nYOUR CURRENT TASK: $currentTask"
        }

        $msg = "PLAN FILE DETECTED - EXECUTION RULES NOW ACTIVE!$taskHint`n`n"
        $msg += "=== YOU MUST (MANDATORY) ===`n"
        $msg += "1. Process tasks ONE AT A TIME - complete one, check it off, then next`n"
        $msg += "2. Set EXACTLY ONE checkmark per edit: - [ ] to - [x]`n"
        $msg += "3. Work through the plan from start to finish WITHOUT interruption`n"
        $msg += "4. Automatically proceed to the next task after each completion`n"
        $msg += "5. Only report to the user AFTER the entire plan (including FINAL) is complete`n"
        $msg += "6. Mark the file index entry AFTER all tasks in that category are done`n"
        $msg += "`n=== YOU MUST NEVER (FORBIDDEN - ENFORCED BY HOOK) ===`n"
        $msg += "1. Check off multiple items in a single edit (WILL BE REJECTED BY HOOK)`n"
        $msg += "2. Use multi_replace to batch-mark checkboxes (WILL BE REJECTED BY HOOK)`n"
        $msg += "3. Pause mid-plan and ask 'Should I continue?'`n"
        $msg += "4. Give status updates and wait for user confirmation`n"
        $msg += "5. Interrupt a plan - either complete it fully or don't start`n"
        $msg += "6. Stop working before all categories + FINAL are done`n"
        $msg += "7. Set checkmarks before the task is actually completed`n"
        $msg += "`nA plan is an assignment. Execute it. Completely. Without asking.`n"
        $msg += "The protect-workflow hook WILL REJECT any edit that checks off more than 1 item at once."

        $out = @{ systemMessage = $msg } | ConvertTo-Json -Compress
        Write-Output $out
    } else {
        # Non-plan file read — check if open plans exist and warn
        $root = Split-Path (Split-Path (Split-Path $PSScriptRoot))
        $openPlans = Find-OpenPlans -Root $root

        if ($openPlans.Count -gt 0) {
            $plan = $openPlans[0]
            $relPath = $plan.Path.Substring($root.Length + 1) -replace "\\", "/"
            $currentTask = Get-CurrentTask -Content $plan.Content

            $msg = "WARNING: You are reading a non-plan file while an open plan exists ($relPath). Return to plan execution immediately unless this read is required for a plan task."
            if ($currentTask) {
                $msg += "`nYour current task is: $currentTask"
            }

            $out = @{ systemMessage = $msg } | ConvertTo-Json -Compress
            Write-Output $out
        } else {
            Write-Output '{"continue":true}'
        }
    }
} catch {
    Write-Output '{"continue":true}'
}
exit 0
