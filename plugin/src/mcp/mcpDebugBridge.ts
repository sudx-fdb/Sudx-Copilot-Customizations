import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { SudxLogger } from '../utils/logger';
import { McpLoggerClient } from './mcpLoggerClient';
import {
  McpLogEvent,
  McpEventType,
  MetricsSnapshot,
  McpServerMetrics,
  McpDetailMetrics,
  ConnectionStatus,
  ConnectionMode,
  WebviewInboundMessage,
  WebviewOutboundMessage,
  DataBridgeConfig,
  ToolMetrics,
} from './mcpLoggerTypes';

const MODULE = 'McpDebugBridge';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_EVENT_BUFFER_SIZE = 100;
const DEFAULT_REFRESH_RATE_MS = 100;
const DEFAULT_METRICS_HISTORY_LIMIT = 500;
const DEFAULT_TDIGEST_CENTROID_LIMIT = 100;
const BATCH_FLUSH_INTERVAL_MS = 100;
const MAX_EVENTS_PER_SEC = 60;
const OFFLINE_THRESHOLD_FAILURES = 3;
const CACHE_STATE_KEY = 'sudx.mcpLoggerCache';
const AUTH_FAILED_COOLDOWN_MS = 30000;

// ─── Data Bridge ─────────────────────────────────────────────────────────────

/**
 * Bridges SSE events from McpLoggerClient to the Debug Panel webview.
 * Handles event buffering, rate limiting, metrics aggregation, and
 * bidirectional communication with the webview.
 */
export class McpDebugDataBridge {
  private logger: SudxLogger;
  private sseClient: McpLoggerClient;
  private config: DataBridgeConfig;
  private webview: vscode.Webview | null = null;
  private globalState: vscode.Memento;

  // Event buffer for when panel is closed
  private eventBuffer: McpLogEvent[] = [];

