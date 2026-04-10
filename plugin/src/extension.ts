import * as vscode from 'vscode';
import { SudxLogger } from './utils/logger';
import { PathUtils } from './utils/paths';
import { FileOperations } from './utils/fileOps';
import { SudxSettings } from './config/settings';
import { StateManager } from './config/state';
import { TemplateScanner } from './deployment/scanner';
import { FileCopier } from './deployment/copier';
import { HookManager } from './deployment/hooks';
import { AgentActivator } from './deployment/agent';
import { McpDeployer } from './deployment/mcpDeployer';
import { McpLifecycleManager } from './mcp/lifecycleManager';
import { McpHealthMonitor } from './mcp/healthMonitor';
import { McpTokenManager } from './mcp/tokenManager';
import { DeploymentEngine } from './deployment/engine';
import { MessageHandler } from './webview/messaging';
import { SudxWebviewProvider } from './webview/provider';
import { StatusBarManager } from './statusBar';
import { CommandRegistry } from './commands';
import { McpLoggerClient } from './mcp/mcpLoggerClient';
import { McpDebugDataBridge } from './mcp/mcpDebugBridge';
import { COMMANDS, CONFIG_SECTION, STRINGS, VALID_MCP_SERVERS } from './constants';

const MODULE = 'Extension';
const BACKEND_TOKEN_KEY = 'sudxAi.backendToken';

let logger: SudxLogger;
let mcpLifecycle: McpLifecycleManager | null = null;
let mcpHealth: McpHealthMonitor | null = null;
let sseClient: McpLoggerClient | null = null;
let debugBridge: McpDebugDataBridge | null = null;

