import * as vscode from 'vscode';
import {
  IDeploymentHistory,
  IHookConfig,
  IMcpDeploymentState,
  IMcpHealthStatus,
} from '../types';
import { SudxLogger } from '../utils/logger';
import {
  STATE_KEYS,
  CURRENT_STATE_VERSION,
  MAX_HISTORY_ENTRIES,
  VALID_MCP_SERVERS,
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

  // ─── MCP Deployment State ─────────────────────────────────────────────────

  getMcpDeploymentState(): IMcpDeploymentState {
    this.logger.debug(MODULE, 'Reading MCP deployment state');
    const dateRaw = this.workspaceGet<string>(STATE_KEYS.MCP_DEPLOY_DATE);
    const servers = this.workspaceGet<string[]>(STATE_KEYS.MCP_DEPLOYED_SERVERS);
    const backup = this.workspaceGet<string>(STATE_KEYS.MCP_CONFIG_BACKUP);
    const conflicts = this.workspaceGet<string[]>(STATE_KEYS.MCP_MERGE_CONFLICTS);

    const state: IMcpDeploymentState = {
      lastMcpDeployDate: typeof dateRaw === 'string' ? dateRaw : null,
      deployedServers: Array.isArray(servers) ? servers : [],
      mcpConfigBackupPath: typeof backup === 'string' ? backup : null,
      mergeConflicts: Array.isArray(conflicts) ? conflicts : [],
    };
    this.logger.debug(MODULE, 'MCP deployment state read', state);
    return state;
  }

  async setMcpDeploymentState(state: IMcpDeploymentState): Promise<void> {
    this.logger.debug(MODULE, 'Setting MCP deployment state', state);
    try {
      await this.workspaceSet(STATE_KEYS.MCP_DEPLOY_DATE, state.lastMcpDeployDate);
      await this.workspaceSet(STATE_KEYS.MCP_DEPLOYED_SERVERS, state.deployedServers);
      await this.workspaceSet(STATE_KEYS.MCP_CONFIG_BACKUP, state.mcpConfigBackupPath);
      await this.workspaceSet(STATE_KEYS.MCP_MERGE_CONFLICTS, state.mergeConflicts);
      this.logger.debug(MODULE, 'MCP deployment state saved successfully');
    } catch (err) {
      this.logger.error(MODULE, 'Failed to save MCP deployment state', err);
      throw err;
    }
  }

  // ─── MCP Health Cache ─────────────────────────────────────────────────

  getMcpHealthCache(): IMcpHealthStatus[] {
    this.logger.debug(MODULE, 'Reading MCP health cache');
    const cached = this.workspaceGet<IMcpHealthStatus[]>(STATE_KEYS.MCP_HEALTH_CACHE);
    if (!Array.isArray(cached)) {
      return [];
    }
    const valid = cached.filter(s => VALID_MCP_SERVERS.includes(s.serverName));
    if (valid.length < cached.length) {
      const stale = cached.filter(s => !VALID_MCP_SERVERS.includes(s.serverName));
      this.logger.warn(MODULE, `Filtered ${stale.length} stale health cache entries`, {
        removed: stale.map(s => s.serverName),
      });
    }
    return valid;
  }

  async setMcpHealthCache(statuses: IMcpHealthStatus[]): Promise<void> {
    const validated = statuses.filter(s => VALID_MCP_SERVERS.includes(s.serverName));
    if (validated.length < statuses.length) {
      this.logger.warn(MODULE, `Rejected ${statuses.length - validated.length} invalid health entries on write`, {
        rejected: statuses.filter(s => !VALID_MCP_SERVERS.includes(s.serverName)).map(s => s.serverName),
      });
    }
    this.logger.debug(MODULE, 'Caching MCP health statuses', { count: validated.length });
    await this.workspaceSet(STATE_KEYS.MCP_HEALTH_CACHE, validated);
  }

  getMcpTemplateVersion(): string {
    return this.workspaceGet<string>(STATE_KEYS.MCP_TEMPLATE_VERSION) ?? '0.0.0';
  }

  async setMcpTemplateVersion(version: string): Promise<void> {
    this.logger.debug(MODULE, 'Storing MCP template version', { version });
    await this.workspaceSet(STATE_KEYS.MCP_TEMPLATE_VERSION, version);
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

      // Clear stale health cache entries from previous versions (e.g., removed servers like figma)
      const cached = this.workspaceGet<IMcpHealthStatus[]>(STATE_KEYS.MCP_HEALTH_CACHE);
      if (Array.isArray(cached)) {
        const valid = cached.filter(s => VALID_MCP_SERVERS.includes(s.serverName));
        if (valid.length < cached.length) {
          this.logger.info(MODULE, `Migration: cleared ${cached.length - valid.length} stale health cache entries`);
          void this.workspaceSet(STATE_KEYS.MCP_HEALTH_CACHE, valid);
        }
      }

      void this.workspaceSet(STATE_KEYS.STATE_VERSION, CURRENT_STATE_VERSION);
      this.logger.info(MODULE, 'State migration complete');
    }
  }
}
