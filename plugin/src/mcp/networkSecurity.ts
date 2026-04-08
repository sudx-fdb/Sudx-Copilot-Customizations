import { SudxLogger } from '../utils/logger';
import { MCP_BLOCKED_PROTOCOLS, MCP_PRIVATE_IP_RANGES } from '../constants';

const MODULE = 'McpNetworkSecurity';

/**
 * URL validation and SSRF prevention utilities for MCP server interactions.
 * Shared by guard hooks, config validators, and the TypeScript codebase.
 * All methods are static — no instance needed.
 */
export class McpNetworkSecurity {

  /**
   * Check if a hostname resolves to a private/internal IP address.
   * Detects: RFC 1918 (10.x, 172.16-31.x, 192.168.x), loopback (127.x),
   * link-local (169.254.x), and IPv6 private ranges (::1, fc00::/7, fe80::/10).
   */
  static isPrivateIp(hostname: string, logger?: SudxLogger): boolean {
    logger?.debug(MODULE, 'isPrivateIp check', { hostname });

    if (!hostname || typeof hostname !== 'string') {
      logger?.debug(MODULE, 'isPrivateIp — empty hostname');
      return false;
    }

    const lower = hostname.toLowerCase().trim();

    // Loopback
    if (lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower === '[::1]') {
      logger?.debug(MODULE, 'isPrivateIp — loopback detected', { hostname });
      return true;
    }

    // IPv6 private ranges — only check when hostname looks like IPv6 (contains ':' or is bracketed)
    const isIpv6 = lower.includes(':') || (lower.startsWith('[') && lower.endsWith(']'));
    if (isIpv6 && (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('[fc') || lower.startsWith('[fd') || lower.startsWith('[fe80'))) {
      logger?.debug(MODULE, 'isPrivateIp — IPv6 private range', { hostname });
      return true;
    }

    // IPv4 check
    const parts = lower.replace(/^\[/, '').replace(/\]$/, '').split('.');
    if (parts.length === 4) {
      const octets = parts.map(p => parseInt(p, 10));
      if (octets.some(o => isNaN(o) || o < 0 || o > 255)) {
        return false;
      }
      const [a, b] = octets;

      // 10.0.0.0/8
      if (a === 10) {
        logger?.debug(MODULE, 'isPrivateIp — RFC1918 10.x', { hostname });
        return true;
      }
      // 172.16.0.0/12
      if (a === 172 && b >= 16 && b <= 31) {
        logger?.debug(MODULE, 'isPrivateIp — RFC1918 172.16-31.x', { hostname });
        return true;
      }
      // 192.168.0.0/16
      if (a === 192 && b === 168) {
        logger?.debug(MODULE, 'isPrivateIp — RFC1918 192.168.x', { hostname });
        return true;
      }
      // 127.0.0.0/8 loopback
      if (a === 127) {
        logger?.debug(MODULE, 'isPrivateIp — loopback 127.x', { hostname });
        return true;
      }
      // 169.254.0.0/16 link-local
      if (a === 169 && b === 254) {
        logger?.debug(MODULE, 'isPrivateIp — link-local 169.254.x', { hostname });
        return true;
      }
      // 0.0.0.0
      if (a === 0 && b === 0 && octets[2] === 0 && octets[3] === 0) {
        logger?.debug(MODULE, 'isPrivateIp — 0.0.0.0', { hostname });
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a URL is an allowed crawl target for Crawl4ai.
   * Blocks: private IPs, localhost, file:/data:/javascript: protocols, configurable blocklist.
   * @param allowLocalhost If true, allow localhost/127.x (for local dev testing)
   */
  static isAllowedCrawlTarget(
    url: string,
    allowLocalhost: boolean = false,
    domainBlocklist: string[] = [],
    logger?: SudxLogger
  ): { allowed: boolean; reason?: string } {
    logger?.debug(MODULE, 'isAllowedCrawlTarget', { url, allowLocalhost });

    if (!url || typeof url !== 'string') {
      return { allowed: false, reason: 'Empty or invalid URL' };
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      logger?.debug(MODULE, 'isAllowedCrawlTarget — URL parse failed', { url });
      return { allowed: false, reason: 'Invalid URL format' };
    }

    // Protocol check
    const protocol = parsed.protocol.toLowerCase();
    if (MCP_BLOCKED_PROTOCOLS.includes(protocol)) {
      logger?.debug(MODULE, 'isAllowedCrawlTarget — blocked protocol', { protocol });
      return { allowed: false, reason: `Blocked protocol: ${protocol}` };
    }

    // Only allow http: and https:
    if (protocol !== 'http:' && protocol !== 'https:') {
      return { allowed: false, reason: `Unsupported protocol: ${protocol}` };
    }

    // Private IP check
    const hostname = parsed.hostname;
    if (McpNetworkSecurity.isPrivateIp(hostname, logger)) {
      if (allowLocalhost && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')) {
        logger?.debug(MODULE, 'isAllowedCrawlTarget — localhost allowed by config');
      } else {
        return { allowed: false, reason: `Private/internal IP blocked: ${hostname}` };
      }
    }

    // Domain blocklist
    const lowerHost = hostname.toLowerCase();
    for (const blocked of domainBlocklist) {
      if (lowerHost === blocked.toLowerCase() || lowerHost.endsWith('.' + blocked.toLowerCase())) {
        logger?.debug(MODULE, 'isAllowedCrawlTarget — domain blocklisted', { hostname, blocked });
        return { allowed: false, reason: `Domain blocklisted: ${hostname}` };
      }
    }

    return { allowed: true };
  }

  /**
   * Check if a URL is an allowed navigation target for Playwright.
   * Blocks: javascript:, data: with script content, private IPs (with localhost override).
   */
  static isAllowedNavigationTarget(
    url: string,
    allowLocalhost: boolean = false,
    logger?: SudxLogger
  ): { allowed: boolean; reason?: string } {
    logger?.debug(MODULE, 'isAllowedNavigationTarget', { url, allowLocalhost });

    if (!url || typeof url !== 'string') {
      return { allowed: false, reason: 'Empty or invalid URL' };
    }

    const trimmed = url.trim().toLowerCase();

    // Block javascript: protocol
    if (trimmed.startsWith('javascript:')) {
      return { allowed: false, reason: 'javascript: protocol blocked' };
    }

    // Block vbscript: protocol
    if (trimmed.startsWith('vbscript:')) {
      return { allowed: false, reason: 'vbscript: protocol blocked' };
    }

    // Block data: URLs with potential script content
    if (trimmed.startsWith('data:')) {
      if (trimmed.includes('text/html') || trimmed.includes('script') || trimmed.includes('svg')) {
        return { allowed: false, reason: 'data: URL with executable content blocked' };
      }
    }

    // Block file: protocol
    if (trimmed.startsWith('file:')) {
      return { allowed: false, reason: 'file: protocol blocked' };
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // Could be relative URL — allow
      logger?.debug(MODULE, 'isAllowedNavigationTarget — URL parse failed, allowing relative', { url });
      return { allowed: true };
    }

    // Private IP check
    const hostname = parsed.hostname;
    if (McpNetworkSecurity.isPrivateIp(hostname, logger)) {
      if (allowLocalhost && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')) {
        logger?.debug(MODULE, 'isAllowedNavigationTarget — localhost allowed by config');
      } else {
        return { allowed: false, reason: `Private/internal IP blocked: ${hostname}` };
      }
    }

    return { allowed: true };
  }
}
