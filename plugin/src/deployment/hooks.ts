import {
  IHookConfig,
  IHookDefinition,
  HookConfigChangedHandler,
} from '../types';
import { SudxLogger } from '../utils/logger';
import { SudxSettings } from '../config/settings';
import { StateManager } from '../config/state';
import { DEFAULT_HOOKS, HOOK_FILE_MAP, STRINGS } from '../constants';

const MODULE = 'HookManager';

const HOOK_DEFINITIONS: Omit<IHookDefinition, 'enabled'>[] = [
  {
    name: 'sessionContext',
    displayName: STRINGS.HOOK_SESSION_CONTEXT,
    description: STRINGS.HOOK_SESSION_CONTEXT_DESC,
    configFile: HOOK_FILE_MAP.sessionContext.config,
    scriptFiles: HOOK_FILE_MAP.sessionContext.scripts,
  },
  {
    name: 'protectPlans',
    displayName: STRINGS.HOOK_PROTECT_PLANS,
    description: STRINGS.HOOK_PROTECT_PLANS_DESC,
    configFile: HOOK_FILE_MAP.protectPlans.config,
    scriptFiles: HOOK_FILE_MAP.protectPlans.scripts,
  },
  {
    name: 'postEdit',
    displayName: STRINGS.HOOK_POST_EDIT,
    description: STRINGS.HOOK_POST_EDIT_DESC,
    configFile: HOOK_FILE_MAP.postEdit.config,
    scriptFiles: HOOK_FILE_MAP.postEdit.scripts,
  },
  {
    name: 'planReminder',
    displayName: STRINGS.HOOK_PLAN_REMINDER,
    description: STRINGS.HOOK_PLAN_REMINDER_DESC,
    configFile: HOOK_FILE_MAP.planReminder.config,
    scriptFiles: HOOK_FILE_MAP.planReminder.scripts,
  },
  {
    name: 'workflowSelector',
    displayName: STRINGS.HOOK_WORKFLOW_SELECTOR,
    description: STRINGS.HOOK_WORKFLOW_SELECTOR_DESC,
    configFile: HOOK_FILE_MAP.workflowSelector.config,
    scriptFiles: HOOK_FILE_MAP.workflowSelector.scripts,
  },
  {
    name: 'protectWorkflow',
    displayName: STRINGS.HOOK_PROTECT_WORKFLOW,
    description: STRINGS.HOOK_PROTECT_WORKFLOW_DESC,
    configFile: HOOK_FILE_MAP.protectWorkflow.config,
    scriptFiles: HOOK_FILE_MAP.protectWorkflow.scripts,
  },
  {
    name: 'playwrightGuard',
    displayName: STRINGS.HOOK_PLAYWRIGHT_GUARD,
    description: STRINGS.HOOK_PLAYWRIGHT_GUARD_DESC,
    configFile: HOOK_FILE_MAP.playwrightGuard.config,
    scriptFiles: HOOK_FILE_MAP.playwrightGuard.scripts,
  },
  {
    name: 'crawl4aiGuard',
    displayName: STRINGS.HOOK_CRAWL4AI_GUARD,
    description: STRINGS.HOOK_CRAWL4AI_GUARD_DESC,
    configFile: HOOK_FILE_MAP.crawl4aiGuard.config,
    scriptFiles: HOOK_FILE_MAP.crawl4aiGuard.scripts,
  },
];

const VALID_HOOK_NAMES = HOOK_DEFINITIONS.map((h) => h.name);

export class HookManager {
  private logger: SudxLogger;
  private settings: SudxSettings;
  private state: StateManager;
  private changeHandlers: HookConfigChangedHandler[] = [];

  constructor(logger: SudxLogger, settings: SudxSettings, state: StateManager) {
    this.logger = logger;
    this.settings = settings;
    this.state = state;
    this.logger.debug(MODULE, 'HookManager initialized');
  }

  onHookConfigChanged(handler: HookConfigChangedHandler): void {
    this.changeHandlers.push(handler);
  }

  getHookConfig(): IHookConfig {
    this.logger.debug(MODULE, 'Getting hook config');
    return this.settings.getHookConfig();
  }

