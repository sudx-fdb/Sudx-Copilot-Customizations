import * as vscode from 'vscode';
import {
  IDeploymentConfig,
  IDeploymentResult,
  ITemplateFile,
  DeploymentState,
  DeploymentStateChangedHandler,
  ProgressCallback,
  IDeploymentHistory,
} from '../types';
import { SudxLogger } from '../utils/logger';
import { PathUtils } from '../utils/paths';
import { TemplateScanner } from './scanner';
import { FileCopier } from './copier';
import { HookManager } from './hooks';
import { AgentActivator } from './agent';
import { StateManager } from '../config/state';
import { STRINGS } from '../constants';

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
  private stateManager: StateManager;

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
    stateManager: StateManager
  ) {
    this.logger = logger;
    this.paths = paths;
    this.scanner = scanner;
    this.copier = copier;
    this.hookManager = hookManager;
    this.agentActivator = agentActivator;
    this.stateManager = stateManager;
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

    try {
      // Add timeout wrapper
      const result = await Promise.race([
        this.deployPromise,
        this.createTimeoutPromise(),
      ]);
      return result;
    } finally {
      // Release the lock
      this.deployPromise = null;
    }
  }

  /**
   * Creates a promise that resolves with an error result after DEPLOY_TIMEOUT_MS
   */
  private createTimeoutPromise(): Promise<IDeploymentResult> {
    return new Promise((resolve) => {
      setTimeout(() => {
        this.logger.error(MODULE, `Deployment timed out after ${DEPLOY_TIMEOUT_MS}ms`);
        this.cancel(); // Cancel the operation
        resolve(this.makeErrorResult('Deployment timed out'));
      }, DEPLOY_TIMEOUT_MS);
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

      this.logger.info(MODULE, 'Files filtered', {
        total: allFiles.length,
        deploy: filesToDeploy.length,
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
      const copyResult = await this.copier.copyFiles(
        filesToDeploy,
        targetRoot,
        (current, total, fileName) => {
          this.emitProgress(current, total, fileName);
        },
        this.cancellationSource.token
      );

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
  }> {
    const lastDate = this.stateManager.getLastDeployDate();
    const files = this.stateManager.getDeployedFilesList();
    return {
      deployed: lastDate !== null,
      lastDeployDate: lastDate,
      filesCount: files.length,
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

  private isCancelled(): boolean {
    return this.cancellationSource?.token.isCancellationRequested ?? false;
  }

  private async saveDeploymentState(result: IDeploymentResult): Promise<void> {
    const now = new Date();
    await this.stateManager.setLastDeployDate(now);
    await this.stateManager.setDeployedFilesList(result.deployedFiles);
    await this.stateManager.incrementDeploymentCount();

    const historyEntry: IDeploymentHistory = {
      date: now.toISOString(),
      filesDeployed: result.deployedFiles.length,
      hooksEnabled: this.hookManager
        .getEnabledHooks()
        .map((h) => h.name),
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
