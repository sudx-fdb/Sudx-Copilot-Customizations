import { IHookConfig, LogLevel } from './types';

// ─── Extension Identity ──────────────────────────────────────────────────────

export const EXTENSION_ID = 'sudx-ai-setup';
export const EXTENSION_NAME = 'Sudx Copilot Customizations';
export const COMMAND_PREFIX = 'sudx-ai';

// ─── Commands ────────────────────────────────────────────────────────────────

export const COMMANDS = {
  OPEN_PANEL: `${COMMAND_PREFIX}.openPanel`,
  DEPLOY: `${COMMAND_PREFIX}.deploy`,
  RESET_CONFIG: `${COMMAND_PREFIX}.resetConfig`,
  SHOW_LOG: `${COMMAND_PREFIX}.showLog`,
} as const;

// ─── Configuration ───────────────────────────────────────────────────────────

export const CONFIG_SECTION = 'sudx-ai';

export const CONFIG_KEYS = {
  HOOKS: 'hooks',
  AUTO_ACTIVATE_AGENT: 'autoActivateAgent',
  DEPLOY_PATH: 'deployPath',
  SHOW_STATUS_BAR: 'showStatusBar',
  LOG_LEVEL: 'logLevel',
} as const;

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_HOOKS: IHookConfig = {
  sessionContext: true,
  protectPlans: true,
  postEdit: true,
  planReminder: true,
  workflowSelector: true,
  protectWorkflow: true,
};

export const VALID_HOOKS: string[] = Object.keys(DEFAULT_HOOKS);

export const DEFAULT_DEPLOY_PATH = '.github';
export const DEFAULT_LOG_LEVEL: LogLevel = LogLevel.Warn;
export const DEFAULT_AUTO_ACTIVATE_AGENT = true;
export const DEFAULT_SHOW_STATUS_BAR = true;

// ─── Template Directories ────────────────────────────────────────────────────

export const TEMPLATE_DIRS = [
  'agents',
  'instructions',
  'prompts',
  'skills',
  'hooks',
] as const;

export const FILE_PATTERNS_EXCLUDE = ['info.md'];

// ─── State Keys ──────────────────────────────────────────────────────────────

export const STATE_KEYS = {
  LAST_DEPLOY_DATE: 'sudxAi.lastDeployDate',
  DEPLOY_HISTORY: 'sudxAi.deployHistory',
  DEPLOYED_FILES: 'sudxAi.deployedFiles',
  CACHED_HOOK_CONFIG: 'sudxAi.cachedHookConfig',
  STATE_VERSION: 'sudxAi.stateVersion',
  EXTENSION_VERSION: 'sudxAi.extensionVersion',
  FIRST_INSTALL_DATE: 'sudxAi.firstInstallDate',
  DEPLOYMENT_COUNT: 'sudxAi.deploymentCount',
} as const;

export const CURRENT_STATE_VERSION = 1;

// ─── Logging ─────────────────────────────────────────────────────────────────

export const LOG_CHANNEL_NAME = 'Sudx CC';

// ─── Webview ─────────────────────────────────────────────────────────────────

export const WEBVIEW_TYPE = 'sudxAiPanel';
export const WEBVIEW_TITLE = 'Sudx Copilot Customizations';

// ─── Status Bar ──────────────────────────────────────────────────────────────

export const STATUS_BAR_PRIORITY = 100;

export const STATUS_BAR_TEXT = {
  idle: '$(rocket) Sudx CC',
  deploying: '$(sync~spin) Sudx CC',
  deployed: '$(check) Sudx CC',
  error: '$(warning) Sudx CC',
} as const;

export const STATUS_BAR_TOOLTIP = {
  idle: 'Sudx Copilot Customizations — Click to open',
  deploying: 'Sudx Copilot Customizations — Deploying...',
  deployed: 'Sudx Copilot Customizations — Deployed',
  error: 'Sudx Copilot Customizations — Error occurred',
} as const;

// ─── Limits ──────────────────────────────────────────────────────────────────

export const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
export const MAX_TOTAL_DEPLOY_SIZE = 50 * 1024 * 1024; // 50 MB
export const MAX_FILE_COUNT = 200;
export const MAX_HISTORY_ENTRIES = 10;
export const MAX_BACKUPS_PER_FILE = 5;
export const FILE_OP_TIMEOUT_MS = 10_000;
export const FILE_OP_RETRY_COUNT = 3;
export const FILE_OP_RETRY_DELAY_MS = 500;
export const MESSAGE_RATE_LIMIT = 100;
export const DEPLOY_DEBOUNCE_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const HOOK_NAME_MAX_LENGTH = 50;
export const RATE_LIMIT_WINDOW_MS = 1_000;

