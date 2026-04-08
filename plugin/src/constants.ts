import { IHookConfig, IMcpServerConfig, LogLevel } from './types';

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
  ROLLBACK_MCP: `${COMMAND_PREFIX}.rollbackMcp`,
  MCP_START: `${COMMAND_PREFIX}.mcpStart`,
  MCP_STOP: `${COMMAND_PREFIX}.mcpStop`,
  MCP_RESTART: `${COMMAND_PREFIX}.mcpRestart`,
  MCP_STATUS: `${COMMAND_PREFIX}.mcpStatus`,
} as const;

// ─── Configuration ───────────────────────────────────────────────────────────

export const CONFIG_SECTION = 'sudx-ai';

export const CONFIG_KEYS = {
  HOOKS: 'hooks',
  AUTO_ACTIVATE_AGENT: 'autoActivateAgent',
  DEPLOY_PATH: 'deployPath',
  SHOW_STATUS_BAR: 'showStatusBar',
  LOG_LEVEL: 'logLevel',
  MCP_DEPLOY_MODE: 'mcpDeployMode',
  MCP_SERVERS: 'mcpServers',
  MCP_ALLOW_LOCALHOST: 'mcpAllowLocalhost',
} as const;

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_HOOKS: IHookConfig = {
  sessionContext: true,
  protectPlans: true,
  postEdit: true,
  planReminder: true,
  workflowSelector: true,
  protectWorkflow: true,
  figmaGuard: true,
  playwrightGuard: true,
  crawl4aiGuard: true,
};

export const VALID_HOOKS: string[] = Object.keys(DEFAULT_HOOKS);

export const DEFAULT_MCP_SERVERS: IMcpServerConfig = {
  playwright: true,
  figma: true,
  crawl4ai: true,
};

export const VALID_MCP_SERVERS: string[] = Object.keys(DEFAULT_MCP_SERVERS);

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
  'mcp',
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
  MCP_DEPLOY_DATE: 'sudxAi.mcpDeployDate',
  MCP_DEPLOYED_SERVERS: 'sudxAi.mcpDeployedServers',
  MCP_CONFIG_BACKUP: 'sudxAi.mcpConfigBackup',
  MCP_MERGE_CONFLICTS: 'sudxAi.mcpMergeConflicts',
  MCP_HEALTH_CACHE: 'sudxAi.mcpHealthCache',
  MCP_TEMPLATE_VERSION: 'sudxAi.mcpTemplateVersion',
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
// ─── MCP ─────────────────────────────────────────────────────────────────

/** Metadata key embedded per MCP server to identify Sudx-managed entries */
export const SUDX_MCP_MARKER_KEY = '_sudxManaged';

/** Target filename for the merged MCP configuration */
export const MCP_CONFIG_FILENAME = 'mcp.json';

/** Target directory relative to workspace root for MCP config */
export const MCP_DEPLOY_TARGET = '.vscode';

/** Valid MCP deployment modes */
export const VALID_MCP_DEPLOY_MODES = ['merge', 'overwrite', 'skip'] as const;

/** Default MCP deployment mode */
export const DEFAULT_MCP_DEPLOY_MODE: 'merge' | 'overwrite' | 'skip' = 'merge';

/** Timeout for MCP server health check in ms */
export const MCP_HEALTH_CHECK_TIMEOUT_MS = 3000;

/** Base delay for MCP retry operations (exponential backoff) */
export const MCP_RETRY_BASE_MS = 500;

/** Maximum retry count for MCP operations */
export const MCP_RETRY_MAX_COUNT = 3;

/** Timeout for MCP health check probe in ms */
export const MCP_HEALTH_TIMEOUT_MS = 3000;

/** Timeout for npx availability check in ms */
export const MCP_NPX_CHECK_TIMEOUT_MS = 5000;

/** Retryable error codes for MCP file operations */
export const MCP_RETRYABLE_ERRORS = ['EBUSY', 'EPERM', 'EACCES', 'EAGAIN'];

/** Protocols blocked by MCP network security for SSRF prevention */
export const MCP_BLOCKED_PROTOCOLS: string[] = ['file:', 'data:', 'javascript:', 'vbscript:', 'ftp:'];

