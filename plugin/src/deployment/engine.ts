import * as vscode from 'vscode';
import * as path from 'path';
import {
  IDeploymentConfig,
  IDeploymentResult,
  ITemplateFile,
  DeploymentState,
  DeploymentStateChangedHandler,
  ProgressCallback,
  IDeploymentHistory,
  IMcpDeploymentState,
  TemplateCategory,
} from '../types';
import { SudxLogger } from '../utils/logger';
import { PathUtils } from '../utils/paths';
import { TemplateScanner } from './scanner';
import { FileCopier } from './copier';
import { HookManager } from './hooks';
import { AgentActivator } from './agent';
import { McpDeployer } from './mcpDeployer';
import { StateManager } from '../config/state';
import { STRINGS } from '../constants';
import { SudxSettings } from '../config/settings';

const MODULE = 'DeployEngine';

/** Maximum time for entire deployment operation (2 minutes) */
const DEPLOY_TIMEOUT_MS = 120_000;

export class DeploymentEngine {
  private logger: SudxLogger;
  private paths: PathUtils;
  private scanner: TemplateScanner;
  private copier: FileCopier;
  private hookManager: HookManager;
  private agentActivator: AgentActivator;
  private mcpDeployer: McpDeployer;
  private stateManager: StateManager;
  private settings: SudxSettings;

  private currentState: DeploymentState = DeploymentState.Idle;
  private cancellationSource: vscode.CancellationTokenSource | null = null;
  
  /** Promise-based lock to prevent concurrent deployments */
  private deployPromise: Promise<IDeploymentResult> | null = null;

  private stateChangeHandlers: DeploymentStateChangedHandler[] = [];
  private progressHandlers: ProgressCallback[] = [];

  constructor(
    logger: SudxLogger,
    paths: PathUtils,
    scanner: TemplateScanner,
    copier: FileCopier,
    hookManager: HookManager,
    agentActivator: AgentActivator,
    mcpDeployer: McpDeployer,
    stateManager: StateManager,
    settings: SudxSettings
  ) {
    this.logger = logger;
    this.paths = paths;
    this.scanner = scanner;
    this.copier = copier;
    this.hookManager = hookManager;
    this.agentActivator = agentActivator;
    this.mcpDeployer = mcpDeployer;
    this.stateManager = stateManager;
    this.settings = settings;
  }

  onStateChange(handler: DeploymentStateChangedHandler): void {
    this.stateChangeHandlers.push(handler);
  }

  onProgress(handler: ProgressCallback): void {
    this.progressHandlers.push(handler);
  }

  getState(): DeploymentState {
    return this.currentState;
  }

