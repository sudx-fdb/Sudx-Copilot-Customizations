import * as vscode from 'vscode';
import {
  IDeploymentHistory,
  IHookConfig,
} from '../types';
import { SudxLogger } from '../utils/logger';
import {
  STATE_KEYS,
  CURRENT_STATE_VERSION,
  MAX_HISTORY_ENTRIES,
} from '../constants';

const MODULE = 'State';

export class StateManager {
  private context: vscode.ExtensionContext;
  private logger: SudxLogger;

  constructor(context: vscode.ExtensionContext, logger: SudxLogger) {
    this.context = context;
    this.logger = logger;
    this.logger.debug(MODULE, 'StateManager initialized');
    this.migrateIfNeeded();
  }

  // ─── Workspace State ──────────────────────────────────────────────────────

  getLastDeployDate(): Date | null {
    const value = this.workspaceGet<string>(STATE_KEYS.LAST_DEPLOY_DATE);
    if (!value) {
      return null;
    }
    try {
      const date = new Date(value);
      if (isNaN(date.getTime())) {
        return null;
      }
      return date;
    } catch {
      return null;
    }
  }

  async setLastDeployDate(date: Date): Promise<void> {
    this.logger.debug(MODULE, 'Setting last deploy date', { date: date.toISOString() });
    await this.workspaceSet(STATE_KEYS.LAST_DEPLOY_DATE, date.toISOString());
  }

  getDeploymentHistory(): IDeploymentHistory[] {
    const value = this.workspaceGet<IDeploymentHistory[]>(STATE_KEYS.DEPLOY_HISTORY);
    if (!Array.isArray(value)) {
      return [];
    }
    return value;
  }

  async addDeploymentHistory(entry: IDeploymentHistory): Promise<void> {
    this.logger.debug(MODULE, 'Adding deployment history entry', entry);
    const history = this.getDeploymentHistory();
    history.unshift(entry);

    if (history.length > MAX_HISTORY_ENTRIES) {
      const removedCount = history.length - MAX_HISTORY_ENTRIES;
      this.logger.debug(MODULE, `Truncating history: removing ${removedCount} oldest entries`);
      history.splice(MAX_HISTORY_ENTRIES);
    }

    await this.workspaceSet(STATE_KEYS.DEPLOY_HISTORY, history);
    this.logger.debug(MODULE, 'History updated', { entries: history.length });
  }

  getDeployedFilesList(): string[] {
    const value = this.workspaceGet<string[]>(STATE_KEYS.DEPLOYED_FILES);
    if (!Array.isArray(value)) {
      return [];
    }
    return value;
  }

  async setDeployedFilesList(files: string[]): Promise<void> {
    this.logger.debug(MODULE, 'Setting deployed files list', { count: files.length });
    await this.workspaceSet(STATE_KEYS.DEPLOYED_FILES, files);
  }

  getCachedHookConfig(): IHookConfig | null {
    return this.workspaceGet<IHookConfig>(STATE_KEYS.CACHED_HOOK_CONFIG) ?? null;
  }

  async setCachedHookConfig(config: IHookConfig): Promise<void> {
    this.logger.debug(MODULE, 'Caching hook config', config);
    await this.workspaceSet(STATE_KEYS.CACHED_HOOK_CONFIG, config);
  }

  // ─── Global State ─────────────────────────────────────────────────────────

  getExtensionVersion(): string | undefined {
    return this.globalGet<string>(STATE_KEYS.EXTENSION_VERSION);
  }

  async setExtensionVersion(version: string): Promise<void> {
    await this.globalSet(STATE_KEYS.EXTENSION_VERSION, version);
  }