/** RFC 1918 and special-use IP ranges for private IP detection */
export const MCP_PRIVATE_IP_RANGES: Array<{ prefix: string; description: string }> = [
  { prefix: '10.', description: 'RFC 1918 Class A (10.0.0.0/8)' },
  { prefix: '172.16.', description: 'RFC 1918 Class B (172.16.0.0/12)' },
  { prefix: '192.168.', description: 'RFC 1918 Class C (192.168.0.0/16)' },
  { prefix: '127.', description: 'Loopback (127.0.0.0/8)' },
  { prefix: '169.254.', description: 'Link-Local (169.254.0.0/16)' },
  { prefix: '0.0.0.0', description: 'Unspecified address' },
  { prefix: 'fc', description: 'IPv6 Unique Local (fc00::/7)' },
  { prefix: 'fd', description: 'IPv6 Unique Local (fd00::/8)' },
  { prefix: 'fe80', description: 'IPv6 Link-Local (fe80::/10)' },
  { prefix: '::1', description: 'IPv6 Loopback' },
];

/** Crawl depth threshold that triggers guard warning */
export const MAX_CRAWL_DEPTH_WARNING = 3;

/** Figma depth threshold that triggers guard warning */
export const MAX_FIGMA_DEPTH_WARNING = 2;

/** Figma batch image export threshold that triggers guard warning */
export const MAX_FIGMA_BATCH_IMAGES = 10;

