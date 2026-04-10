import * as vscode from 'vscode';
import { SudxLogger } from './utils/logger';
import { SudxSettings } from './config/settings';
import { DeploymentEngine } from './deployment/engine';
import { McpDeployer } from './deployment/mcpDeployer';
import { McpLifecycleManager } from './mcp/lifecycleManager';
import { StateManager } from './config/state';
import { SudxWebviewProvider } from './webview/provider';
import { StatusBarManager } from './statusBar';
import { DeploymentState } from './types';
import { COMMANDS, STRINGS, VALID_MCP_SERVERS } from './constants';

const MODULE = 'Commands';

export class CommandRegistry {
  private logger: SudxLogger;
  private settings: SudxSettings;
  private engine: DeploymentEngine;
  private mcpDeployer: McpDeployer;
  private lifecycleManager: McpLifecycleManager;
  private stateManager: StateManager;
  private webviewProvider: SudxWebviewProvider;
  private statusBar: StatusBarManager;
  private context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];

  constructor(
    logger: SudxLogger,
    settings: SudxSettings,
    engine: DeploymentEngine,
    mcpDeployer: McpDeployer,
    lifecycleManager: McpLifecycleManager,
    stateManager: StateManager,
    webviewProvider: SudxWebviewProvider,
    statusBar: StatusBarManager,
    context: vscode.ExtensionContext
  ) {
    this.logger = logger;
    this.settings = settings;
    this.engine = engine;
    this.mcpDeployer = mcpDeployer;
    this.lifecycleManager = lifecycleManager;
    this.stateManager = stateManager;
    this.webviewProvider = webviewProvider;
    this.statusBar = statusBar;
    this.context = context;
  }

  registerAll(): void {
    this.logger.debug(MODULE, 'Registering commands');

    this.register(COMMANDS.OPEN_PANEL, () => this.handleOpenPanel());
    this.register(COMMANDS.DEPLOY, () => this.handleDeploy());
    this.register(COMMANDS.RESET_CONFIG, () => this.handleResetConfig());
    this.register(COMMANDS.SHOW_LOG, () => this.handleShowLog());
    this.register(COMMANDS.ROLLBACK_MCP, () => this.handleRollbackMcp());
    this.register(COMMANDS.MCP_START, () => this.handleMcpLifecycle('start'));
    this.register(COMMANDS.MCP_STOP, () => this.handleMcpLifecycle('stop'));
    this.register(COMMANDS.MCP_RESTART, () => this.handleMcpLifecycle('restart'));
    this.register(COMMANDS.MCP_STATUS, () => this.handleMcpStatus());

    this.logger.info(MODULE, `Registered ${this.disposables.length} commands`);
  }

  getDisposables(): vscode.Disposable[] {
    return this.disposables;
  }

  private register(command: string, handler: () => void | Promise<void>): void {
    const disposable = vscode.commands.registerCommand(command, async () => {
      this.logger.debug(MODULE, `Command triggered: ${command}`);
      try {
        await handler();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(MODULE, `Command failed: ${command}`, err);
        vscode.window.showErrorMessage(`Sudx CC: Command '${command}' failed: ${message}`);
      }
    });
    this.disposables.push(disposable);
  }

  // ─── Command Handlers ──────────────────────────────────────────────────

  private handleOpenPanel(): void {
    this.logger.debug(MODULE, 'Opening webview panel');
    this.webviewProvider.createOrShowPanel();
  }

  private async handleDeploy(): Promise<void> {
    // Guard: workspace must be open
    if (
      !vscode.workspace.workspaceFolders ||
      vscode.workspace.workspaceFolders.length === 0
    ) {
      vscode.window.showWarningMessage(STRINGS.NOTIFY_NO_WORKSPACE);
      return;
    }

    // Guard: no concurrent deployments
    if (this.engine.getState() === DeploymentState.Deploying) {
      vscode.window.showInformationMessage(STRINGS.NOTIFY_DEPLOY_IN_PROGRESS);
      return;
    }

    this.statusBar.setState('deploying');

    const config = {
      hookConfig: this.settings.getHookConfig(),
      autoActivateAgent: this.settings.getAutoActivateAgent(),
      deployPath: this.settings.getDeployPath(),
    };

    const result = await this.engine.deploy(config, this.context);

    if (result.success) {
      this.statusBar.setState('deployed');
      vscode.window.showInformationMessage(
        STRINGS.NOTIFY_DEPLOY_SUCCESS(result.deployedFiles.length)
      );
    } else {
      this.statusBar.setState('error');
      vscode.window.showErrorMessage(STRINGS.NOTIFY_DEPLOY_FAILED);
    }
  }

  private async handleResetConfig(): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      'Reset all Sudx Copilot Customizations settings to defaults?',
      { modal: true },
      'Reset'
    );

    if (answer !== 'Reset') {
      return;
    }

    await this.settings.resetAll();
    vscode.window.showInformationMessage(STRINGS.NOTIFY_RESET_COMPLETE);
    this.logger.info(MODULE, 'Configuration reset to defaults');
  }

  private handleShowLog(): void {
    this.logger.show();
  }

  private async handleRollbackMcp(): Promise<void> {
    this.logger.debug(MODULE, 'MCP rollback command triggered');
    const mcpState = this.stateManager.getMcpDeploymentState();

    if (!mcpState.mcpConfigBackupPath) {
      this.logger.warn(MODULE, 'No MCP backup path available for rollback');
      vscode.window.showWarningMessage(STRINGS.MCP_ROLLBACK_NO_BACKUP);
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      STRINGS.MCP_ROLLBACK_CONFIRM,
      { modal: true },
      'Rollback'
    );

    if (answer !== 'Rollback') {
      this.logger.debug(MODULE, 'MCP rollback cancelled by user');
      return;
    }

    const result = await this.mcpDeployer.rollbackMcpConfig(mcpState.mcpConfigBackupPath);
    if (result.success) {
      // Clear MCP deployment state after successful rollback
      await this.stateManager.setMcpDeploymentState({
        lastMcpDeployDate: null,
        deployedServers: [],
        mcpConfigBackupPath: null,
        mergeConflicts: [],
      });
      vscode.window.showInformationMessage(STRINGS.MCP_ROLLBACK_SUCCESS);
      this.logger.info(MODULE, 'MCP config rolled back successfully');
    } else {
      vscode.window.showErrorMessage(STRINGS.MCP_ROLLBACK_FAILED);
      this.logger.error(MODULE, 'MCP rollback failed', { error: result.error });
    }
  }

  private async handleMcpLifecycle(action: 'start' | 'stop' | 'restart'): Promise<void> {
    this.logger.debug(MODULE, `MCP lifecycle command: ${action}`);

    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      vscode.window.showWarningMessage(STRINGS.NOTIFY_NO_WORKSPACE);
      return;
    }

    const serverName = await this.pickMcpServer();
    if (!serverName) {
      this.logger.debug(MODULE, 'MCP lifecycle cancelled — no server selected');
      return;
    }

    let result: { success: boolean; error?: string };
    switch (action) {
      case 'start':
        result = await this.lifecycleManager.startServer(serverName);
        break;
      case 'stop':
        result = await this.lifecycleManager.stopServer(serverName);
        break;
      case 'restart':
        result = await this.lifecycleManager.restartServer(serverName);
        break;
    }

    if (result.success) {
      const msg = action === 'start'
        ? STRINGS.MCP_LIFECYCLE_SERVER_STARTED(serverName)
        : action === 'stop'
          ? STRINGS.MCP_LIFECYCLE_SERVER_STOPPED(serverName)
          : STRINGS.MCP_LIFECYCLE_SERVER_RESTARTED(serverName);
      vscode.window.showInformationMessage(msg);
    } else {
      vscode.window.showErrorMessage(STRINGS.MCP_LIFECYCLE_START_FAILED(serverName) + (result.error ? `: ${result.error}` : ''));
    }
  }

  private async handleMcpStatus(): Promise<void> {
    this.logger.debug(MODULE, 'MCP status command triggered');

    const statuses: string[] = [];
    for (const name of VALID_MCP_SERVERS) {
      const runtime = await this.lifecycleManager.getServerStatus(name);
      const icon = runtime.status === 'running' ? '$(check)' : '$(circle-slash)';
      statuses.push(`${icon} ${name}: ${runtime.status}`);
    }

    vscode.window.showInformationMessage(`MCP Servers: ${statuses.join(' | ')}`);
  }

  private async pickMcpServer(): Promise<string | undefined> {
    const items = VALID_MCP_SERVERS.map(name => ({ label: name }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: STRINGS.MCP_LIFECYCLE_PICK_SERVER,
    });
    return picked?.label;
  }
}
