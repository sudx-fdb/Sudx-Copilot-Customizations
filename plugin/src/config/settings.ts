import * as vscode from 'vscode';
import {
  IHookConfig,
  IMcpServerConfig,
  IExtensionSettings,
  IUiSettings,
  LogLevel,
  SettingsChangedHandler,
} from '../types';
import { SudxLogger } from '../utils/logger';
import {
  CONFIG_SECTION,
  CONFIG_KEYS,
  DEFAULT_HOOKS,
  DEFAULT_MCP_SERVERS,
  VALID_MCP_SERVERS,
  DEFAULT_DEPLOY_PATH,
  DEFAULT_AUTO_ACTIVATE_AGENT,
  DEFAULT_SHOW_STATUS_BAR,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MCP_DEPLOY_MODE,
  VALID_MCP_DEPLOY_MODES,
  DEPLOY_PATH_ALLOWED_CHARS,
  DEPLOY_PATH_MAX_LENGTH,
  DEPLOY_PATH_BLOCKLIST,
  VALID_HOOKS,
  FEATURES,
} from '../constants';

const MODULE = 'Settings';

const DEFAULT_UI_SETTINGS: IUiSettings = {
  matrixRain: FEATURES.MATRIX_RAIN,
  crtOverlay: FEATURES.CRT_OVERLAY,
  animations: true,
};

const UI_CONFIG_KEYS = {
  MATRIX_RAIN: 'ui.matrixRain',
  CRT_OVERLAY: 'ui.crtOverlay',
  ANIMATIONS: 'ui.animations',
} as const;

export class SudxSettings {
  private logger: SudxLogger;
  private disposable: vscode.Disposable;
  private changeHandlers: SettingsChangedHandler[] = [];
  private _cachedValues: Map<string, unknown> = new Map();

