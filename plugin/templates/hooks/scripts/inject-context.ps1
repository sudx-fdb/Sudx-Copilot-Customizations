# SessionStart Hook: Inject permanent AI context from .ai_workfolder/context_files/
# Reads all context files and returns them as systemMessage

$ErrorActionPreference = "SilentlyContinue"

# Consume stdin (required by hook contract)
$null = [Console]::In.ReadToEnd()

$root = Split-Path (Split-Path (Split-Path $PSScriptRoot))
$contextDir = Join-Path (Join-Path $root ".ai_workfolder") "context_files"

if (-not (Test-Path $contextDir)) {
    $out = @{ continue = $true } | ConvertTo-Json -Compress
    Write-Output $out
    exit 0
}

$files = Get-ChildItem -Path $contextDir -File
if ($null -eq $files -or $files.Count -eq 0) {
    $out = @{ continue = $true } | ConvertTo-Json -Compress
    Write-Output $out
    exit 0
}

$parts = New-Object System.Collections.ArrayList
foreach ($f in $files) {
    $content = Get-Content $f.FullName -Raw
    if ($content) {
        $null = $parts.Add("=== $($f.Name) ===`n$content")
    }
}

if ($parts.Count -eq 0) {
    $out = @{ continue = $true } | ConvertTo-Json -Compress
    Write-Output $out
    exit 0
}

$message = "Permanent project context from .ai_workfolder/context_files/:`n`n" + ($parts -join "`n`n")
$message += "`n`nREMINDER: If open plans exist, execute them first. Read skills + instructions before any implementation. One checkmark per edit."
$out = @{ systemMessage = $message } | ConvertTo-Json -Compress
Write-Output $out
exit 0
