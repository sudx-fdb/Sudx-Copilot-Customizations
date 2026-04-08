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

      log('init', 'done');
    } catch (err) {
      log('init', 'ERROR: ' + (err && err.message ? err.message : err));
    }
  }

  function cacheElements() {
    log('cacheElements', 'start');
    serverToggles = document.querySelectorAll('[data-mcp-server-toggle]');
    healthDots = document.querySelectorAll('.mcp-status-dot');
    log('cacheElements', 'toggles=' + (serverToggles ? serverToggles.length : 0) +
      ' dots=' + (healthDots ? healthDots.length : 0));
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

  // ─── Export ────────────────────────────────────────────────────────────

  window.SudxMcp = {
    init: init,
    requestMcpData: requestMcpData,
    getHealthState: function () { return serverHealthState; },
  };
})();