// ─── Paths ───────────────────────────────────────────────────────────────────

export const BACKUP_DIR_NAME = '.sudx-backups';

export const DEPLOY_PATH_BLOCKLIST = [
  '.git',
  'node_modules',
  '.vscode',
  'src',
  'dist',
  'build',
  'out',
];

export const DEPLOY_PATH_MAX_LENGTH = 200;
export const DEPLOY_PATH_ALLOWED_CHARS = /^[a-zA-Z0-9._\-/ ]+$/;

// ─── Hook File Mapping ──────────────────────────────────────────────────────

export const HOOK_FILE_MAP: Record<string, { config: string; scripts: string[] }> = {
  sessionContext: {
    config: 'hooks/session-context.json',
    scripts: [
      'hooks/scripts/inject-context.ps1',
      'hooks/scripts/inject-context.sh',
    ],
  },
  protectPlans: {
    config: 'hooks/protect-plans.json',
    scripts: [
      'hooks/scripts/protect-plans.ps1',
      'hooks/scripts/protect-plans.sh',
    ],
  },
  postEdit: {
    config: 'hooks/post-edit.json',
    scripts: [
      'hooks/scripts/post-edit.ps1',
      'hooks/scripts/post-edit.sh',
    ],
  },
  planReminder: {
    config: 'hooks/plan-reminder.json',
    scripts: [
      'hooks/scripts/plan-reminder.ps1',
      'hooks/scripts/plan-reminder.sh',
    ],
  },
  workflowSelector: {
    config: 'hooks/workflow-selector.json',
    scripts: [
      'hooks/scripts/workflow-selector.ps1',
      'hooks/scripts/workflow-selector.sh',
    ],
  },
  protectWorkflow: {
    config: 'hooks/protect-workflow.json',
    scripts: [
      'hooks/scripts/protect-workflow-pre.ps1',
      'hooks/scripts/protect-workflow-pre.sh',
      'hooks/scripts/protect-workflow-post.ps1',
      'hooks/scripts/protect-workflow-post.sh',
    ],
  },
};

// ─── User-Facing Strings (Language Pack) ─────────────────────────────────────

