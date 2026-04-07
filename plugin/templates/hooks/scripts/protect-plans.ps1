# PreToolUse Hook: Protect plan Final-Tasklist from content changes
# Allows checkmark changes but blocks structural edits to FINAL section
# Detects both English and German plan files

$ErrorActionPreference = "SilentlyContinue"

# Read hook input from stdin
$inputText = [Console]::In.ReadToEnd()

$decision = "allow"
$reason = ""

try {
    $hookInput = $inputText | ConvertFrom-Json

    # Extract tool name and input
    $toolName = ""
    $filePath = ""
    $oldString = ""
    $newString = ""

    if ($hookInput.PSObject.Properties["toolName"]) {
        $toolName = $hookInput.toolName
    }
    if ($hookInput.PSObject.Properties["tool_name"]) {
        $toolName = $hookInput.tool_name
    }
    if ($hookInput.PSObject.Properties["toolInput"]) {
        $ti = $hookInput.toolInput
        if ($ti.PSObject.Properties["filePath"]) { $filePath = $ti.filePath }
        if ($ti.PSObject.Properties["file_path"]) { $filePath = $ti.file_path }
        if ($ti.PSObject.Properties["oldString"]) { $oldString = $ti.oldString }
        if ($ti.PSObject.Properties["old_string"]) { $oldString = $ti.old_string }
        if ($ti.PSObject.Properties["newString"]) { $newString = $ti.newString }
        if ($ti.PSObject.Properties["new_string"]) { $newString = $ti.new_string }
    }
    if ($hookInput.PSObject.Properties["input"]) {
        $ti = $hookInput.input
        if ($ti.PSObject.Properties["filePath"]) { $filePath = $ti.filePath }
        if ($ti.PSObject.Properties["file_path"]) { $filePath = $ti.file_path }
        if ($ti.PSObject.Properties["oldString"]) { $oldString = $ti.oldString }
        if ($ti.PSObject.Properties["old_string"]) { $oldString = $ti.old_string }
        if ($ti.PSObject.Properties["newString"]) { $newString = $ti.newString }
        if ($ti.PSObject.Properties["new_string"]) { $newString = $ti.new_string }
    }
    if ($hookInput.PSObject.Properties["tool_input"]) {
        $ti = $hookInput.tool_input
        if ($ti.PSObject.Properties["filePath"]) { $filePath = $ti.filePath }
        if ($ti.PSObject.Properties["file_path"]) { $filePath = $ti.file_path }
        if ($ti.PSObject.Properties["oldString"]) { $oldString = $ti.oldString }
        if ($ti.PSObject.Properties["old_string"]) { $oldString = $ti.old_string }
        if ($ti.PSObject.Properties["newString"]) { $newString = $ti.newString }
        if ($ti.PSObject.Properties["new_string"]) { $newString = $ti.new_string }
    }

    # Only check edit-type tools
    $isEditTool = $toolName -match "edit|replace|write|str_replace"

    if ($isEditTool -and $filePath -and (Test-Path $filePath)) {
        $fileContent = Get-Content $filePath -Raw

        # Detect plan file: must contain ## FINAL + ### TaskList combo (language-independent)
        $hasFinalSection = $fileContent -match "## FINAL" -and $fileContent -match "### TaskList"
        # Also detect by known plan markers (German and English)
        $hasGermanMarker = $fileContent -match "Gesamte Implementation dieses Plans"
        $hasEnglishMarker = $fileContent -match "Full implementation of this plan verified"

        $isPlanFile = $hasFinalSection -or $hasGermanMarker -or $hasEnglishMarker

        if ($isPlanFile -and $oldString) {
            # Check if edit touches the FINAL section
            $touchesFinal = $oldString -match "## FINAL" -or
                            $oldString -match "Gesamte Implementation dieses Plans" -or
                            $oldString -match "Full implementation of this plan verified" -or
                            $oldString -match "version\.py ausge" -or
                            $oldString -match "version\.py executed" -or
                            $oldString -match "Code Docs und Usage Docs" -or
                            $oldString -match "Code Docs and Usage Docs"

            if ($touchesFinal) {
                # Validate: only checkmark changes are allowed in the FINAL section
                # Strip all checkbox markers and compare — if anything else changed, block
                $oldStripped = $oldString -replace "\[[ x]\]", "[_]"
                $newStripped = $newString -replace "\[[ x]\]", "[_]"

                if ($oldStripped -ne $newStripped) {
                    # Structural change detected in FINAL section
                    $decision = "deny"
                    $reason = "WARNING: Edit affects the Final-Tasklist of a plan. Its content MUST NOT be changed structurally. Only checkmarks ([ ] to [x]) may be set. | WARNUNG: Edit betrifft die Final-Tasklist eines Plans. Nur Checkmarks duerfen gesetzt werden."
                } else {
                    # Only checkmark change — allow but warn
                    $decision = "allow"
                }
            }
        }
    }
} catch {
    # On any error, allow the operation (don't block on hook failure)
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