  getFirstInstallDate(): Date | null {
    const value = this.globalGet<string>(STATE_KEYS.FIRST_INSTALL_DATE);
    if (!value) {
      return null;
    }
    try {
      const date = new Date(value);
      return isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  }

  async setFirstInstallDate(date: Date): Promise<void> {
    await this.globalSet(STATE_KEYS.FIRST_INSTALL_DATE, date.toISOString());
  }

  getDeploymentCount(): number {
    return this.globalGet<number>(STATE_KEYS.DEPLOYMENT_COUNT) ?? 0;
  }

  async incrementDeploymentCount(): Promise<void> {
    const count = this.getDeploymentCount() + 1;
    await this.globalSet(STATE_KEYS.DEPLOYMENT_COUNT, count);
    this.logger.debug(MODULE, 'Deployment count incremented', { count });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  isFirstRun(): boolean {
    return this.getLastDeployDate() === null;
  }

  isVersionUpgrade(): boolean {
    const stored = this.getExtensionVersion();
    const current = process.env.EXTENSION_VERSION;
    return stored !== undefined && stored !== current;
  }

  async clearHistory(): Promise<void> {
    this.logger.info(MODULE, 'Clearing deployment history');
    await this.workspaceSet(STATE_KEYS.DEPLOY_HISTORY, []);
  }

  async resetState(scope: 'workspace' | 'global' | 'all'): Promise<void> {
    this.logger.info(MODULE, `Resetting state: ${scope}`);

    if (scope === 'workspace' || scope === 'all') {
      await this.workspaceSet(STATE_KEYS.LAST_DEPLOY_DATE, undefined);
      await this.workspaceSet(STATE_KEYS.DEPLOY_HISTORY, undefined);
      await this.workspaceSet(STATE_KEYS.DEPLOYED_FILES, undefined);
      await this.workspaceSet(STATE_KEYS.CACHED_HOOK_CONFIG, undefined);
    }

    if (scope === 'global' || scope === 'all') {
      await this.globalSet(STATE_KEYS.DEPLOYMENT_COUNT, undefined);
    }

    this.logger.info(MODULE, 'State reset complete');
  }

  dumpState(): { workspace: Record<string, unknown>; global: Record<string, unknown> } {
    return {
      workspace: {
        lastDeployDate: this.workspaceGet(STATE_KEYS.LAST_DEPLOY_DATE),
        deployHistory: this.workspaceGet(STATE_KEYS.DEPLOY_HISTORY),
        deployedFiles: this.workspaceGet(STATE_KEYS.DEPLOYED_FILES),
        cachedHookConfig: this.workspaceGet(STATE_KEYS.CACHED_HOOK_CONFIG),
        stateVersion: this.workspaceGet(STATE_KEYS.STATE_VERSION),
      },
      global: {
        extensionVersion: this.globalGet(STATE_KEYS.EXTENSION_VERSION),
        firstInstallDate: this.globalGet(STATE_KEYS.FIRST_INSTALL_DATE),
        deploymentCount: this.globalGet(STATE_KEYS.DEPLOYMENT_COUNT),
      },
    };
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private workspaceGet<T>(key: string): T | undefined {
    return this.context.workspaceState.get<T>(key);
  }

  private async workspaceSet<T>(key: string, value: T): Promise<void> {
    await this.context.workspaceState.update(key, value);
  }

  private globalGet<T>(key: string): T | undefined {
    return this.context.globalState.get<T>(key);
  }

  private async globalSet<T>(key: string, value: T): Promise<void> {
    await this.context.globalState.update(key, value);
  }

  private migrateIfNeeded(): void {
    const currentVersion = this.workspaceGet<number>(STATE_KEYS.STATE_VERSION) ?? 0;
    if (currentVersion < CURRENT_STATE_VERSION) {
      this.logger.info(MODULE, `State migration from v${currentVersion} to v${CURRENT_STATE_VERSION}`);
      this.logger.debug(MODULE, 'Pre-migration state dump', this.dumpState());
      // Fire-and-forget is acceptable here - worst case is migration runs again on next startup
      void this.workspaceSet(STATE_KEYS.STATE_VERSION, CURRENT_STATE_VERSION);
      this.logger.info(MODULE, 'State migration complete');
    }
  }
}