export const STRINGS = {
  // Status messages
  STATUS_NOT_DEPLOYED: 'Not deployed',
  STATUS_DEPLOYED: 'Deployed',
  STATUS_DEPLOYING: 'Deploying...',
  STATUS_DEPLOY_COMPLETE: 'Deployment complete',
  STATUS_DEPLOY_FAILED: 'Deployment failed',
  STATUS_DEPLOY_CANCELLED: 'Deployment cancelled',

  // Notifications
  NOTIFY_DEPLOY_SUCCESS: (count: number) =>
    `Sudx CC: Successfully deployed ${count} files.`,
  NOTIFY_DEPLOY_FAILED: 'Sudx CC: Deployment failed. Check the log for details.',
  NOTIFY_DEPLOY_CANCELLED: 'Sudx CC: Deployment cancelled.',
  NOTIFY_NO_WORKSPACE: 'Sudx CC: Please open a workspace first.',
  NOTIFY_DEPLOY_IN_PROGRESS: 'Sudx CC: A deployment is already in progress.',
  NOTIFY_AGENT_ACTIVATED: 'Sudx CC: Agent configuration deployed.',
  NOTIFY_COPILOT_NOT_FOUND: 'Sudx CC: GitHub Copilot extension not detected.',
  NOTIFY_RESET_COMPLETE: 'Sudx CC: Configuration reset to defaults.',

  // Errors
  ERR_PERMISSION_DENIED: 'Could not write files — check permissions.',
  ERR_INVALID_CONFIG: 'Invalid configuration value.',
  ERR_DEPLOY_FAILED: 'Deployment failed — see log for details.',
  ERR_PATH_TRAVERSAL: 'Invalid file path detected.',
  ERR_FILE_TOO_LARGE: 'Template file exceeds size limit.',
  ERR_TEMPLATE_CORRUPT: 'Template integrity check failed.',

  // Log messages
  LOG_EXTENSION_ACTIVATED: 'Extension activated',
  LOG_EXTENSION_DEACTIVATED: 'Extension deactivated',
  LOG_DEPLOY_START: 'Starting deployment',
  LOG_DEPLOY_COMPLETE: 'Deployment complete',
  LOG_SCAN_START: 'Scanning templates',
  LOG_SCAN_COMPLETE: (count: number) => `Scan complete: ${count} files found`,

  // Webview
  WV_TITLE: 'Sudx Copilot Customizations',
  WV_SUBTITLE: 'Copilot Setup Deployment',
  WV_SECTION_STATUS: 'Status',
  WV_SECTION_HOOKS: 'Hooks Configuration',
  WV_SECTION_HOOKS_DESC: 'Enable or disable individual automation hooks',
  WV_SECTION_AGENT: 'Agent Activation',
  WV_SECTION_DEPLOY: 'Deploy',
  WV_SECTION_LOG: 'Deployment Log',
  WV_BTN_DEPLOY: 'DEPLOY ALL FILES',
  WV_BTN_DEPLOYING: 'DEPLOYING...',
  WV_BTN_DEPLOYED: 'DEPLOYED SUCCESSFULLY',
  WV_BTN_FAILED: 'DEPLOYMENT FAILED',
  WV_BTN_CANCELLED: 'CANCELLED',
  WV_LOG_EMPTY: 'No deployment log yet',
  WV_RESET: 'Reset all settings',
  WV_OPEN_LOG: 'Open Log',

  // Hook display names
  HOOK_SESSION_CONTEXT: 'Session Context',
  HOOK_SESSION_CONTEXT_DESC: 'Inject project context at session start',
  HOOK_PROTECT_PLANS: 'Plan Protection',
  HOOK_PROTECT_PLANS_DESC: 'Protect plan files from structural changes',
  HOOK_POST_EDIT: 'Post-Edit Automation',
  HOOK_POST_EDIT_DESC: 'Auto-format and content.md reminders',
  HOOK_PLAN_REMINDER: 'Plan Reminder',
  HOOK_PLAN_REMINDER_DESC: 'Warn about unfinished plans',
  HOOK_WORKFLOW_SELECTOR: 'Workflow Selector',
  HOOK_WORKFLOW_SELECTOR_DESC: 'Inject workflow selection reminder on every prompt',
  HOOK_PROTECT_WORKFLOW: 'Workflow Protection',
  HOOK_PROTECT_WORKFLOW_DESC: 'Enforce single-checkmark-per-edit rule for plan files',

  // Agent
  AGENT_TOGGLE_LABEL: 'Auto-activate Sudx Copilot Customizations Agent after deployment',
  AGENT_TOGGLE_DESC: 'Sets the Sudx Copilot Customizations agent as the preferred Copilot agent mode',

  // UI Labels (hardcoded in HTML/JS)
  TOGGLE_ON: '[ON]',
  TOGGLE_OFF: '[OFF]',
  BTN_EXECUTE_DEPLOY: '[ EXECUTE DEPLOY ]',
  BTN_CANCEL_DEPLOY: '[ CANCEL DEPLOY ]',
  BTN_COMPLETE: '[ ✓ COMPLETE ]',
  BTN_FAILED: '[ ✗ FAILED ]',
  BTN_CANCELLED: '[ CANCELLED ]',
  LOG_TITLE: 'DEPLOYMENT LOG',
  LOG_BACK: 'BACK TO MAIN',
  LOG_AUTOSCROLL_ON: '[AUTO-SCROLL: ON]',
  LOG_AUTOSCROLL_OFF: '[AUTO-SCROLL: OFF]',
  LOG_NO_ENTRIES: 'No deployment logs available. Execute a deploy to see results.',

  // Time formatting
  TIME_JUST_NOW: 'just now',
  TIME_MINUTES_AGO: (n: number) => `${n}m ago`,
  TIME_HOURS_AGO: (n: number) => `${n}h ago`,
  TIME_DAYS_AGO: (n: number) => `${n}d ago`,

  // Terminal command descriptions
  CMD_DESC_SCAN_HOOKS: 'Scanning all automation hooks',
  CMD_DESC_VERIFY_TEMPLATES: 'Verifying template integrity',
  CMD_DESC_ENCRYPT_PAYLOAD: 'Encrypting deployment payload',
  CMD_DESC_DEPLOY_INJECT: 'Injecting session context',
  CMD_DESC_PROTECT_PLANS: 'Protecting plan files',
  CMD_DESC_SYNC_AGENT: 'Syncing agent configuration',
  CMD_DESC_VALIDATE_CONFIG: 'Validating workspace config',
  CMD_DESC_CHECK_PERMS: 'Checking file permissions',
  CMD_DESC_BUILD_MANIFEST: 'Building deploy manifest',
  CMD_DESC_INIT_WATCHDOG: 'Initializing file watchdog',
  CMD_DESC_CACHE_TEMPLATES: 'Caching template data',
  CMD_DESC_RESOLVE_CONFLICTS: 'Resolving merge conflicts',
  CMD_DESC_BACKUP_STATE: 'Backing up current state',
  CMD_DESC_VERIFY_CHECKSUMS: 'Verifying file checksums',
  CMD_DESC_COMPILE_HOOKS: 'Compiling hook scripts',
  CMD_DESC_INDEX_FILES: 'Indexing workspace files',
  CMD_DESC_PATCH_CONFIG: 'Patching configuration',
  CMD_DESC_MONITOR_CHANGES: 'Monitoring file changes',
  CMD_DESC_OPTIMIZE_CACHE: 'Optimizing template cache',
  CMD_DESC_FINALIZE_DEPLOY: 'Finalizing deployment',
  CMD_DESC_GENERATE_REPORT: 'Generating deploy report',
  CMD_DESC_CLEANUP_TEMP: 'Cleaning up temp files',
  CMD_DESC_ROTATE_LOGS: 'Rotating log files',
  CMD_DESC_VALIDATE_HOOKS: 'Validating hook definitions',
  CMD_DESC_TEST_CONNECTION: 'Testing connection health',
  CMD_DESC_LOAD_EXTENSIONS: 'Loading extension modules',
  CMD_DESC_PARSE_TEMPLATES: 'Parsing template hierarchy',
  CMD_DESC_MAP_DEPENDENCIES: 'Mapping file dependencies',
  CMD_DESC_REGISTER_HANDLERS: 'Registering event handlers',
  CMD_DESC_APPLY_PATCHES: 'Applying configuration patches',
} as const;

