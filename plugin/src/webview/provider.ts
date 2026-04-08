import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { SudxLogger } from '../utils/logger';
import { MessageHandler } from './messaging';
import { DeploymentEngine } from '../deployment/engine';
import { HookManager } from '../deployment/hooks';
import { SudxSettings } from '../config/settings';
import { StateManager } from '../config/state';
import { McpTokenManager } from '../mcp/tokenManager';
import { TemplateScanner } from '../deployment/scanner';
import {
  IConfigDataPayload,
  IStatusDataPayload,
  IDeployProgressPayload,
  IUpdateHookPayload,
  IHookConfig,
  IFeatureFlags,
  IMcpServerStatus,
  IMcpServerConfig,
  DeploymentState,
} from '../types';
import {
  WEBVIEW_TYPE,
  WEBVIEW_TITLE,
  STRINGS,
  FEATURES,
  ERROR_STRINGS,
} from '../constants';

const MODULE = 'WebviewProvider';

export class SudxWebviewProvider {
  private logger: SudxLogger;
  private messageHandler: MessageHandler;
  private engine: DeploymentEngine;
  private hookManager: HookManager;
  private settings: SudxSettings;
  private state: StateManager;
  private scanner: TemplateScanner;
  private tokenManager: McpTokenManager | null;
  private context: vscode.ExtensionContext;

