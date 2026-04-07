// @ts-check
/* ═══════════════════════════════════════════════════════════════════════════
   Sudx Copilot Customizations — Webview Messaging Layer
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ─── Config ────────────────────────────────────────────────────────────

  var DEBUG = false;
  function log(fn, msg) { if (DEBUG) { console.debug('[Messaging.' + fn + ']', msg); } }

  var REQUEST_TIMEOUT = 30000;
  var DEDUP_WINDOW_MS = 200;
  var HEARTBEAT_INTERVAL_MS = 30000;
  var HEARTBEAT_TIMEOUT_MS = 5000;
  var HEARTBEAT_BACKOFF_INTERVALS = [30000, 60000, 120000, 300000];
  var PENDING_SWEEP_INTERVAL_MS = 60000;
  var REQUEST_QUEUE_MAX = 10;

  // ─── State ─────────────────────────────────────────────────────────────

  let requestCounter = 0;
  const pendingRequests = new Map();
  const messageHandlers = new Map();
  const recentRequests = new Map(); // dedup: key → { promise, timestamp }
  var heartbeatInterval = null;
  var connectionAlive = true;
  var heartbeatBackoffIndex = 0;
  /** @type {function|null} */
  var _heartbeatPongHandler = null;
  /** @type {Array<function>} */
  var _connectionLostCallbacks = [];
  /** @type {Array<function>} */
  var _connectionRestoredCallbacks = [];
  /** @type {Array<{type: string, payload: unknown}>} */
  var requestQueue = [];
  var pendingSweepTimer = null;

  /**
   * Register a handler for a specific response type from the extension.
   * @param {string} type
   * @param {(payload: unknown) => void} handler
   */
  function onMessage(type, handler) {
    log('onMessage', 'register: ' + type);
    if (!messageHandlers.has(type)) {
      messageHandlers.set(type, []);
    }
    messageHandlers.get(type).push(handler);
  }

  /**
   * Send a message to the extension without expecting a specific response.
   * @param {string} type
   * @param {unknown} [payload]
   */
  function send(type, payload) {
    log('send', type + ' connected=' + connectionAlive);
    // Queue requests when disconnected (except heartbeat)
    if (!connectionAlive && type !== '__heartbeat__') {
      if (requestQueue.length < REQUEST_QUEUE_MAX) {
        requestQueue.push({ type: type, payload: payload });
        log('send', 'queued (queue=' + requestQueue.length + ')');
      } else {
        log('send', 'queue full \u2014 dropped: ' + type);
      }
      return;
    }
    try {
      var message = { type: type };
      if (payload !== undefined) {
        message.payload = payload;
      }
      vscode.postMessage(message);
    } catch (err) {
      logError('send', type, err);
    }
  }

  /**
   * Send a request and return a cancellable promise.
   * @param {string} type
   * @param {unknown} [payload]
   * @param {number} [timeout]
   * @returns {{ promise: Promise<unknown>, cancel: function(): void }}
   */
  function request(type, payload, timeout, dedupWindow) {
    log('request', type);
    var resolveTimeout = timeout || REQUEST_TIMEOUT;
    var requestId = 'req_' + (++requestCounter) + '_' + Date.now();
    var effectiveDedupMs = typeof dedupWindow === 'number' ? dedupWindow : DEDUP_WINDOW_MS;

    // Stabilized dedup key \u2014 sorted key serialization
    var payloadStr = '';
    if (payload && typeof payload === 'object') {
      try { payloadStr = Object.keys(payload).sort().map(function(k) { return k + '=' + payload[k]; }).join('&'); }
      catch (_) { payloadStr = String(payload); }
    } else { payloadStr = String(payload || null); }
    var dedupKey = type + ':' + payloadStr;
    var recent = recentRequests.get(dedupKey);
    if (effectiveDedupMs > 0 && recent && (Date.now() - recent.timestamp) < effectiveDedupMs) {
      log('request', 'dedup hit: ' + dedupKey);
      return { promise: recent.promise, cancel: recent.cancel || function () {} };
    }

    var cancelled = false;
    var timer = null;
    var warnTimer = null;

    var promise = new Promise(function (resolve, reject) {
      // Timeout warning at 50%
      warnTimer = setTimeout(function () {
        log('request', 'SLOW: ' + type + ' \u2014 ' + Math.round(resolveTimeout / 2000) + 's of ' + Math.round(resolveTimeout / 1000) + 's elapsed');
      }, Math.floor(resolveTimeout / 2));

      timer = setTimeout(function () {
        if (warnTimer) { clearTimeout(warnTimer); }
        pendingRequests.delete(requestId);
        recentRequests.delete(dedupKey);
        var err = new Error('Request timeout: ' + type);
        logError('request', type, err);
        reject(err);
      }, resolveTimeout);

      pendingRequests.set(requestId, {
        _created: Date.now(),
        resolve: function (data) {
          clearTimeout(timer);
          if (warnTimer) { clearTimeout(warnTimer); }
          if (!cancelled) { resolve(data); }
        },
        reject: function (err) {
          clearTimeout(timer);
          if (warnTimer) { clearTimeout(warnTimer); }
          if (!cancelled) { reject(err); }
        },
      });

      try {
        var message = { type: type, requestId: requestId };
        if (payload !== undefined) {
          message.payload = payload;
        }
        vscode.postMessage(message);
      } catch (err) {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        logError('request', type, err);
        reject(err);
      }
    });

    var cancelFn = function () {
      log('request.cancel', requestId);
      cancelled = true;
      if (timer) { clearTimeout(timer); }
      if (warnTimer) { clearTimeout(warnTimer); }
      pendingRequests.delete(requestId);
      recentRequests.delete(dedupKey);
    };

    recentRequests.set(dedupKey, { promise: promise, cancel: cancelFn, timestamp: Date.now() });

    // Cleanup dedup entry after window expires
    setTimeout(function () { recentRequests.delete(dedupKey); }, effectiveDedupMs + 50);

    return { promise: promise, cancel: cancelFn };
  }

  // ─── Structured Error Logging ──────────────────────────────────────────

  function logError(fn, type, err) {
    var entry = {
      timestamp: new Date().toISOString(),
      module: 'Messaging',
      function: fn,
      type: type,
      error: err && err.message ? err.message : String(err),
    };
    console.error('[Messaging] Error:', entry);
  }

  // ─── Connection Health ─────────────────────────────────────────────────

  function startHeartbeat() {
    log('startHeartbeat', 'interval=' + getCurrentHeartbeatInterval() + 'ms');
    if (heartbeatInterval) { clearTimeout(heartbeatInterval); }
    heartbeatBackoffIndex = 0;
    scheduleNextHeartbeat();
  }

  function getCurrentHeartbeatInterval() {
    return HEARTBEAT_BACKOFF_INTERVALS[Math.min(heartbeatBackoffIndex, HEARTBEAT_BACKOFF_INTERVALS.length - 1)];
  }

  function scheduleNextHeartbeat() {
    if (heartbeatInterval) { clearTimeout(heartbeatInterval); }
    heartbeatInterval = setTimeout(function () {
      log('heartbeat', 'ping (backoff=' + heartbeatBackoffIndex + ' interval=' + getCurrentHeartbeatInterval() + 'ms)');
      var timer = setTimeout(function () {
        if (connectionAlive) {
          connectionAlive = false;
          heartbeatBackoffIndex = Math.min(heartbeatBackoffIndex + 1, HEARTBEAT_BACKOFF_INTERVALS.length - 1);
          log('heartbeat', 'timeout — connection lost (next=' + getCurrentHeartbeatInterval() + 'ms)');
          notifyConnectionLost();
        }
        scheduleNextHeartbeat();
      }, HEARTBEAT_TIMEOUT_MS);

      // Isolated heartbeat pong handler (not in general handler map)
      _heartbeatPongHandler = function () {
        clearTimeout(timer);
        if (!connectionAlive) {
          connectionAlive = true;
          heartbeatBackoffIndex = 0;
          log('heartbeat', 'reconnected — backoff reset');
          notifyConnectionRestored();
          flushRequestQueue();
        }
        scheduleNextHeartbeat();
      };

      try {
        vscode.postMessage({ type: '__heartbeat__' });
      } catch (e) {
        clearTimeout(timer);
        connectionAlive = false;
        notifyConnectionLost();
        scheduleNextHeartbeat();
      }
    }, getCurrentHeartbeatInterval());
  }

  function stopHeartbeat() {
    log('stopHeartbeat', '');
    if (heartbeatInterval) { clearTimeout(heartbeatInterval); heartbeatInterval = null; }
    if (pendingSweepTimer) { clearInterval(pendingSweepTimer); pendingSweepTimer = null; }
  }

  function notifyConnectionLost() {
    for (var i = 0; i < _connectionLostCallbacks.length; i++) {
      try { _connectionLostCallbacks[i](); } catch (e) { log('notifyConnectionLost', 'error: ' + e); }
    }
    var handlers = messageHandlers.get('connectionLost');
    if (handlers) { for (var j = 0; j < handlers.length; j++) { try { handlers[j](null); } catch(_) {} } }
  }

  function notifyConnectionRestored() {
    for (var i = 0; i < _connectionRestoredCallbacks.length; i++) {
      try { _connectionRestoredCallbacks[i](); } catch (e) { log('notifyConnectionRestored', 'error: ' + e); }
    }
    var handlers = messageHandlers.get('connectionRestored');
    if (handlers) { for (var j = 0; j < handlers.length; j++) { try { handlers[j](null); } catch(_) {} } }
  }

  function onConnectionLost(fn) { _connectionLostCallbacks.push(fn); }
  function onConnectionRestored(fn) { _connectionRestoredCallbacks.push(fn); }

  function flushRequestQueue() {
    log('flushRequestQueue', 'queue=' + requestQueue.length);
    while (requestQueue.length > 0) {
      var item = requestQueue.shift();
      try { send(item.type, item.payload); } catch (e) { log('flushRequestQueue', 'error: ' + e); }
    }
  }

  // Listen for messages from the extension
  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || typeof message.type !== 'string') {
      log('onWindowMessage', 'invalid message');
      return;
    }
    log('onWindowMessage', message.type + (message.requestId ? ' reqId=' + message.requestId : ''));

    // Any message means connection is alive
    connectionAlive = true;

    // Isolated heartbeat pong handling
    if (message.type === '__heartbeat__' && _heartbeatPongHandler) {
      _heartbeatPongHandler();
      return;
    }

    // Resolve pending request if requestId matches
    if (message.requestId && pendingRequests.has(message.requestId)) {
      var pending = pendingRequests.get(message.requestId);
      pendingRequests.delete(message.requestId);

      if (message.success === false) {
        pending.reject(new Error(message.error || 'Request failed'));
      } else {
        pending.resolve(message.payload);
      }
    }

    // Dispatch to registered handlers
    var handlers = messageHandlers.get(message.type);
    if (handlers) {
      for (var i = 0; i < handlers.length; i++) {
        try {
          handlers[i](message.payload, message);
        } catch (err) {
          logError('handler', message.type, err);
        }
      }
    }
  });

  // Start heartbeat
  startHeartbeat();

  // Periodic pending request sweep
  pendingSweepTimer = setInterval(function () {
    var now = Date.now();
    var sweepCount = 0;
    pendingRequests.forEach(function (val, key) {
      if (val._created && (now - val._created) > REQUEST_TIMEOUT * 2) {
        pendingRequests.delete(key);
        sweepCount++;
      }
    });
    if (sweepCount > 0) { log('pendingSweep', 'removed ' + sweepCount + ' stale requests'); }
  }, PENDING_SWEEP_INTERVAL_MS);

  // Export to window
  window.SudxMessaging = {
    send: send,
    request: request,
    onMessage: onMessage,
    startHeartbeat: startHeartbeat,
    stopHeartbeat: stopHeartbeat,
    isConnected: function () { return connectionAlive; },
    onConnectionLost: onConnectionLost,
    onConnectionRestored: onConnectionRestored,
  };
})();