  async deploy(
    config: IDeploymentConfig,
    context: vscode.ExtensionContext,
    options?: { dryRun?: boolean }
  ): Promise<IDeploymentResult> {
    const dryRun = options?.dryRun ?? false;

    this.logger.info(MODULE, `Starting deployment${dryRun ? ' (DRY RUN)' : ''}`, {
      deployPath: config.deployPath,
      hookConfig: config.hookConfig,
      autoActivateAgent: config.autoActivateAgent,
    });

    // Promise-based atomic lock check — if deployPromise exists, a deploy is in progress
    if (this.deployPromise) {
      this.logger.warn(MODULE, 'Deployment already in progress');
      return this.makeErrorResult('Deployment already in progress');
    }

    // Create the deployment promise and store it (atomic lock acquisition)
    this.deployPromise = this.executeDeployment(config, context, dryRun);

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      // Add timeout wrapper
      const result = await Promise.race([
        this.deployPromise,
        this.createTimeoutPromise((id) => { timeoutId = id; }),
      ]);
      return result;
    } finally {
      // Clear the timeout to prevent stale fire after successful deploy
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      // Release the lock
      this.deployPromise = null;
    }
  }

  /**
   * Creates a promise that resolves with an error result after DEPLOY_TIMEOUT_MS.
   * Calls onTimerCreated with the timer ID so the caller can clear it.
   */
  private createTimeoutPromise(onTimerCreated: (id: ReturnType<typeof setTimeout>) => void): Promise<IDeploymentResult> {
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        this.logger.error(MODULE, `Deployment timed out after ${DEPLOY_TIMEOUT_MS}ms`);
        this.cancel(); // Cancel the operation
        resolve(this.makeErrorResult('Deployment timed out'));
      }, DEPLOY_TIMEOUT_MS);
      onTimerCreated(id);
    });
  }

  /**
   * Internal deployment execution (separated for timeout wrapper)
   */
  private async executeDeployment(
    config: IDeploymentConfig,
    context: vscode.ExtensionContext,
    dryRun: boolean
  ): Promise<IDeploymentResult> {
    this.cancellationSource = new vscode.CancellationTokenSource();
    const startTime = Date.now();

    try {
      // ── Step 1: Resolve target ─────────────────────────────────────────
      const targetRoot = this.paths.getDeployTarget(config.deployPath);
      if (!targetRoot) {
        this.logger.error(MODULE, 'Failed to resolve deploy target');
        return this.makeErrorResult('Invalid deploy path');
      }

      // ── Step 2: Scan templates ─────────────────────────────────────────
      this.setState(DeploymentState.Scanning);
      const allFiles = await this.scanner.scan(context);
      if (allFiles.length === 0) {
        this.logger.error(MODULE, 'No template files found');
        return this.makeErrorResult('No template files found');
      }

      if (this.isCancelled()) {
        return this.makeCancelledResult();
      }

      // ── Step 3: Filter files ───────────────────────────────────────────
      const filesToDeploy = this.filterFiles(allFiles);
      const skippedFiles = allFiles
        .filter((f) => !filesToDeploy.includes(f))
        .map((f) => f.relativePath);

      // Separate MCP files (deploy to .vscode/) from regular files (deploy to .github/)
      const mcpFiles = filesToDeploy.filter((f) => f.category === TemplateCategory.Mcp);
      const regularFiles = filesToDeploy.filter((f) => f.category !== TemplateCategory.Mcp);

      this.logger.info(MODULE, 'Files filtered', {
        total: allFiles.length,
        deploy: filesToDeploy.length,
        mcp: mcpFiles.length,
        skip: skippedFiles.length,
      });

      if (dryRun) {
        return {
          success: true,
          deployedFiles: filesToDeploy.map((f) => f.relativePath),
          skippedFiles,
          errors: [],
          duration: Date.now() - startTime,
        };
      }

      // ── Step 4: Deploy files ───────────────────────────────────────────
      this.setState(DeploymentState.Deploying);

      // Deploy regular files to .github/ (or custom deploy path)
      const copyResult = await this.copier.copyFiles(
        regularFiles,
        targetRoot,
        (current, total, fileName) => {
          this.emitProgress(current, total + mcpFiles.length, fileName);
        },
        this.cancellationSource.token
      );

      // Deploy MCP files via McpDeployer (merge/overwrite/skip based on setting)
      if (mcpFiles.length > 0 && copyResult.success) {
        const mcpMode = this.settings.getMcpDeployMode();
        const mcpServerConfig = this.settings.getMcpServerConfig();
        this.logger.info(MODULE, `MCP deployment mode: ${mcpMode}`, { mcpFileCount: mcpFiles.length, serverConfig: mcpServerConfig });

        // Check for MCP template version mismatch
        const storedVersion = this.stateManager.getMcpTemplateVersion();
        if (storedVersion !== '0.0.0') {
          this.emitMcpProgress(`Previous MCP version: ${storedVersion}`, 'mcp-validate');
        }

        this.emitMcpProgress('Validating MCP config', 'mcp-validate');
        this.emitMcpProgress('Merging MCP servers', 'mcp-merge');

        const mcpResult = await this.mcpDeployer.deploy(mcpFiles, mcpMode, mcpServerConfig);
        // Emit validation warnings as [MCP-WARN] entries
        if (mcpResult.validationWarnings && mcpResult.validationWarnings.length > 0) {
          for (const warning of mcpResult.validationWarnings) {
            this.emitMcpProgress(warning, 'mcp-validate');
          }
        }
        if (mcpResult.success) {
          this.emitMcpProgress(`MCP deployed: ${mcpResult.serversDeployed.join(', ')}`, 'mcp-merge');
          if (mcpResult.serversPreserved && mcpResult.serversPreserved.length > 0) {
            this.emitMcpProgress(`Preserved user servers: ${mcpResult.serversPreserved.join(', ')}`, 'mcp-merge');
          }
          for (const server of mcpResult.serversDeployed) {
            copyResult.copied.push(`.vscode/mcp.json [${server}]`);
          }
          // Persist MCP deployment state for tracking and rollback
          const mcpState: IMcpDeploymentState = {
            lastMcpDeployDate: new Date().toISOString(),
            deployedServers: mcpResult.serversDeployed,
            mcpConfigBackupPath: mcpResult.backupPath,
            mergeConflicts: [],
          };
          await this.stateManager.setMcpDeploymentState(mcpState);
          // Store deployed template version for future mismatch detection
          if (mcpResult.templateVersion) {
            const previousVersion = this.stateManager.getMcpTemplateVersion();
            await this.stateManager.setMcpTemplateVersion(mcpResult.templateVersion);
            // Notify user if MCP template was updated
            if (previousVersion !== '0.0.0' && previousVersion !== mcpResult.templateVersion) {
              this.emitMcpProgress(`MCP template updated: ${previousVersion} → ${mcpResult.templateVersion}`, 'mcp-merge');
              vscode.window.showInformationMessage(
                `MCP config updated from v${previousVersion} to v${mcpResult.templateVersion}`,
                'View Log'
              );
            }
          }
          this.logger.info(MODULE, 'MCP deployment state persisted', mcpState);
          this.logger.info(MODULE, 'MCP deployment complete', {
            deployed: mcpResult.serversDeployed,
            preserved: mcpResult.serversPreserved,
            duration: `${mcpResult.duration}ms`,
          });
        } else {
          copyResult.failed.push({ file: '.vscode/mcp.json', error: mcpResult.error ?? 'MCP deployment failed', recoverable: true });
          this.logger.error(MODULE, 'MCP deployment failed', { error: mcpResult.error });
        }

        // Emit cached MCP health check results into deploy log
        try {
          const healthCache = this.stateManager.getMcpHealthCache();
          if (healthCache && healthCache.length > 0) {
            const healthParts = healthCache.map(s => `${s.serverName}: ${s.healthy ? 'ready' : 'unreachable'}`);
            this.emitMcpProgress(`[MCP-HEALTH] ${healthParts.join(', ')}`, 'mcp-health');
          }
        } catch (healthErr) {
          this.logger.debug(MODULE, 'Could not emit MCP health status', healthErr);
        }

        // Generate MCP context file for session-context hook
        const workspaceRoot = this.paths.getWorkspaceRoot();
        if (mcpResult.success && workspaceRoot) {
          try {
            const healthCache = this.stateManager.getMcpHealthCache();
            const healthMap: Record<string, boolean> = {};
            if (healthCache) {
              for (const s of healthCache) { healthMap[s.serverName] = s.healthy; }
            }
            const mcpConfigUri = vscode.Uri.file(path.join(workspaceRoot, '.vscode', 'mcp.json'));
            const deployedConfig = await this.mcpDeployer.readExistingMcpConfig(mcpConfigUri);
            if (deployedConfig) {
              await this.mcpDeployer.generateMcpContextFile(
                deployedConfig,
                healthMap,
                workspaceRoot
              );
              this.logger.debug(MODULE, 'MCP context file generated after deployment', {
                serverCount: deployedConfig.mcpServers ? Object.keys(deployedConfig.mcpServers).length : 0,
              });
            } else {
              this.logger.debug(MODULE, 'MCP context file skipped — no deployed config found');
            }
          } catch (ctxErr) {
            this.logger.warn(MODULE, 'Failed to generate MCP context file', { error: String(ctxErr) });
          }
        }
      }

      if (this.isCancelled()) {
        return this.makeCancelledResult();
      }

      // ── Step 5: Verify deployment ──────────────────────────────────────
      this.setState(DeploymentState.Verifying);
      // Verification is done inline by the copier (post-copy check)

      // ── Step 6: Agent activation (fire-and-forget — must NOT block deploy) ──
      if (config.autoActivateAgent && copyResult.success) {
        this.agentActivator.activateAgent().catch((err) => {
          this.logger.error(MODULE, 'Agent activation failed', err);
        });
      }

      // ── Step 7: Save state ─────────────────────────────────────────────
      const duration = Date.now() - startTime;
      const result: IDeploymentResult = {
        success: copyResult.success,
        deployedFiles: copyResult.copied,
        skippedFiles: [...skippedFiles, ...copyResult.skipped],
        errors: copyResult.failed.map((f) => ({
          file: f.file,
          error: f.error,
          recoverable: f.recoverable,
        })),
        duration,
      };

      if (copyResult.success) {
        this.setState(DeploymentState.Completed);
        await this.saveDeploymentState(result);
        this.logger.info(MODULE, STRINGS.LOG_DEPLOY_COMPLETE, {
          files: copyResult.copied.length,
          duration: `${duration}ms`,
        });
      } else {
        this.setState(DeploymentState.Error);
        this.logger.error(MODULE, 'Deployment completed with errors', {
          failed: copyResult.failed.length,
        });
      }

      return result;
    } catch (err) {
      this.setState(DeploymentState.Error);
      this.logger.error(MODULE, 'Deployment failed with exception', err);
      return this.makeErrorResult(
        err instanceof Error ? err.message : 'Unknown deployment error'
      );
    } finally {
      // Cleanup cancellation source
      this.cancellationSource?.dispose();
      this.cancellationSource = null;
    }
  }

  cancel(): void {
    if (this.cancellationSource) {
      this.logger.info(MODULE, 'Deployment cancellation requested');
      this.cancellationSource.cancel();
      this.setState(DeploymentState.Cancelled);
    }
  }

  async getDeploymentStatus(): Promise<{
    deployed: boolean;
    lastDeployDate: Date | null;
    filesCount: number;
    mcpDeployed: boolean;
    lastMcpDeployDate: string | null;
    mcpServerCount: number;
    mcpServers: string[];
  }> {
    const lastDate = this.stateManager.getLastDeployDate();
    const files = this.stateManager.getDeployedFilesList();
    const mcpState = this.stateManager.getMcpDeploymentState();
    this.logger.debug(MODULE, 'getDeploymentStatus called', {
      deployed: lastDate !== null,
      filesCount: files.length,
      mcpDeployed: mcpState.deployedServers.length > 0,
      mcpServerCount: mcpState.deployedServers.length,
    });
    return {
      deployed: lastDate !== null,
      lastDeployDate: lastDate,
      filesCount: files.length,
      mcpDeployed: mcpState.deployedServers.length > 0,
      lastMcpDeployDate: mcpState.lastMcpDeployDate,
      mcpServerCount: mcpState.deployedServers.length,
      mcpServers: mcpState.deployedServers,
    };
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private filterFiles(allFiles: ITemplateFile[]): ITemplateFile[] {
    return allFiles.filter((file) => this.hookManager.shouldDeployHookFile(file.relativePath));
  }

  private setState(newState: DeploymentState): void {
    const oldState = this.currentState;
    this.currentState = newState;
    this.logger.debug(MODULE, `State: ${oldState} → ${newState}`);

    for (const handler of this.stateChangeHandlers) {
      try {
        handler(oldState, newState);
      } catch (err) {
        this.logger.error(MODULE, 'State change handler error', err);
      }
    }
  }

  private emitProgress(current: number, total: number, fileName: string): void {
    for (const handler of this.progressHandlers) {
      try {
        handler(current, total, fileName);
      } catch (err) {
        this.logger.error(MODULE, 'Progress handler error', err);
      }
    }
  }

  private emitMcpProgress(message: string, logType: string): void {
    this.logger.debug(MODULE, `MCP progress: [${logType}] ${message}`);
    for (const handler of this.progressHandlers) {
      try {
        handler(0, 0, `[MCP] ${message}`);
      } catch (err) {
        this.logger.error(MODULE, 'MCP progress handler error', err);
      }
    }
  }

  private isCancelled(): boolean {
    return this.cancellationSource?.token.isCancellationRequested ?? false;
  }

  private async saveDeploymentState(result: IDeploymentResult): Promise<void> {
    const now = new Date();
    await this.stateManager.setLastDeployDate(now);
    await this.stateManager.setDeployedFilesList(result.deployedFiles);
    await this.stateManager.incrementDeploymentCount();

    const mcpState = this.stateManager.getMcpDeploymentState();
    const historyEntry: IDeploymentHistory = {
      date: now.toISOString(),
      filesDeployed: result.deployedFiles.length,
      hooksEnabled: this.hookManager
        .getEnabledHooks()
        .map((h) => h.name),
      mcpServersDeployed: mcpState.deployedServers,
      duration: result.duration,
      success: result.success,
    };
    await this.stateManager.addDeploymentHistory(historyEntry);
  }

  private makeErrorResult(error: string): IDeploymentResult {
    return {
      success: false,
      deployedFiles: [],
      skippedFiles: [],
      errors: [{ file: '', error, recoverable: false }],
      duration: 0,
    };
  }

  private makeCancelledResult(): IDeploymentResult {
    this.setState(DeploymentState.Cancelled);
    return {
      success: false,
      deployedFiles: [],
      skippedFiles: [],
      errors: [{ file: '', error: 'Cancelled by user', recoverable: true }],
      duration: 0,
    };
  }
}