  // Rate limiting
  private pendingBatch: McpLogEvent[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushTime: number = 0;

  // Metrics aggregation
  private metricsMap: Map<string, LocalMcpMetrics> = new Map();
  private _lastSnapshot: MetricsSnapshot | null = null;

  // Connection state
  private _connectionFailures: number = 0;
  private _authFailedAt: number = 0;
  private _mode: ConnectionMode = 'offline';

  // Configuration references for API calls
  private backendUrl: string;
  private authToken: string;

  private disposables: vscode.Disposable[] = [];
  private _webviewMsgDisposable: vscode.Disposable | null = null;
  private _disposed: boolean = false;

  // Bound event handlers for cleanup
  private _boundOnEvent: (event: McpLogEvent) => void;
  private _boundOnStatus: (status: ConnectionStatus) => void;
  private _boundOnAuthFailure: (statusCode: number) => void;
  private _boundOnError: (err: Error) => void;

  constructor(
    logger: SudxLogger,
    sseClient: McpLoggerClient,
    globalState: vscode.Memento,
    backendUrl: string,
    authToken: string,
    config?: Partial<DataBridgeConfig>
  ) {
    this.logger = logger;
    this.sseClient = sseClient;
    this.globalState = globalState;
    this.backendUrl = backendUrl;
    this.authToken = authToken;
    this.config = {
      eventBufferSize: config?.eventBufferSize ?? DEFAULT_EVENT_BUFFER_SIZE,
      refreshRateMs: config?.refreshRateMs ?? DEFAULT_REFRESH_RATE_MS,
      metricsHistoryLimit: config?.metricsHistoryLimit ?? DEFAULT_METRICS_HISTORY_LIMIT,
      tDigestCentroidLimit: config?.tDigestCentroidLimit ?? DEFAULT_TDIGEST_CENTROID_LIMIT,
    };

    this.logger.debug(MODULE, 'McpDebugDataBridge created', {
      bufferSize: this.config.eventBufferSize,
      refreshRate: this.config.refreshRateMs,
    });

    this._boundOnEvent = (event: McpLogEvent) => this._onSseEvent(event);
    this._boundOnStatus = (status: ConnectionStatus) => this._onConnectionStatus(status);
    this._boundOnAuthFailure = (statusCode: number) => this._onAuthFailure(statusCode);
    this._boundOnError = (err: Error) => this.logger.error(MODULE, 'SSE client error', err);

    this._wireEvents();
    this._restoreCache();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Attach a webview panel. Replays buffered events and starts forwarding.
   */
  attachWebview(webview: vscode.Webview): void {
    this.logger.debug(MODULE, 'attachWebview()', { bufferedEvents: this.eventBuffer.length });
    this.webview = webview;

    // Replay buffered events
    if (this.eventBuffer.length > 0) {
      this._postToWebview({ type: 'mcpEventBatch', payload: [...this.eventBuffer] });
      this.eventBuffer = [];
      this.logger.debug(MODULE, 'Replayed buffered events to webview');
    }

    // Send current connection status
    this._postToWebview({
      type: 'connectionStatus',
      payload: this.sseClient.getConnectionStatus(),
    });

    // Send cached metrics snapshot if available
    if (this._lastSnapshot) {
      this._postToWebview({ type: 'metricsSnapshot', payload: this._lastSnapshot });
    }

    // Listen for messages from webview
    if (this._webviewMsgDisposable) {
      this._webviewMsgDisposable.dispose();
    }
    this._webviewMsgDisposable = webview.onDidReceiveMessage(
      (msg: WebviewOutboundMessage) => this._handleWebviewMessage(msg)
    );
  }

  /**
   * Detach the webview (panel closed).
   */
  detachWebview(): void {
    this.logger.debug(MODULE, 'detachWebview()');
    if (this._webviewMsgDisposable) {
      this._webviewMsgDisposable.dispose();
      this._webviewMsgDisposable = null;
    }
    this.webview = null;
  }

  /**
   * Get current aggregated metrics snapshot.
   */
  getMetricsSnapshot(): MetricsSnapshot | null {
    return this._lastSnapshot;
  }

  /**
   * Update backend connection info.
   */
  updateBackendConfig(url: string, token: string): void {
    this.logger.debug(MODULE, 'updateBackendConfig()');
    this.backendUrl = url;
    this.authToken = token;
  }

  /**
   * Persist current metrics to cache for offline recovery.
   */
  persistCache(): void {
    try {
      if (this._lastSnapshot) {
        this.globalState.update(CACHE_STATE_KEY, {
          snapshot: this._lastSnapshot,
          timestamp: Date.now(),
        });
        this.logger.debug(MODULE, 'Metrics cache persisted');
      }
    } catch (err) {
      this.logger.warn(MODULE, 'Failed to persist metrics cache', err);
    }
  }

  /**
   * Dispose the bridge. Cleans up all resources.
   */
  dispose(): void {
    this.logger.debug(MODULE, 'dispose()');
    this._disposed = true;
    this.persistCache();

    // Remove SSE client listeners
    this.sseClient.off('event', this._boundOnEvent);
    this.sseClient.off('connectionStatus', this._boundOnStatus);
    this.sseClient.off('authFailure', this._boundOnAuthFailure);
    this.sseClient.off('error', this._boundOnError);

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    if (this._webviewMsgDisposable) {
      this._webviewMsgDisposable.dispose();
      this._webviewMsgDisposable = null;
    }
    this.webview = null;
    this.eventBuffer = [];
    this.pendingBatch = [];
    this.metricsMap.clear();
  }

  // ─── Private: Event Wiring ───────────────────────────────────────────────

  private _wireEvents(): void {
    this.sseClient.on('event', this._boundOnEvent);
    this.sseClient.on('connectionStatus', this._boundOnStatus);
    this.sseClient.on('authFailure', this._boundOnAuthFailure);
    this.sseClient.on('error', this._boundOnError);
  }

  private _onSseEvent(event: McpLogEvent): void {
    if (this._disposed) {
      return;
    }

    this.logger.debug(MODULE, 'SSE event received', {
      mcpName: event.mcp_name,
      eventType: event.event_type,
    });

    // Update local metrics
    this._updateLocalMetrics(event);

    // Connection success — reset failure count
    this._connectionFailures = 0;
    this._mode = 'online';

    if (this.webview) {
      // Rate-limited forwarding to webview
      this._enqueueForWebview(event);
    } else {
      // Buffer when panel is closed
      this.eventBuffer.push(event);
      if (this.eventBuffer.length > this.config.eventBufferSize) {
        this.eventBuffer.shift(); // Evict oldest
      }
    }
  }

  private _onConnectionStatus(status: ConnectionStatus): void {
    if (this._disposed) {
      return;
    }

    this.logger.debug(MODULE, 'Connection status update', {
      isConnected: status.isConnected,
      mode: status.mode,
    });

    if (!status.isConnected) {
      this._connectionFailures++;
      if (this._connectionFailures >= OFFLINE_THRESHOLD_FAILURES) {
        this._mode = 'offline';
        this._postToWebview({
          type: 'backendOffline',
          payload: { lastUpdated: this.sseClient.lastEventTime },
        });
      }
    }

    this._postToWebview({ type: 'connectionStatus', payload: status });
  }

  private _onAuthFailure(statusCode: number): void {
    this.logger.warn(MODULE, 'Authentication failure', { statusCode });
    this._authFailedAt = Date.now();
    this._postToWebview({
      type: 'authRequired',
      payload: { message: `Backend returned ${statusCode}. Please re-enter your token.` },
    });
  }

  // ─── Private: Rate-Limited Webview Forwarding ────────────────────────────

  private _enqueueForWebview(event: McpLogEvent): void {
    this.pendingBatch.push(event);

    if (!this.batchTimer) {
      const elapsed = Date.now() - this.lastFlushTime;
      const delay = Math.max(0, this.config.refreshRateMs - elapsed);

      this.batchTimer = setTimeout(() => {
        this._flushBatch();
      }, delay);
    }
  }

  private _flushBatch(): void {
    this.batchTimer = null;
    this.lastFlushTime = Date.now();

    if (this.pendingBatch.length === 0 || !this.webview) {
      return;
    }

    if (this.pendingBatch.length === 1) {
      this._postToWebview({ type: 'mcpEvent', payload: this.pendingBatch[0] });
    } else {
      this._postToWebview({ type: 'mcpEventBatch', payload: [...this.pendingBatch] });
    }

    this.logger.debug(MODULE, 'Flushed event batch to webview', {
      count: this.pendingBatch.length,
    });

    this.pendingBatch = [];
  }

  // ─── Private: Local Metrics Aggregation ──────────────────────────────────

  private _updateLocalMetrics(event: McpLogEvent): void {
    const mcpName = event.mcp_name;
    let metrics = this.metricsMap.get(mcpName);
    if (!metrics) {
      metrics = new LocalMcpMetrics(mcpName, this.config.metricsHistoryLimit);
      this.metricsMap.set(mcpName, metrics);
    }
    metrics.processEvent(event);
    this._rebuildSnapshot();
  }

  private _rebuildSnapshot(): void {
    const servers: McpServerMetrics[] = [];
    let globalCalls = 0;
    let globalErrors = 0;
    let latencySum = 0;
    let latencyCount = 0;

    for (const [, metrics] of this.metricsMap) {
      const serverMetrics = metrics.toServerMetrics();
      servers.push(serverMetrics);
      globalCalls += serverMetrics.total_calls;
      globalErrors += serverMetrics.total_errors;
      if (serverMetrics.avg_latency_ms > 0) {
        latencySum += serverMetrics.avg_latency_ms * serverMetrics.total_calls;
        latencyCount += serverMetrics.total_calls;
      }
    }

    this._lastSnapshot = {
      timestamp: Date.now(),
      servers,
      global_total_calls: globalCalls,
      global_total_errors: globalErrors,
      global_error_rate: globalCalls > 0 ? globalErrors / globalCalls : 0,
      global_avg_latency_ms: latencyCount > 0 ? latencySum / latencyCount : 0,
    };
  }

  // ─── Private: Webview Message Handling ───────────────────────────────────

  private _handleWebviewMessage(msg: WebviewOutboundMessage): void {
    this.logger.debug(MODULE, 'Webview message received', { type: msg.type });

    switch (msg.type) {
      case 'requestSnapshot':
        this._handleRequestSnapshot();
        break;
      case 'requestMcpDetail':
        this._handleRequestMcpDetail(msg.mcp);
        break;
      case 'requestHistory':
        this._handleRequestHistory(msg.mcp, msg.limit);
        break;
      case 'setFilter':
        this.sseClient.setFilter(msg.mcp);
        break;
      case 'connectBackend':
        this.sseClient.connect();
        break;
      case 'disconnectBackend':
        this.sseClient.disconnect();
        break;
    }
  }

  private _handleRequestSnapshot(): void {
    this.logger.debug(MODULE, 'Handling snapshot request');
    // Fetch fresh snapshot from backend API
    this._apiGet('/api/v1/mcp/metrics')
      .then((data) => {
        const snapshot = data as MetricsSnapshot;
        this._lastSnapshot = snapshot;
        this._postToWebview({ type: 'metricsSnapshot', payload: snapshot });
      })
      .catch((err) => {
        this.logger.warn(MODULE, 'Failed to fetch metrics snapshot from backend', err);
        // Fall back to local snapshot
        if (this._lastSnapshot) {
          this._postToWebview({ type: 'metricsSnapshot', payload: this._lastSnapshot });
        }
      });
  }

  private _handleRequestMcpDetail(mcpName: string): void {
    this.logger.debug(MODULE, 'Handling MCP detail request', { mcpName });
    this._apiGet(`/api/v1/mcp/metrics/${encodeURIComponent(mcpName)}`)
      .then((data) => {
        const detail = data as McpDetailMetrics;
        this._postToWebview({ type: 'mcpDetailResponse', payload: detail });
      })
      .catch((err) => {
        this.logger.warn(MODULE, 'Failed to fetch MCP detail', { mcpName, error: err });
      });
  }

  private _handleRequestHistory(mcpName: string, limit: number): void {
    this.logger.debug(MODULE, 'Handling history request', { mcpName, limit });
    this._apiGet(`/api/v1/mcp/metrics/${encodeURIComponent(mcpName)}?limit=${limit}`)
      .then((data) => {
        const detail = data as McpDetailMetrics;
        this._postToWebview({ type: 'mcpDetailResponse', payload: detail });
      })
      .catch((err) => {
        this.logger.warn(MODULE, 'Failed to fetch MCP history', { mcpName, error: err });
      });
  }

  // ─── Private: Backend API Helper ─────────────────────────────────────────

  private _apiGet(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.backendUrl) {
        reject(new Error('Backend URL not configured'));
        return;
      }

      let fullUrl: string;
      try {
        const base = this.backendUrl.replace(/\/+$/, '');
        fullUrl = `${base}${path}`;
      } catch {
        reject(new Error(`Invalid backend URL: ${this.backendUrl}`));
        return;
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(fullUrl);
      } catch {
        reject(new Error(`Invalid URL: ${fullUrl}`));
        return;
      }

      const isHttps = parsedUrl.protocol === 'https:';
      const mod = isHttps ? https : http;

      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };
      if (this.authToken) {
        headers['Authorization'] = `Bearer ${this.authToken}`;
      }

      const req = mod.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers,
          timeout: 15000,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(body));
              } catch {
                reject(new Error(`Invalid JSON response from ${path}`));
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode} from ${path}`));
            }
          });
        }
      );

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout fetching ${path}`));
      });
      req.end();
    });
  }

  // ─── Private: Cache ──────────────────────────────────────────────────────

  private _restoreCache(): void {
    try {
      const cached = this.globalState.get<{ snapshot: MetricsSnapshot; timestamp: number }>(CACHE_STATE_KEY);
      if (cached?.snapshot) {
        this._lastSnapshot = cached.snapshot;
        this._mode = 'cached';
        this.logger.debug(MODULE, 'Restored metrics cache', {
          cacheAge: Date.now() - cached.timestamp,
        });
      }
    } catch (err) {
      this.logger.warn(MODULE, 'Failed to restore metrics cache', err);
    }
  }

  // ─── Private: Webview Communication ──────────────────────────────────────

  private _postToWebview(message: WebviewInboundMessage): void {
    if (!this.webview || this._disposed) {
      return;
    }
    try {
      this.webview.postMessage(message);
    } catch (err) {
      this.logger.warn(MODULE, 'Failed to post message to webview', err);
    }
  }
}