  constructor(logger: SudxLogger) {
    this.logger = logger;
    this.logger.debug(MODULE, 'Initializing settings');

    // Cache initial values for old/new comparison
    this._cacheCurrentValues();

    this.disposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        this.logger.debug(MODULE, 'Configuration changed');
        this.notifyChangeHandlers(e);
      }
    });
  }

  getDisposable(): vscode.Disposable {
    return this.disposable;
  }

  onSettingsChanged(handler: SettingsChangedHandler): void {
    this.changeHandlers.push(handler);
  }

  // ─── Getters ─────────────────────────────────────────────────────────────

  getHookConfig(): IHookConfig {
    this.logger.debug(MODULE, 'Getting hook config');
    const config = this.getConfig();
    const raw = config.get<Record<string, unknown>>(CONFIG_KEYS.HOOKS);

    if (!raw || typeof raw !== 'object') {
      this.logger.warn(MODULE, 'Invalid hook config — using defaults');
      return { ...DEFAULT_HOOKS };
    }

    const result: IHookConfig = { ...DEFAULT_HOOKS };
    const validKeys = VALID_HOOKS as string[];

    // Log unknown keys
    for (const rawKey of Object.keys(raw)) {
      if (!validKeys.includes(rawKey)) {
        this.logger.warn(MODULE, `Unknown hook config key ignored: "${rawKey}"`, {
          knownKeys: validKeys,
        });
      }
    }

    for (const key of validKeys) {
      const hookKey = key as keyof IHookConfig;
      const value = raw[hookKey];
      if (typeof value === 'boolean') {
        result[hookKey] = value;
      } else if (value !== undefined) {
        this.logger.warn(MODULE, `Invalid hook value for ${hookKey} — using default`, {
          value,
          type: typeof value,
        });
      }
    }

    this.logger.debug(MODULE, 'Hook config resolved', result);
    return result;
  }

  getAutoActivateAgent(): boolean {
    this.logger.debug(MODULE, 'Getting autoActivateAgent');
    const value = this.getConfig().get<unknown>(CONFIG_KEYS.AUTO_ACTIVATE_AGENT);
    if (typeof value !== 'boolean') {
      if (value !== undefined) {
        this.logger.warn(MODULE, 'Invalid autoActivateAgent value — using default', {
          value,
        });
      }
      return DEFAULT_AUTO_ACTIVATE_AGENT;
    }
    return value;
  }

  getDeployPath(): string {
    this.logger.debug(MODULE, 'Getting deploy path');
    const value = this.getConfig().get<unknown>(CONFIG_KEYS.DEPLOY_PATH);

    if (typeof value !== 'string' || !value) {
      if (value !== undefined) {
        this.logger.warn(MODULE, 'Invalid deploy path — using default', { value });
      }
      return DEFAULT_DEPLOY_PATH;
    }

    if (!this.isValidDeployPath(value)) {
      this.logger.warn(MODULE, 'Deploy path failed validation — using default', {
        value,
      });
      return DEFAULT_DEPLOY_PATH;
    }

    return value;
  }

  getShowStatusBar(): boolean {
    this.logger.debug(MODULE, 'Getting showStatusBar');
    const value = this.getConfig().get<unknown>(CONFIG_KEYS.SHOW_STATUS_BAR);
    if (typeof value !== 'boolean') {
      return DEFAULT_SHOW_STATUS_BAR;
    }
    return value;
  }

  getLogLevel(): LogLevel {
    this.logger.debug(MODULE, 'Getting log level');
    const value = this.getConfig().get<unknown>(CONFIG_KEYS.LOG_LEVEL);
    if (
      typeof value !== 'string' ||
      !Object.values(LogLevel).includes(value.toLowerCase() as LogLevel)
    ) {
      if (value !== undefined) {
        this.logger.warn(MODULE, 'Invalid log level — using default', { value });
      }
      return DEFAULT_LOG_LEVEL;
    }
    return value.toLowerCase() as LogLevel;
  }

  getMcpDeployMode(): 'merge' | 'overwrite' | 'skip' {
    this.logger.debug(MODULE, 'Getting MCP deploy mode');
    const value = this.getConfig().get<unknown>(CONFIG_KEYS.MCP_DEPLOY_MODE);
    if (
      typeof value !== 'string' ||
      !(VALID_MCP_DEPLOY_MODES as readonly string[]).includes(value)
    ) {
      if (value !== undefined) {
        this.logger.warn(MODULE, 'Invalid mcpDeployMode — using default', { value });
      }
      return DEFAULT_MCP_DEPLOY_MODE;
    }
    return value as 'merge' | 'overwrite' | 'skip';
  }

  getMcpHealthCheckInterval(): number {
    this.logger.debug(MODULE, 'Getting MCP health check interval');
    const value = this.getConfig().get<unknown>('mcpHealthCheckInterval');
    if (typeof value !== 'number' || value < 10 || value > 300) {
      if (value !== undefined) {
        this.logger.warn(MODULE, 'Invalid mcpHealthCheckInterval — using default 60', { value });
      }
      return 60;
    }
    return value;
  }

  getMcpServerConfig(): IMcpServerConfig {
    this.logger.debug(MODULE, 'Getting MCP server config');
    const config = this.getConfig();
    const raw = config.get<Record<string, unknown>>(CONFIG_KEYS.MCP_SERVERS);

    if (!raw || typeof raw !== 'object') {
      this.logger.warn(MODULE, 'Invalid MCP server config — using defaults');
      return { ...DEFAULT_MCP_SERVERS };
    }

    const result: IMcpServerConfig = { ...DEFAULT_MCP_SERVERS };

    for (const rawKey of Object.keys(raw)) {
      if (!VALID_MCP_SERVERS.includes(rawKey)) {
        this.logger.warn(MODULE, `Unknown MCP server key ignored: "${rawKey}"`, {
          knownKeys: VALID_MCP_SERVERS,
        });
      }
    }

    for (const key of VALID_MCP_SERVERS) {
      const value = raw[key];
      if (typeof value === 'boolean') {
        result[key] = value;
      } else if (value !== undefined) {
        this.logger.warn(MODULE, `Invalid MCP server value for ${key} — using default`, {
          value,
          type: typeof value,
        });
      }
    }

    this.logger.debug(MODULE, 'MCP server config resolved', result);
    return result;
  }

  getMcpAllowLocalhost(): boolean {
    this.logger.debug(MODULE, 'Getting mcpAllowLocalhost');
    const value = this.getConfig().get<unknown>(CONFIG_KEYS.MCP_ALLOW_LOCALHOST);
    if (typeof value !== 'boolean') {
      return false;
    }
    return value;
  }

  getUiSettings(): IUiSettings {
    this.logger.debug(MODULE, 'Getting UI settings (batch read)');
    const config = this.getConfig();
    const result: IUiSettings = { ...DEFAULT_UI_SETTINGS };

    try {
      const uiSection = config.get<Record<string, unknown>>('ui');
      if (uiSection && typeof uiSection === 'object') {
        if (typeof uiSection.matrixRain === 'boolean') {
          result.matrixRain = uiSection.matrixRain;
        }
        if (typeof uiSection.crtOverlay === 'boolean') {
          result.crtOverlay = uiSection.crtOverlay;
        }
        if (typeof uiSection.animations === 'boolean') {
          result.animations = uiSection.animations;
        }
      } else {
        // Fallback: read individually
        const matrixRain = config.get<unknown>(UI_CONFIG_KEYS.MATRIX_RAIN);
        if (typeof matrixRain === 'boolean') { result.matrixRain = matrixRain; }

        const crtOverlay = config.get<unknown>(UI_CONFIG_KEYS.CRT_OVERLAY);
        if (typeof crtOverlay === 'boolean') { result.crtOverlay = crtOverlay; }

        const animations = config.get<unknown>(UI_CONFIG_KEYS.ANIMATIONS);
        if (typeof animations === 'boolean') { result.animations = animations; }
      }
    } catch (err) {
      this.logger.error(MODULE, 'Failed to read UI settings — using defaults', err);
      return { ...DEFAULT_UI_SETTINGS };
    }

    this.logger.debug(MODULE, 'UI settings resolved', result);
    return result;
  }

  getAllSettings(): IExtensionSettings {
    return {
      hooks: this.getHookConfig(),
      autoActivateAgent: this.getAutoActivateAgent(),
      deployPath: this.getDeployPath(),
      showStatusBar: this.getShowStatusBar(),
      logLevel: this.getLogLevel(),
      mcpDeployMode: this.getMcpDeployMode(),
    };
  }

  // ─── Setters ─────────────────────────────────────────────────────────────

  async setUiSettings(settings: Partial<IUiSettings>): Promise<void> {
    this.logger.debug(MODULE, 'Setting UI settings', settings);
    const config = this.getConfig();
    const target = vscode.ConfigurationTarget.Workspace;

    try {
      if (typeof settings.matrixRain === 'boolean') {
        await config.update(UI_CONFIG_KEYS.MATRIX_RAIN, settings.matrixRain, target);
      }
      if (typeof settings.crtOverlay === 'boolean') {
        await config.update(UI_CONFIG_KEYS.CRT_OVERLAY, settings.crtOverlay, target);
      }
      if (typeof settings.animations === 'boolean') {
        await config.update(UI_CONFIG_KEYS.ANIMATIONS, settings.animations, target);
      }
      this.logger.info(MODULE, 'UI settings updated', settings);
    } catch (err) {
      this.logger.error(MODULE, 'Failed to update UI settings', err);
    }
  }

  async setHookConfig(config: IHookConfig): Promise<void> {
    this.logger.debug(MODULE, 'Setting hook config', config);
    const validated: IHookConfig = { ...DEFAULT_HOOKS };
    for (const key of VALID_HOOKS) {
      const hookKey = key as keyof IHookConfig;
      if (typeof config[hookKey] === 'boolean') {
        validated[hookKey] = config[hookKey];
      }
    }
    await this.getConfig().update(
      CONFIG_KEYS.HOOKS,
      validated,
      vscode.ConfigurationTarget.Workspace
    );
    this.logger.info(MODULE, 'Hook config updated', validated);
  }

  async setMcpServerConfig(config: IMcpServerConfig): Promise<void> {
    this.logger.debug(MODULE, 'Setting MCP server config', config);
    const validated: IMcpServerConfig = { ...DEFAULT_MCP_SERVERS };
    for (const key of VALID_MCP_SERVERS) {
      if (typeof config[key] === 'boolean') {
        validated[key] = config[key];
      }
    }
    await this.getConfig().update(
      CONFIG_KEYS.MCP_SERVERS,
      validated,
      vscode.ConfigurationTarget.Workspace
    );
    this.logger.info(MODULE, 'MCP server config updated', validated);
  }

  async setAutoActivateAgent(value: boolean): Promise<void> {
    this.logger.debug(MODULE, 'Setting autoActivateAgent', { value });
    if (typeof value !== 'boolean') {
      this.logger.warn(MODULE, 'Rejected non-boolean autoActivateAgent');
      return;
    }
    await this.getConfig().update(
      CONFIG_KEYS.AUTO_ACTIVATE_AGENT,
      value,
      vscode.ConfigurationTarget.Workspace
    );
    this.logger.info(MODULE, 'autoActivateAgent updated', { value });
  }

  async setDeployPath(deployPath: string): Promise<void> {
    this.logger.debug(MODULE, 'Setting deploy path', { deployPath });
    if (!this.isValidDeployPath(deployPath)) {
      this.logger.warn(MODULE, 'Rejected invalid deploy path');
      return;
    }
    await this.getConfig().update(
      CONFIG_KEYS.DEPLOY_PATH,
      deployPath,
      vscode.ConfigurationTarget.Workspace
    );
    this.logger.info(MODULE, 'Deploy path updated', { deployPath });
  }

  async setLogLevel(level: LogLevel): Promise<void> {
    this.logger.debug(MODULE, 'Setting log level', { level });
    if (!Object.values(LogLevel).includes(level)) {
      this.logger.warn(MODULE, 'Rejected invalid log level', { level });
      return;
    }
    await this.getConfig().update(
      CONFIG_KEYS.LOG_LEVEL,
      level,
      vscode.ConfigurationTarget.Workspace
    );
    this.logger.info(MODULE, 'Log level updated', { level });
  }

  async resetAll(): Promise<void> {
    this.logger.info(MODULE, 'Resetting all settings to defaults');
    const config = this.getConfig();
    const target = vscode.ConfigurationTarget.Workspace;
    await config.update(CONFIG_KEYS.HOOKS, undefined, target);
    await config.update(CONFIG_KEYS.AUTO_ACTIVATE_AGENT, undefined, target);
    await config.update(CONFIG_KEYS.DEPLOY_PATH, undefined, target);
    await config.update(CONFIG_KEYS.SHOW_STATUS_BAR, undefined, target);
    await config.update(CONFIG_KEYS.LOG_LEVEL, undefined, target);
    await config.update(UI_CONFIG_KEYS.MATRIX_RAIN, undefined, target);
    await config.update(UI_CONFIG_KEYS.CRT_OVERLAY, undefined, target);
    await config.update(UI_CONFIG_KEYS.ANIMATIONS, undefined, target);
    this.logger.info(MODULE, 'All settings reset');
  }

  dispose(): void {
    this.disposable.dispose();
    this.changeHandlers = [];
    this._cachedValues.clear();
  }

  // ─── Validation ──────────────────────────────────────────────────────────

  validateSettings(): Array<{ key: string; issue: string; severity: 'warn' | 'error' }> {
    this.logger.debug(MODULE, 'Validating all settings');
    const issues: Array<{ key: string; issue: string; severity: 'warn' | 'error' }> = [];
    const config = this.getConfig();

    // Validate deploy path
    const deployPath = config.get<unknown>(CONFIG_KEYS.DEPLOY_PATH);
    if (typeof deployPath === 'string' && deployPath && !this.isValidDeployPath(deployPath)) {
      issues.push({ key: CONFIG_KEYS.DEPLOY_PATH, issue: 'Invalid deploy path', severity: 'error' });
    }

    // Validate hooks
    const hooks = config.get<Record<string, unknown>>(CONFIG_KEYS.HOOKS);
    if (hooks && typeof hooks === 'object') {
      for (const key of Object.keys(hooks)) {
        if (!(VALID_HOOKS as string[]).includes(key)) {
          issues.push({ key: `${CONFIG_KEYS.HOOKS}.${key}`, issue: `Unknown hook key: ${key}`, severity: 'warn' });
        }
      }
    }

    // Validate log level
    const logLevel = config.get<unknown>(CONFIG_KEYS.LOG_LEVEL);
    if (logLevel !== undefined && (typeof logLevel !== 'string' || !Object.values(LogLevel).includes(logLevel.toLowerCase() as LogLevel))) {
      issues.push({ key: CONFIG_KEYS.LOG_LEVEL, issue: 'Invalid log level', severity: 'warn' });
    }

    this.logger.debug(MODULE, `Validation complete: ${issues.length} issues found`);
    return issues;
  }

  // ─── Migration ───────────────────────────────────────────────────────────

  async migrateSettings(): Promise<void> {
    this.logger.debug(MODULE, 'Checking for settings migration');
    // Placeholder for future schema migrations
    // Example: rename old keys, convert formats, update deprecated values
    // Currently no migrations needed
    this.logger.debug(MODULE, 'No migrations required');
  }

  // ─── Export / Import ─────────────────────────────────────────────────────

  exportSettings(): IExtensionSettings {
    this.logger.debug(MODULE, 'Exporting settings');
    return this.getAllSettings();
  }

  async importSettings(settings: Partial<IExtensionSettings>): Promise<void> {
    this.logger.debug(MODULE, 'Importing settings', { keys: Object.keys(settings) });

    try {
      if (settings.hooks) {
        await this.setHookConfig(settings.hooks);
      }
      if (typeof settings.autoActivateAgent === 'boolean') {
        await this.setAutoActivateAgent(settings.autoActivateAgent);
      }
      if (typeof settings.deployPath === 'string') {
        await this.setDeployPath(settings.deployPath);
      }
      if (typeof settings.logLevel === 'string') {
        await this.setLogLevel(settings.logLevel as LogLevel);
      }
      this.logger.info(MODULE, 'Settings imported successfully');
    } catch (err) {
      this.logger.error(MODULE, 'Failed to import settings', err);
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }

  private isValidDeployPath(value: string): boolean {
    if (!value || typeof value !== 'string') {
      return false;
    }
    if (value.length > DEPLOY_PATH_MAX_LENGTH) {
      return false;
    }
    if (value.includes('\0') || value.includes('..')) {
      return false;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(value)) {
      return false;
    }
    if (require('path').isAbsolute(value)) {
      return false;
    }
    const normalized = value.replace(/\\/g, '/');
    if (!DEPLOY_PATH_ALLOWED_CHARS.test(normalized)) {
      return false;
    }
    const firstSegment = normalized.split('/')[0].toLowerCase();
    if (DEPLOY_PATH_BLOCKLIST.includes(firstSegment)) {
      return false;
    }
    return true;
  }

  private _cacheCurrentValues(): void {
    const config = this.getConfig();
    const keys = [
      CONFIG_KEYS.HOOKS,
      CONFIG_KEYS.AUTO_ACTIVATE_AGENT,
      CONFIG_KEYS.DEPLOY_PATH,
      CONFIG_KEYS.SHOW_STATUS_BAR,
      CONFIG_KEYS.LOG_LEVEL,
      UI_CONFIG_KEYS.MATRIX_RAIN,
      UI_CONFIG_KEYS.CRT_OVERLAY,
      UI_CONFIG_KEYS.ANIMATIONS,
    ];
    for (const key of keys) {
      try {
        this._cachedValues.set(key, config.get(key));
      } catch {
        // Ignore read errors during caching
      }
    }
  }

  private notifyChangeHandlers(e: vscode.ConfigurationChangeEvent): void {
    const keys = [
      CONFIG_KEYS.HOOKS,
      CONFIG_KEYS.AUTO_ACTIVATE_AGENT,
      CONFIG_KEYS.DEPLOY_PATH,
      CONFIG_KEYS.SHOW_STATUS_BAR,
      CONFIG_KEYS.LOG_LEVEL,
      UI_CONFIG_KEYS.MATRIX_RAIN,
      UI_CONFIG_KEYS.CRT_OVERLAY,
      UI_CONFIG_KEYS.ANIMATIONS,
    ];

    for (const key of keys) {
      const fullKey = `${CONFIG_SECTION}.${key}`;
      if (e.affectsConfiguration(fullKey)) {
        const oldValue = this._cachedValues.get(key);
        const newValue = this.getConfig().get(key);
        this._cachedValues.set(key, newValue);

        this.logger.debug(MODULE, `Setting changed: ${key}`, { oldValue, newValue });

        for (const handler of this.changeHandlers) {
          try {
            handler({ key, oldValue, newValue });
          } catch (err) {
            this.logger.error(MODULE, 'Settings change handler error', err);
          }
        }
      }
    }
  }
}