  private panel: vscode.WebviewPanel | null = null;
  private _panelNonce: string | null = null;
  private initTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    logger: SudxLogger,
    messageHandler: MessageHandler,
    engine: DeploymentEngine,
    hookManager: HookManager,
    settings: SudxSettings,
    state: StateManager,
    scanner: TemplateScanner,
    context: vscode.ExtensionContext,
    tokenManager?: McpTokenManager
  ) {
    this.logger = logger;
    this.messageHandler = messageHandler;
    this.engine = engine;
    this.hookManager = hookManager;
    this.settings = settings;
    this.state = state;
    this.scanner = scanner;
    this.tokenManager = tokenManager ?? null;
    this.context = context;

    this.registerMessageHandlers();
    this.registerEngineEvents();
  }

  createOrShowPanel(): void {
    this.logger.debug(MODULE, 'createOrShowPanel called');

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.logger.debug(MODULE, 'Existing panel revealed');
      return;
    }

    this.logger.info(MODULE, 'Creating new webview panel');

    const mediaPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media');

    this.panel = vscode.window.createWebviewPanel(
      WEBVIEW_TYPE,
      WEBVIEW_TITLE,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaPath],
      }
    );

    this.messageHandler.setPanel(this.panel);

    this.panel.webview.html = this.getHtmlContent(this.panel.webview, mediaPath);

    this.panel.onDidDispose(() => {
      this.logger.debug(MODULE, 'Panel disposed');
      if (this.initTimer) {
        clearTimeout(this.initTimer);
        this.initTimer = null;
      }
      this.panel = null;
      this._panelNonce = null;
    });

    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        this.logger.debug(MODULE, 'Panel became visible — pushing fresh data');
        this.pushConfigData();
        this.pushStatusData();
      }
    });

    // Push initial data
    this.initTimer = setTimeout(() => {
      this.initTimer = null;
      this.pushConfigData();
      this.pushStatusData();
    }, 200);
  }

  dispose(): void {
    if (this.initTimer) {
      clearTimeout(this.initTimer);
      this.initTimer = null;
    }
    this.panel?.dispose();
    this.panel = null;
    this.messageHandler.dispose();
  }

  // ─── Private: HTML Generation ──────────────────────────────────────────

  private getHtmlContent(webview: vscode.Webview, mediaPath: vscode.Uri): string {
    this.logger.debug(MODULE, 'Generating HTML content');
    const nonce = this.getOrCreateNonce();
    const uris = this.resolveMediaUris(webview, mediaPath);
    const features = this.getFeatureFlags();
    const version = this.escapeHtml(this.context.extension.packageJSON?.version ?? '0.0.0');

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="color-scheme" content="dark">
  <link rel="stylesheet" href="${uris.mainCss}">
  <link rel="stylesheet" href="${uris.animCss}">
  <link rel="stylesheet" href="${uris.compCss}">
  <title>${this.escapeHtml(WEBVIEW_TITLE)}</title>
</head>
<body data-feature-matrix="${features.matrixRain}" data-feature-crt="${features.crtOverlay}" data-feature-terminal="${features.terminalLogo}" data-feature-animations="${features.deployParticles}">
  ${this.buildMatrixCanvas()}
  <div class="app-container" data-version="${version}">
    ${this.buildErrorBanner()}
    ${this.buildLogoSection()}
    <main id="page-main" class="page page--active">
      ${this.buildStatusSection()}
      ${this.buildHooksSection()}
      ${this.buildMcpSection()}
      ${this.buildAgentSection()}
      ${this.buildDeploySection()}
      ${this.buildFooter()}
    </main>
    ${this.buildLogPage()}
    <div id="status-announcer" aria-live="polite" aria-atomic="true" class="sr-only"></div>
  </div>
  ${this.buildScripts(nonce, uris)}
</body>
</html>`;
  }

  private resolveMediaUris(webview: vscode.Webview, mediaPath: vscode.Uri) {
    return {
      mainCss: webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'styles', 'main.css')),
      animCss: webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'styles', 'animations.css')),
      compCss: webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'styles', 'components.css')),
      messagingJs: webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'scripts', 'messaging.js')),
      animationsJs: webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'scripts', 'animations.js')),
      terminalLogoJs: webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'scripts', 'terminalLogo.js')),
      deployJs: webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'scripts', 'deploy.js')),
      mcpJs: webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'scripts', 'mcp.js')),
      mainJs: webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'scripts', 'main.js')),
    };
  }

  private getFeatureFlags(): IFeatureFlags {
    try {
      const uiSettings = this.settings.getUiSettings();
      return {
        matrixRain: uiSettings.matrixRain && FEATURES.MATRIX_RAIN,
        crtOverlay: uiSettings.crtOverlay && FEATURES.CRT_OVERLAY,
        terminalLogo: FEATURES.TERMINAL_LOGO,
        deployParticles: FEATURES.DEPLOY_PARTICLES,
      };
    } catch (err) {
      this.logger.warn(MODULE, 'Failed to resolve feature flags — using defaults', err);
      return {
        matrixRain: FEATURES.MATRIX_RAIN,
        crtOverlay: FEATURES.CRT_OVERLAY,
        terminalLogo: FEATURES.TERMINAL_LOGO,
        deployParticles: FEATURES.DEPLOY_PARTICLES,
      };
    }
  }

  private buildMatrixCanvas(): string {
    return `<canvas id="matrix-canvas" class="matrix-canvas" aria-hidden="true" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none;opacity:var(--matrix-opacity, 0.12);"></canvas>`;
  }

  private buildErrorBanner(): string {
    return `<a href="#page-main" class="sr-only" style="position:absolute;top:-100px;left:0;z-index:9999;background:var(--bg-primary);color:var(--green-primary);padding:8px 16px;" onfocus="this.style.top='0'" onblur="this.style.top='-100px'">Skip to main content</a>
    <div id="error-banner" class="error-banner" style="display:none;" role="alert">
      <span class="error-banner__text">${this.escapeHtml(ERROR_STRINGS.CONNECTION_LOST)}</span>
      <button class="error-banner__retry" id="error-banner-retry" tabindex="0">Retry</button>
    </div>`;
  }

  private buildLogoSection(): string {
    return `<header class="logo-section" aria-label="Terminal Logo">
      <div id="terminal-logo" class="terminal-logo">
        <span class="terminal-prefix">sudx:copilot_custom:~$</span>
        <span class="terminal-command"></span>
        <span class="terminal-cursor">█</span>
      </div>
      <div id="command-tooltip" class="command-tooltip hidden" role="tooltip">
        <div class="tooltip-content">
          <p class="tooltip-description"></p>
          <span class="tooltip-permission"></span>
        </div>
      </div>
      <div class="logo-section__meta">
        <span class="logo-section__title">${this.escapeHtml(STRINGS.WV_SUBTITLE)}</span>
        <span class="logo-section__version">v${this.escapeHtml(this.context.extension.packageJSON?.version ?? '0.0.0')}</span>
      </div>
    </header>`;
  }

  private buildStatusSection(): string {
    return `<section class="section card" aria-labelledby="status-section-title">
        <h2 class="section-title" id="status-section-title">\u250C\u2500\u2500 ${this.escapeHtml(STRINGS.WV_SECTION_STATUS)}</h2>
        <div class="status-indicator">
          <span class="status-dot status-dot--inactive" id="status-dot"></span>
          <div class="status-info">
            <span class="status-text" id="status-text" aria-live="polite">${this.escapeHtml(STRINGS.STATUS_NOT_DEPLOYED)}</span>
            <span class="status-date" id="status-date"></span>
          </div>
          <span class="file-count" id="file-count">0 files</span>
        </div>
        <div class="mcp-deploy-status" id="mcp-deploy-status" style="display:none"></div>
      </section>`;
  }

  private buildHooksSection(): string {
    const hooks = this.hookManager.getAvailableHooks();

    const hookItems = hooks.map(h => `
          <div class="hook-item" data-hook="${h.name}">
            <div class="hook-item__info">
              <span class="hook-item__name">${this.escapeHtml(h.displayName)}</span>
              <span class="hook-item__desc" title="${this.escapeHtml(h.description)}">${this.escapeHtml(h.description)}</span>
            </div>
            <button class="toggle" role="switch" aria-checked="true" aria-label="${this.escapeHtml(h.displayName)}: Enabled" aria-roledescription="toggle switch" data-hook="${h.name}" tabindex="0">
              <span class="toggle__label--on">${this.escapeHtml(STRINGS.TOGGLE_ON)}</span>
              <span class="toggle__label--off">${this.escapeHtml(STRINGS.TOGGLE_OFF)}</span>
            </button>
          </div>`).join('');

    return `<section class="section skeleton-loading" aria-labelledby="hooks-section-title">
        <h2 class="section-title" id="hooks-section-title">\u250C\u2500\u2500 ${this.escapeHtml(STRINGS.WV_SECTION_HOOKS)}</h2>
        <p class="section-description">${this.escapeHtml(STRINGS.WV_SECTION_HOOKS_DESC)}</p>
        <div class="card">${hookItems}
        </div>
      </section>`;
  }

  private buildMcpSection(): string {
    this.logger.debug(MODULE, 'Building MCP Servers section');

    const servers = [
      { name: 'Playwright', key: 'playwright', transport: 'stdio' },
      { name: 'Crawl4ai', key: 'crawl4ai', transport: 'SSE' },
    ];

    const serverItems = servers.map(s => `
          <div class="hook-item" data-mcp-server="${s.key}">
            <div class="hook-item__info">
              <span class="hook-item__name">${this.escapeHtml(s.name)}</span>
              <span class="hook-item__desc">${this.escapeHtml(s.transport)}</span>
            </div>
            <div class="hook-item__controls">
              <span class="status-dot status-dot--inactive mcp-status-dot" data-mcp-server="${s.key}" title="Not configured"></span>
              <button class="toggle" role="switch" aria-checked="true" aria-label="${this.escapeHtml(s.name)}: Enabled" aria-roledescription="toggle switch" data-mcp-server-toggle="${s.key}" tabindex="0">
                <span class="toggle__label--on">${this.escapeHtml(STRINGS.TOGGLE_ON)}</span>
                <span class="toggle__label--off">${this.escapeHtml(STRINGS.TOGGLE_OFF)}</span>
              </button>
            </div>
          </div>`).join('');

    return `<section class="section skeleton-loading" aria-labelledby="mcp-section-title">
        <h2 class="section-title" id="mcp-section-title">\u250C\u2500\u2500 ${this.escapeHtml(STRINGS.WV_SECTION_MCP)}</h2>
        <p class="section-description">${this.escapeHtml(STRINGS.WV_SECTION_MCP_DESC)}</p>
        <div class="card">${serverItems}
        </div>
      </section>`;
  }

  private buildAgentSection(): string {
    return `<section class="section skeleton-loading" aria-labelledby="agent-section-title">
        <h2 class="section-title" id="agent-section-title">\u250C\u2500\u2500 ${this.escapeHtml(STRINGS.WV_SECTION_AGENT)}</h2>
        <div class="card">
          <div class="hook-item" data-setting="autoActivateAgent">
            <div class="hook-item__info">
              <span class="hook-item__name">${this.escapeHtml(STRINGS.AGENT_TOGGLE_LABEL)}</span>
              <span class="hook-item__desc" title="${this.escapeHtml(STRINGS.AGENT_TOGGLE_DESC)}">${this.escapeHtml(STRINGS.AGENT_TOGGLE_DESC)}</span>
            </div>
            <button class="toggle" role="switch" aria-checked="true" aria-label="${this.escapeHtml(STRINGS.AGENT_TOGGLE_LABEL)}: Enabled" aria-roledescription="toggle switch" id="agent-toggle" tabindex="0">
              <span class="toggle__label--on">${this.escapeHtml(STRINGS.TOGGLE_ON)}</span>
              <span class="toggle__label--off">${this.escapeHtml(STRINGS.TOGGLE_OFF)}</span>
            </button>
          </div>
        </div>
      </section>`;
  }

  private buildDeploySection(): string {
    return `<section class="section skeleton-loading" aria-labelledby="deploy-section-title">
        <h2 class="sr-only" id="deploy-section-title">${this.escapeHtml(STRINGS.WV_SECTION_DEPLOY)}</h2>
        <button class="deploy-btn" id="deploy-btn" aria-describedby="progress-text" tabindex="0">
          <span class="deploy-btn__text">${this.escapeHtml(STRINGS.BTN_EXECUTE_DEPLOY)}</span>
        </button>
        <div class="progress" id="progress-container" style="display:none;">
          <div class="progress__bar" id="progress-bar" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100" style="width:0%"></div>
        </div>
        <p class="progress__text" id="progress-text" style="display:none;" aria-live="polite"></p>
        <div class="deploy-log-preview" aria-label="Deploy log preview">
          <div class="deploy-log-preview__body" id="log-preview-body"></div>
          <a class="deploy-log-preview__link" id="log-preview-link" href="#" style="display:none;">view full log \u2192</a>
        </div>
      </section>`;
  }

  private buildFooter(): string {
    return `<footer class="footer" role="contentinfo">
        <div class="footer__links">
          <a class="footer__link" id="reset-btn" href="#">${this.escapeHtml(STRINGS.WV_RESET)}</a>
          <a class="footer__link" id="log-btn" href="#">${this.escapeHtml(STRINGS.WV_OPEN_LOG)}</a>
        </div>
      </footer>`;
  }

  private buildLogPage(): string {
    return `<div id="page-log" class="page">
      <div class="log-page">
        <div class="log-header">
          <h2 class="log-header__title" id="log-header-title">\u250C\u2500\u2500 ${this.escapeHtml(STRINGS.LOG_TITLE)}</h2>
          <p class="log-header__summary" id="log-header-summary"></p>
        </div>
        <div class="log-filters" role="toolbar" aria-label="Log filters">
          <button class="log-filter-btn log-filter-btn--active" data-filter="all">[ALL]</button>
          <button class="log-filter-btn" data-filter="success">[\u2713]</button>
          <button class="log-filter-btn" data-filter="error">[\u2717]</button>
          <button class="log-filter-btn" data-filter="skip">[\u2014]</button>
          <button class="log-filter-btn" data-filter="mcp">[\u25C6 MCP]</button>
        </div>
        <div class="log-body" id="log-body" role="log" aria-live="polite">
          <p class="log-empty" id="log-empty">${this.escapeHtml(STRINGS.WV_LOG_EMPTY)}</p>
        </div>
        <div class="log-autoscroll">
          <button class="log-autoscroll__btn log-autoscroll__btn--on" id="log-autoscroll-btn">${this.escapeHtml(STRINGS.LOG_AUTOSCROLL_ON)}</button>
        </div>
        <a class="log-back" id="log-back-btn" href="#">${this.escapeHtml(STRINGS.LOG_BACK)}</a>
      </div>
    </div>`;
  }

  private buildScripts(nonce: string, uris: ReturnType<typeof SudxWebviewProvider.prototype.resolveMediaUris>): string {
    return `<script nonce="${nonce}" src="${uris.messagingJs}" defer data-load-order="1"></script>
  <script nonce="${nonce}" src="${uris.animationsJs}" defer data-load-order="2"></script>
  <script nonce="${nonce}" src="${uris.terminalLogoJs}" defer data-load-order="3"></script>
  <script nonce="${nonce}" src="${uris.deployJs}" defer data-load-order="4"></script>
  <script nonce="${nonce}" src="${uris.mcpJs}" defer data-load-order="5"></script>
  <script nonce="${nonce}" src="${uris.mainJs}" defer data-load-order="6"></script>`;
  }

  // ─── Private: Message Handlers ─────────────────────────────────────────

  private registerMessageHandlers(): void {
    this.messageHandler.registerHandler('getConfig', async (_payload, requestId) => {
      await this.pushConfigData(requestId);
    });

    this.messageHandler.registerHandler('getStatus', async (_payload, requestId) => {
      await this.pushStatusData(requestId);
    });

    this.messageHandler.registerHandler('getHistory', async (_payload, requestId) => {
      const history = this.state.getDeploymentHistory();
      await this.messageHandler.sendToWebview({
        type: 'historyData',
        payload: history,
        requestId,
        success: true,
      });
    });

    this.messageHandler.registerHandler('updateHook', async (payload, requestId) => {
      const data = payload as IUpdateHookPayload;
      await this.hookManager.setHookEnabled(data.hookName, data.enabled);
      await this.messageHandler.sendToWebview({
        type: 'hookUpdated',
        payload: { hookName: data.hookName, enabled: data.enabled },
        requestId,
        success: true,
      });
    });

    this.messageHandler.registerHandler('updateAllHooks', async (payload, requestId) => {
      await this.hookManager.setAllHooks(payload as IHookConfig);
      await this.messageHandler.sendToWebview({
        type: 'hookUpdated',
        payload: this.hookManager.getHookConfig(),
        requestId,
        success: true,
      });
    });

    this.messageHandler.registerHandler('toggleAgent', async (payload, requestId) => {
      const data = payload as { enabled: boolean };
      await this.settings.setAutoActivateAgent(data.enabled);
      await this.messageHandler.sendToWebview({
        type: 'configData',
        payload: { autoActivateAgent: data.enabled },
        requestId,
        success: true,
      });
    });

    this.messageHandler.registerHandler('deploy', async (_payload, _requestId) => {
      const config = {
        hookConfig: this.hookManager.getHookConfig(),
        autoActivateAgent: this.settings.getAutoActivateAgent(),
        deployPath: this.settings.getDeployPath(),
      };

      const result = await this.engine.deploy(config, this.context);

      if (result.success) {
        await this.messageHandler.sendToWebview({
          type: 'deployComplete',
          payload: result,
          success: true,
        });
      } else {
        await this.messageHandler.sendToWebview({
          type: 'deployError',
          payload: result,
          success: false,
          error: result.errors[0]?.error ?? 'Deployment failed',
        });
      }
    });

    this.messageHandler.registerHandler('cancelDeploy', async () => {
      this.engine.cancel();
    });

    this.messageHandler.registerHandler('resetConfig', async (_payload, requestId) => {
      await this.settings.resetAll();
      await this.hookManager.resetToDefaults();
      await this.pushConfigData(requestId);
    });

    this.messageHandler.registerHandler('openLog', async () => {
      this.logger.show();
      vscode.window.showInformationMessage('Deployment log opened in Output panel');
    });

    this.messageHandler.registerHandler('pushUiSettings', async (_payload, requestId) => {
      this.logger.debug(MODULE, 'Pushing UI settings to webview');
      const uiSettings = this.settings.getUiSettings();
      const featureFlags = this.getFeatureFlags();
      await this.messageHandler.sendToWebview({
        type: 'uiSettings',
        payload: { uiSettings, featureFlags },
        requestId,
        success: true,
      });
    });

    this.messageHandler.registerHandler('getLogData', async (_payload, requestId) => {
      this.logger.debug(MODULE, 'Sending fresh log data to webview');
      const history = this.state.getDeploymentHistory();
      await this.messageHandler.sendToWebview({
        type: 'logData',
        payload: history,
        requestId,
        success: true,
      });
    });

    this.messageHandler.registerHandler('getMcpServers', async (_payload, requestId) => {
      this.logger.debug(MODULE, 'Fetching MCP server status for webview');
      try {
        const servers = await this.readMcpServerStatus();
        await this.messageHandler.sendToWebview({
          type: 'mcpServersData',
          payload: servers,
          requestId,
          success: true,
        });
        this.logger.debug(MODULE, 'MCP server status pushed', { count: servers.length });
      } catch (err) {
        this.logger.error(MODULE, 'Failed to read MCP server status', err);
        await this.messageHandler.sendToWebview({
          type: 'mcpServersData',
          payload: [],
          requestId,
          success: false,
          error: 'Failed to read MCP configuration',
        });
      }
    });

    this.messageHandler.registerHandler('updateMcpServer', async (payload, requestId) => {
      this.logger.debug(MODULE, 'Updating individual MCP server toggle', payload);
      const data = payload as { serverName: string; enabled: boolean };
      const current = this.settings.getMcpServerConfig();
      current[data.serverName] = data.enabled;
      await this.settings.setMcpServerConfig(current);
      await this.messageHandler.sendToWebview({
        type: 'configData',
        payload: { mcpServers: current },
        requestId,
        success: true,
      });
    });

    this.messageHandler.registerHandler('updateAllMcpServers', async (payload, requestId) => {
      this.logger.debug(MODULE, 'Updating all MCP server toggles', payload);
      const config = payload as IMcpServerConfig;
      await this.settings.setMcpServerConfig(config);
      await this.messageHandler.sendToWebview({
        type: 'configData',
        payload: { mcpServers: config },
        requestId,
        success: true,
      });
    });

    this.messageHandler.registerHandler('setMcpToken', async (payload, requestId) => {
      this.logger.debug(MODULE, 'setMcpToken request received');
      const data = payload as { serverName: string; token: string };
      if (!this.tokenManager) {
        await this.messageHandler.sendToWebview({ type: 'mcpTokenStatus', payload: { serverName: data.serverName, hasToken: false, error: 'Token manager not available' }, requestId, success: false });
        return;
      }
      const result = await this.tokenManager.storeToken(data.serverName, data.token);
      await this.messageHandler.sendToWebview({
        type: 'mcpTokenStatus',
        payload: { serverName: data.serverName, hasToken: result.success, error: result.error },
        requestId,
        success: result.success,
      });
    });

    this.messageHandler.registerHandler('clearMcpToken', async (payload, requestId) => {
      this.logger.debug(MODULE, 'clearMcpToken request received');
      const data = payload as { serverName: string };
      if (!this.tokenManager) {
        await this.messageHandler.sendToWebview({ type: 'mcpTokenStatus', payload: { serverName: data.serverName, hasToken: false }, requestId, success: true });
        return;
      }
      const result = await this.tokenManager.deleteToken(data.serverName);
      await this.messageHandler.sendToWebview({
        type: 'mcpTokenStatus',
        payload: { serverName: data.serverName, hasToken: false, error: result.error },
        requestId,
        success: result.success,
      });
    });

    this.messageHandler.registerHandler('getMcpTokenStatus', async (payload, requestId) => {
      this.logger.debug(MODULE, 'getMcpTokenStatus request received');
      const data = payload as { serverName: string };
      const hasToken = this.tokenManager ? await this.tokenManager.hasToken(data.serverName) : false;
      await this.messageHandler.sendToWebview({
        type: 'mcpTokenStatus',
        payload: { serverName: data.serverName, hasToken },
        requestId,
        success: true,
      });
    });

    // Push UI settings to webview when settings change
    this.settings.onSettingsChanged(({ key }) => {
      if (key.startsWith('ui.') && this.panel) {
        this.logger.debug(MODULE, 'UI setting changed — pushing to webview', { key });
        const uiSettings = this.settings.getUiSettings();
        const featureFlags = this.getFeatureFlags();
        this.messageHandler.sendToWebview({
          type: 'uiSettings',
          payload: { uiSettings, featureFlags },
          success: true,
        });
      }
    });
  }

  private registerEngineEvents(): void {
    this.engine.onProgress((current, total, fileName) => {
      const payload: IDeployProgressPayload = {
        state: this.engine.getState(),
        current,
        total,
        currentFile: fileName,
        percent: Math.round((current / total) * 100),
      };
      this.messageHandler.sendToWebview({
        type: 'deployProgress',
        payload,
        success: true,
      });
    });

    this.engine.onStateChange((_oldState, newState) => {
      this.logger.debug(MODULE, 'Engine state changed', { newState });
      this.messageHandler.sendToWebview({
        type: 'statusData',
        payload: { deploymentState: newState },
        success: true,
      });

      if (this.panel) {
        switch (newState) {
          case DeploymentState.Deploying:
            this.panel.title = `${WEBVIEW_TITLE} \u2014 Deploying...`;
            break;
          case DeploymentState.Completed:
            this.panel.title = `${WEBVIEW_TITLE} \u2014 \u2713 Deployed`;
            break;
          case DeploymentState.Error:
            this.panel.title = `${WEBVIEW_TITLE} \u2014 \u2717 Error`;
            break;
          default:
            this.panel.title = WEBVIEW_TITLE;
            break;
        }
      }
    });
  }

  // ─── Private: Data Push ────────────────────────────────────────────────

  private async pushConfigData(requestId?: string): Promise<void> {
    this.logger.debug(MODULE, 'Pushing config data to webview');
    try {
      const status = await this.engine.getDeploymentStatus();
      const allFiles = await this.scanner.scan(this.context);
      const uiSettings = this.settings.getUiSettings();

      const payload: IConfigDataPayload = {
        hooks: this.hookManager.getHookConfig(),
        autoActivateAgent: this.settings.getAutoActivateAgent(),
        deployPath: this.settings.getDeployPath(),
        isDeployed: status.deployed,
        lastDeployDate: status.lastDeployDate?.toISOString() ?? null,
        fileCount: allFiles.length,
        uiSettings,
        featureFlags: this.getFeatureFlags(),
        mcpServers: this.settings.getMcpServerConfig(),
      };

      await this.messageHandler.sendToWebview({
        type: 'configData',
        payload,
        requestId,
        success: true,
      });
      this.logger.debug(MODULE, 'Config data pushed successfully');
    } catch (err) {
      this.logger.error(MODULE, 'Failed to push config data', err);
    }
  }

  private async pushStatusData(requestId?: string): Promise<void> {
    this.logger.debug(MODULE, 'Pushing status data to webview');
    try {
      const status = await this.engine.getDeploymentStatus();

      const payload: IStatusDataPayload = {
        deployed: status.deployed,
        lastDeployDate: status.lastDeployDate?.toISOString() ?? null,
        filesCount: status.filesCount,
        deploymentState: this.engine.getState(),
        mcpDeployed: status.mcpDeployed,
        lastMcpDeployDate: status.lastMcpDeployDate,
        mcpServerCount: status.mcpServerCount,
        mcpServers: status.mcpServers,
      };

      await this.messageHandler.sendToWebview({
        type: 'statusData',
        payload,
        requestId,
        success: true,
      });
      this.logger.debug(MODULE, 'Status data pushed successfully');
    } catch (err) {
      this.logger.error(MODULE, 'Failed to push status data', err);
    }
  }

  // ─── Private: Utilities ────────────────────────────────────────────────

  private async readMcpServerStatus(): Promise<IMcpServerStatus[]> {
    this.logger.debug(MODULE, 'Reading MCP server status from .vscode/mcp.json');
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this.logger.debug(MODULE, 'No workspace folder — returning empty MCP status');
      return [];
    }

    const mcpConfigUri = vscode.Uri.joinPath(workspaceFolders[0].uri, '.vscode', 'mcp.json');

    try {
      const fileData = await vscode.workspace.fs.readFile(mcpConfigUri);
      const content = Buffer.from(fileData).toString('utf-8');
      const parsed = JSON.parse(content);
      const servers: IMcpServerStatus[] = [];

      if (parsed && typeof parsed === 'object' && (parsed.servers || parsed.mcpServers)) {
        const serverMap = parsed.servers ?? parsed.mcpServers;
        for (const [name, entry] of Object.entries(serverMap)) {
          if (!entry || typeof entry !== 'object') { continue; }
          const serverEntry = entry as Record<string, unknown>;
          const isSSE = typeof serverEntry.url === 'string';
          servers.push({
            name,
            transport: isSSE ? 'sse' : 'stdio',
            configured: true,
            command: typeof serverEntry.command === 'string' ? serverEntry.command : undefined,
            url: typeof serverEntry.url === 'string' ? serverEntry.url : undefined,
          });
        }
      }

      this.logger.debug(MODULE, 'MCP server status read', { count: servers.length });
      return servers;
    } catch {
      this.logger.debug(MODULE, 'No .vscode/mcp.json found or unreadable — returning empty');
      return [];
    }
  }

  private getOrCreateNonce(): string {
    if (!this._panelNonce) {
      this._panelNonce = crypto.randomBytes(16).toString('base64');
      this.logger.debug(MODULE, 'Generated new nonce for panel instance');
    }
    return this._panelNonce;
  }

  /**
   * Escapes HTML special characters to prevent XSS.
   * Covers OWASP recommended encoding for HTML context.
   */
  private escapeHtml(text: string | null | undefined): string {
    if (text == null) {
      return '';
    }
    const str = String(text);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
      .replace(/`/g, '&#96;'); // Backticks for JS template literal contexts
  }
}
