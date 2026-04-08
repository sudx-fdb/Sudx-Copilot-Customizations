# Shared Network Security Validation Functions for MCP Guard Hooks
# Sourced by: crawl4ai-guard.ps1, playwright-guard.ps1
# Mirrors logic from plugin/src/mcp/networkSecurity.ts

function Test-PrivateIp {
    param([string]$Hostname)
    if (-not $Hostname) { return $false }
    $h = $Hostname.Trim().ToLower()

    # Loopback
    if ($h -eq 'localhost' -or $h -eq '127.0.0.1' -or $h -eq '::1' -or $h -eq '[::1]') {
        return $true
    }

    # IPv6 private
    if ($h.StartsWith('fc') -or $h.StartsWith('fd') -or $h.StartsWith('fe80')) {
        return $true
    }

    # IPv4 ranges
    if ($h -match '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$') {
        $a = [int]$Matches[1]; $b = [int]$Matches[2]
        if ($a -eq 10) { return $true }
        if ($a -eq 172 -and $b -ge 16 -and $b -le 31) { return $true }
        if ($a -eq 192 -and $b -eq 168) { return $true }
        if ($a -eq 127) { return $true }
        if ($a -eq 169 -and $b -eq 254) { return $true }
        if ($a -eq 0 -and $b -eq 0 -and [int]$Matches[3] -eq 0 -and [int]$Matches[4] -eq 0) { return $true }
    }

    return $false
}

function Test-BlockedProtocol {
    param([string]$Url)
    if (-not $Url) { return $true }
    $lower = $Url.Trim().ToLower()
    $blocked = @('file:', 'data:', 'javascript:', 'vbscript:', 'ftp:')
    foreach ($proto in $blocked) {
        if ($lower.StartsWith($proto)) { return $true }
    }
    return $false
}

function Test-AllowedCrawlTarget {
    param([string]$Url, [bool]$AllowLocalhost = $false)
    if (-not $Url) { return @{ Allowed = $false; Reason = 'Empty URL' } }

    if (Test-BlockedProtocol -Url $Url) {
        return @{ Allowed = $false; Reason = "Blocked protocol in URL: $Url" }
    }

    # Extract hostname
    $hostname = ''
    if ($Url -match '://([^/:]+)') {
        $hostname = $Matches[1]
    }

    if ($hostname -and (Test-PrivateIp -Hostname $hostname)) {
        if ($AllowLocalhost -and ($hostname -eq 'localhost' -or $hostname -eq '127.0.0.1' -or $hostname -eq '::1')) {
            return @{ Allowed = $true; Reason = 'Localhost allowed by config' }
        }
        return @{ Allowed = $false; Reason = "Private/internal IP blocked: $hostname" }
    }

    return @{ Allowed = $true; Reason = '' }
}

function Test-AllowedNavigationTarget {
    param([string]$Url, [bool]$AllowLocalhost = $false)
    if (-not $Url) { return @{ Allowed = $false; Reason = 'Empty URL' } }

    $lower = $Url.Trim().ToLower()
    if ($lower.StartsWith('javascript:')) {
        return @{ Allowed = $false; Reason = 'javascript: protocol blocked' }
    }
    if ($lower.StartsWith('vbscript:')) {
        return @{ Allowed = $false; Reason = 'vbscript: protocol blocked' }
    }
    if ($lower.StartsWith('data:') -and ($lower -match 'text/html|script|svg')) {
        return @{ Allowed = $false; Reason = 'data: URL with executable content blocked' }
    }
    if ($lower.StartsWith('file:')) {
        return @{ Allowed = $false; Reason = 'file: protocol blocked' }
    }

    $hostname = ''
    if ($Url -match '://([^/:]+)') {
        $hostname = $Matches[1]
    }

    if ($hostname -and (Test-PrivateIp -Hostname $hostname)) {
        if ($AllowLocalhost -and ($hostname -eq 'localhost' -or $hostname -eq '127.0.0.1' -or $hostname -eq '::1')) {
            return @{ Allowed = $true; Reason = 'Localhost allowed by config' }
        }
        return @{ Allowed = $false; Reason = "Private/internal IP blocked: $hostname" }
    }

    return @{ Allowed = $true; Reason = '' }
}
