import * as vscode from 'vscode';
import * as path from 'path';
import { SudxLogger } from '../utils/logger';
import { FileOperations } from '../utils/fileOps';
import { PathUtils } from '../utils/paths';
import { McpConfigValidator } from '../mcp/configValidator';
import { McpTokenManager } from '../mcp/tokenManager';
import {
  IMcpConfig,
  IMcpServerEntry,
  IMcpServerConfig,
  IFileOpResult,
  ITemplateFile,
} from '../types';
import {
  BACKUP_DIR_NAME,
  SUDX_MCP_MARKER_KEY,
  MCP_CONFIG_FILENAME,
  MCP_DEPLOY_TARGET,
  MCP_RETRY_BASE_MS,
  MCP_RETRY_MAX_COUNT,
  MCP_RETRYABLE_ERRORS,
} from '../constants';

const MODULE = 'McpDeployer';

/**
 * Encapsulates all MCP deployment logic: reading existing .vscode/mcp.json,
 * merging with the Sudx template, writing the merged result, backup, and rollback.
 *
 * This module replaces the raw copier.copyFiles() approach for MCP files,
 * providing intelligent config merging that preserves user-defined MCP servers
 * while deploying/updating Sudx-managed servers.
 */
export class McpDeployer {
  private logger: SudxLogger;
  private fileOps: FileOperations;
  private paths: PathUtils;
  private validator: McpConfigValidator;
  private tokenManager: McpTokenManager | null;

  constructor(logger: SudxLogger, fileOps: FileOperations, paths: PathUtils, tokenManager?: McpTokenManager) {
    this.logger = logger;
    this.fileOps = fileOps;
    this.paths = paths;
    this.tokenManager = tokenManager ?? null;
    this.validator = new McpConfigValidator(logger);
    this.logger.debug(MODULE, 'McpDeployer initialized', { hasTokenManager: !!tokenManager });
  }

