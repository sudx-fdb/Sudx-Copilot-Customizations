#!/usr/bin/env bash
# Shared Network Security Validation Functions for MCP Guard Hooks
# Sourced by: crawl4ai-guard.sh, playwright-guard.sh
# Mirrors logic from plugin/src/mcp/networkSecurity.ts

is_private_ip() {
    local hostname="${1,,}"  # lowercase
    [ -z "$hostname" ] && echo "false" && return

    # Loopback
    case "$hostname" in
        localhost|127.0.0.1|::1|"[::1]") echo "true"; return ;;
    esac

    # IPv6 private
    case "$hostname" in
        fc*|fd*|fe80*) echo "true"; return ;;
    esac

    # IPv4 ranges
    if [[ "$hostname" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
        local a="${BASH_REMATCH[1]}" b="${BASH_REMATCH[2]}" c="${BASH_REMATCH[3]}" d="${BASH_REMATCH[4]}"
        [ "$a" -eq 10 ] && echo "true" && return
        [ "$a" -eq 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && echo "true" && return
        [ "$a" -eq 192 ] && [ "$b" -eq 168 ] && echo "true" && return
        [ "$a" -eq 127 ] && echo "true" && return
        [ "$a" -eq 169 ] && [ "$b" -eq 254 ] && echo "true" && return
        [ "$a" -eq 0 ] && [ "$b" -eq 0 ] && [ "$c" -eq 0 ] && [ "$d" -eq 0 ] && echo "true" && return
    fi

    echo "false"
}

is_blocked_protocol() {
    local url="${1,,}"
    [ -z "$url" ] && echo "true" && return

    case "$url" in
        file:*|data:*|javascript:*|vbscript:*|ftp:*) echo "true"; return ;;
    esac

    echo "false"
}

# Returns "allowed" or "blocked:<reason>"
check_crawl_target() {
    local url="$1"
    local allow_localhost="${2:-false}"

    [ -z "$url" ] && echo "blocked:Empty URL" && return

    if [ "$(is_blocked_protocol "$url")" = "true" ]; then
        echo "blocked:Blocked protocol in URL: $url"
        return
    fi

    local hostname=""
    if [[ "$url" =~ ://([^/:]+) ]]; then
        hostname="${BASH_REMATCH[1]}"
    fi

    if [ -n "$hostname" ] && [ "$(is_private_ip "$hostname")" = "true" ]; then
        if [ "$allow_localhost" = "true" ]; then
            case "$hostname" in
                localhost|127.0.0.1|::1) echo "allowed"; return ;;
            esac
        fi
        echo "blocked:Private/internal IP blocked: $hostname"
        return
    fi

    echo "allowed"
}

# Returns "allowed" or "blocked:<reason>"
check_navigation_target() {
    local url="$1"
    local allow_localhost="${2:-false}"

    [ -z "$url" ] && echo "blocked:Empty URL" && return

    local lower="${url,,}"
    case "$lower" in
        javascript:*) echo "blocked:javascript: protocol blocked"; return ;;
        vbscript:*) echo "blocked:vbscript: protocol blocked"; return ;;
        file:*) echo "blocked:file: protocol blocked"; return ;;
    esac

    if [[ "$lower" == data:* ]] && [[ "$lower" =~ text/html|script|svg ]]; then
        echo "blocked:data: URL with executable content blocked"
        return
    fi

    local hostname=""
    if [[ "$url" =~ ://([^/:]+) ]]; then
        hostname="${BASH_REMATCH[1]}"
    fi

    if [ -n "$hostname" ] && [ "$(is_private_ip "$hostname")" = "true" ]; then
        if [ "$allow_localhost" = "true" ]; then
            case "$hostname" in
                localhost|127.0.0.1|::1) echo "allowed"; return ;;
            esac
        fi
        echo "blocked:Private/internal IP blocked: $hostname"
        return
    fi

    echo "allowed"
}
