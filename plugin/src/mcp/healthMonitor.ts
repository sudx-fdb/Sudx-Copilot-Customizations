import * as vscode from 'vscode';
import { SudxLogger } from '../utils/logger';
import { IMcpHealthStatus, McpTransport } from '../types';
import {
  VALID_MCP_SERVERS,
  MCP_HEALTH_CHECK_TIMEOUT_MS,
} from '../constants';

const MODULE = 'McpHealthMonitor';

/**
 * Periodically checks MCP server availability and emits health status events.
 * Results are cached in workspace state for immediate display on restart.
 * Does NOT block any operations — health checks are informational only.
 */
export class McpHealthMonitor implements vscode.Disposable {
  private logger: SudxLogger;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private healthStatuses: Map<string, IMcpHealthStatus> = new Map();
  private readonly _onHealthChanged = new vscode.EventEmitter<IMcpHealthStatus[]>();
  public readonly onHealthChanged = this._onHealthChanged.event;

  constructor(logger: SudxLogger, intervalMs: number = 60_000) {
    this.logger = logger;
    this.intervalMs = Math.max(10_000, Math.min(300_000, intervalMs));
    this.logger.debug(MODULE, 'McpHealthMonitor initialized', { intervalMs: this.intervalMs });
  }

  /**
   * Start the periodic health check loop.
   */
  start(): void {
    this.logger.info(MODULE, 'Starting health monitor', { intervalMs: this.intervalMs });

    if (this.intervalId) {
      this.logger.warn(MODULE, 'Health monitor already running — restarting');
      this.stop();
    }

    // Run immediately, then schedule
    this.runHealthChecks();
    this.intervalId = setInterval(() => this.runHealthChecks(), this.intervalMs);
    this.logger.debug(MODULE, 'Health check loop scheduled');
  }