  async setHookEnabled(hookName: string, enabled: boolean): Promise<void> {
    this.logger.debug(MODULE, 'Setting hook enabled', { hookName, enabled });

    if (!VALID_HOOK_NAMES.includes(hookName)) {
      this.logger.warn(MODULE, `Unknown hook name: ${hookName}`);
      return;
    }

    if (typeof enabled !== 'boolean') {
      this.logger.warn(MODULE, `Invalid enabled value for ${hookName}`, { enabled });
      return;
    }

    const config = this.getHookConfig();
    (config as Record<string, boolean>)[hookName] = enabled;

    await this.settings.setHookConfig(config);
    await this.state.setCachedHookConfig(config);

    this.logger.debug(MODULE, `Hook ${hookName} ${enabled ? 'enabled' : 'disabled'}`);
    this.notifyChangeHandlers(config);
  }

  async setAllHooks(config: IHookConfig): Promise<void> {
    this.logger.debug(MODULE, 'Setting all hooks', config);

    const validated: IHookConfig = { ...DEFAULT_HOOKS };
    for (const key of VALID_HOOK_NAMES) {
      const value = (config as Record<string, unknown>)[key];
      if (typeof value === 'boolean') {
        (validated as Record<string, boolean>)[key] = value;
      }
    }

    await this.settings.setHookConfig(validated);
    await this.state.setCachedHookConfig(validated);

    this.logger.debug(MODULE, 'All hooks updated', validated);
    this.notifyChangeHandlers(validated);
  }

  async resetToDefaults(): Promise<void> {
    this.logger.debug(MODULE, 'Resetting hooks to defaults');
    await this.setAllHooks(DEFAULT_HOOKS);
  }

  getAvailableHooks(): IHookDefinition[] {
    const config = this.getHookConfig();
    const hooks = HOOK_DEFINITIONS.map((def) => ({
      ...def,
      enabled: (config as Record<string, boolean>)[def.name] ?? true,
    }));
    const enabledCount = hooks.filter((h) => h.enabled).length;
    this.logger.debug(MODULE, 'Available hooks summary', {
      total: hooks.length,
      enabled: enabledCount,
      disabled: hooks.length - enabledCount,
    });
    return hooks;
  }

  getEnabledHooks(): IHookDefinition[] {
    return this.getAvailableHooks().filter((h) => h.enabled);
  }

  getDisabledHooks(): IHookDefinition[] {
    return this.getAvailableHooks().filter((h) => !h.enabled);
  }

  getHookFiles(hookName: string): string[] {
    if (!VALID_HOOK_NAMES.includes(hookName)) {
      this.logger.warn(MODULE, `Unknown hook name: ${hookName}`);
      return [];
    }

    const mapping = HOOK_FILE_MAP[hookName];
    if (!mapping) {
      return [];
    }

    return [mapping.config, ...mapping.scripts];
  }

  getFilesToDeploy(): string[] {
    const config = this.getHookConfig();
    const files: string[] = [];

    for (const hookName of VALID_HOOK_NAMES) {
      if ((config as Record<string, boolean>)[hookName]) {
        files.push(...this.getHookFiles(hookName));
      }
    }

    this.logger.debug(MODULE, 'Hook files to deploy', { count: files.length, files });
    return files;
  }

  getFilesToSkip(): string[] {
    const config = this.getHookConfig();
    const files: string[] = [];

    for (const hookName of VALID_HOOK_NAMES) {
      if (!(config as Record<string, boolean>)[hookName]) {
        files.push(...this.getHookFiles(hookName));
      }
    }

    this.logger.debug(MODULE, 'Hook files to skip', { count: files.length });
    return files;
  }

  isHookFile(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/');
    return normalized.startsWith('hooks/');
  }

  shouldDeployHookFile(relativePath: string): boolean {
    if (!this.isHookFile(relativePath)) {
      return true;
    }

    const filesToDeploy = this.getFilesToDeploy();
    const normalized = relativePath.replace(/\\/g, '/');
    return filesToDeploy.includes(normalized);
  }

  private notifyChangeHandlers(config: IHookConfig): void {
    for (const handler of this.changeHandlers) {
      try {
        handler(config);
      } catch (err) {
        this.logger.error(MODULE, 'Hook config change handler error', err);
      }
    }
  }
}
