// @ts-check
/* ═══════════════════════════════════════════════════════════════════════════
   Sudx Copilot Customizations — MCP Frontend Module
   Handles MCP server toggles, health status, transport badges, token mgmt.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var messaging = window.SudxMessaging;

  // ─── Config ────────────────────────────────────────────────────────────

  var DEBUG = false;
  function log(fn, msg) { if (DEBUG) { console.debug('[Mcp.' + fn + ']', msg); } }

  // ─── DOM References ────────────────────────────────────────────────────

  /** @type {NodeListOf<Element>|null} */
  var serverToggles = null;
  /** @type {NodeListOf<Element>|null} */
  var healthDots = null;
  /** @type {HTMLElement|null} */
  var setTokenBtn = null;
  /** @type {HTMLElement|null} */
  var clearTokenBtn = null;
  /** @type {HTMLElement|null} */
  var tokenStatusEl = null;

  // ─── State ─────────────────────────────────────────────────────────────

  /** @type {Object<string, boolean>} */
  var serverHealthState = {};

  // ─── Init ──────────────────────────────────────────────────────────────

  function init() {
    log('init', 'start');
    try {
      messaging = window.SudxMessaging;
      if (!messaging) {
        console.error('[SudxMcp] Missing: SudxMessaging');
        return;
      }

      cacheElements();
      bindEvents();
      registerMessageHandlers();
      requestMcpData();
      requestTokenStatus();

      log('init', 'done');
    } catch (err) {
      log('init', 'ERROR: ' + (err && err.message ? err.message : err));
    }
  }

  function cacheElements() {
    log('cacheElements', 'start');
    serverToggles = document.querySelectorAll('[data-mcp-server-toggle]');
    healthDots = document.querySelectorAll('.mcp-status-dot');
    setTokenBtn = document.getElementById('mcp-set-figma-token');
    clearTokenBtn = document.getElementById('mcp-clear-figma-token');
    tokenStatusEl = document.getElementById('mcp-figma-token-status');
    log('cacheElements', 'toggles=' + (serverToggles ? serverToggles.length : 0) +
      ' dots=' + (healthDots ? healthDots.length : 0) +
      ' tokenBtn=' + !!setTokenBtn);
  }

  function bindEvents() {
    log('bindEvents', 'start');

    // Server toggle click handlers
    if (serverToggles) {
      for (var i = 0; i < serverToggles.length; i++) {
        serverToggles[i].addEventListener('click', handleMcpServerToggle);
        serverToggles[i].addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleMcpServerToggle.call(this, e);
          }
        });
      }
    }

    // Token management buttons
    if (setTokenBtn) {
      setTokenBtn.addEventListener('click', handleSetToken);
    }
    if (clearTokenBtn) {
      clearTokenBtn.addEventListener('click', handleClearToken);
    }

    log('bindEvents', 'done');
  }

  // ─── MCP Data Request ──────────────────────────────────────────────────

  function requestMcpData() {
    log('requestMcpData', 'sending getMcpServers');
    try {
      messaging.send('getMcpServers');
    } catch (err) {
      log('requestMcpData', 'ERROR: ' + (err && err.message ? err.message : err));
    }
  }

  function requestTokenStatus() {
    log('requestTokenStatus', 'sending getMcpTokenStatus for figma');
    try {
      messaging.send('getMcpTokenStatus', { serverName: 'figma' });
    } catch (err) {
      log('requestTokenStatus', 'ERROR: ' + (err && err.message ? err.message : err));
    }
  }

  // ─── Message Handlers ──────────────────────────────────────────────────

  function registerMessageHandlers() {
    log('registerMessageHandlers', 'start');

    messaging.onMessage('mcpServersData', function (payload) {
      log('onMcpServersData', JSON.stringify(payload));
      if (!payload || !Array.isArray(payload)) { return; }
      for (var i = 0; i < payload.length; i++) {
        var server = payload[i];
        if (server && server.serverName) {
          renderServerHealth(server.serverName, !!server.enabled);
          if (server.transport) {
            renderTransportBadge(server.serverName, server.transport);
          }
        }
      }
    });

    messaging.onMessage('mcpHealthUpdate', function (payload) {
      log('onMcpHealthUpdate', JSON.stringify(payload));
      if (!payload || !Array.isArray(payload)) { return; }
      for (var i = 0; i < payload.length; i++) {
        var status = payload[i];
        if (status && status.serverName) {
          renderServerHealth(status.serverName, !!status.healthy);
        }
      }
    });

    messaging.onMessage('mcpTokenStatus', function (payload) {
      log('onMcpTokenStatus', JSON.stringify(payload));
      if (!payload || typeof payload !== 'object') { return; }
      updateTokenStatusDisplay(!!payload.hasToken);
    });

    log('registerMessageHandlers', 'done');
  }

  // ─── Server Toggle ─────────────────────────────────────────────────────

  /** @param {Event} event */
  function handleMcpServerToggle(event) {
    var target = event.currentTarget || event.target;
    if (!target) { return; }

    var serverName = target.getAttribute('data-mcp-server-toggle');
    if (!serverName) { return; }

    var isChecked = target.getAttribute('aria-checked') === 'true';
    var newState = !isChecked;

    log('handleMcpServerToggle', serverName + ' -> ' + newState);

    target.setAttribute('aria-checked', String(newState));
    target.setAttribute('aria-label', serverName + ': ' + (newState ? 'Enabled' : 'Disabled'));

    try {
      messaging.send('updateMcpServer', { serverName: serverName, enabled: newState });
    } catch (err) {
      log('handleMcpServerToggle', 'ERROR: ' + (err && err.message ? err.message : err));
      // Revert on failure
      target.setAttribute('aria-checked', String(isChecked));
    }
  }

  // ─── Health Rendering ──────────────────────────────────────────────────

  /**
   * @param {string} serverName
   * @param {boolean} healthy
   */
  function renderServerHealth(serverName, healthy) {
    log('renderServerHealth', serverName + '=' + healthy);
    serverHealthState[serverName] = healthy;

    if (!healthDots) { return; }
    for (var i = 0; i < healthDots.length; i++) {
      var dot = healthDots[i];
      if (dot.getAttribute('data-mcp-server') === serverName) {
        dot.classList.remove('status-dot--active', 'status-dot--inactive', 'status-dot--error');
        if (healthy) {
          dot.classList.add('status-dot--active');
          dot.setAttribute('title', serverName + ': healthy');
        } else {
          dot.classList.add('status-dot--error');
          dot.setAttribute('title', serverName + ': unreachable');
        }
      }
    }
  }

  /**
   * @param {string} serverName
   * @param {string} transport
   */
  function renderTransportBadge(serverName, transport) {
    log('renderTransportBadge', serverName + '=' + transport);

    var items = document.querySelectorAll('[data-mcp-server="' + serverName + '"] .hook-item__desc');
    for (var i = 0; i < items.length; i++) {
      items[i].textContent = transport;
    }
  }

  // ─── Token Management ──────────────────────────────────────────────────

  /** @param {Event} _event */
  function handleSetToken(_event) {
    log('handleSetToken', 'prompting for token');

    // Use native prompt for secure input (webview limitation — no password inputs via VS Code API)
    var token = prompt('Enter your Figma personal access token (starts with figd_):');
    if (!token || token.trim().length === 0) {
      log('handleSetToken', 'cancelled or empty');
      return;
    }

    try {
      messaging.send('setMcpToken', { serverName: 'figma', token: token.trim() });
      log('handleSetToken', 'sent setMcpToken');
    } catch (err) {
      log('handleSetToken', 'ERROR: ' + (err && err.message ? err.message : err));
    }
  }

  /** @param {Event} _event */
  function handleClearToken(_event) {
    log('handleClearToken', 'clearing figma token');
    try {
      messaging.send('clearMcpToken', { serverName: 'figma' });
      log('handleClearToken', 'sent clearMcpToken');
    } catch (err) {
      log('handleClearToken', 'ERROR: ' + (err && err.message ? err.message : err));
    }
  }

  /**
   * @param {boolean} hasToken
   */
  function updateTokenStatusDisplay(hasToken) {
    log('updateTokenStatusDisplay', 'hasToken=' + hasToken);
    if (!tokenStatusEl) { return; }

    if (hasToken) {
      tokenStatusEl.textContent = 'Token stored securely';
      tokenStatusEl.classList.add('mcp-token--set');
      tokenStatusEl.classList.remove('mcp-token--not-set');
    } else {
      tokenStatusEl.textContent = 'No token stored';
      tokenStatusEl.classList.remove('mcp-token--set');
      tokenStatusEl.classList.add('mcp-token--not-set');
    }
  }

  // ─── Export ────────────────────────────────────────────────────────────

  window.SudxMcp = {
    init: init,
    requestMcpData: requestMcpData,
    getHealthState: function () { return serverHealthState; },
  };
})();
