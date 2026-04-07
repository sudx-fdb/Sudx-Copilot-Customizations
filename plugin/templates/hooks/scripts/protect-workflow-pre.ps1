# PreToolUse Hook: Enforce single-checkmark-per-edit rule for plan files
# If an edit changes more than 1 checkbox from [ ] to [x] in a plan file, REJECT.
# Also detects task deletion (removing unchecked items) as a skip attempt.
# This is a hard enforcement of execute_plan.instructions.md rules.

$ErrorActionPreference = "SilentlyContinue"

$inputText = [Console]::In.ReadToEnd()

$decision = "allow"
$reason = ""

# Helper: Determine if a file is a plan file (content-based + path-based)
function Test-PlanFile {
    param([string]$FilePath)

    if (-not $FilePath) { return $false }

    # Path-based detection: .md files in plan-related directories
    $normPath = $FilePath -replace "\\", "/"
    $pathLikePlan = ($normPath -match "plans/" -or $normPath -match "\.ai_workfolder/") -and ($normPath -match "\.md$")

    # Content-based detection (primary, more reliable)
    if (Test-Path $FilePath) {
        $content = Get-Content $FilePath -Raw
        if ($content -match "## FINAL" -and $content -match "\- \[[ x]\]") {
            return $true
        }
    }

    # If content read failed but path looks like a plan, assume plan file
    if ($pathLikePlan) { return $true }

    return $false
}

# Helper: Read and increment violation counter
function Get-ViolationCount {
    $counterFile = Join-Path $env:TEMP "sudx-workflow-violations.txt"
    $count = 0
    if (Test-Path $counterFile) {
        $val = Get-Content $counterFile -Raw
        if ($val -match "^\d+$") { $count = [int]$val }
    }
    $count++
    Set-Content -Path $counterFile -Value $count -NoNewline
    return $count
}

try {
    $hookInput = $inputText | ConvertFrom-Json

    # Extract tool name
    $toolName = ""
    if ($hookInput.PSObject.Properties["tool_name"]) { $toolName = $hookInput.tool_name }
    if ($hookInput.PSObject.Properties["toolName"]) { $toolName = $hookInput.toolName }

    # Only check edit tools
    $isEditTool = $toolName -match "replace_string|multi_replace|edit_file"

    if ($isEditTool) {
        # Get tool input from possible field names
        $toolInput = $null
        if ($hookInput.PSObject.Properties["tool_input"]) { $toolInput = $hookInput.tool_input }
        if (-not $toolInput -and $hookInput.PSObject.Properties["toolInput"]) { $toolInput = $hookInput.toolInput }
        if (-not $toolInput -and $hookInput.PSObject.Properties["input"]) { $toolInput = $hookInput.input }

        if ($toolInput) {
            # Collect all old/new string pairs and file paths
            $pairs = @()

            # Single replacement (replace_string_in_file)
            if ($toolInput.PSObject.Properties["oldString"] -and $toolInput.PSObject.Properties["newString"]) {
                $fp = ""
                if ($toolInput.PSObject.Properties["filePath"]) { $fp = $toolInput.filePath }
                $pairs += @{ old = $toolInput.oldString; new = $toolInput.newString; path = $fp }
            }

            # Multi replacement (multi_replace_string_in_file) — sum across ALL replacements
            if ($toolInput.PSObject.Properties["replacements"]) {
                $repls = @($toolInput.replacements)
                foreach ($r in $repls) {
                    $fp = ""
                    if ($r.PSObject.Properties["filePath"]) { $fp = $r.filePath }
                    if ($r.PSObject.Properties["oldString"] -and $r.PSObject.Properties["newString"]) {
                        $pairs += @{ old = $r.oldString; new = $r.newString; path = $fp }
                    }
                }
            }

            # Aggregate checkbox changes across ALL pairs targeting plan files
            $totalNewChecks = 0
            $totalTasksRemoved = 0

            foreach ($pair in $pairs) {
                $filePath = $pair.path

                if (-not (Test-PlanFile -FilePath $filePath)) { continue }

                # Count checked/unchecked in old vs new
                $oldChecked = ([regex]::Matches($pair.old, "\- \[x\]")).Count
                $newChecked = ([regex]::Matches($pair.new, "\- \[x\]")).Count
                $oldUnchecked = ([regex]::Matches($pair.old, "\- \[ \]")).Count
                $newUnchecked = ([regex]::Matches($pair.new, "\- \[ \]")).Count

                # New checkmarks added
                $checksAdded = $newChecked - $oldChecked
                if ($checksAdded -gt 0) { $totalNewChecks += $checksAdded }

                # Tasks removed: unchecked items disappeared without becoming checked
                $uncheckedLost = $oldUnchecked - $newUnchecked
                if ($uncheckedLost -gt 0) {
                    $accountedByChecks = if ($checksAdded -gt 0) { $checksAdded } else { 0 }
                    $unaccounted = $uncheckedLost - $accountedByChecks
                    if ($unaccounted -gt 0) { $totalTasksRemoved += $unaccounted }
                }
            }

            # REJECT: Batch checkmark edits (>1 checkbox changed in single edit)
            if ($totalNewChecks -gt 1) {
                $violationNum = Get-ViolationCount
                $decision = "deny"
                $reason = "VIOLATION #$violationNum of execute_plan.instructions.md!`n"
                $reason += "You attempted to check off $totalNewChecks checkmarks in a SINGLE edit. This is STRICTLY FORBIDDEN.`n`n"
                $reason += "RULES YOU MUST FOLLOW:`n"
                $reason += "1. Complete ONE task`n"
                $reason += "2. Set exactly ONE [x] in the planfile`n"
                $reason += "3. Then proceed to the next task`n`n"
                $reason += "RULES YOU VIOLATED:`n"
                $reason += "- NEVER batch-check multiple items in one edit`n"
                $reason += "- NEVER use multi_replace to mark multiple checkmarks at once`n"
                $reason += "- NEVER group completions`n`n"
                $reason += "Go back and make $totalNewChecks SEPARATE edits, each changing exactly ONE checkbox from [ ] to [x].`n`n"
                $reason += "--- DEUTSCH ---`n"
                $reason += "VERSTOSS #$violationNum gegen execute_plan.instructions.md!`n"
                $reason += "Du hast versucht $totalNewChecks Checkmarks in EINEM Edit zu setzen. Das ist STRENG VERBOTEN.`n"
                $reason += "Mache $totalNewChecks EINZELNE Edits, jeder aendert genau EINE Checkbox von [ ] zu [x]."
            }

            # REJECT: Task deletion (removing unchecked items = skipping tasks)
            if ($decision -eq "allow" -and $totalTasksRemoved -gt 0) {
                $violationNum = Get-ViolationCount
                $decision = "deny"
                $reason = "VIOLATION #$violationNum of execute_plan.instructions.md!`n"
                $reason += "You attempted to REMOVE $totalTasksRemoved unchecked task(s) from a plan file. This is STRICTLY FORBIDDEN.`n`n"
                $reason += "Plan tasks MUST NOT be deleted or skipped. Every task must be completed and checked off individually.`n`n"
                $reason += "--- DEUTSCH ---`n"
                $reason += "VERSTOSS #$violationNum gegen execute_plan.instructions.md!`n"
                $reason += "Du hast versucht $totalTasksRemoved unerledigte Aufgabe(n) aus dem Plan zu entfernen. Das ist STRENG VERBOTEN."
            }
        }
    }
} catch {
    # On any error, allow (don't block on hook failure)
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
