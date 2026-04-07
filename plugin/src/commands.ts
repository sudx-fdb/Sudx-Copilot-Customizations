import * as vscode from 'vscode';
import { SudxLogger } from './utils/logger';
import { SudxSettings } from './config/settings';
import { DeploymentEngine } from './deployment/engine';
import { SudxWebviewProvider } from './webview/provider';
import { StatusBarManager } from './statusBar';
import { DeploymentState } from './types';
import { COMMANDS, STRINGS } from './constants';

const MODULE = 'Commands';

export class CommandRegistry {
  private logger: SudxLogger;
  private settings: SudxSettings;
  private engine: DeploymentEngine;
  private webviewProvider: SudxWebviewProvider;
  private statusBar: StatusBarManager;
  private context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];

  constructor(
    logger: SudxLogger,
    settings: SudxSettings,
    engine: DeploymentEngine,
    webviewProvider: SudxWebviewProvider,
    statusBar: StatusBarManager,
    context: vscode.ExtensionContext
  ) {
    this.logger = logger;
    this.settings = settings;
    this.engine = engine;
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
        this.logger.error(MODULE, `Command failed: ${command}`, err);
        vscode.window.showErrorMessage(STRINGS.ERR_DEPLOY_FAILED);
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
}