/** Playwright tools that should be preceded by a snapshot */
export const PLAYWRIGHT_SNAPSHOT_REQUIRED_TOOLS = [
  'browser_click',
  'browser_type',
  'browser_drag',
] as const;

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
  figmaGuard: {
    config: 'hooks/figma-guard.json',
    scripts: [
      'hooks/scripts/figma-guard.ps1',
      'hooks/scripts/figma-guard.sh',
    ],
  },
  playwrightGuard: {
    config: 'hooks/playwright-guard.json',
    scripts: [
      'hooks/scripts/playwright-guard.ps1',
      'hooks/scripts/playwright-guard.sh',
    ],
  },
  crawl4aiGuard: {
    config: 'hooks/crawl4ai-guard.json',
    scripts: [
      'hooks/scripts/crawl4ai-guard.ps1',
      'hooks/scripts/crawl4ai-guard.sh',
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
  WV_SECTION_MCP: 'MCP Servers',
  WV_SECTION_MCP_DESC: 'Configured Model Context Protocol servers',
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
  HOOK_FIGMA_GUARD: 'Figma Guard',
  HOOK_FIGMA_GUARD_DESC: 'Enforce Figma API best practices (depth-first fetching, safe operations)',
  HOOK_PLAYWRIGHT_GUARD: 'Playwright Guard',
  HOOK_PLAYWRIGHT_GUARD_DESC: 'Enforce Playwright best practices (HTTPS navigation, snapshot-before-click, vision cap)',
  HOOK_CRAWL4AI_GUARD: 'Crawl4ai Guard',
  HOOK_CRAWL4AI_GUARD_DESC: 'Enforce crawl safety (SSRF prevention, depth limits, rate awareness)',

  // MCP
  MCP_DEPLOY_SKIPPED: 'MCP deployment skipped by configuration',
  MCP_DEPLOY_SUCCESS: (deployed: number, preserved: number) =>
    `MCP deployed: ${deployed} servers updated, ${preserved} user servers preserved`,
  MCP_DEPLOY_FAILED: 'MCP deployment failed — check log for details',
  MCP_NO_WORKSPACE: 'No workspace root — MCP config not deployed',
  MCP_CONFIG_SYNTAX_ERROR: 'Existing mcp.json has syntax errors — backed up and deploying fresh',
  MCP_CONFLICT: (name: string) => `MCP conflict: user server "${name}" overwritten by Sudx template`,
  MCP_ROLLBACK_CONFIRM: 'Rollback MCP config to the previous backup?',
  MCP_ROLLBACK_SUCCESS: 'MCP config rolled back successfully.',
  MCP_ROLLBACK_FAILED: 'MCP rollback failed — check log for details.',
  MCP_ROLLBACK_NO_BACKUP: 'No MCP backup available to rollback to.',

  // MCP Error strings
  ERR_MCP_CONFIG_PARSE: 'Failed to parse existing MCP configuration',
  ERR_MCP_MERGE_FAILED: 'MCP configuration merge failed',
  ERR_MCP_BACKUP_FAILED: 'Failed to backup existing MCP configuration',
  ERR_MCP_WRITE_FAILED: 'Failed to write MCP configuration',
  ERR_MCP_ROLLBACK_FAILED: 'MCP configuration rollback failed',

  // MCP Notifications
  NOTIFY_MCP_DEPLOYED: (count: number) =>
    `Sudx CC: MCP config deployed (${count} servers to .vscode/mcp.json)`,
  NOTIFY_MCP_MERGE_COMPLETE: 'Sudx CC: MCP servers merged with existing config',
  NOTIFY_MCP_ROLLBACK_COMPLETE: 'Sudx CC: MCP config rolled back to previous version',
  NOTIFY_MCP_SERVER_UNAVAILABLE: (name: string) =>
    `Sudx CC: MCP server "${name}" is unreachable — check if it is running`,

  // MCP Webview labels
  WV_MCP_TRANSPORT_STDIO: 'stdio',
  WV_MCP_TRANSPORT_SSE: 'SSE',
  WV_MCP_STATUS_CONFIGURED: 'Configured',
  WV_MCP_STATUS_NOT_CONFIGURED: 'Not configured',
  WV_MCP_STATUS_ENABLED: 'Enabled',
  WV_MCP_STATUS_DISABLED: 'Disabled',

  // MCP Log strings
  LOG_MCP_DEPLOY_START: 'Starting MCP deployment',
  LOG_MCP_DEPLOY_COMPLETE: (count: number) => `MCP deployment complete: ${count} servers deployed`,
  LOG_MCP_MERGE_START: 'Starting MCP config merge',
  LOG_MCP_MERGE_COMPLETE: 'MCP config merge complete',

  // MCP Lifecycle
  MCP_LIFECYCLE_NPX_NOT_FOUND: 'npx is not available on PATH — install Node.js to use Playwright MCP',
  MCP_LIFECYCLE_DOCKER_NOT_FOUND: 'Docker is not available — install Docker to use Crawl4ai MCP',
  MCP_LIFECYCLE_DOCKER_NOT_RUNNING: 'Docker daemon is not running — start Docker Desktop first',
  MCP_LIFECYCLE_SERVER_STARTED: (name: string) => `MCP server "${name}" started successfully`,
  MCP_LIFECYCLE_SERVER_STOPPED: (name: string) => `MCP server "${name}" stopped`,
  MCP_LIFECYCLE_SERVER_RESTARTED: (name: string) => `MCP server "${name}" restarted`,
  MCP_LIFECYCLE_SERVER_NOT_RUNNING: (name: string) => `MCP server "${name}" is not running`,
  MCP_LIFECYCLE_START_FAILED: (name: string) => `Failed to start MCP server "${name}"`,
  MCP_LIFECYCLE_PICK_SERVER: 'Select an MCP server',

  // MCP Health
  MCP_HEALTH_SUMMARY: (statuses: Array<{ serverName: string; healthy: boolean }>) => {
    const icons = statuses.map(s => `${s.healthy ? '●' : '○'} ${s.serverName}`);
    return `MCP: ${icons.join(' | ')}`;
  },

  // MCP Token Management
  MCP_TOKEN_LABEL_FIGMA: 'Figma API Token',
  MCP_TOKEN_STATUS_CHECKING: 'Checking\u2026',
  MCP_TOKEN_STATUS_SET: 'Token stored securely',
  MCP_TOKEN_STATUS_NOT_SET: 'No token stored',
  MCP_TOKEN_BTN_SET: '[SET TOKEN]',
  MCP_TOKEN_BTN_CLEAR: '[CLEAR]',
  MCP_TOKEN_PROMPT: 'Enter your Figma personal access token (starts with figd_)',
  MCP_TOKEN_STORED: (server: string) => `${server} token stored successfully`,
  MCP_TOKEN_CLEARED: (server: string) => `${server} token cleared`,
  MCP_TOKEN_STORE_FAILED: (server: string, error: string) => `Failed to store ${server} token: ${error}`,

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
