import * as vscode from 'vscode';
import { IStatusBarState, IMcpHealthStatus } from './types';
import { SudxLogger } from './utils/logger';
import {
  COMMANDS,
  STATUS_BAR_PRIORITY,
  STATUS_BAR_TEXT,
  STATUS_BAR_TOOLTIP,
  CONFIG_SECTION,
  CONFIG_KEYS,
  UI_CONSTANTS,
  STRINGS,
} from './constants';

const MODULE = 'StatusBar';

export class StatusBarManager {
  private logger: SudxLogger;
  private statusBarItem: vscode.StatusBarItem;
  private currentState: IStatusBarState;
  private configDisposable: vscode.Disposable;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private _fileCount = 0;
  private _lastDeploy = '';
  private _mcpHealthStatuses: IMcpHealthStatus[] = [];

  constructor(logger: SudxLogger) {
    this.logger = logger;
    this.logger.debug(MODULE, 'Initializing status bar');

    this.currentState = { state: 'idle', message: '' };

    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      STATUS_BAR_PRIORITY
    );
    this.statusBarItem.command = COMMANDS.OPEN_PANEL;
    this.applyState();

    const showSetting = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<boolean>(CONFIG_KEYS.SHOW_STATUS_BAR, true);

    if (showSetting) {
      this.statusBarItem.show();
      this.logger.debug(MODULE, 'Status bar shown');
    }

    this.configDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEYS.SHOW_STATUS_BAR}`)) {
        const show = vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<boolean>(CONFIG_KEYS.SHOW_STATUS_BAR, true);
        if (show) {
          this.statusBarItem.show();
        } else {
          this.statusBarItem.hide();
        }
        this.logger.debug(MODULE, `Status bar visibility changed: ${show}`);
      }
    });
  }

  setState(state: IStatusBarState['state']): void {
    this.logger.debug(MODULE, `State transition: ${this.currentState.state} → ${state}`);
    this.currentState.state = state;
    this.applyState();

    // Clear existing reset timer
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    // Auto-reset from deployed/error back to idle
    if (state === 'deployed' || state === 'error') {
      this.resetTimer = setTimeout(() => {
        if (this.currentState.state === state) {
          this.logger.debug(MODULE, `Auto-reset from ${state} to idle`);
          this.setState('idle');
        }
      }, UI_CONSTANTS.STATUS_BAR_RESET_MS);
    }
  }

  setProgress(percent: number): void {
    if (this.currentState.state === 'deploying') {
      const clampedPercent = Math.max(0, Math.min(100, Math.round(percent)));
      this.statusBarItem.text = `$(sync~spin) Sudx CC: ${clampedPercent}%`;
      this.logger.debug(MODULE, `Progress updated: ${clampedPercent}%`);
    }
  }

  setDeployInfo(fileCount: number, lastDeploy: string): void {
    this._fileCount = fileCount;
    this._lastDeploy = lastDeploy;
    this.applyState(); // Refresh tooltip with new info
    this.logger.debug(MODULE, 'Deploy info updated', { fileCount, lastDeploy });
  }

  updateMcpHealth(statuses: IMcpHealthStatus[]): void {
    this._mcpHealthStatuses = statuses;
    this.applyState(); // Refresh tooltip with MCP health
    this.logger.debug(MODULE, 'MCP health updated in status bar', { count: statuses.length });
  }

  getDisposable(): vscode.Disposable {
    return vscode.Disposable.from(this.statusBarItem, this.configDisposable);
  }

  dispose(): void {
    this.logger.debug(MODULE, 'Disposing status bar');
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    this.statusBarItem.dispose();
    this.configDisposable.dispose();
  }

  private applyState(): void {
    this.statusBarItem.text = STATUS_BAR_TEXT[this.currentState.state];

    // Tooltip with details
    const baseTooltip = STATUS_BAR_TOOLTIP[this.currentState.state];
    const parts: string[] = [baseTooltip];
    if (this._fileCount > 0 && this._lastDeploy) {
      parts.push(`${this._fileCount} files, last: ${this._lastDeploy}`);
    }
    if (this._mcpHealthStatuses.length > 0) {
      const mcpLine = STRINGS.MCP_HEALTH_SUMMARY(this._mcpHealthStatuses);
      parts.push(mcpLine);
    }
    this.statusBarItem.tooltip = parts.join('\n');

    switch (this.currentState.state) {
      case 'deployed':
        this.statusBarItem.backgroundColor = undefined;
        break;
      case 'error':
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.errorBackground'
        );
        break;
      case 'deploying':
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        break;
      default:
        this.statusBarItem.backgroundColor = undefined;
    }

    this.logger.debug(MODULE, `State applied: ${this.currentState.state}`, {
      text: this.statusBarItem.text,
    });
  }
}