// ─── Local Metrics Aggregator ────────────────────────────────────────────────

/**
 * Lightweight per-MCP metrics aggregator running in the extension host.
 * Provides instant rendering even when SSE has lag.
 */
class LocalMcpMetrics {
  private mcpName: string;
  private historyLimit: number;
  private toolMetrics: Map<string, LocalToolMetrics> = new Map();
  private _startCount: number = 0;
  private _endCount: number = 0;
  private _totalErrors: number = 0;
  private _latencies: number[] = [];
  private _tokensIn: number = 0;
  private _tokensOut: number = 0;
  private _startTime: number = Date.now();
  private _lastHealthCheck: number = 0;
  private _healthStatus: 'healthy' | 'degraded' | 'unhealthy' | 'unknown' = 'unknown';

  constructor(mcpName: string, historyLimit: number) {
    this.mcpName = mcpName;
    this.historyLimit = historyLimit;
  }

  processEvent(event: McpLogEvent): void {
    const data = event.data;

    switch (event.event_type) {
      case McpEventType.TOOL_CALL_START:
        this._startCount++;
        break;

      case McpEventType.TOOL_CALL_END: {
        this._endCount++;
        const toolName = (data.tool_name as string) ?? 'unknown';
        const latency = (data.latency_ms as number) ?? 0;
        const tokensIn = (data.tokens_in as number) ?? 0;
        const tokensOut = (data.tokens_out as number) ?? 0;

        this._latencies.push(latency);
        if (this._latencies.length > this.historyLimit) {
          this._latencies.shift();
        }
        this._tokensIn += tokensIn;
        this._tokensOut += tokensOut;

        let toolM = this.toolMetrics.get(toolName);
        if (!toolM) {
          toolM = new LocalToolMetrics(toolName);
          this.toolMetrics.set(toolName, toolM);
        }
        toolM.recordCall(latency, true, tokensIn, tokensOut);
        break;
      }

      case McpEventType.TOOL_CALL_ERROR:
      case McpEventType.TOOL_CALL_TIMEOUT:
        this._totalErrors++;
        {
          const toolName = (data.tool_name as string) ?? 'unknown';
          let toolM = this.toolMetrics.get(toolName);
          if (!toolM) {
            toolM = new LocalToolMetrics(toolName);
            this.toolMetrics.set(toolName, toolM);
          }
          toolM.recordCall(0, false, 0, 0);
        }
        break;

      case McpEventType.HEALTH_CHECK_OK:
        this._lastHealthCheck = event.timestamp;
        this._healthStatus = 'healthy';
        break;

      case McpEventType.HEALTH_CHECK_FAIL:
        this._lastHealthCheck = event.timestamp;
        this._healthStatus = 'unhealthy';
        break;

      case McpEventType.SERVER_START:
      case McpEventType.SERVER_RESTART:
        this._startTime = event.timestamp;
        this._healthStatus = 'healthy';
        break;

      case McpEventType.SERVER_CRASH:
        this._healthStatus = 'unhealthy';
        break;
    }
  }