export function activate(context: vscode.ExtensionContext): void {
  // ── 1. Logger ──────────────────────────────────────────────────────────
  try {
    logger = SudxLogger.getInstance();
  } catch (loggerErr) {
    // Logger init failed — fallback to console, cannot proceed safely
    console.error('[Sudx CC] CRITICAL: Logger initialization failed', loggerErr);
    vscode.window.showErrorMessage('Sudx Copilot Customizations: Logger failed to initialize.');
    return;
  }

  logger.debug(MODULE, 'activate() called — starting extension initialization');
  logger.info(MODULE, STRINGS.LOG_EXTENSION_ACTIVATED);

  // Register logger disposable with safety check
  try {
    const loggerDisposable = logger.getDisposable();
    if (loggerDisposable) {
      context.subscriptions.push(loggerDisposable);
      logger.debug(MODULE, 'Logger disposable registered');
    }
  } catch (dispErr) {
    logger.warn(MODULE, 'Failed to register logger disposable', dispErr);
  }

  try {
    // ── 2. Utilities ───────────────────────────────────────────────────
    logger.debug(MODULE, 'Initializing PathUtils...');
    const paths = new PathUtils(logger);
    logger.debug(MODULE, 'PathUtils initialized');

    logger.debug(MODULE, 'Initializing FileOperations...');
    const fileOps = new FileOperations(logger, paths);
    logger.debug(MODULE, 'FileOperations initialized');

    // ── 3. Configuration ───────────────────────────────────────────────
    logger.debug(MODULE, 'Initializing SudxSettings...');
    const settings = new SudxSettings(logger);
    try {
      const settingsDisposable = settings.getDisposable();
      if (settingsDisposable) {
        context.subscriptions.push(settingsDisposable);
        logger.debug(MODULE, 'Settings disposable registered');
      }
    } catch (settingsDispErr) {
      logger.warn(MODULE, 'Failed to register settings disposable', settingsDispErr);
    }

    logger.debug(MODULE, 'Initializing StateManager...');
    const state = new StateManager(context, logger);
    logger.debug(MODULE, 'StateManager initialized');

    // ── 4. Deployment Services ─────────────────────────────────────────
    logger.debug(MODULE, 'Initializing TemplateScanner...');
    const scanner = new TemplateScanner(logger, fileOps, paths);
    logger.debug(MODULE, 'TemplateScanner initialized');

    logger.debug(MODULE, 'Initializing FileCopier...');
    const copier = new FileCopier(logger, fileOps, paths);
    logger.debug(MODULE, 'FileCopier initialized');

    logger.debug(MODULE, 'Initializing HookManager...');
    const hookManager = new HookManager(logger, settings, state);
    logger.debug(MODULE, 'HookManager initialized');

    logger.debug(MODULE, 'Initializing AgentActivator...');
    const agentActivator = new AgentActivator(logger, settings, state, paths);
    logger.debug(MODULE, 'AgentActivator initialized');

    logger.debug(MODULE, 'Initializing McpDeployer...');
    const tokenManager = new McpTokenManager(logger, context.secrets);
    const mcpDeployer = new McpDeployer(logger, fileOps, paths, tokenManager);
    logger.debug(MODULE, 'McpDeployer initialized');

    logger.debug(MODULE, 'Initializing McpLifecycleManager...');
    const lifecycleManager = new McpLifecycleManager(logger);
    mcpLifecycle = lifecycleManager;
    logger.debug(MODULE, 'McpLifecycleManager initialized');

    logger.debug(MODULE, 'Initializing DeploymentEngine...');
    const engine = new DeploymentEngine(
      logger,
      paths,
      scanner,
      copier,
      hookManager,
      agentActivator,
      mcpDeployer,
      state,
      settings
    );
    logger.debug(MODULE, 'DeploymentEngine initialized');

    // ── 5. Webview ─────────────────────────────────────────────────────
    logger.debug(MODULE, 'Initializing MessageHandler...');
    const messageHandler = new MessageHandler(logger);
    logger.debug(MODULE, 'MessageHandler initialized');

    logger.debug(MODULE, 'Initializing SudxWebviewProvider...');
    const webviewProvider = new SudxWebviewProvider(
      logger,
      messageHandler,
      engine,
      hookManager,
      settings,
      state,
      scanner,
      context,
      tokenManager
    );
    logger.debug(MODULE, 'SudxWebviewProvider initialized');

    // ── 6. Status Bar ──────────────────────────────────────────────────
    logger.debug(MODULE, 'Initializing StatusBarManager...');
    const statusBar = new StatusBarManager(logger);
    try {
      const statusBarDisposable = statusBar.getDisposable();
      if (statusBarDisposable) {
        context.subscriptions.push(statusBarDisposable);
        logger.debug(MODULE, 'StatusBar disposable registered');
      }
    } catch (statusBarDispErr) {
      logger.warn(MODULE, 'Failed to register statusBar disposable', statusBarDispErr);
    }

    // Bridge engine state changes to status bar
    logger.debug(MODULE, 'Registering engine state change listener...');
    engine.onStateChange((_oldState, newState) => {
      logger.debug(MODULE, `Engine state changed: ${_oldState} -> ${newState}`);
      switch (newState) {
        case 'deploying':
          statusBar.setState('deploying');
          break;
        case 'completed':
          statusBar.setState('deployed');
          break;
        case 'error':
          statusBar.setState('error');
          break;
        case 'idle':
        case 'cancelled':
          statusBar.setState('idle');
          break;
      }
    });

    // ── 6b. Health Monitor ─────────────────────────────────────────────
    logger.debug(MODULE, 'Initializing McpHealthMonitor...');
    const healthIntervalMs = settings.getMcpHealthCheckInterval() * 1000;
    const healthMonitor = new McpHealthMonitor(logger, healthIntervalMs);
    mcpHealth = healthMonitor;

    // Restore cached health on startup
    const cachedHealth = state.getMcpHealthCache();
    if (cachedHealth.length > 0) {
      const validHealth = cachedHealth.filter(s => VALID_MCP_SERVERS.includes(s.serverName));
      const removedCount = cachedHealth.length - validHealth.length;
      if (removedCount > 0) {
        logger.debug(MODULE, 'Filtered stale health entries from cache', {
          removed: removedCount,
          staleServers: cachedHealth.filter(s => !VALID_MCP_SERVERS.includes(s.serverName)).map(s => s.serverName),
        });
      }
      healthMonitor.restoreFromCache(validHealth);
      statusBar.updateMcpHealth(validHealth);
      logger.debug(MODULE, 'MCP health restored from cache', { count: validHealth.length });
    }

    // Wire health changes to status bar + cache
    healthMonitor.onHealthChanged((statuses) => {
      statusBar.updateMcpHealth(statuses);
      state.setMcpHealthCache(statuses);
    });

    try {
      healthMonitor.start();
      logger.debug(MODULE, 'McpHealthMonitor started');
    } catch (healthErr) {
      logger.error(MODULE, 'McpHealthMonitor failed to start — extension continues without health monitoring', healthErr);
    }
    context.subscriptions.push(healthMonitor);

    // ── 7. Commands ────────────────────────────────────────────────────
    logger.debug(MODULE, 'Initializing CommandRegistry...');
    const commands = new CommandRegistry(
      logger,
      settings,
      engine,
      mcpDeployer,
      lifecycleManager,
      state,
      webviewProvider,
      statusBar,
      context
    );
    logger.debug(MODULE, 'Registering commands...');
    commands.registerAll();
    context.subscriptions.push(...commands.getDisposables());
    logger.debug(MODULE, 'Commands registered');

    // ── 7b. Backend Commands ─────────────────────────────────────────────
    logger.debug(MODULE, 'Registering backend commands...');

    const connectCmd = vscode.commands.registerCommand(COMMANDS.CONNECT_BACKEND, async () => {
      logger.debug(MODULE, 'connectBackend command triggered');
      try {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        let backendUrl = config.get<string>('vpsBackendUrl', '');

        if (!backendUrl) {
          backendUrl = await vscode.window.showInputBox({
            prompt: 'Enter the VPS Backend URL',
            placeHolder: 'https://rtnc.sudx.de:8420',
            ignoreFocusOut: true,
          }) ?? '';
        }

        if (!backendUrl) {
          logger.debug(MODULE, 'connectBackend cancelled — no URL provided');
          return;
        }

        // Get token: SecretStorage first, then settings fallback
        let token = await context.secrets.get(BACKEND_TOKEN_KEY) ?? '';
        if (!token) {
          token = config.get<string>('vpsBackendToken', '');
        }

        if (!token) {
          token = await vscode.window.showInputBox({
            prompt: 'Enter the Backend API token',
            password: true,
            ignoreFocusOut: true,
          }) ?? '';
        }

        if (!token) {
          logger.debug(MODULE, 'connectBackend cancelled — no token provided');
          return;
        }

        // Store token securely if configured
        const storeSecurely = config.get<boolean>('storeTokenSecurely', true);
        if (storeSecurely) {
          await context.secrets.store(BACKEND_TOKEN_KEY, token);
          logger.debug(MODULE, 'Backend token stored in SecretStorage');
        }

        // Disconnect existing client if any
        if (sseClient) {
          sseClient.dispose();
          sseClient = null;
        }
        if (debugBridge) {
          debugBridge.dispose();
          debugBridge = null;
        }

        // Create and connect SSE client
        sseClient = new McpLoggerClient(logger, {
          backendUrl,
          authToken: token,
        });
        sseClient.connect();

        // Create debug data bridge
        debugBridge = new McpDebugDataBridge(
          logger,
          sseClient,
          context.globalState,
          backendUrl,
          token
        );

        logger.info(MODULE, 'Backend SSE connected', { url: backendUrl });
        statusBar.updateBackendStatus(true);
        vscode.window.showInformationMessage('Sudx CC: Connected to Backend SSE');
      } catch (err) {
        logger.error(MODULE, 'Failed to connect to backend', err);
        statusBar.updateBackendStatus(false);
        vscode.window.showErrorMessage('Sudx CC: Failed to connect to backend — check log for details');
      }
    });

    const disconnectCmd = vscode.commands.registerCommand(COMMANDS.DISCONNECT_BACKEND, () => {
      logger.debug(MODULE, 'disconnectBackend command triggered');
      try {
        if (debugBridge) {
          debugBridge.dispose();
          debugBridge = null;
        }
        if (sseClient) {
          sseClient.dispose();
          sseClient = null;
        }
        logger.info(MODULE, 'Backend SSE disconnected');
        statusBar.updateBackendStatus(false);
        vscode.window.showInformationMessage('Sudx CC: Disconnected from Backend SSE');
      } catch (err) {
        logger.error(MODULE, 'Error during backend disconnect', err);
      }
    });

    const setTokenCmd = vscode.commands.registerCommand(COMMANDS.SET_BACKEND_TOKEN, async () => {
      logger.debug(MODULE, 'setBackendToken command triggered');
      try {
        const token = await vscode.window.showInputBox({
          prompt: 'Enter backend API token',
          password: true,
          ignoreFocusOut: true,
        });

        if (token === undefined) {
          logger.debug(MODULE, 'setBackendToken cancelled by user');
          return;
        }

        if (token) {
          await context.secrets.store(BACKEND_TOKEN_KEY, token);
          logger.info(MODULE, 'Backend token stored in SecretStorage');
          vscode.window.showInformationMessage('Sudx CC: Backend token stored securely');
        } else {
          await context.secrets.delete(BACKEND_TOKEN_KEY);
          logger.info(MODULE, 'Backend token cleared from SecretStorage');
          vscode.window.showInformationMessage('Sudx CC: Backend token cleared');
        }
      } catch (err) {
        logger.error(MODULE, 'Failed to store backend token', err);
        vscode.window.showErrorMessage('Sudx CC: Failed to store backend token');
      }
    });

    context.subscriptions.push(connectCmd, disconnectCmd, setTokenCmd);
    logger.debug(MODULE, 'Backend commands registered');

    // ── 7c. Backend Auto-Connect ───────────────────────────────────────
    const backendConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const autoConnect = backendConfig.get<boolean>('autoConnectToBackend', false);
    const backendUrl = backendConfig.get<string>('vpsBackendUrl', '');

    if (autoConnect && backendUrl) {
      logger.debug(MODULE, 'Auto-connecting to backend SSE...');
      context.secrets.get(BACKEND_TOKEN_KEY).then((secureToken) => {
        const token = secureToken ?? backendConfig.get<string>('vpsBackendToken', '');
        if (!token) {
          logger.warn(MODULE, 'Auto-connect skipped — no backend token configured');
          return;
        }

        try {
          sseClient = new McpLoggerClient(logger, {
            backendUrl,
            authToken: token,
          });
          sseClient.connect();

          debugBridge = new McpDebugDataBridge(
            logger,
            sseClient,
            context.globalState,
            backendUrl,
            token
          );

          logger.info(MODULE, 'Backend SSE auto-connected', { url: backendUrl });
          statusBar.updateBackendStatus(true);
        } catch (err) {
          logger.error(MODULE, 'Backend SSE auto-connect failed', err);
          statusBar.updateBackendStatus(false);
        }
      }).catch((err) => {
        logger.error(MODULE, 'Failed to retrieve backend token for auto-connect', err);
      });
    } else {
      logger.debug(MODULE, 'Backend auto-connect skipped', {
        autoConnect,
        hasUrl: !!backendUrl,
      });
    }

    logger.info(MODULE, 'All services initialized successfully');

    // ── 8. Auto-Deploy ───────────────────────────────────────────────────
    // Runs deployment automatically on activation so templates, hooks,
    // agent config and MCP servers are always up-to-date without manual trigger.
    logger.debug(MODULE, 'Starting auto-deploy...');
    const deployPath = settings.getDeployPath();
    if (!deployPath) {
      logger.warn(MODULE, 'Auto-deploy skipped — deployPath is empty');
    } else {
      const autoDeployConfig = {
        hookConfig: settings.getHookConfig(),
        autoActivateAgent: settings.getAutoActivateAgent(),
        deployPath,
      };
      engine.deploy(autoDeployConfig, context).then((result) => {
        if (result.success) {
          logger.info(MODULE, 'Auto-deploy completed successfully', {
            deployedFiles: result.deployedFiles.length,
            skippedFiles: result.skippedFiles.length,
            duration: result.duration,
          });
        } else {
          logger.warn(MODULE, 'Auto-deploy completed with errors', {
            errors: result.errors,
          });
        }
      }).catch((err) => {
        logger.error(MODULE, 'Auto-deploy failed unexpectedly', err);
      });
    }
  } catch (err) {
    logger.error(MODULE, 'Failed to activate extension', err);
    vscode.window.showErrorMessage('Sudx Copilot Customizations failed to activate. Check the log.');
  }
}

export function deactivate(): void {
  try {
    if (debugBridge) {
      debugBridge.dispose();
      debugBridge = null;
    }
    if (sseClient) {
      sseClient.dispose();
      sseClient = null;
    }
    if (mcpHealth) {
      mcpHealth.dispose();
      mcpHealth = null;
    }
    if (mcpLifecycle) {
      mcpLifecycle.dispose();
      mcpLifecycle = null;
    }
    if (logger) {
      logger.debug(MODULE, 'deactivate() called — cleaning up extension');
      logger.info(MODULE, STRINGS.LOG_EXTENSION_DEACTIVATED);
      logger.debug(MODULE, 'Extension deactivation complete');
    }
  } catch (err) {
    // Silently fail during deactivation — extension is shutting down anyway
    console.error('[Sudx CC] Error during deactivation:', err);
  }
}
