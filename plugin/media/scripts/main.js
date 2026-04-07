// @ts-check
/* ═══════════════════════════════════════════════════════════════════════════
   Sudx Copilot Customizations — Hacker Terminal UI Controller
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var messaging = window.SudxMessaging;
  var animations = window.SudxAnimations;

  // ─── Config ────────────────────────────────────────────────────────────

  var DEBUG = false;
  function log(fn, msg) { if (DEBUG) { console.debug('[Main.' + fn + ']', msg); } }

  var BOOT_STAGGER_MS = 80;
  var BOOT_HOOK_DELAY_MS = 250;
  var CONFIG_TIMEOUT_MS = 5000;
  var SKELETON_TIMEOUT_MS = 10000;
  var RETRY_MAX = 3;
  var RETRY_BASE_MS = 1000;
  var ANNOUNCE_DEBOUNCE_MS = 300;

  /** @type {Object|null} */
  var features = null;

  // ─── State ─────────────────────────────────────────────────────────────

  var configReceived = false;
  var retryCount = 0;
  var configTimer = null;
  var skeletonTimer = null;
  var announceTimer = null;

  // ─── DOM Caches ────────────────────────────────────────────────────────

  var statusDot;
  var statusText;
  var statusDate;
  var fileCount;
  var agentToggle;
  var resetBtn;
  var logBtn;
  var logBackBtn;
  var logPreviewLink;
  var statusAnnouncer;

  // Pages
  var pageMain;
  var pageLog;
  var currentPage = 'main';

  // ─── Init ──────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    log('DOMContentLoaded', 'start');
    try {
      // Dependency check
      if (typeof window.SudxMessaging === 'undefined') { console.error('[SudxUI] Missing: SudxMessaging'); return; }
      if (typeof window.SudxAnimations === 'undefined') { console.error('[SudxUI] Missing: SudxAnimations'); return; }
      messaging = window.SudxMessaging;
      animations = window.SudxAnimations;

      cacheElements();
      bindEvents();
      registerMessageHandlers();
      requestInitialData();
      runBootSequence();

      // Init deploy module
      if (window.SudxDeploy) {
        window.SudxDeploy.init();
      }

      // Init matrix rain
      var canvas = document.getElementById('matrix-canvas');
      if (canvas && animations.initMatrixRain) {
        animations.initMatrixRain(canvas);
      }

      // Init terminal logo typing animation
      if (window.SudxTerminalLogo) {
        window.SudxTerminalLogo.init();
      }

      // Skeleton timeout — force remove + error + retry
      skeletonTimer = setTimeout(function () {
        if (!configReceived) {
          log('skeletonTimeout', 'force remove after ' + SKELETON_TIMEOUT_MS + 'ms');
          removeSkeletonLoading();
          showConnectionError();
          retryCount = 0;
          requestInitialData();
        }
      }, SKELETON_TIMEOUT_MS);

      log('DOMContentLoaded', 'done');
    } catch (err) {
      log('DOMContentLoaded', 'ERROR: ' + (err && err.message ? err.message : err));
    }
  });

  // Cleanup on unload
  window.addEventListener('beforeunload', function () {
    log('beforeunload', 'cleanup');
    if (configTimer) { clearTimeout(configTimer); }
    if (skeletonTimer) { clearTimeout(skeletonTimer); }
    if (announceTimer) { clearTimeout(announceTimer); }
    if (animations && animations.destroyAll) { animations.destroyAll(); }
    if (window.SudxTerminalLogo && window.SudxTerminalLogo.destroy) { window.SudxTerminalLogo.destroy(); }
    if (messaging && messaging.stopHeartbeat) { messaging.stopHeartbeat(); }
  });

  // Performance: Pause expensive effects when tab is hidden
  document.addEventListener('visibilitychange', function () {
    var hidden = document.hidden;
    log('visibilitychange', hidden ? 'hidden' : 'visible');

    // CRT overlay: remove will-change when idle
    var crtOverlay = document.querySelector('body::after') ? document.body : null;
    if (crtOverlay) {
      crtOverlay.style.setProperty('--crt-will-change', hidden ? 'auto' : 'transform');
    }

    // Matrix rain: stop/start
    if (animations) {
      if (hidden && animations.stopMatrix) {
        animations.stopMatrix();
      } else if (!hidden && animations.startMatrix) {
        animations.startMatrix();
      }
    }
  });

  function cacheElements() {
    log('cacheElements', 'start');
    statusDot = document.getElementById('status-dot');
    statusText = document.getElementById('status-text');
    statusDate = document.getElementById('status-date');
    fileCount = document.getElementById('file-count');
    agentToggle = document.getElementById('agent-toggle');
    resetBtn = document.getElementById('reset-btn');
    logBtn = document.getElementById('log-btn');
    logBackBtn = document.getElementById('log-back-btn');
    logPreviewLink = document.getElementById('log-preview-link');
    statusAnnouncer = document.getElementById('status-announcer');
    pageMain = document.getElementById('page-main');
    pageLog = document.getElementById('page-log');

    // Warn on missing critical elements
    var critical = { 'status-dot': statusDot, 'page-main': pageMain, 'page-log': pageLog };
    var keys = Object.keys(critical);
    for (var i = 0; i < keys.length; i++) {
      if (!critical[keys[i]]) {
        console.warn('[SudxUI] Missing: #' + keys[i]);
      }
    }
  }

  // ─── Navigation ────────────────────────────────────────────────────────

  /** @param {string} pageId */
  function showPage(pageId) {
    log('showPage', pageId);
    var oldPage = currentPage;
    currentPage = pageId;

    // Page-transition: crossfade 150ms
    var hideEl = oldPage === 'main' ? pageMain : pageLog;
    var showEl = pageId === 'main' ? pageMain : pageLog;

    if (hideEl && showEl && hideEl !== showEl) {
      hideEl.style.transition = 'opacity 150ms ease-out';
      hideEl.style.opacity = '0';
      setTimeout(function () {
        if (pageMain) {
          pageMain.classList.toggle('page--active', pageId === 'main');
          pageMain.classList.toggle('page--hidden', pageId !== 'main');
        }
        if (pageLog) {
          pageLog.classList.toggle('page--active', pageId === 'log');
          pageLog.classList.toggle('page--hidden', pageId !== 'log');
        }
        hideEl.style.opacity = '';
        hideEl.style.transition = '';
        showEl.style.opacity = '0';
        showEl.style.transition = 'opacity 150ms ease-in';
        requestAnimationFrame(function () { showEl.style.opacity = '1'; });
        setTimeout(function () { showEl.style.transition = ''; showEl.style.opacity = ''; }, 160);
      }, 150);
    } else {
      if (pageMain) {
        pageMain.classList.toggle('page--active', pageId === 'main');
        pageMain.classList.toggle('page--hidden', pageId !== 'main');
      }
      if (pageLog) {
        pageLog.classList.toggle('page--active', pageId === 'log');
        pageLog.classList.toggle('page--hidden', pageId !== 'log');
      }
    }
  }

  // Expose for deploy.js
  window.SudxShowPage = showPage;

  // ─── Events ────────────────────────────────────────────────────────────

  function bindEvents() {
    // Hook toggles
    var hookToggles = document.querySelectorAll('.toggle[data-hook]');
    for (var i = 0; i < hookToggles.length; i++) {
      hookToggles[i].addEventListener('click', handleHookToggle);
      hookToggles[i].addEventListener('keydown', handleToggleKeydown);
    }

    // Agent toggle
    if (agentToggle) {
      agentToggle.addEventListener('click', handleAgentToggle);
      agentToggle.addEventListener('keydown', handleToggleKeydown);
    }

    // Footer buttons
    if (resetBtn) {
      resetBtn.addEventListener('click', function (e) {
        e.preventDefault();
        messaging.send('resetConfig');
      });
    }
    if (logBtn) {
      logBtn.addEventListener('click', function (e) {
        e.preventDefault();
        showPage('log');
      });
    }
    if (logBackBtn) {
      logBackBtn.addEventListener('click', function (e) {
        e.preventDefault();
        showPage('main');
      });
    }
    if (logPreviewLink) {
      logPreviewLink.addEventListener('click', function (e) {
        e.preventDefault();
        showPage('log');
      });
    }
  }

  // ─── Message Handlers ──────────────────────────────────────────────────

  function registerMessageHandlers() {
    messaging.onMessage('configData', handleConfigData);
    messaging.onMessage('statusData', handleStatusData);
    messaging.onMessage('hookUpdated', handleHookUpdated);
    messaging.onMessage('uiSettings', handleUiSettings);
    log('registerMessageHandlers', 'registered 4 handlers');
  }

  function requestInitialData() {
    log('requestInitialData', 'attempt=' + retryCount);
    messaging.send('getConfig');
    messaging.send('getStatus');

    // Config timeout — retry or show error
    configTimer = setTimeout(function () {
      if (!configReceived) {
        retryCount++;
        if (retryCount <= RETRY_MAX) {
          var delay = RETRY_BASE_MS * Math.pow(2, retryCount - 1);
          log('requestInitialData', 'retry ' + retryCount + ' in ' + delay + 'ms');
          setTimeout(requestInitialData, delay);
        } else {
          log('requestInitialData', 'max retries reached — showing error');
          showConnectionError();
        }
      }
    }, CONFIG_TIMEOUT_MS);
  }

  function showConnectionError() {
    log('showConnectionError', '');
    removeSkeletonLoading();

    // Use template-based error banner (hidden by default in provider.ts)
    var errorBanner = document.getElementById('error-banner');
    if (errorBanner) {
      errorBanner.style.display = '';
      var retryBtn = document.getElementById('error-banner-retry');
      if (retryBtn && !retryBtn._sudxBound) {
        retryBtn._sudxBound = true;
        retryBtn.addEventListener('click', function () {
          log('showConnectionError', 'retry clicked');
          retryCount = 0;
          configReceived = false;
          hideConnectionError();
          requestInitialData();
        });
      }
    }

    // Fallback: legacy dynamic container (if template not present)
    var errorContainer = document.getElementById('connection-error');
    if (!errorBanner && !errorContainer) {
      errorContainer = document.createElement('div');
      errorContainer.id = 'connection-error';
      errorContainer.className = 'connection-error';
      errorContainer.innerHTML = '<span class="connection-error__text">Connection lost</span>' +
        '<button class="connection-error__retry" type="button">[ RETRY ]</button>';
      var fallbackRetry = errorContainer.querySelector('.connection-error__retry');
      if (fallbackRetry) {
        fallbackRetry.addEventListener('click', function () {
          log('showConnectionError', 'retry clicked');
          retryCount = 0;
          configReceived = false;
          if (errorContainer.parentNode) { errorContainer.parentNode.removeChild(errorContainer); }
          requestInitialData();
        });
      }
      var container = document.querySelector('.app-container');
      if (container) { container.insertBefore(errorContainer, container.firstChild); }
    }
    announceStatus('Connection lost — click Retry');
  }

  function hideConnectionError() {
    log('hideConnectionError', '');
    var errorBanner = document.getElementById('error-banner');
    if (errorBanner) { errorBanner.style.display = 'none'; }
    var errorContainer = document.getElementById('connection-error');
    if (errorContainer && errorContainer.parentNode) { errorContainer.parentNode.removeChild(errorContainer); }
  }

  /** @param {unknown} payload */
  function handleConfigData(payload) {
    log('handleConfigData', JSON.stringify(payload));
    if (!payload || typeof payload !== 'object') { log('handleConfigData', 'invalid payload'); return; }
    var data = /** @type {{ hooks?: Record<string, boolean>, autoActivateAgent?: boolean, isDeployed?: boolean, lastDeployDate?: string|null, fileCount?: number }} */ (payload);

    // Mark config received — stop retries
    configReceived = true;
    if (configTimer) { clearTimeout(configTimer); configTimer = null; }
    if (skeletonTimer) { clearTimeout(skeletonTimer); skeletonTimer = null; }

    // Apply boot-config from extension (dynamic timings)
    if (data.uiConfig) {
      if (typeof data.uiConfig.bootStaggerMs === 'number') { BOOT_STAGGER_MS = data.uiConfig.bootStaggerMs; }
      if (typeof data.uiConfig.bootHookDelayMs === 'number') { BOOT_HOOK_DELAY_MS = data.uiConfig.bootHookDelayMs; }
      log('handleConfigData', 'uiConfig applied');
    }

    // Apply feature flags
    if (data.features) {
      features = data.features;
      applyFeatureFlags(features);
    }

    // Remove connection error if shown
    hideConnectionError();

    removeSkeletonLoading('Configuration loaded');

    // Update hook toggles
    if (data.hooks) {
      var hookNames = ['sessionContext', 'protectPlans', 'postEdit', 'planReminder'];
      for (var i = 0; i < hookNames.length; i++) {
        setToggleState(hookNames[i], data.hooks[hookNames[i]]);
      }
    }

    // Agent toggle
    if (data.autoActivateAgent !== undefined && agentToggle) {
      updateToggleVisual(agentToggle, data.autoActivateAgent);
    }

    // File count
    if (data.fileCount !== undefined && fileCount) {
      var currentVal = parseInt(fileCount.textContent, 10) || 0;
      if (currentVal !== data.fileCount) {
        animations.countUp(fileCount, data.fileCount, 600, ' files');
      }
    }

    // Status
    if (data.isDeployed !== undefined) {
      updateStatusDot(data.isDeployed ? 'active' : 'inactive');
    }
    if (data.lastDeployDate && statusDate) {
      statusDate.textContent = formatDate(data.lastDeployDate);
    }
  }

  /** @param {unknown} payload */
  function handleStatusData(payload) {
    log('handleStatusData', JSON.stringify(payload));
    if (!payload || typeof payload !== 'object') { log('handleStatusData', 'invalid payload'); return; }
    var data = /** @type {{ deployed?: boolean, lastDeployDate?: string|null, filesCount?: number, deploymentState?: string }} */ (payload);

    if (data.deployed !== undefined) {
      updateStatusDot(data.deployed ? 'active' : 'inactive');
      if (statusText) {
        statusText.textContent = data.deployed ? 'DEPLOYED' : 'NOT_DEPLOYED';
      }
    }

    // Handle all deployment states
    if (data.deploymentState) {
      switch (data.deploymentState) {
        case 'deploying':
        case 'scanning':
        case 'verifying':
          updateStatusDot('deploying');
          if (statusText) { statusText.textContent = 'DEPLOYING...'; }
          break;
        case 'completed':
          updateStatusDot('active');
          if (statusText) { statusText.textContent = 'DEPLOYED'; }
          break;
        case 'error':
          updateStatusDot('error');
          if (statusText) { statusText.textContent = 'ERROR'; }
          break;
        case 'idle':
        case 'cancelled':
          // Keep current state, don't update
          break;
      }
    }

    if (data.lastDeployDate && statusDate) {
      statusDate.textContent = formatDate(data.lastDeployDate);
    }

    if (data.filesCount !== undefined && fileCount) {
      var currentVal = parseInt(fileCount.textContent, 10) || 0;
      if (currentVal !== data.filesCount) {
        animations.countUp(fileCount, data.filesCount, 600, ' files');
      }
    }
  }

  /** @param {unknown} payload */
  function handleHookUpdated(payload) {
    log('handleHookUpdated', JSON.stringify(payload));
    if (!payload || typeof payload !== 'object') { log('handleHookUpdated', 'invalid payload'); return; }
    var data = /** @type {Record<string, boolean> & { hookName?: string, enabled?: boolean }} */ (payload);

    if (data.hookName && data.enabled !== undefined) {
      setToggleState(data.hookName, data.enabled);
      return;
    }

    var hookNames = ['sessionContext', 'protectPlans', 'postEdit', 'planReminder'];
    for (var i = 0; i < hookNames.length; i++) {
      if (data[hookNames[i]] !== undefined) {
        setToggleState(hookNames[i], data[hookNames[i]]);
      }
    }
  }

  // ─── UI Handlers ───────────────────────────────────────────────────────

  function handleHookToggle() {
    var hookName = this.getAttribute('data-hook');
    if (!hookName) { return; }
    log('handleHookToggle', hookName);
    var isActive = this.getAttribute('aria-checked') === 'true';
    var newState = !isActive;
    updateToggleVisual(this, newState);
    messaging.send('updateHook', { hookName: hookName, enabled: newState });
  }

  function handleAgentToggle() {
    log('handleAgentToggle', '');
    var isActive = agentToggle.getAttribute('aria-checked') === 'true';
    var newState = !isActive;
    updateToggleVisual(agentToggle, newState);
    messaging.send('toggleAgent', { enabled: newState });
  }

  /** @param {KeyboardEvent} e */
  function handleToggleKeydown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.click();
    }
  }

  // ─── Boot Sequence ─────────────────────────────────────────────────────

  function runBootSequence() {
    log('runBootSequence', 'stagger=' + BOOT_STAGGER_MS + ' hookDelay=' + BOOT_HOOK_DELAY_MS);
    var sections = document.querySelectorAll('.section');
    for (var i = 0; i < sections.length; i++) {
      sections[i].classList.add('skeleton-loading');
    }
    animations.stagger(sections, BOOT_STAGGER_MS, 'fadeSlideUp');

    setTimeout(function () {
      var hookItems = document.querySelectorAll('.hook-item');
      animations.stagger(hookItems, 50, 'fadeSlideLeft');
    }, BOOT_HOOK_DELAY_MS);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /** @param {string} [message] */
  function removeSkeletonLoading(message) {
    var sections = document.querySelectorAll('.section.skeleton-loading');
    for (var i = 0; i < sections.length; i++) {
      sections[i].classList.remove('skeleton-loading');
    }
    if (message) { announceStatus(message); }
  }

  /** @param {string} text */
  function announceStatus(text) {
    log('announceStatus', text);
    // Debounce rapid status updates
    if (announceTimer) { clearTimeout(announceTimer); }
    announceTimer = setTimeout(function () {
      if (statusAnnouncer) { statusAnnouncer.textContent = text; }
    }, ANNOUNCE_DEBOUNCE_MS);
  }

  /**
   * @param {string} hookName
   * @param {boolean} enabled
   */
  function setToggleState(hookName, enabled) {
    var toggle = document.querySelector('.toggle[data-hook="' + hookName + '"]');
    if (toggle) { updateToggleVisual(toggle, enabled); }
  }

  /**
   * @param {Element} toggle
   * @param {boolean} active
   */
  function updateToggleVisual(toggle, active) {
    log('updateToggleVisual', 'active=' + active);
    toggle.setAttribute('aria-checked', String(active));
    // CSS handles label visibility via aria-checked — no inline style needed
  }

  /** @param {'active'|'inactive'|'deploying'|'error'} state */
  function updateStatusDot(state) {
    log('updateStatusDot', state);
    if (!statusDot) { return; }
    var targetClass = 'status-dot--' + state;

    // Prevent flash: only change class if it's actually different
    if (!statusDot.classList.contains(targetClass)) {
      var states = ['active', 'inactive', 'deploying', 'error'];
      for (var i = 0; i < states.length; i++) {
        var cls = 'status-dot--' + states[i];
        if (cls !== targetClass) { statusDot.classList.remove(cls); }
      }
      statusDot.classList.add(targetClass);
    }

    var labels = { active: 'DEPLOYED', inactive: 'OFFLINE', deploying: 'DEPLOYING', error: 'ERROR' };
    var contextParts = [labels[state] || state];
    if (fileCount) { contextParts.push(fileCount.textContent || ''); }
    if (statusDate && statusDate.textContent) { contextParts.push('last: ' + statusDate.textContent); }
    announceStatus('Status: ' + contextParts.join(' \u2014 '));
  }

  // Localized time strings (mirrors STRINGS.TIME_* from constants.ts)
  var TIME_STRINGS = {
    JUST_NOW: 'just now',
    MINUTES_AGO: '{n}m ago',
    HOURS_AGO: '{n}h ago',
    DAYS_AGO: '{n}d ago',
    UNKNOWN: 'Unknown'
  };

  /**
   * @param {string} isoString
   * @returns {string}
   */
  function formatDate(isoString) {
    try {
      var date = new Date(isoString);
      if (isNaN(date.getTime())) { return TIME_STRINGS.UNKNOWN; }
      var now = new Date();
      var diff = now.getTime() - date.getTime();
      var mins = Math.floor(diff / 60000);

      if (mins < 1) { return TIME_STRINGS.JUST_NOW; }
      if (mins < 60) { return TIME_STRINGS.MINUTES_AGO.replace('{n}', String(mins)); }

      var hours = Math.floor(mins / 60);
      if (hours < 24) { return TIME_STRINGS.HOURS_AGO.replace('{n}', String(hours)); }

      var days = Math.floor(hours / 24);
      if (days < 7) { return TIME_STRINGS.DAYS_AGO.replace('{n}', String(days)); }

      return date.toLocaleDateString();
    } catch (_e) {
      return TIME_STRINGS.UNKNOWN;
    }
  }

  // \u2500\u2500\u2500 Feature Flags & UI Settings \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function applyFeatureFlags(f) {
    log('applyFeatureFlags', JSON.stringify(f));
    if (!f) { return; }
    var canvas = document.getElementById('matrix-canvas');
    if (f.MATRIX_RAIN === false && canvas) { canvas.style.display = 'none'; }
    if (f.MATRIX_RAIN === true && canvas) { canvas.style.display = ''; }
    if (f.CRT_OVERLAY === false) { document.body.classList.add('crt-disabled'); }
    if (f.CRT_OVERLAY === true) { document.body.classList.remove('crt-disabled'); }
    if (f.TERMINAL_LOGO === false && window.SudxTerminalLogo) { window.SudxTerminalLogo.destroy(); }
    if (f.ANIMATIONS === false) { document.body.classList.add('anim-paused'); }
    if (f.ANIMATIONS === true) { document.body.classList.remove('anim-paused'); }
  }

  /** @param {unknown} payload */
  function handleUiSettings(payload) {
    log('handleUiSettings', JSON.stringify(payload));
    if (!payload || typeof payload !== 'object') { return; }
    var data = /** @type {{ matrixRain?: boolean, crtOverlay?: boolean, animations?: boolean }} */ (payload);
    if (data.matrixRain !== undefined) {
      var canvas = document.getElementById('matrix-canvas');
      if (canvas) { canvas.style.display = data.matrixRain ? '' : 'none'; }
      if (data.matrixRain && animations.startMatrix) { animations.startMatrix(); }
      if (!data.matrixRain && animations.stopMatrix) { animations.stopMatrix(); }
    }
    if (data.crtOverlay !== undefined) {
      document.body.classList.toggle('crt-disabled', !data.crtOverlay);
    }
    if (data.animations !== undefined) {
      document.body.classList.toggle('anim-paused', !data.animations);
    }
  }
})();