  toServerMetrics(): McpServerMetrics {
    const sorted = [...this._latencies].sort((a, b) => a - b);
    const tools: ToolMetrics[] = [];
    for (const [, tm] of this.toolMetrics) {
      tools.push(tm.toToolMetrics());
    }

    const totalCalls = Math.max(this._startCount, this._endCount + this._totalErrors);

    return {
      mcp_name: this.mcpName,
      uptime_seconds: (Date.now() - this._startTime) / 1000,
      total_calls: totalCalls,
      total_errors: this._totalErrors,
      error_rate: totalCalls > 0 ? this._totalErrors / totalCalls : 0,
      avg_latency_ms: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
      p50_latency_ms: this._percentile(sorted, 50),
      p95_latency_ms: this._percentile(sorted, 95),
      tokens_in_total: this._tokensIn,
      tokens_out_total: this._tokensOut,
      tools,
      health_status: this._healthStatus,
      last_health_check: this._lastHealthCheck,
    };
  }

  private _percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) {
      return 0;
    }
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
}

/**
 * Per-tool metrics tracker.
 */
class LocalToolMetrics {
  private toolName: string;
  private _callCount: number = 0;
  private _errorCount: number = 0;
  private _latencies: number[] = [];
  private _lastCallTime: number = 0;
  private _tokensIn: number = 0;
  private _tokensOut: number = 0;

  constructor(toolName: string) {
    this.toolName = toolName;
  }

  recordCall(latencyMs: number, success: boolean, tokensIn: number, tokensOut: number): void {
    this._callCount++;
    if (!success) {
      this._errorCount++;
    }
    if (latencyMs > 0) {
      this._latencies.push(latencyMs);
      if (this._latencies.length > 500) {
        this._latencies.shift();
      }
    }
    this._lastCallTime = Date.now();
    this._tokensIn += tokensIn;
    this._tokensOut += tokensOut;
  }

  toToolMetrics(): ToolMetrics {
    const sorted = [...this._latencies].sort((a, b) => a - b);
    return {
      tool_name: this.toolName,
      call_count: this._callCount,
      error_count: this._errorCount,
      avg_latency_ms: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
      p50_latency_ms: this._percentile(sorted, 50),
      p95_latency_ms: this._percentile(sorted, 95),
      p99_latency_ms: this._percentile(sorted, 99),
      last_call_time: this._lastCallTime,
      tokens_in: this._tokensIn,
      tokens_out: this._tokensOut,
    };
  }

  private _percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) {
      return 0;
    }
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
}