  /**
   * Retry an async operation with exponential backoff.
   * Only retries on transient errors (EBUSY, EPERM, EACCES, EAGAIN).
   */
  async retryMcpOperation<T>(
    fn: () => Promise<T>,
    label: string,
    maxRetries: number = MCP_RETRY_MAX_COUNT,
    onRetry?: (attempt: number, maxRetries: number, error: unknown) => void
  ): Promise<T> {
    this.logger.debug(MODULE, `retryMcpOperation — start`, { label, maxRetries });
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const result = await fn();
        if (attempt > 1) {
          this.logger.info(MODULE, `retryMcpOperation — succeeded on attempt ${attempt}`, { label });
        }
        return result;
      } catch (err) {
        lastError = err;
        const code = (err as NodeJS.ErrnoException)?.code;
        const isRetryable = code ? MCP_RETRYABLE_ERRORS.includes(code) : false;

        if (attempt > maxRetries || !isRetryable) {
          this.logger.debug(MODULE, `retryMcpOperation — no more retries`, { label, attempt, code, isRetryable });
          throw err;
        }

        const delay = MCP_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        this.logger.warn(MODULE, `retryMcpOperation — retry ${attempt}/${maxRetries}`, { label, code, delay });

        if (onRetry) { onRetry(attempt, maxRetries, err); }

        await new Promise<void>(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Main deployment entry point. Reads existing config, merges with template,
   * backs up previous config, and writes the merged result.
   *
   * @param templateFiles MCP template files from scanner (category=Mcp)
   * @param mode 'merge' | 'overwrite' | 'skip'
   * @returns Deployment result with list of affected servers
   */
  async deploy(
    templateFiles: ITemplateFile[],
    mode: 'merge' | 'overwrite' | 'skip',
    serverConfig?: IMcpServerConfig
  ): Promise<IMcpDeployResult> {
    this.logger.info(MODULE, 'Starting MCP deployment', { mode, fileCount: templateFiles.length, serverConfig });
    const startTime = Date.now();

    if (mode === 'skip') {
      this.logger.info(MODULE, 'MCP deployment skipped by configuration');
      return { success: true, serversDeployed: [], serversPreserved: [], backupPath: null, duration: 0 };
    }

    const workspaceRoot = this.paths.getWorkspaceRoot();
    if (!workspaceRoot) {
      this.logger.error(MODULE, 'No workspace root — cannot deploy MCP config');
      return { success: false, serversDeployed: [], serversPreserved: [], backupPath: null, duration: 0, error: 'No workspace root' };
    }

    const targetDir = path.join(workspaceRoot, MCP_DEPLOY_TARGET);
    const targetPath = path.join(targetDir, MCP_CONFIG_FILENAME);
    const targetUri = vscode.Uri.file(targetPath);

    try {
      // Ensure .vscode/ directory exists
      const dirUri = vscode.Uri.file(targetDir);
      await this.fileOps.createDirectory(dirUri);
      this.logger.debug(MODULE, '.vscode/ directory ensured', { path: targetDir });

      // Read template MCP config
      const templateConfig = await this.readTemplateMcpConfig(templateFiles);
      if (!templateConfig) {
        this.logger.error(MODULE, 'Failed to read MCP template config');
        return { success: false, serversDeployed: [], serversPreserved: [], backupPath: null, duration: Date.now() - startTime, error: 'Failed to read template' };
      }

      // Filter disabled servers from template
      if (serverConfig && templateConfig.mcpServers) {
        for (const serverName of Object.keys(templateConfig.mcpServers)) {
          if (serverConfig[serverName] === false) {
            this.logger.info(MODULE, `MCP server "${serverName}" disabled by config — excluding from deployment`);
            delete templateConfig.mcpServers[serverName];
          }
        }
      }

      // Inject stored tokens into config (replaces ${input:...} prompts)
      await this.injectStoredTokens(templateConfig);

      // Extract template version for state tracking
      const templateVersion = this.getMcpTemplateVersion(templateConfig);

      // Validate config before deployment
      const validation = await this.validator.validateAll(templateConfig);
      const validationWarnings: string[] = [];
      if (!validation.valid) {
        for (const issue of validation.errors) {
          this.logger.error(MODULE, `MCP validation error [${issue.code}]: ${issue.message}`, { suggestion: issue.suggestion });
          validationWarnings.push(`[MCP-WARN] ${issue.server}: ${issue.message}`);
        }
        for (const issue of validation.warnings) {
          this.logger.warn(MODULE, `MCP validation warning [${issue.code}]: ${issue.message}`, { suggestion: issue.suggestion });
          validationWarnings.push(`[MCP-WARN] ${issue.server}: ${issue.message}`);
        }
        vscode.window.showWarningMessage(
          `MCP config has ${validation.errors.length} error(s) and ${validation.warnings.length} warning(s). Check output log for details.`
        );
      } else if (validation.warnings.length > 0) {
        for (const issue of validation.warnings) {
          this.logger.warn(MODULE, `MCP validation warning [${issue.code}]: ${issue.message}`, { suggestion: issue.suggestion });
          validationWarnings.push(`[MCP-WARN] ${issue.server}: ${issue.message}`);
        }
      }

      if (mode === 'overwrite') {
        this.logger.info(MODULE, 'Overwrite mode — deploying template directly');
        // Backup existing before overwriting
        const backupPath = await this.backupExistingConfig(targetUri, workspaceRoot);
        const markResult = this.markSudxServers(templateConfig);
        const writeResult = await this.writeMcpConfig(markResult, targetPath);
        if (!writeResult.success) {
          return { success: false, serversDeployed: [], serversPreserved: [], backupPath, duration: Date.now() - startTime, error: writeResult.error, validationWarnings };
        }
        const serverNames = Object.keys(markResult.mcpServers ?? {});
        this.logger.info(MODULE, 'MCP config overwritten', { servers: serverNames });
        return { success: true, serversDeployed: serverNames, serversPreserved: [], backupPath, duration: Date.now() - startTime, validationWarnings, templateVersion };
      }

      // mode === 'merge'
      const existing = await this.readExistingMcpConfig(targetUri);
      const backupPath = await this.backupExistingConfig(targetUri, workspaceRoot);
      const markedTemplate = this.markSudxServers(templateConfig);
      const merged = this.mergeMcpConfigs(existing, markedTemplate);
      const writeResult = await this.writeMcpConfig(merged.config, targetPath);
      if (!writeResult.success) {
        return { success: false, serversDeployed: [], serversPreserved: [], backupPath, duration: Date.now() - startTime, error: writeResult.error, validationWarnings };
      }
      this.logger.info(MODULE, 'MCP config merged and deployed', {
        deployed: merged.deployed,
        preserved: merged.preserved,
        conflicts: merged.conflicts,
        duration: `${Date.now() - startTime}ms`,
      });
      return {
        success: true,
        serversDeployed: merged.deployed,
        serversPreserved: merged.preserved,
        backupPath,
        duration: Date.now() - startTime,
        validationWarnings,
        templateVersion,
      };
    } catch (err) {
      this.logger.error(MODULE, 'MCP deployment failed with exception', err);
      return { success: false, serversDeployed: [], serversPreserved: [], backupPath: null, duration: Date.now() - startTime, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Read and parse existing .vscode/mcp.json. Returns null if not found or invalid.
   * ENOENT returns null (expected). EBUSY/EPERM retries with backoff.
   */
  async readExistingMcpConfig(targetUri: vscode.Uri): Promise<IMcpConfig | null> {
    this.logger.debug(MODULE, 'Reading existing MCP config (with retry)', { path: targetUri.fsPath });

    const exists = await this.fileOps.fileExists(targetUri);
    if (!exists) {
      this.logger.debug(MODULE, 'No existing MCP config found');
      return null;
    }

    try {
      return await this.retryMcpOperation(
        async () => {
          const readResult = await this.fileOps.readFile(targetUri);
          if (!readResult.success || !readResult.data) {
            const err = new Error(readResult.error ?? 'Read failed');
            (err as NodeJS.ErrnoException).code = 'EBUSY';
            throw err;
          }
          const parsed = JSON.parse(readResult.data) as IMcpConfig;
          this.logger.debug(MODULE, 'Existing MCP config parsed', {
            serverCount: Object.keys(parsed.mcpServers ?? {}).length,
          });
          return parsed;
        },
        'readExistingMcpConfig'
      );
    } catch (err) {
      this.logger.warn(MODULE, 'Failed to read existing MCP config after retries', { error: String(err) });
      return null;
    }
  }

  /**
   * Merge Sudx template config into existing config.
   * - Sudx-managed servers (marked with _sudxManaged) overwrite matching keys.
   * - User servers (without _sudxManaged) are preserved.
   * - Inputs arrays are merged without duplicates (by id).
   */
  mergeMcpConfigs(
    existing: IMcpConfig | null,
    template: IMcpConfig
  ): IMcpMergeResult {
    this.logger.debug(MODULE, 'Merging MCP configs', {
      existingServers: existing ? Object.keys(existing.mcpServers ?? {}).length : 0,
      templateServers: Object.keys(template.mcpServers ?? {}).length,
    });

    if (!existing) {
      this.logger.debug(MODULE, 'No existing config — using template as-is');
      return {
        config: { ...template },
        deployed: Object.keys(template.mcpServers ?? {}),
        preserved: [],
        conflicts: [],
      };
    }

    const merged: IMcpConfig = {
      mcpServers: {},
      inputs: [],
    };

    const deployed: string[] = [];
    const preserved: string[] = [];
    const conflicts: string[] = [];

    // Carry over existing user servers (non-Sudx-managed)
    const existingServers = existing.mcpServers ?? {};
    for (const [name, entry] of Object.entries(existingServers)) {
      if (!entry[SUDX_MCP_MARKER_KEY as keyof IMcpServerEntry]) {
        merged.mcpServers![name] = entry;
        preserved.push(name);
        this.logger.debug(MODULE, `Preserved user server: ${name}`);
      }
    }

    // Deploy/update Sudx-managed servers from template
    const templateServers = template.mcpServers ?? {};
    for (const [name, entry] of Object.entries(templateServers)) {
      if (merged.mcpServers![name] && !merged.mcpServers![name][SUDX_MCP_MARKER_KEY as keyof IMcpServerEntry]) {
        // User has a server with the same name — Sudx wins but log conflict
        this.logger.warn(MODULE, `Conflict: user server "${name}" overwritten by Sudx template`, {
          oldCommand: (merged.mcpServers![name] as Record<string, unknown>).command,
          newCommand: (entry as Record<string, unknown>).command,
        });
        conflicts.push(name);
      }
      merged.mcpServers![name] = entry;
      deployed.push(name);
    }

    // Merge inputs arrays without duplicates (by id)
    const inputMap = new Map<string, Record<string, unknown>>();
    for (const input of existing.inputs ?? []) {
      if (input.id) {
        inputMap.set(input.id, input);
      }
    }
    for (const input of template.inputs ?? []) {
      if (input.id) {
        inputMap.set(input.id, input); // Template wins on same id
      }
    }
    merged.inputs = Array.from(inputMap.values());

    // Carry over _sudxMeta if present in template
    if (template._sudxMeta) {
      merged._sudxMeta = template._sudxMeta;
    }

    this.logger.debug(MODULE, 'Merge complete', {
      totalServers: Object.keys(merged.mcpServers!).length,
      deployed: deployed.length,
      preserved: preserved.length,
      conflicts: conflicts.length,
      inputs: merged.inputs.length,
    });

    return { config: merged, deployed, preserved, conflicts };
  }

  /**
   * Write MCP config to target path with atomic write (write to temp, then rename).
   * Wrapped with retry logic for transient file system errors.
   */
  async writeMcpConfig(config: IMcpConfig, targetPath: string): Promise<IFileOpResult> {
    this.logger.debug(MODULE, 'Writing MCP config (with retry)', { path: targetPath });

    return this.retryMcpOperation(
      async () => {
        const content = JSON.stringify(config, null, 2) + '\n';
        const tempPath = targetPath + '.tmp';
        const tempUri = vscode.Uri.file(tempPath);
        const targetUri = vscode.Uri.file(targetPath);

        // Atomic write: write to temp file first
        const writeResult = await this.fileOps.writeFile(tempUri, content);
        if (!writeResult.success) {
          this.logger.error(MODULE, 'Failed to write temp MCP config', { error: writeResult.error });
          // Throw to trigger retry if error is retryable
          const err = new Error(writeResult.error ?? 'Write failed');
          (err as NodeJS.ErrnoException).code = 'EBUSY';
          throw err;
        }

        // Rename temp to target (atomic on most filesystems)
        try {
          await vscode.workspace.fs.rename(tempUri, targetUri, { overwrite: true });
          this.logger.debug(MODULE, 'MCP config written atomically', { path: targetPath, size: content.length });
          return { success: true } as IFileOpResult;
        } catch (renameErr) {
          this.logger.warn(MODULE, 'Atomic rename failed — falling back to direct write', renameErr);
          try { await this.fileOps.deleteFile(tempUri); } catch { /* ignore */ }
          return this.fileOps.writeFile(targetUri, content);
        }
      },
      'writeMcpConfig'
    ).catch(err => {
      this.logger.error(MODULE, 'Failed to write MCP config after retries', err);
      return { success: false, error: `Failed to write MCP config: ${err instanceof Error ? err.message : String(err)}` } as IFileOpResult;
    });
  }

  /**
   * Inject stored tokens into the MCP config, replacing ${input:...} prompts
   * with environment variable injections. Currently handles Figma token.
   */
  private async injectStoredTokens(config: IMcpConfig): Promise<void> {
    if (!this.tokenManager) {
      this.logger.debug(MODULE, 'No token manager — skipping token injection');
      return;
    }

    const figmaEntry = config.mcpServers?.['figma'];
    if (!figmaEntry) {
      this.logger.debug(MODULE, 'No figma server in config — skipping token injection');
      return;
    }

    try {
      const hasToken = await this.tokenManager.hasToken('figma');
      if (!hasToken) {
        this.logger.debug(MODULE, 'No stored Figma token — keeping original config');
        return;
      }

      const token = await this.tokenManager.getToken('figma');
      if (!token) {
        this.logger.debug(MODULE, 'Figma token retrieval returned null');
        return;
      }

      // Replace ${input:figmaApiToken} with direct env value
      if (figmaEntry.env && typeof figmaEntry.env === 'object') {
        for (const [key, value] of Object.entries(figmaEntry.env)) {
          if (typeof value === 'string' && value.includes('${input:figmaApiToken}')) {
            (figmaEntry.env as Record<string, string>)[key] = token;
            this.logger.info(MODULE, `Injected stored Figma token into env.${key} (replaced input prompt)`);
          }
        }
      }
    } catch (err) {
      this.logger.error(MODULE, 'Failed to inject stored Figma token', err);
      // Non-fatal — continue with original config
    }
  }

  /**
   * Mark all servers in a config as Sudx-managed by adding _sudxManaged: true.
   */
  markSudxServers(config: IMcpConfig): IMcpConfig {
    this.logger.debug(MODULE, 'Marking Sudx-managed servers');
    const result: IMcpConfig = { ...config, mcpServers: {} };
    for (const [name, entry] of Object.entries(config.mcpServers ?? {})) {
      result.mcpServers![name] = { ...entry, [SUDX_MCP_MARKER_KEY]: true } as IMcpServerEntry;
    }
    return result;
  }

  /**
   * Remove only Sudx-managed servers from config, preserving user servers.
   */
  removeSudxServers(config: IMcpConfig): IMcpConfig {
    this.logger.debug(MODULE, 'Removing Sudx-managed servers');
    const result: IMcpConfig = { ...config, mcpServers: {} };
    for (const [name, entry] of Object.entries(config.mcpServers ?? {})) {
      if (!(entry as Record<string, unknown>)[SUDX_MCP_MARKER_KEY]) {
        result.mcpServers![name] = entry;
        this.logger.debug(MODULE, `Kept user server: ${name}`);
      } else {
        this.logger.debug(MODULE, `Removed Sudx server: ${name}`);
      }
    }
    // Keep inputs that don't belong to removed Sudx servers
    result.inputs = config.inputs ?? [];
    return result;
  }

  /**
   * Backup existing .vscode/mcp.json to .sudx-backups/ before merge.
   */
  private async backupExistingConfig(targetUri: vscode.Uri, workspaceRoot: string): Promise<string | null> {
    this.logger.debug(MODULE, 'Backing up existing MCP config');
    const exists = await this.fileOps.fileExists(targetUri);
    if (!exists) {
      this.logger.debug(MODULE, 'No existing config to backup');
      return null;
    }
    const backupDir = path.join(workspaceRoot, BACKUP_DIR_NAME);
    const backupResult = await this.fileOps.backupFile(targetUri, backupDir);
    if (backupResult.success && backupResult.data) {
      this.logger.info(MODULE, 'MCP config backed up', { path: backupResult.data });
      return backupResult.data;
    }
    this.logger.warn(MODULE, 'Failed to backup MCP config', { error: backupResult.error });
    return null;
  }

  /**
   * Read MCP config from template files (expects mcp/mcp.json in the template set).
   */
  private async readTemplateMcpConfig(templateFiles: ITemplateFile[]): Promise<IMcpConfig | null> {
    this.logger.debug(MODULE, 'Reading MCP template config', { fileCount: templateFiles.length });

    const configFile = templateFiles.find(
      (f) => f.relativePath.replace(/\\/g, '/') === 'mcp/mcp.json'
    );

    if (!configFile) {
      this.logger.error(MODULE, 'MCP template config file not found in template set');
      return null;
    }

    const readResult = await this.fileOps.readFile(vscode.Uri.file(configFile.absolutePath));
    if (!readResult.success || !readResult.data) {
      this.logger.error(MODULE, 'Failed to read MCP template file', { error: readResult.error });
      return null;
    }

    try {
      const parsed = JSON.parse(readResult.data) as IMcpConfig;
      this.logger.debug(MODULE, 'MCP template parsed', {
        servers: Object.keys(parsed.mcpServers ?? {}),
      });
      return parsed;
    } catch (err) {
      this.logger.error(MODULE, 'Failed to parse MCP template config', err);
      return null;
    }
  }

  /**
   * Non-blocking health check for SSE-based MCP servers (e.g., crawl4ai).
   * Logs a warning if the endpoint is unreachable. Does NOT block deployment.
   */
  async checkSseServerHealth(serverName: string, url: string): Promise<boolean> {
    this.logger.debug(MODULE, `Health check for SSE server: ${serverName}`, { url });
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const reachable = response.ok || response.status < 500;
      if (reachable) {
        this.logger.info(MODULE, `SSE server "${serverName}" is reachable`, { status: response.status });
      } else {
        this.logger.warn(MODULE, `SSE server "${serverName}" returned error status`, { status: response.status });
      }
      return reachable;
    } catch (err) {
      this.logger.warn(MODULE, `SSE server "${serverName}" is unreachable — server may need to be started`, {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Rollback MCP config to the backup created during the last deployment.
   * Restores the .vscode/mcp.json from .sudx-backups/ if a backup path is known.
   *
   * @param backupPath Absolute path to the backup file (from IMcpDeploymentState.mcpConfigBackupPath)
   * @returns Result indicating success/failure
   */
  async rollbackMcpConfig(backupPath: string): Promise<IFileOpResult> {
    this.logger.info(MODULE, 'Rolling back MCP config', { backupPath });

    if (!backupPath) {
      this.logger.error(MODULE, 'No backup path provided for MCP rollback');
      return { success: false, error: 'No backup path provided' };
    }

    const workspaceRoot = this.paths.getWorkspaceRoot();
    if (!workspaceRoot) {
      this.logger.error(MODULE, 'No workspace root — cannot rollback MCP config');
      return { success: false, error: 'No workspace root' };
    }

    const backupUri = vscode.Uri.file(backupPath);
    const targetPath = path.join(workspaceRoot, MCP_DEPLOY_TARGET, MCP_CONFIG_FILENAME);
    const targetUri = vscode.Uri.file(targetPath);

    try {
      const backupExists = await this.fileOps.fileExists(backupUri);
      if (!backupExists) {
        this.logger.error(MODULE, 'Backup file not found', { path: backupPath });
        return { success: false, error: 'Backup file not found' };
      }

      const readResult = await this.fileOps.readFile(backupUri);
      if (!readResult.success || !readResult.data) {
        this.logger.error(MODULE, 'Failed to read backup file', { error: readResult.error });
        return { success: false, error: readResult.error ?? 'Failed to read backup' };
      }

      // Validate backup is valid JSON before restoring
      try {
        JSON.parse(readResult.data);
      } catch {
        this.logger.error(MODULE, 'Backup file contains invalid JSON — aborting rollback');
        return { success: false, error: 'Backup file contains invalid JSON' };
      }

      const writeResult = await this.fileOps.writeFile(targetUri, readResult.data);
      if (!writeResult.success) {
        this.logger.error(MODULE, 'Failed to write rolled-back MCP config', { error: writeResult.error });
        return { success: false, error: writeResult.error };
      }

      this.logger.info(MODULE, 'MCP config rolled back successfully', { from: backupPath, to: targetPath });
      return { success: true };
    } catch (err) {
      this.logger.error(MODULE, 'MCP rollback failed with exception', err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── Versioning & Migration ──────────────────────────────────────────────

  /**
   * Extract the _sudxMeta.version from an MCP config.
   * Returns '0.0.0' if the config has no _sudxMeta (pre-versioning).
   */
  getMcpTemplateVersion(config: IMcpConfig): string {
    this.logger.debug(MODULE, 'getMcpTemplateVersion called');
    const meta = (config as Record<string, unknown>)['_sudxMeta'] as { version?: string } | undefined;
    if (!meta || typeof meta.version !== 'string') {
      this.logger.debug(MODULE, 'No _sudxMeta.version found — returning 0.0.0');
      return '0.0.0';
    }
    this.logger.debug(MODULE, 'Template version', { version: meta.version });
    return meta.version;
  }

  /**
   * Detect if the deployed MCP config has a different version than the template.
   * Returns true if versions differ (migration needed).
   */
  detectVersionMismatch(deployed: IMcpConfig | null, template: IMcpConfig): boolean {
    this.logger.debug(MODULE, 'detectVersionMismatch called');
    if (!deployed) {
      this.logger.debug(MODULE, 'No deployed config — fresh install, no mismatch');
      return false;
    }
    const deployedVersion = this.getMcpTemplateVersion(deployed);
    const templateVersion = this.getMcpTemplateVersion(template);
    const mismatch = deployedVersion !== templateVersion;
    this.logger.info(MODULE, 'Version comparison', { deployedVersion, templateVersion, mismatch });
    return mismatch;
  }

  /**
   * Migrate an old deployed config to match the new template while preserving user servers.
   * Returns a detailed migration result with change log.
   */
  migrateMcpConfig(oldConfig: IMcpConfig, newTemplate: IMcpConfig): IMcpMigrationResult {
    this.logger.info(MODULE, 'Starting MCP config migration');
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const preserved: string[] = [];

    const oldServers = oldConfig.mcpServers ?? {};
    const newServers = newTemplate.mcpServers ?? {};
    const mergedServers: Record<string, IMcpServerEntry> = {};

    // Identify managed server names from template _sudxMeta
    const meta = (newTemplate as Record<string, unknown>)['_sudxMeta'] as { managedServers?: string[] } | undefined;
    const managedNames = new Set(meta?.managedServers ?? Object.keys(newServers));

    // Process all old servers
    for (const [name, entry] of Object.entries(oldServers)) {
      const isSudxManaged = !!(entry as Record<string, unknown>)[SUDX_MCP_MARKER_KEY] || managedNames.has(name);

      if (isSudxManaged) {
        if (name in newServers) {
          // Server exists in new template — update it
          mergedServers[name] = { ...newServers[name], [SUDX_MCP_MARKER_KEY]: true } as IMcpServerEntry;
          // Check if actually changed
          const oldJson = JSON.stringify(entry);
          const newJson = JSON.stringify(newServers[name]);
          if (oldJson !== newJson) {
            updated.push(name);
            this.logger.debug(MODULE, `Server "${name}" updated`);
          }
        } else {
          // Server removed from template — drop it
          removed.push(name);
          this.logger.debug(MODULE, `Server "${name}" removed (no longer in template)`);
        }
      } else {
        // User server — always preserve
        mergedServers[name] = entry;
        preserved.push(name);
        this.logger.debug(MODULE, `User server "${name}" preserved`);
      }
    }

    // Add new servers from template that weren't in old config
    for (const [name, entry] of Object.entries(newServers)) {
      if (!(name in mergedServers) && !(name in oldServers)) {
        mergedServers[name] = { ...entry, [SUDX_MCP_MARKER_KEY]: true } as IMcpServerEntry;
        added.push(name);
        this.logger.debug(MODULE, `Server "${name}" added (new in template)`);
      }
    }

    // Build migrated config with updated _sudxMeta
    const migratedConfig: IMcpConfig = {
      ...newTemplate,
      mcpServers: mergedServers,
    };
    // Set deployDate in meta
    const migratedMeta = { ...(meta ?? {}), deployDate: new Date().toISOString() };
    (migratedConfig as Record<string, unknown>)['_sudxMeta'] = migratedMeta;

    // Build migration log
    const logParts: string[] = [];
    if (added.length > 0) { logParts.push(`Added: ${added.join(', ')}`); }
    if (updated.length > 0) { logParts.push(`Updated: ${updated.join(', ')}`); }
    if (removed.length > 0) { logParts.push(`Removed: ${removed.join(', ')}`); }
    if (preserved.length > 0) { logParts.push(`Preserved: ${preserved.join(', ')}`); }
    const migrationLog = logParts.length > 0 ? logParts.join('. ') : 'No changes detected';

    this.logger.info(MODULE, 'Migration complete', { added, updated, removed, preserved, log: migrationLog });

    return {
      config: migratedConfig,
      added,
      updated,
      removed,
      preserved,
      migrationLog,
      oldVersion: this.getMcpTemplateVersion(oldConfig),
      newVersion: this.getMcpTemplateVersion(newTemplate),
    };
  }

  /**
   * Generate an MCP status context file for the session-context hook.
   * Written to `.ai_workfolder/context_files/mcp-status.md`.
   */
  async generateMcpContextFile(
    config: IMcpConfig,
    healthCache: Record<string, boolean> | null,
    workspaceRoot: string
  ): Promise<void> {
    this.logger.debug(MODULE, 'generateMcpContextFile — start', { workspaceRoot });

    try {
      const contextDir = path.join(workspaceRoot, '.ai_workfolder', 'context_files');
      const contextPath = path.join(contextDir, 'mcp-status.md');
      const contentMdPath = path.join(workspaceRoot, '.ai_workfolder', 'content.md');

      // Ensure directory exists
      await this.fileOps.ensureDirectory(contextDir);

      const lines: string[] = [];
      lines.push('# MCP Server Status');
      lines.push('');
      lines.push('> Auto-generated by Sudx CC after MCP deployment. Do not edit manually.');
      lines.push('');

      // Server list
      lines.push('## Configured Servers');
      lines.push('');
      lines.push('| Server | Transport | Status | Health |');
      lines.push('|--------|-----------|--------|--------|');

      const servers = config.mcpServers ?? {};
      for (const [name, entry] of Object.entries(servers)) {
        if (!entry || typeof entry !== 'object') { continue; }
        const serverEntry = entry as IMcpServerEntry;
        const transport = serverEntry.type === 'stdio' ? 'stdio' : 'SSE';
        const isSudx = (serverEntry as Record<string, unknown>)[SUDX_MCP_MARKER_KEY] === true;
        const status = isSudx ? 'Sudx-managed' : 'User-defined';
        const healthy = healthCache?.[name];
        const healthStr = healthy === true ? '● Online' : healthy === false ? '○ Offline' : '? Unknown';
        lines.push(`| ${name} | ${transport} | ${status} | ${healthStr} |`);
      }
      lines.push('');

      // Tool quick-reference
      lines.push('## MCP Tool Quick Reference');
      lines.push('');
      lines.push('### Playwright (browser automation)');
      lines.push('`browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_take_screenshot`, `browser_tab_list`, `browser_tab_new`, `browser_tab_close`, `browser_console_messages`, `browser_select_option`, `browser_hover`, `browser_drag`, `browser_press_key`, `browser_handle_dialog`, `browser_file_upload`, `browser_wait`, `browser_resize`, `browser_pdf_save`, `browser_install`');
      lines.push('');
      lines.push('### Figma (design data)');
      lines.push('`figma_get_file`, `figma_get_node`, `figma_get_images`, `figma_get_comments`, `figma_get_styles`, `figma_get_components`');
      lines.push('');
      lines.push('### Crawl4ai (web crawling)');
      lines.push('`crawl4ai_crawl`, `crawl4ai_extract`, `crawl4ai_markdown`, `crawl4ai_status`');
      lines.push('');

      // Server info
      lines.push('## Server Details');
      lines.push('');
      lines.push('- **Playwright**: Auto-started by plugin via `npx @playwright/mcp@latest` (stdio)');
      lines.push('- **Figma**: Auto-started by plugin via `npx @anthropic/mcp-figma` (stdio). Requires API token (set in Sudx CC panel)');
      lines.push('- **Crawl4ai**: Auto-started by plugin via Docker at `http://localhost:11235/sse` (SSE). Requires Docker running');
      lines.push('');

      // Instruction references
      lines.push('## Detailed Instructions');
      lines.push('');
      lines.push('- Playwright: `.github/instructions/playwright.instructions.md`');
      lines.push('- Figma: `.github/instructions/figma.instructions.md`');
      lines.push('- Crawl4ai: `.github/instructions/crawl4ai.instructions.md`');
      lines.push('- MCP Tools: `.github/instructions/mcp-tools.instructions.md`');
      lines.push('');

      const content = lines.join('\n');
      await this.fileOps.writeFile(contextPath, content);
      this.logger.info(MODULE, 'MCP context file generated', {
        path: contextPath,
        serverCount: Object.keys(servers).length,
      });

      // Auto-update content.md if entry doesn't exist
      try {
        const contentMdExists = await this.fileOps.fileExists(contentMdPath);
        if (contentMdExists) {
          const contentMd = await this.fileOps.readFile(contentMdPath);
          if (!contentMd.includes('mcp-status.md')) {
            const entry = '| context_files/mcp-status.md | Auto-generated MCP server status and tool reference |';
            const updatedContent = contentMd.trimEnd() + '\n' + entry + '\n';
            await this.fileOps.writeFile(contentMdPath, updatedContent);
            this.logger.debug(MODULE, 'content.md updated with mcp-status.md entry');
          }
        }
      } catch (contentErr) {
        this.logger.warn(MODULE, 'Failed to update content.md', { error: String(contentErr) });
      }
    } catch (err) {
      this.logger.error(MODULE, 'Failed to generate MCP context file', { error: String(err) });
    }
  }
}

// ─── Result Interfaces (module-local) ────────────────────────────────────────

export interface IMcpDeployResult {
  success: boolean;
  serversDeployed: string[];
  serversPreserved: string[];
  backupPath: string | null;
  duration: number;
  error?: string;
  validationWarnings?: string[];
  templateVersion?: string;
}

export interface IMcpMergeResult {
  config: IMcpConfig;
  deployed: string[];
  preserved: string[];
  conflicts: string[];
}

export interface IMcpMigrationResult {
  config: IMcpConfig;
  added: string[];
  updated: string[];
  removed: string[];
  preserved: string[];
  migrationLog: string;
  oldVersion: string;
  newVersion: string;
}