// ─── Error Strings (User-Facing) ─────────────────────────────────────────────

export const ERROR_STRINGS = {
  RATE_LIMIT: 'Too many requests — please slow down',
  DEPLOY_FAILED: 'Deployment failed — see log for details',
  CONNECTION_LOST: 'Connection lost — click Retry',
  TIMEOUT: 'Request timed out — please try again',
  INVALID_PAYLOAD: 'Invalid request data',
  UNKNOWN_TYPE: 'Unknown message type',
  HOOK_NAME_UNKNOWN: (name: string) => `Unknown hook: '${name}'`,
  RETRY_AFTER: (seconds: number) => `Retry in ${seconds}s`,
  CONNECTION_HEALTH: (status: string) => `Connection: ${status}`,
} as const;

// ─── UI Constants ────────────────────────────────────────────────────────────

export const UI_CONSTANTS = {
  MAX_LOG_PREVIEW_LINES: 5,
  LOG_ANIMATION_MAX_DURATION_MS: 1000,
  BOOT_STAGGER_DELAY_MS: 80,
  STATUS_TRANSITION_MS: 300,
  FILE_PATH_MAX_DISPLAY_LENGTH: 60,
  SKELETON_TIMEOUT_MS: 10000,
  CONFIG_TIMEOUT_MS: 5000,
  RETRY_MAX: 3,
  RETRY_BASE_MS: 1000,
  ANNOUNCE_DEBOUNCE_MS: 300,
  HOVER_MAX_PAUSE_MS: 10000,
  STATUS_BAR_RESET_MS: 8000,
} as const;

// ─── Animation Timings ───────────────────────────────────────────────────────

export const ANIMATION_TIMINGS = {
  TYPING_MIN_MS: 40,
  TYPING_MAX_MS: 100,
  DELETE_SPEED_MS: 20,
  CURSOR_BLINK_MS: 400,
  PAUSE_AFTER_MS: 3000,
  BOOT_STAGGER_MS: 80,
  RIPPLE_DURATION_MS: 600,
  PARTICLE_CLEANUP_FALLBACK_MS: 1200,
  PAGE_TRANSITION_MS: 150,
  COUNT_UP_DURATION_MS: 800,
} as const;

// ─── Log Constants ───────────────────────────────────────────────────────────

export const LOG_CONSTANTS = {
  MAX_DOM_ENTRIES: 500,
  ENTRY_POOL_SIZE: 50,
  EXPORT_FORMAT: 'json',
  SCROLL_THRESHOLD: 120,
  AUTO_SCROLL_BUFFER: 10,
} as const;

// ─── Debug Strings ───────────────────────────────────────────────────────────

export const DEBUG_STRINGS = {
  REQUEST_RECEIVED: (type: string, size: number) => `[REQ] ${type} (${size}B)`,
  REQUEST_COMPLETED: (type: string, ms: number) => `[RES] ${type} completed in ${ms}ms`,
  TIMING_INFO: (label: string, ms: number) => `[TIMING] ${label}: ${ms}ms`,
  MEMORY_USAGE: (heapMb: number) => `[MEM] Heap: ${heapMb.toFixed(1)}MB`,
  RATE_LIMIT_HIT: (type: string, retryMs: number) => `[RATE] ${type} limited, retry in ${retryMs}ms`,
} as const;

// ─── Feature Flags ───────────────────────────────────────────────────────────

export const FEATURES = {
  MATRIX_RAIN: true,
  CRT_OVERLAY: true,
  TERMINAL_LOGO: true,
  DEPLOY_PARTICLES: true,
} as const;
