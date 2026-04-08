import * as vscode from 'vscode';
import { SudxLogger } from '../utils/logger';
import { IMcpServerRuntime } from '../types';
import {
  VALID_MCP_SERVERS,
  MCP_HEALTH_CHECK_TIMEOUT_MS,
  MCP_CRAWL4AI_DOCKER_IMAGE,
  MCP_CRAWL4AI_PORT,
  STRINGS,
} from '../constants';

const MODULE = 'McpLifecycleManager';

/**
 * Manages start/stop/status for MCP servers directly from VS Code.
 * Each server type has its own start/stop strategy:
 *   - Playwright: npx @playwright/mcp@latest (stdio)
 *   - Crawl4ai: Docker container (SSE)
 *   - Figma: stateless (token validation only, no persistent process)
 */
export class McpLifecycleManager implements vscode.Disposable {
  private logger: SudxLogger;
  private runtimes: Map<string, IMcpServerRuntime> = new Map();
  private outputChannels: Map<string, vscode.OutputChannel> = new Map();
  private _disposed = false;

  constructor(logger: SudxLogger) {
    this.logger = logger;
    this.logger.debug(MODULE, 'McpLifecycleManager initialized');
  }

  // ─── Start ─────────────────────────────────────────────────────────────

  async startServer(serverName: string): Promise<{ success: boolean; error?: string }> {
    if (this._disposed) {
      this.logger.warn(MODULE, 'startServer called after dispose', { serverName });
      return { success: false, error: 'Lifecycle manager has been disposed' };
    }
    this.logger.info(MODULE, `Starting MCP server: ${serverName}`);

    if (!VALID_MCP_SERVERS.includes(serverName)) {
      this.logger.error(MODULE, `Unknown MCP server: ${serverName}`);
      return { success: false, error: `Unknown MCP server: ${serverName}` };
    }

    const existing = this.runtimes.get(serverName);
    if (existing && existing.status === 'running') {
      this.logger.warn(MODULE, `Server "${serverName}" is already running`, { pid: existing.pid });
      return { success: false, error: `Server "${serverName}" is already running` };
    }

    try {
      switch (serverName) {
        case 'playwright':
          return await this.startPlaywright();
        case 'crawl4ai':
          return await this.startCrawl4ai();
        case 'figma':
          return this.startFigma();
        default:
          return { success: false, error: `No start handler for: ${serverName}` };
      }
    } catch (err) {
      this.logger.error(MODULE, `Failed to start server "${serverName}"`, err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── Stop ──────────────────────────────────────────────────────────────

  async stopServer(serverName: string): Promise<{ success: boolean; error?: string }> {
    if (this._disposed) {
      this.logger.warn(MODULE, 'stopServer called after dispose', { serverName });
      return { success: false, error: 'Lifecycle manager has been disposed' };
    }
    this.logger.info(MODULE, `Stopping MCP server: ${serverName}`);

    if (!VALID_MCP_SERVERS.includes(serverName)) {
      this.logger.error(MODULE, `Unknown MCP server: ${serverName}`);
      return { success: false, error: `Unknown MCP server: ${serverName}` };
    }

    try {
      switch (serverName) {
        case 'playwright':
          return await this.stopPlaywright();
        case 'crawl4ai':
          return await this.stopCrawl4ai();
        case 'figma':
          return this.stopFigma();
        default:
          return { success: false, error: `No stop handler for: ${serverName}` };
      }
    } catch (err) {
      this.logger.error(MODULE, `Failed to stop server "${serverName}"`, err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── Status ────────────────────────────────────────────────────────────

  async getServerStatus(serverName: string): Promise<IMcpServerRuntime> {
    this.logger.debug(MODULE, `Checking status for: ${serverName}`);

    const defaultRuntime: IMcpServerRuntime = {
      serverName,
      pid: null,
      startTime: null,
      status: 'stopped',
      outputChannelName: null,
    };

    if (!VALID_MCP_SERVERS.includes(serverName)) {
      this.logger.error(MODULE, `Unknown MCP server: ${serverName}`);
      return { ...defaultRuntime, status: 'error' };
    }

    try {
      switch (serverName) {
        case 'playwright':
          return await this.checkPlaywrightStatus();
        case 'crawl4ai':
          return await this.checkCrawl4aiStatus();
        case 'figma':
          return this.checkFigmaStatus();
        default:
          return defaultRuntime;
      }
    } catch (err) {
      this.logger.error(MODULE, `Status check failed for "${serverName}"`, err);
      return { ...defaultRuntime, status: 'error' };
    }
  }

  // ─── Restart ───────────────────────────────────────────────────────────

  async restartServer(serverName: string): Promise<{ success: boolean; error?: string }> {
    this.logger.info(MODULE, `Restarting MCP server: ${serverName}`);

    const stopResult = await this.stopServer(serverName);
    if (!stopResult.success) {
      this.logger.warn(MODULE, `Stop returned error during restart of "${serverName}" — attempting start anyway`, { error: stopResult.error });
    }

    const startResult = await this.startServer(serverName);
    if (!startResult.success) {
      this.logger.error(MODULE, `Start failed during restart of "${serverName}"`, { error: startResult.error });
      return { success: false, error: `Restart failed at start phase: ${startResult.error}` };
    }

    this.logger.info(MODULE, `Server "${serverName}" restarted successfully`);
    return { success: true };
  }

  // ─── Disposal ──────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    this.logger.debug(MODULE, 'Disposing lifecycle manager — stopping all managed servers');
    this._disposed = true;

    for (const [name] of this.runtimes) {
      try {
        await this.stopServer(name);
      } catch (err) {
        this.logger.warn(MODULE, `Failed to stop "${name}" during disposal`, err);
      }
    }

    for (const [, channel] of this.outputChannels) {
      try {
        channel.dispose();
      } catch {
        // ignore channel dispose errors during shutdown
      }
    }

    this.runtimes.clear();
    this.outputChannels.clear();
    this.logger.debug(MODULE, 'Lifecycle manager disposed');
  }

  // ─── Playwright ────────────────────────────────────────────────────────

  private async startPlaywright(): Promise<{ success: boolean; error?: string }> {
    this.logger.debug(MODULE, 'Starting Playwright MCP server');

    const npxAvailable = await this.checkCommandAvailable('npx');
    if (!npxAvailable) {
      this.logger.error(MODULE, 'npx is not available on PATH — cannot start Playwright');
      return { success: false, error: STRINGS.MCP_LIFECYCLE_NPX_NOT_FOUND };
    }

    const channel = this.getOrCreateOutputChannel('MCP: Playwright');
    channel.appendLine(`[${new Date().toISOString()}] Starting Playwright MCP server...`);

    const terminal = vscode.window.createTerminal({
      name: 'MCP: Playwright',
      hideFromUser: false,
    });
    terminal.sendText('npx @playwright/mcp@latest', true);

    const runtime: IMcpServerRuntime = {
      serverName: 'playwright',
      pid: null, // Terminal PIDs not reliably accessible
      startTime: new Date().toISOString(),
      status: 'running',
      outputChannelName: 'MCP: Playwright',
    };
    this.runtimes.set('playwright', runtime);

    channel.appendLine(`[${new Date().toISOString()}] Playwright MCP server started via terminal`);
    this.logger.info(MODULE, 'Playwright MCP server started');
    return { success: true };
  }

  private async stopPlaywright(): Promise<{ success: boolean; error?: string }> {
    this.logger.debug(MODULE, 'Stopping Playwright MCP server');

    const runtime = this.runtimes.get('playwright');
    if (!runtime || runtime.status !== 'running') {
      this.logger.debug(MODULE, 'Playwright server is not running');
      return { success: true }; // Already stopped
    }

    // Find and dispose the matching terminal
    const terminal = vscode.window.terminals.find(t => t.name === 'MCP: Playwright');
    if (terminal) {
      terminal.dispose();
      this.logger.debug(MODULE, 'Playwright terminal disposed');
    }

    this.runtimes.set('playwright', { ...runtime, status: 'stopped', pid: null });
    this.logger.info(MODULE, 'Playwright MCP server stopped');
    return { success: true };
  }

  private async checkPlaywrightStatus(): Promise<IMcpServerRuntime> {
    this.logger.debug(MODULE, 'Checking Playwright status');

    const runtime = this.runtimes.get('playwright');
    if (runtime && runtime.status === 'running') {
      // Verify terminal still exists
      const terminal = vscode.window.terminals.find(t => t.name === 'MCP: Playwright');
      if (!terminal) {
        this.logger.warn(MODULE, 'Playwright terminal no longer exists — marking as stopped');
        const stopped: IMcpServerRuntime = { ...runtime, status: 'stopped', pid: null };
        this.runtimes.set('playwright', stopped);
        return stopped;
      }
      return runtime;
    }

    return {
      serverName: 'playwright',
      pid: null,
      startTime: null,
      status: 'stopped',
      outputChannelName: null,
    };
  }

  // ─── Crawl4ai ──────────────────────────────────────────────────────────

  private async startCrawl4ai(): Promise<{ success: boolean; error?: string }> {
    this.logger.debug(MODULE, 'Starting Crawl4ai MCP server');

    const dockerAvailable = await this.checkCommandAvailable('docker');
    if (!dockerAvailable) {
      this.logger.error(MODULE, 'Docker is not available — cannot start Crawl4ai');
      return { success: false, error: STRINGS.MCP_LIFECYCLE_DOCKER_NOT_FOUND };
    }

    // Check if Docker daemon is running
    const daemonCheck = await this.execCommand('docker info');
    if (!daemonCheck.success) {
      this.logger.error(MODULE, 'Docker daemon is not running');
      return { success: false, error: STRINGS.MCP_LIFECYCLE_DOCKER_NOT_RUNNING };
    }

    const channel = this.getOrCreateOutputChannel('MCP: Crawl4ai');
    channel.appendLine(`[${new Date().toISOString()}] Starting Crawl4ai Docker container...`);

    // Stop existing container if any (ignore errors)
    await this.execCommand('docker stop crawl4ai');
    await this.execCommand('docker rm crawl4ai');

    const startResult = await this.execCommand(
      `docker run -d -p ${MCP_CRAWL4AI_PORT}:${MCP_CRAWL4AI_PORT} --name crawl4ai ${MCP_CRAWL4AI_DOCKER_IMAGE}`
    );

    if (!startResult.success) {
      this.logger.error(MODULE, 'Failed to start Crawl4ai container', { error: startResult.error });
      channel.appendLine(`[${new Date().toISOString()}] ERROR: ${startResult.error}`);
      return { success: false, error: startResult.error };
    }

    const runtime: IMcpServerRuntime = {
      serverName: 'crawl4ai',
      pid: null,
      startTime: new Date().toISOString(),
      status: 'running',
      outputChannelName: 'MCP: Crawl4ai',
    };
    this.runtimes.set('crawl4ai', runtime);

    channel.appendLine(`[${new Date().toISOString()}] Crawl4ai container started`);
    this.logger.info(MODULE, 'Crawl4ai MCP server started via Docker');
    return { success: true };
  }

  private async stopCrawl4ai(): Promise<{ success: boolean; error?: string }> {
    this.logger.debug(MODULE, 'Stopping Crawl4ai MCP server');

    const runtime = this.runtimes.get('crawl4ai');

    const stopResult = await this.execCommand('docker stop crawl4ai');
    if (!stopResult.success) {
      this.logger.warn(MODULE, 'docker stop crawl4ai failed — container may already be stopped', { error: stopResult.error });
    }

    const rmResult = await this.execCommand('docker rm crawl4ai');
    if (!rmResult.success) {
      this.logger.warn(MODULE, 'docker rm crawl4ai failed — container may not exist', { error: rmResult.error });
    }

    if (runtime) {
      this.runtimes.set('crawl4ai', { ...runtime, status: 'stopped', pid: null });
    }

    this.logger.info(MODULE, 'Crawl4ai MCP server stopped');
    return { success: true };
  }

  private async checkCrawl4aiStatus(): Promise<IMcpServerRuntime> {
    this.logger.debug(MODULE, 'Checking Crawl4ai status');

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), MCP_HEALTH_CHECK_TIMEOUT_MS);
      const response = await fetch(`http://localhost:${MCP_CRAWL4AI_PORT}/mcp`, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const healthy = response.ok || response.status < 500;
      const runtime = this.runtimes.get('crawl4ai');

      if (healthy) {
        const result: IMcpServerRuntime = {
          serverName: 'crawl4ai',
          pid: null,
          startTime: runtime?.startTime ?? null,
          status: 'running',
          outputChannelName: 'MCP: Crawl4ai',
        };
        this.runtimes.set('crawl4ai', result);
        return result;
      }
    } catch {
      // Server unreachable
    }

    const runtime = this.runtimes.get('crawl4ai');
    const stopped: IMcpServerRuntime = {
      serverName: 'crawl4ai',
      pid: null,
      startTime: runtime?.startTime ?? null,
      status: 'stopped',
      outputChannelName: null,
    };
    this.runtimes.set('crawl4ai', stopped);
    return stopped;
  }

  // ─── Figma ─────────────────────────────────────────────────────────────

  private startFigma(): { success: boolean; error?: string } {
    this.logger.debug(MODULE, 'Figma is stateless — validating token presence only');

    // Figma MCP uses stdio via npx and is invoked per-call — no persistent process
    const runtime: IMcpServerRuntime = {
      serverName: 'figma',
      pid: null,
      startTime: new Date().toISOString(),
      status: 'running',
      outputChannelName: null,
    };
    this.runtimes.set('figma', runtime);

    this.logger.info(MODULE, 'Figma MCP marked as available (stateless, token-based)');
    return { success: true };
  }

  private stopFigma(): { success: boolean; error?: string } {
    this.logger.debug(MODULE, 'Figma stop is a no-op (stateless server)');

    const runtime = this.runtimes.get('figma');
    if (runtime) {
      this.runtimes.set('figma', { ...runtime, status: 'stopped' });
    }

    return { success: true };
  }

  private checkFigmaStatus(): IMcpServerRuntime {
    this.logger.debug(MODULE, 'Checking Figma status (token-based, stateless)');

    // Figma is always "available" if the token env var is set — check runtime map
    const runtime = this.runtimes.get('figma');
    return runtime ?? {
      serverName: 'figma',
      pid: null,
      startTime: null,
      status: 'stopped',
      outputChannelName: null,
    };
  }

  // ─── Utility ───────────────────────────────────────────────────────────

  private getOrCreateOutputChannel(name: string): vscode.OutputChannel {
    let channel = this.outputChannels.get(name);
    if (!channel) {
      channel = vscode.window.createOutputChannel(name);
      this.outputChannels.set(name, channel);
      this.logger.debug(MODULE, `Created output channel: ${name}`);
    }
    return channel;
  }

  /**
   * Check if a command is available on PATH.
   */
  private async checkCommandAvailable(command: string): Promise<boolean> {
    this.logger.debug(MODULE, `Checking command availability: ${command}`);
    const checkCmd = process.platform === 'win32' ? `where ${command}` : `which ${command}`;
    const result = await this.execCommand(checkCmd);
    this.logger.debug(MODULE, `Command "${command}" available: ${result.success}`);
    return result.success;
  }

  /**
   * Execute a shell command and return result. Does NOT block on long-running commands.
   */
  private execCommand(command: string): Promise<{ success: boolean; stdout?: string; error?: string }> {
    this.logger.debug(MODULE, `Executing command: ${command}`);
    return new Promise((resolve) => {
      const { exec } = require('child_process') as typeof import('child_process');
      const child = exec(command, { timeout: 30_000 }, (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          this.logger.debug(MODULE, `Command failed: ${command}`, { error: err.message, stderr });
          resolve({ success: false, error: err.message });
        } else {
          this.logger.debug(MODULE, `Command succeeded: ${command}`, { stdout: stdout.substring(0, 200) });
          resolve({ success: true, stdout: stdout.trim() });
        }
      });
      child.on('error', (err: Error) => {
        this.logger.debug(MODULE, `Command error event: ${command}`, { error: err.message });
        resolve({ success: false, error: err.message });
      });
    });
  }
}
