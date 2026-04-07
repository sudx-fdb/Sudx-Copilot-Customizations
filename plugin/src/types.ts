// ─── Enums ───────────────────────────────────────────────────────────────────

export enum TemplateCategory {
  Agents = 'agents',
  Instructions = 'instructions',
  Prompts = 'prompts',
  Skills = 'skills',
  Hooks = 'hooks',
}

export enum DeploymentState {
  Idle = 'idle',
  Scanning = 'scanning',
  Deploying = 'deploying',
  Verifying = 'verifying',
  Completed = 'completed',
  Error = 'error',
  Cancelled = 'cancelled',
}

export enum LogLevel {
  Debug = 'debug',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

// ─── Configuration Interfaces ────────────────────────────────────────────────

export interface IHookConfig {
  sessionContext: boolean;
  protectPlans: boolean;
  postEdit: boolean;
  planReminder: boolean;
  workflowSelector: boolean;
  protectWorkflow: boolean;
  [key: string]: boolean;
}

export interface IDeploymentConfig {
  hookConfig: IHookConfig;
  autoActivateAgent: boolean;
  deployPath: string;
}

export interface IExtensionSettings {
  hooks: IHookConfig;
  autoActivateAgent: boolean;
  deployPath: string;
  showStatusBar: boolean;
  logLevel: LogLevel;
}

// ─── Template Interfaces ─────────────────────────────────────────────────────

export interface ITemplateFile {
  relativePath: string;
  absolutePath: string;
  category: TemplateCategory;
  size: number;
}

export interface ITemplateManifest {
  version: string;
  files: ITemplateManifestEntry[];
}

export interface ITemplateManifestEntry {
  path: string;
  category: string;
  sha256: string;
  size: number;
}

// ─── Deployment Result Interfaces ────────────────────────────────────────────

export interface IDeploymentResult {
  success: boolean;
  deployedFiles: string[];
  skippedFiles: string[];
  errors: IDeployError[];
  duration: number;
}

export interface IDeployError {
  file: string;
  error: string;
  recoverable: boolean;
}

export interface ICopyResult {
  success: boolean;
  copied: string[];
  skipped: string[];
  failed: ICopyError[];
  backups: string[];
}

export interface ICopyError {
  file: string;
  error: string;
  recoverable: boolean;
}

export interface ICopyFileResult {
  success: boolean;
  backedUp: boolean;
  error?: string;
}

// ─── State Interfaces ────────────────────────────────────────────────────────

export interface IDeploymentHistory {
  date: string;
  filesDeployed: number;
  hooksEnabled: string[];
  duration: number;
  success: boolean;
}

export interface IExtensionState {
  lastDeployDate: string | null;
  deployHistory: IDeploymentHistory[];
  deployedFiles: string[];
  cachedHookConfig: IHookConfig | null;
  stateVersion: number;
}

export interface IStatusBarState {
  state: 'idle' | 'deploying' | 'deployed' | 'error';
  message: string;
}

// ─── Webview Message Interfaces ──────────────────────────────────────────────

export type WebviewMessageType =
  | 'getConfig'
  | 'updateHook'
  | 'updateAllHooks'
  | 'toggleAgent'
  | 'deploy'
  | 'cancelDeploy'
  | 'getStatus'
  | 'getHistory'
  | 'resetConfig'
  | 'openLog'
  | 'pushUiSettings'
  | 'getLogData';

export type WebviewResponseType =
  | 'configData'
  | 'statusData'
  | 'historyData'
  | 'deployProgress'
  | 'deployComplete'
  | 'deployError'
  | 'hookUpdated'
  | 'uiSettings'
  | 'logData'
  | 'error';

export interface IWebviewMessage {
  type: WebviewMessageType;
  payload?: unknown;
  requestId?: string;
}

// Discriminated message subtypes for type-safe payload access
export interface IUpdateHookMessage {
  type: 'updateHook';
  payload: IUpdateHookPayload;
  requestId?: string;
}

export interface IToggleAgentMessage {
  type: 'toggleAgent';
  payload: { enabled: boolean };
  requestId?: string;
}

export interface IUpdateAllHooksMessage {
  type: 'updateAllHooks';
  payload: IHookConfig;
  requestId?: string;
}

export type TypedWebviewMessage =
  | IUpdateHookMessage
  | IToggleAgentMessage
  | IUpdateAllHooksMessage
  | IWebviewMessage;

export interface IWebviewResponse {
  type: WebviewResponseType;
  payload?: unknown;
  requestId?: string;
  success: boolean;
  error?: string;
}

export interface IDeployProgressPayload {
  state: DeploymentState;
  current: number;
  total: number;
  currentFile: string;
  percent: number;
}

export interface IConfigDataPayload {
  hooks: IHookConfig;
  autoActivateAgent: boolean;
  deployPath: string;
  isDeployed: boolean;
  lastDeployDate: string | null;
  fileCount: number;
  uiSettings?: IUiSettings;
  featureFlags?: IFeatureFlags;
}

export interface IStatusDataPayload {
  deployed: boolean;
  lastDeployDate: string | null;
  filesCount: number;
  deploymentState: DeploymentState;
}

export interface IUpdateHookPayload {
  hookName: string;
  enabled: boolean;
}

// ─── Hook Interfaces ─────────────────────────────────────────────────────────

export interface IHookDefinition {
  name: string;
  displayName: string;
  description: string;
  configFile: string;
  scriptFiles: string[];
  enabled: boolean;
}

// ─── File Operation Result ───────────────────────────────────────────────────

export interface IFileOpResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

// ─── Progress Callback ──────────────────────────────────────────────────────

export type ProgressCallback = (
  current: number,
  total: number,
  fileName: string
) => void;

// ─── Event Types ─────────────────────────────────────────────────────────────

export type HookConfigChangedHandler = (config: IHookConfig) => void;
export type DeploymentStateChangedHandler = (
  oldState: DeploymentState,
  newState: DeploymentState
) => void;
export type SettingsChangedHandler = (change: {
  key: string;
  oldValue: unknown;
  newValue: unknown;
}) => void;

// ─── UI State Interfaces ─────────────────────────────────────────────────────

export interface IWebviewUiState {
  currentPage: 'main' | 'log';
  logFilterActive: string;
  autoScrollEnabled: boolean;
  skeletonLoading: boolean;
  errorBannerVisible: boolean;
}

export interface IWebviewErrorResponse {
  type: 'error';
  code: string;
  message: string;
  timestamp: string;
  requestId?: string;
}

export interface IFeatureFlags {
  matrixRain: boolean;
  crtOverlay: boolean;
  terminalLogo: boolean;
  deployParticles: boolean;
}

export interface IUiSettings {
  matrixRain: boolean;
  crtOverlay: boolean;
  animations: boolean;
}

// ─── Log Entry ───────────────────────────────────────────────────────────────

export interface ILogEntry {
  id: number;
  type: 'success' | 'error' | 'skip' | 'info';
  text: string;
  timestamp: string;
  detail?: string;
  expanded?: boolean;
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

export interface IRateLimiterConfig {
  limit: number;
  windowMs: number;
  burstLimit?: number;
}

// ─── Connection Health ───────────────────────────────────────────────────────

export interface IConnectionHealth {
  alive: boolean;
  latencyMs: number;
  uptime?: number;
  memUsage?: number;
}

// ─── Deploy Summary ──────────────────────────────────────────────────────────

export interface IDeploySummary {
  totalFiles: number;
  deployed: number;
  skipped: number;
  errors: number;
  durationMs: number;
  timestamp: string;
}

// ─── Animation Config ────────────────────────────────────────────────────────

export interface IAnimationConfig {
  typingMinMs: number;
  typingMaxMs: number;
  deleteSpeedMs: number;
  cursorBlinkMs: number;
  pauseAfterMs: number;
  bootStaggerMs: number;
}

// ─── Theme Config ────────────────────────────────────────────────────────────

export interface IThemeConfig {
  mode: 'dark' | 'light' | 'high-contrast';
  matrixRain: boolean;
  crtOverlay: boolean;
  animations: boolean;
  colorScheme: 'default' | 'colorblind';
}

// ─── Log Filter State ────────────────────────────────────────────────────────

export interface ILogFilterState {
  activeFilter: 'all' | 'success' | 'error' | 'skip';
  persistTo: 'session' | 'local';
}
