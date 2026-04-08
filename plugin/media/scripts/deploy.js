// @ts-check
/* ═══════════════════════════════════════════════════════════════════════════
   Sudx Copilot Customizations — Deploy State Machine + Log Page Controller
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var messaging = window.SudxMessaging;
  var animations = window.SudxAnimations;

  // ─── Config ────────────────────────────────────────────────────────────

  var DEBUG = false;
  function log(fn, msg) { if (DEBUG) { console.debug('[Deploy.' + fn + ']', msg); } }

  var MAX_ANIM_TOTAL_MS = 1000;
  var MIN_ANIM_DELAY_MS = 5;
  var LOG_ANIM_THRESHOLD = 50;
  var SCROLL_THRESHOLD = 120;
  var PROGRESS_PATH_MAX = 45;
  var MAX_DOM_ENTRIES = 500;
  var AUTO_RESET_MIN_MS = 8000;
  var AUTO_RESET_MAX_MS = 30000;
  var AUTO_RESET_PER_ERROR_MS = 2000;

  // ─── State ─────────────────────────────────────────────────────────────

  var STATE_IDLE = 'idle';
  var STATE_DEPLOYING = 'deploying';
  var STATE_SUCCESS = 'success';
  var STATE_PARTIAL = 'partial';
  var STATE_ERROR = 'error';
  var STATE_CANCELLED = 'cancelled';
  var currentState = STATE_IDLE;
  var deployLocked = false;

  // ─── DOM References ────────────────────────────────────────────────────

  var deployBtn = null;
  var deployBtnText = null;
  var progressContainer = null;
  var progressBar = null;
  var progressText = null;

  // Inline preview (main page)
  var previewBody = null;
  var previewLink = null;

  // Full log page
  var logBody = null;
  var logHeaderTitle = null;
  var logHeaderSummary = null;
  var logFilterBtns = null;
  var logAutoScrollBtn = null;
  var logEmpty = null;

  var autoScroll = true;
  var logLineCount = 0;
  var activeFilter = 'all';

  // ─── All log entries stored for filtering ──────────────────────────────
  /** @type {Array<{type: string, element: HTMLElement, text: string}>} */
  var logEntries = [];
  /** @type {Array<{type: string, text: string, time: string}>} */
  var previewData = [];
  var deployStartTime = 0;
  var resetCountdownTimer = null;
  var _scrollRafPending = false;
  /** @type {Object<string, number>} */
  var filterCounts = { all: 0, success: 0, error: 0, skip: 0, info: 0, mcp: 0 };

  function init() {
    log('init', 'start');
    try {
      deployBtn = document.getElementById('deploy-btn');
      deployBtnText = deployBtn ? deployBtn.querySelector('.deploy-btn__text') : null;
      progressContainer = document.getElementById('progress-container');
      progressBar = document.getElementById('progress-bar');
      progressText = document.getElementById('progress-text');

      // Inline preview
      previewBody = document.getElementById('log-preview-body');
      previewLink = document.getElementById('log-preview-link');

      // Full log page
      logBody = document.getElementById('log-body');
      logHeaderTitle = document.getElementById('log-header-title');
      logHeaderSummary = document.getElementById('log-header-summary');
      logFilterBtns = document.querySelectorAll('.log-filter-btn');
      logAutoScrollBtn = document.getElementById('log-autoscroll-btn');
      logEmpty = document.getElementById('log-empty');

      if (deployBtn) {
        deployBtn.addEventListener('click', handleDeployClick);
      }

      // Filter buttons — restore persisted filter
      if (logFilterBtns) {
        for (var i = 0; i < logFilterBtns.length; i++) {
          logFilterBtns[i].addEventListener('click', handleFilterClick);
        }
      }
      restoreFilterState();

      // Auto-scroll toggle
      if (logAutoScrollBtn) {
        logAutoScrollBtn.addEventListener('click', function () {
          autoScroll = !autoScroll;
          this.classList.toggle('log-autoscroll__btn--on', autoScroll);
          this.textContent = '[AUTO-SCROLL: ' + (autoScroll ? 'ON' : 'OFF') + ']';
          log('autoScrollToggle', String(autoScroll));
        });
      }

      // Smart auto-scroll with rAF debounce
      if (logBody) {
        logBody.addEventListener('scroll', function () {
          if (_scrollRafPending) { return; }
          _scrollRafPending = true;
          requestAnimationFrame(function () {
            _scrollRafPending = false;
            if (!logBody) { return; }
            var distFromBottom = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight;
            if (distFromBottom > SCROLL_THRESHOLD) {
              if (autoScroll) { autoScroll = false; updateAutoScrollBtn(); log('smartScroll', 'paused'); }
            } else {
              if (!autoScroll) { autoScroll = true; updateAutoScrollBtn(); log('smartScroll', 'resumed'); }
            }
          });
        });
      }

      // Log export button
      var logExportBtn = document.querySelector('.log-export');
      if (logExportBtn) {
        logExportBtn.addEventListener('click', exportLog);
        log('init', 'export button bound');
      }

      // Inject CSS-based filter rules
      if (!document.getElementById('deploy-filter-style')) {
        var filterStyle = document.createElement('style');
        filterStyle.id = 'deploy-filter-style';
        filterStyle.textContent = '.log-body[data-filter="success"] .log-line:not([data-type="success"]){display:none}' +
          '.log-body[data-filter="error"] .log-line:not([data-type="error"]){display:none}' +
          '.log-body[data-filter="skip"] .log-line:not([data-type="skip"]){display:none}' +
          '.log-body[data-filter="info"] .log-line:not([data-type="info"]){display:none}' +
          '.log-body[data-filter="mcp"] .log-line:not([data-type="mcp"]){display:none}' +
          '.log-line--mcp .log-line__text{color:var(--vscode-charts-blue, #4fc1ff)}' +
          '.log-line__icon--mcp{color:var(--vscode-charts-blue, #4fc1ff)}' +
          '.log-line--mcp-warn .log-line__text{color:var(--vscode-charts-yellow, #e5c07b)}' +
          '.log-line__icon--mcp-warn{color:var(--vscode-charts-yellow, #e5c07b)}';
        document.head.appendChild(filterStyle);
      }

      // Show log empty state if no entries
      showEmptyState();

      // Register message handlers
      messaging.onMessage('deployProgress', handleProgress);
      messaging.onMessage('deployComplete', handleComplete);
      messaging.onMessage('deployError', handleError);
      log('init', 'done');
    } catch (err) {
      log('init', 'ERROR: ' + (err && err.message ? err.message : err));
    }
  }

  function updateAutoScrollBtn() {
    if (logAutoScrollBtn) {
      logAutoScrollBtn.classList.toggle('log-autoscroll__btn--on', autoScroll);
      logAutoScrollBtn.textContent = '[AUTO-SCROLL: ' + (autoScroll ? 'ON' : 'OFF') + ']';
    }
  }

  function showEmptyState() {
    if (logBody && logEntries.length === 0 && !logEmpty) {
      logEmpty = document.createElement('div');
      logEmpty.id = 'log-empty';
      logEmpty.className = 'log-empty';
      logEmpty.textContent = 'No deployment logs available. Execute a deploy to see results.';
      logBody.appendChild(logEmpty);
      log('showEmptyState', 'shown');
    }
  }

  // ─── Deploy Click ──────────────────────────────────────────────────────

  function handleDeployClick(event) {
    log('handleDeployClick', 'state=' + currentState + ' locked=' + deployLocked);
    if (deployLocked) { log('handleDeployClick', 'blocked — locked'); return; }

    if (currentState === STATE_DEPLOYING) {
      messaging.send('cancelDeploy');
      setState(STATE_CANCELLED);
      return;
    }

    if (currentState === STATE_CANCELLED) {
      return;
    }

    if (currentState !== STATE_IDLE && currentState !== STATE_SUCCESS
        && currentState !== STATE_PARTIAL && currentState !== STATE_ERROR) {
      return;
    }

    // Double-click protection
    deployLocked = true;
    if (deployBtn) { deployBtn.style.pointerEvents = 'none'; }

    if (event instanceof MouseEvent && deployBtn) {
      animations.ripple(deployBtn, event);
    }

    setState(STATE_DEPLOYING);
    clearLog();
    deployStartTime = Date.now();
    messaging.send('deploy');
    log('handleDeployClick', 'deploy sent — timer started');
  }

  // ─── Message Handlers ──────────────────────────────────────────────────

  /** @param {unknown} payload */
  function handleProgress(payload) {
    log('handleProgress', JSON.stringify(payload));
    if (!payload || typeof payload !== 'object') { return; }
    var data = /** @type {{ current: number, total: number, currentFile: string, percent: number }} */ (payload);

    if (progressContainer) { progressContainer.style.display = ''; }
    if (progressBar) { progressBar.style.width = data.percent + '%'; }
    if (progressText) {
      progressText.style.display = '';
      var pct = Math.round(data.percent);
      progressText.textContent = '[' + data.current + '/' + data.total + '] ' + pct + '% \u2014 ' + smartTruncatePath(data.currentFile, PROGRESS_PATH_MAX);
    }

    // Route MCP-prefixed progress to dedicated 'mcp' log type
    // [MCP-WARN] entries get 'mcp-warn' subtype for yellow color
    if (typeof data.currentFile === 'string' && data.currentFile.indexOf('[MCP]') === 0) {
      if (data.currentFile.indexOf('[MCP-WARN]') >= 0) {
        addLogEntry('mcp-warn', data.currentFile);
      } else {
        addLogEntry('mcp', data.currentFile);
      }
    } else {
      addLogEntry('info', '[' + data.current + '/' + data.total + '] ' + data.currentFile);
    }
  }

  /** @param {unknown} payload */
  function handleComplete(payload) {
    log('handleComplete', JSON.stringify(payload));
    if (!payload || typeof payload !== 'object') { return; }
    var data = /** @type {{ deployedFiles: string[], skippedFiles: string[], errors: Array<{file: string, error: string}>, duration: number }} */ (payload);

    var hasErrors = data.errors && data.errors.length > 0;
    setState(hasErrors ? STATE_PARTIAL : STATE_SUCCESS);

    if (hasErrors && deployBtnText) {
      deployBtnText.textContent = '[ PARTIAL: ' + data.errors.length + ' ERROR' + (data.errors.length > 1 ? 'S' : '') + ' ]';
    }

    // Fill log
    for (var i = 0; i < data.deployedFiles.length; i++) {
      addLogEntry('success', data.deployedFiles[i]);
    }
    for (var j = 0; j < data.skippedFiles.length; j++) {
      addLogEntry('skip', data.skippedFiles[j]);
    }
    for (var k = 0; k < data.errors.length; k++) {
      addLogEntry('error', data.errors[k].file + ' \u2014 ' + data.errors[k].error);
    }

    // Enhanced deploy summary with client-side timer
    var clientDuration = deployStartTime > 0 ? ((Date.now() - deployStartTime) / 1000).toFixed(1) : (data.duration / 1000).toFixed(1);
    var summaryText = '\u2500\u2500\u2500 Deployed: ' + data.deployedFiles.length + ' \u2713 | Skipped: ' +
      data.skippedFiles.length + ' \u2013 | Errors: ' + data.errors.length + ' \u2717 | Duration: ' + clientDuration + 's';
    addLogEntry('info', summaryText);

    // Update log header
    if (logHeaderSummary) {
      logHeaderSummary.textContent = data.deployedFiles.length + ' \u2713 | ' +
        data.skippedFiles.length + ' \u2013 | ' +
        data.errors.length + ' \u2717 | ' + clientDuration + 's';
    }

    // Particles + success/partial flash
    if (deployBtn) {
      var section = deployBtn.closest('.section');
      if (!hasErrors) {
        animations.particles(deployBtn, 12);
        if (section) {
          section.classList.add('deploy-success-flash');
          setTimeout(function () { section.classList.remove('deploy-success-flash'); }, 400);
        }
      } else {
        // Partial success: reduced particles, yellow flash
        animations.particles(deployBtn, 4);
        if (section) {
          section.classList.add('deploy-partial-flash');
          setTimeout(function () { section.classList.remove('deploy-partial-flash'); }, 400);
        }
      }
    }

    // Intelligent auto-reset: more time with more errors
    var errCount = data.errors.length;
    var resetDelay = Math.min(AUTO_RESET_MAX_MS, Math.max(AUTO_RESET_MIN_MS, errCount * AUTO_RESET_PER_ERROR_MS));
    log('handleComplete', 'auto-reset in ' + resetDelay + 'ms (errors=' + errCount + ')');
    startResetCountdown(resetDelay);
  }

  /** @param {unknown} payload */
  function handleError(payload) {
    log('handleError', JSON.stringify(payload));
    setState(STATE_ERROR);

    if (payload && typeof payload === 'object') {
      var data = /** @type {{ errors?: Array<{file: string, error: string}> }} */ (payload);
      if (data.errors) {
        for (var i = 0; i < data.errors.length; i++) {
          addLogEntry('error', data.errors[i].file + ' \u2014 ' + data.errors[i].error);
        }
      }
    }

    setTimeout(function () {
      if (currentState === STATE_ERROR) { setState(STATE_IDLE); }
    }, AUTO_RESET_MIN_MS);
  }

  function startResetCountdown(delayMs) {
    if (resetCountdownTimer) { clearInterval(resetCountdownTimer); }
    var remaining = Math.ceil(delayMs / 1000);
    var baseText = deployBtnText ? deployBtnText.textContent : '';
    log('startResetCountdown', remaining + 's');
    resetCountdownTimer = setInterval(function () {
      remaining--;
      if (remaining > 0 && deployBtnText && currentState !== STATE_IDLE && currentState !== STATE_DEPLOYING) {
        deployBtnText.textContent = baseText.replace(/\]$/, ' \u2014 RESET ' + remaining + 's ]');
      }
      if (remaining <= 0) {
        clearInterval(resetCountdownTimer);
        resetCountdownTimer = null;
        if (currentState !== STATE_IDLE && currentState !== STATE_DEPLOYING) {
          setState(STATE_IDLE);
        }
      }
    }, 1000);
  }

  // ─── State Machine ─────────────────────────────────────────────────────

  /** Valid state transitions map — only documented transitions are allowed */
  var VALID_TRANSITIONS = {};
  VALID_TRANSITIONS[STATE_IDLE] = [STATE_DEPLOYING];
  VALID_TRANSITIONS[STATE_DEPLOYING] = [STATE_SUCCESS, STATE_PARTIAL, STATE_ERROR, STATE_CANCELLED];
  VALID_TRANSITIONS[STATE_SUCCESS] = [STATE_IDLE, STATE_DEPLOYING];
  VALID_TRANSITIONS[STATE_PARTIAL] = [STATE_IDLE, STATE_DEPLOYING];
  VALID_TRANSITIONS[STATE_ERROR] = [STATE_IDLE, STATE_DEPLOYING];
  VALID_TRANSITIONS[STATE_CANCELLED] = [STATE_IDLE];

  /** @param {string} state */
  function setState(state) {
    var allowed = VALID_TRANSITIONS[currentState];
    if (allowed && allowed.indexOf(state) === -1) {
      log('setState', 'WARN: invalid transition ' + currentState + ' -> ' + state);
      return;
    }
    log('setState', state);
    currentState = state;

    // Unlock deploy button for non-deploying states
    if (state !== STATE_DEPLOYING) {
      deployLocked = false;
      if (deployBtn) { deployBtn.style.pointerEvents = ''; }
    }

    if (!deployBtn || !deployBtnText) { return; }

    deployBtn.classList.remove(
      'deploy-btn--deploying', 'deploy-btn--success', 'deploy-btn--partial',
      'deploy-btn--error', 'deploy-btn--disabled'
    );

    switch (state) {
      case STATE_IDLE:
        deployBtnText.textContent = '[ EXECUTE DEPLOY ]';
        if (progressContainer) { progressContainer.style.display = 'none'; }
        if (progressText) { progressText.style.display = 'none'; }
        if (progressBar) { progressBar.style.width = '0%'; }
        break;
      case STATE_DEPLOYING:
        deployBtn.classList.add('deploy-btn--deploying');
        deployBtnText.textContent = '[ CANCEL DEPLOY ]';
        // Re-enable click for cancel
        deployLocked = false;
        if (deployBtn) { deployBtn.style.pointerEvents = ''; }
        if (logHeaderTitle) {
          logHeaderTitle.textContent = 'DEPLOYMENT LOG \u2014 ' + new Date().toLocaleString();
        }
        break;
      case STATE_SUCCESS:
        deployBtn.classList.add('deploy-btn--success');
        deployBtnText.textContent = '[ \u2713 COMPLETE ]';
        if (progressBar) { progressBar.style.width = '100%'; }
        break;
      case STATE_PARTIAL:
        deployBtn.classList.add('deploy-btn--partial');
        if (progressBar) { progressBar.style.width = '100%'; }
        break;
      case STATE_ERROR:
        deployBtn.classList.add('deploy-btn--error');
        deployBtnText.textContent = '[ \u2717 FAILED ]';
        break;
      case STATE_CANCELLED:
        deployBtnText.textContent = '[ CANCELLED ]';
        if (progressContainer) { progressContainer.style.display = 'none'; }
        if (progressText) { progressText.style.display = 'none'; }
        setTimeout(function () {
          if (currentState === STATE_CANCELLED) { setState(STATE_IDLE); }
        }, 2000);
        break;
    }
  }

  // ─── Log Entries ───────────────────────────────────────────────────────

  /**
   * @param {'success'|'error'|'skip'|'info'|'mcp'|'mcp-warn'} type
   * @param {string} text
   */
  function addLogEntry(type, text) {
    log('addLogEntry', type + ': ' + text);
    logLineCount++;
    // Track mcp-warn under both 'mcp' and its own key for filtering
    var countKey = type === 'mcp-warn' ? 'mcp' : type;
    filterCounts[countKey] = (filterCounts[countKey] || 0) + 1;
    filterCounts.all++;

    var icons = { success: '\u2713', error: '\u2717', skip: '\u2014', info: '\u2022', mcp: '\u25C6', 'mcp-warn': '\u26A0' };

    var now = new Date();
    var h = now.getHours() < 10 ? '0' + now.getHours() : String(now.getHours());
    var m = now.getMinutes() < 10 ? '0' + now.getMinutes() : String(now.getMinutes());
    var s = now.getSeconds() < 10 ? '0' + now.getSeconds() : String(now.getSeconds());
    var ms = now.getMilliseconds();
    var msStr = ms < 10 ? '00' + ms : ms < 100 ? '0' + ms : String(ms);
    var timeStr = h + ':' + m + ':' + s + '.' + msStr;

    var lineHtml =
      '<span class="log-line__num">' + logLineCount + '</span>' +
      '<span class="log-line__time">' + timeStr + '</span>' +
      '<span class="log-line__icon log-line__icon--' + type + '">' + (icons[type] || '\u2022') + '</span>' +
      '<span class="log-line__text">' + escapeHtml(text) + '</span>';

    var entry = document.createElement('div');
    // mcp-warn entries use 'mcp' data-type for filter grouping
    var filterType = type === 'mcp-warn' ? 'mcp' : type;
    entry.className = 'log-line' + (type === 'error' ? ' log-line--error' : '') + (type === 'mcp' ? ' log-line--mcp' : '') + (type === 'mcp-warn' ? ' log-line--mcp-warn' : '');
    entry.setAttribute('data-type', filterType);
    entry.innerHTML = lineHtml;

    // Dynamic animation delay
    var delayPerLine = logLineCount > LOG_ANIM_THRESHOLD
      ? Math.max(MIN_ANIM_DELAY_MS, Math.floor(MAX_ANIM_TOTAL_MS / logLineCount))
      : 20;
    entry.style.animationDelay = (logLineCount * delayPerLine) + 'ms';

    // Error detail expansion — keyboard + mouse accessible
    if (type === 'error') {
      entry.style.cursor = 'pointer';
      entry.setAttribute('title', 'Click or press Enter to expand');
      entry.setAttribute('tabindex', '0');
      entry.setAttribute('role', 'button');
      var toggleExpand = function () {
        var existing = entry.querySelector('.log-line__detail');
        if (existing) {
          entry.removeChild(existing);
          entry.classList.remove('log-line--expanded');
        } else {
          var detail = document.createElement('div');
          detail.className = 'log-line__detail';
          detail.textContent = text;
          entry.appendChild(detail);
          entry.classList.add('log-line--expanded');
        }
      };
      entry.addEventListener('click', toggleExpand);
      entry.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(); }
      });
    }

    logEntries.push({ type: type, element: entry, text: text });

    // Add to full log page
    if (logBody) {
      if (logEmpty && logEmpty.parentNode) {
        logEmpty.parentNode.removeChild(logEmpty);
        logEmpty = null;
      }
      // CSS-based filter via container attribute
      if (activeFilter !== 'all' && logBody.getAttribute('data-filter') !== activeFilter) {
        logBody.setAttribute('data-filter', activeFilter);
      }
      logBody.appendChild(entry);

      // DOM limit: remove oldest nodes (data kept in logEntries array)
      while (logBody.children.length > MAX_DOM_ENTRIES) {
        var oldScrollH = logBody.scrollHeight;
        logBody.removeChild(logBody.firstChild);
        if (!autoScroll) { logBody.scrollTop -= (oldScrollH - logBody.scrollHeight); }
        log('addLogEntry', 'DOM limit — removed oldest node');
      }

      if (autoScroll) { logBody.scrollTop = logBody.scrollHeight; }
    }

    // Inline preview — separate data structure (no cloneNode)
    if (previewBody) {
      previewData.push({ type: type, text: text, time: timeStr });
      if (previewData.length > 5) { previewData.shift(); }
      previewBody.innerHTML = '';
      for (var p = 0; p < previewData.length; p++) {
        var pd = previewData[p];
        var pLine = document.createElement('div');
        pLine.className = 'log-line';
        pLine.setAttribute('data-type', pd.type);
        pLine.innerHTML = '<span class="log-line__icon log-line__icon--' + pd.type + '">' + (icons[pd.type] || '\u2022') + '</span>' +
          '<span class="log-line__text">' + escapeHtml(pd.text) + '</span>';
        previewBody.appendChild(pLine);
      }
    }

    if (previewLink) { previewLink.style.display = ''; }
    updateFilterBadges();
  }

  function clearLog() {
    log('clearLog', 'entries=' + logEntries.length);
    logLineCount = 0;
    logEntries = [];
    previewData = [];
    filterCounts = { all: 0, success: 0, error: 0, skip: 0, info: 0, mcp: 0 };
    if (resetCountdownTimer) { clearInterval(resetCountdownTimer); resetCountdownTimer = null; }
    if (logBody) { logBody.innerHTML = ''; logBody.removeAttribute('data-filter'); }
    if (previewBody) { previewBody.innerHTML = ''; }
    if (logHeaderSummary) { logHeaderSummary.textContent = ''; }
    logEmpty = null;
    updateFilterBadges();
  }

  // ─── Log Filters ───────────────────────────────────────────────────────

  function handleFilterClick() {
    var filter = this.getAttribute('data-filter');
    if (!filter) { return; }
    log('handleFilterClick', filter);
    activeFilter = filter;

    try { sessionStorage.setItem('sudx-log-filter', filter); } catch (e) { /* webview may not support */ }

    // Update button states
    for (var i = 0; i < logFilterBtns.length; i++) {
      var isActive = logFilterBtns[i].getAttribute('data-filter') === filter;
      logFilterBtns[i].classList.toggle('log-filter-btn--active', isActive);
      logFilterBtns[i].setAttribute('aria-pressed', String(isActive));
    }

    // CSS-based filtering: set data-filter on container
    if (logBody) {
      if (filter === 'all') {
        logBody.removeAttribute('data-filter');
      } else {
        logBody.setAttribute('data-filter', filter);
      }
    }
    log('handleFilterClick', 'data-filter=' + filter);
  }

  function restoreFilterState() {
    try {
      var saved = sessionStorage.getItem('sudx-log-filter');
      if (saved) {
        activeFilter = saved;
        log('restoreFilterState', saved);
        // Activate the right button
        if (logFilterBtns) {
          for (var i = 0; i < logFilterBtns.length; i++) {
            var isActive = logFilterBtns[i].getAttribute('data-filter') === saved;
            logFilterBtns[i].classList.toggle('log-filter-btn--active', isActive);
            logFilterBtns[i].setAttribute('aria-pressed', String(isActive));
          }
        }
      }
    } catch (e) { log('restoreFilterState', 'sessionStorage unavailable'); }
  }

  // ─── Utilities ─────────────────────────────────────────────────────────

  function updateFilterBadges() {
    if (!logFilterBtns) { return; }
    for (var i = 0; i < logFilterBtns.length; i++) {
      var f = logFilterBtns[i].getAttribute('data-filter');
      var count = f === 'all' ? filterCounts.all : (filterCounts[f] || 0);
      var badge = logFilterBtns[i].querySelector('.filter-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'filter-badge';
        badge.style.cssText = 'margin-left:4px;opacity:0.6;';
        logFilterBtns[i].appendChild(badge);
      }
      badge.textContent = count > 0 ? '[' + count + ']' : '';
    }
  }

  function exportLog() {
    log('exportLog', 'entries=' + logEntries.length);
    var lines = [];
    for (var i = 0; i < logEntries.length; i++) {
      lines.push(logEntries[i].type.toUpperCase() + ': ' + logEntries[i].text);
    }
    messaging.send('exportLog', { log: lines.join('\n'), format: 'text' });
    log('exportLog', 'sent ' + lines.length + ' lines');
  }

  var _escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /** @param {string} str @returns {string} */
  function escapeHtml(str) {
    if (typeof str !== 'string') { return ''; }
    return str.replace(/[&<>"']/g, function (ch) { return _escapeMap[ch]; });
  }

  /**
   * Smart path truncation — shows parent dir + filename, middle replaced with …
   * @param {string} fullPath
   * @param {number} [maxLen]
   * @returns {string}
   */
  function smartTruncatePath(fullPath, maxLen) {
    maxLen = maxLen || PROGRESS_PATH_MAX;
    if (typeof fullPath !== 'string') { return ''; }
    if (fullPath.length <= maxLen) { return fullPath; }

    // Split by / or \
    var sep = fullPath.indexOf('/') >= 0 ? '/' : '\\';
    var parts = fullPath.split(sep);
    if (parts.length <= 2) {
      return '\u2026' + fullPath.substring(fullPath.length - maxLen + 1);
    }

    var first = parts[0];
    var last = parts[parts.length - 1];
    var parent = parts[parts.length - 2];
    var short = first + sep + '\u2026' + sep + parent + sep + last;

    if (short.length <= maxLen) { return short; }
    // Fallback: just parent + filename
    short = '\u2026' + sep + parent + sep + last;
    if (short.length <= maxLen) { return short; }
    return '\u2026' + sep + last;
  }

  // ─── Export ────────────────────────────────────────────────────────────

  window.SudxDeploy = {
    init: init,
    getState: function () { return currentState; },
    exportLog: exportLog,
  };
})();