  /**
   * Stop the periodic health check loop.
   */
  stop(): void {
    this.logger.debug(MODULE, 'Stopping health monitor');
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.logger.info(MODULE, 'Health monitor stopped');
    }
  }

  /**
   * Get the current cached health statuses.
   */
  getStatuses(): IMcpHealthStatus[] {
    return Array.from(this.healthStatuses.values());
  }

  /**
   * Restore health statuses from cached data (e.g., workspace state on restart).
   */
  restoreFromCache(cached: IMcpHealthStatus[]): void {
    this.logger.debug(MODULE, 'Restoring health statuses from cache', { count: cached.length });
    for (const status of cached) {
      if (VALID_MCP_SERVERS.includes(status.serverName)) {
        this.healthStatuses.set(status.serverName, status);
      }
    }
  }

  /**
   * Run all health checks in parallel.
   */
  private async runHealthChecks(): Promise<void> {
    this.logger.debug(MODULE, 'Running health checks for all servers');
    const startTime = Date.now();

    try {
      const results = await Promise.allSettled([
        this.checkPlaywright(),
        this.checkFigma(),
        this.checkCrawl4ai(),
      ]);

      let changed = false;
      const statuses: IMcpHealthStatus[] = [];

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const status = result.value;
          const previous = this.healthStatuses.get(status.serverName);
          if (!previous || previous.healthy !== status.healthy) {
            changed = true;
            this.logger.info(MODULE, `Health status changed: ${status.serverName}`, {
              healthy: status.healthy,
              wasHealthy: previous?.healthy ?? 'unknown',
            });
          }
          this.healthStatuses.set(status.serverName, status);
          statuses.push(status);
        }
      }

      if (changed) {
        this._onHealthChanged.fire(Array.from(this.healthStatuses.values()));
      }

      this.logger.debug(MODULE, 'Health checks complete', {
        duration: `${Date.now() - startTime}ms`,
        results: statuses.map(s => `${s.serverName}:${s.healthy}`).join(', '),
      });
    } catch (err) {
      this.logger.error(MODULE, 'Health check cycle failed', err);
    }
  }

  /**
   * Check Playwright availability by verifying npx is on PATH.
   */
  private async checkPlaywright(): Promise<IMcpHealthStatus> {
    this.logger.debug(MODULE, 'Checking Playwright health');
    const now = new Date().toISOString();

    try {
      const available = await this.checkCommandAvailable('npx');
      if (available) {
        this.logger.debug(MODULE, 'Playwright health: npx available');
        return { serverName: 'playwright', healthy: true, lastCheck: now, transport: McpTransport.Stdio };
      }
      this.logger.debug(MODULE, 'Playwright health: npx not available');
      return { serverName: 'playwright', healthy: false, lastCheck: now, error: 'npx not found on PATH', transport: McpTransport.Stdio };
    } catch (err) {
      this.logger.warn(MODULE, 'Playwright health check error', err);
      return { serverName: 'playwright', healthy: false, lastCheck: now, error: err instanceof Error ? err.message : String(err), transport: McpTransport.Stdio };
    }
  }

  /**
   * Check Figma availability by verifying token format (no API call).
   * Figma tokens start with figd_ or fig_ and are at least 20 chars.
   */
  private async checkFigma(): Promise<IMcpHealthStatus> {
    this.logger.debug(MODULE, 'Checking Figma health');
    const now = new Date().toISOString();

    try {
      // Check if FIGMA_PERSONAL_ACCESS_TOKEN env var exists and has valid format
      const token = process.env.FIGMA_PERSONAL_ACCESS_TOKEN;
      if (token && token.length >= 20 && (token.startsWith('figd_') || token.startsWith('fig_'))) {
        this.logger.debug(MODULE, 'Figma health: token format valid');
        return { serverName: 'figma', healthy: true, lastCheck: now, transport: McpTransport.Stdio };
      }

      // Also check npx availability as secondary check
      const npxAvailable = await this.checkCommandAvailable('npx');
      if (npxAvailable) {
        this.logger.debug(MODULE, 'Figma health: npx available, token not verified');
        return { serverName: 'figma', healthy: true, lastCheck: now, transport: McpTransport.Stdio };
      }

      this.logger.debug(MODULE, 'Figma health: neither token nor npx available');
      return { serverName: 'figma', healthy: false, lastCheck: now, error: 'npx not found and no valid FIGMA_PERSONAL_ACCESS_TOKEN', transport: McpTransport.Stdio };
    } catch (err) {
      this.logger.warn(MODULE, 'Figma health check error', err);
      return { serverName: 'figma', healthy: false, lastCheck: now, error: err instanceof Error ? err.message : String(err), transport: McpTransport.Stdio };
    }
  }

  /**
   * Check Crawl4ai availability by probing the SSE endpoint.
   */
  private async checkCrawl4ai(): Promise<IMcpHealthStatus> {
    this.logger.debug(MODULE, 'Checking Crawl4ai health');
    const now = new Date().toISOString();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), MCP_HEALTH_CHECK_TIMEOUT_MS);
      const response = await fetch('http://localhost:11235/mcp', {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const healthy = response.ok || response.status < 500;
      this.logger.debug(MODULE, `Crawl4ai health: ${healthy ? 'reachable' : 'error'}`, { status: response.status });
      return {
        serverName: 'crawl4ai',
        healthy,
        lastCheck: now,
        transport: McpTransport.Sse,
        error: healthy ? undefined : `HTTP ${response.status}`,
      };
    } catch (err) {
      this.logger.debug(MODULE, 'Crawl4ai health: unreachable', { error: err instanceof Error ? err.message : String(err) });
      return {
        serverName: 'crawl4ai',
        healthy: false,
        lastCheck: now,
        error: 'SSE endpoint unreachable',
        transport: McpTransport.Sse,
      };
    }
  }

  /**
   * Check if a command exists on PATH.
   */
  private checkCommandAvailable(command: string): Promise<boolean> {
    this.logger.debug(MODULE, `Checking command availability: ${command}`);
    return new Promise((resolve) => {
      const { exec } = require('child_process') as typeof import('child_process');
      const checkCmd = process.platform === 'win32' ? `where ${command}` : `which ${command}`;
      exec(checkCmd, { timeout: 5_000 }, (err: Error | null) => {
        resolve(!err);
      });
    });
  }

  /**
   * Dispose the health monitor — stop interval and clean up event emitter.
   */
  dispose(): void {
    this.logger.debug(MODULE, 'Disposing health monitor');
    this.stop();
    this._onHealthChanged.dispose();
    this.healthStatuses.clear();
    this.logger.debug(MODULE, 'Health monitor disposed');
  }
}
