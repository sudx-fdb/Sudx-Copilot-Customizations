# SessionStart Hook: Inject permanent AI context from .ai_workfolder/context_files/
# Reads all context files and returns them as hookSpecificOutput.additionalContext

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

# ── MCP Server Status Injection ──
try {
    $mcpPath = Join-Path (Join-Path $root ".vscode") "mcp.json"
    if (Test-Path $mcpPath) {
        $mcpContent = Get-Content $mcpPath -Raw
        $mcpConfig = $mcpContent | ConvertFrom-Json
        $servers = $mcpConfig.mcpServers
        if ($servers) {
            $mcpLines = New-Object System.Collections.ArrayList
            foreach ($prop in $servers.PSObject.Properties) {
                $name = $prop.Name
                $entry = $prop.Value
                $transport = "unknown"
                $status = "configured"
                if ($entry.PSObject.Properties["url"]) {
                    $transport = "SSE"
                    # Quick reachability check for SSE servers (2s timeout)
                    try {
                        $uri = $entry.url -replace '\$\{input:[^}]+\}', 'http://localhost:11235/mcp'
                        $req = [System.Net.HttpWebRequest]::Create($uri)
                        $req.Method = "HEAD"
                        $req.Timeout = 2000
                        $resp = $req.GetResponse()
                        $resp.Close()
                        $status = "reachable"
                    } catch {
                        $status = "unreachable (server may need to be started)"
                    }
                } elseif ($entry.PSObject.Properties["command"]) {
                    $cmd = $entry.command
                    $transport = "stdio/$cmd"
                    # Check if command is available
                    $cmdCheck = Get-Command $cmd -ErrorAction SilentlyContinue
                    if ($cmdCheck) {
                        $status = "$cmd available"
                    } else {
                        $status = "$cmd not found"
                    }
                }
                $null = $mcpLines.Add("  - $name ($transport): $status")
            }
            if ($mcpLines.Count -gt 0) {
                $message += "`n`nMCP Servers Configured:`n" + ($mcpLines -join "`n")
                $message += "`nIf crawl4ai is unreachable, start it with: docker run -p 11235:11235 unclecode/crawl4ai"
            }
        }
    }
} catch {
    # MCP check must not block session start — silently continue
}

$message += "`n`nREMINDER: If open plans exist, execute them first. Read skills + instructions before any implementation. One checkmark per edit."
$out = @{ hookSpecificOutput = @{ hookEventName = "SessionStart"; additionalContext = $message } } | ConvertTo-Json -Compress -Depth 3
Write-Output $out
exit 0
