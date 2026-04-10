import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { EventEmitter } from 'events';
import { URL } from 'url';
import { SudxLogger } from '../utils/logger';
import {
  McpLogEvent,
  ConnectionStatus,
  SseClientConfig,
  ConnectionMode,
} from './mcpLoggerTypes';

const MODULE = 'McpLoggerClient';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_RECONNECT_BASE_MS = 2000;
const DEFAULT_RECONNECT_MAX_MS = 60000;
const DEFAULT_STABLE_THRESHOLD_MS = 30000;
const DEFAULT_FILTER_DEBOUNCE_MS = 300;
const HEARTBEAT_TIMEOUT_MS = 90000; // Server sends heartbeat every 30s, timeout at 3x
const SSE_LINE_SEPARATOR = /\r\n|\r|\n/;

// ─── SSE Client ──────────────────────────────────────────────────────────────

/**
 * Node.js SSE client for consuming the Central MCP Logger event stream.
 * Built on raw `http.request`/`https.request` with manual SSE protocol parsing
 * since Node.js has no native EventSource API.
 */
export class McpLoggerClient extends EventEmitter implements vscode.Disposable {
  private logger: SudxLogger;
  private config: SseClientConfig;
  private currentRequest: http.ClientRequest | null = null;
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private filterDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // SSE parser state
  private sseBuffer: string = '';
  private currentEventType: string = 'message';
  private currentEventData: string[] = [];
  private currentEventId: string = '';

  // Connection state
  private _isConnected: boolean = false;
  private _lastEventTime: number = 0;
  private _reconnectCount: number = 0;
  private _connectionStartTime: number = 0;
  private _eventsReceived: number = 0;
  private _lastEventId: string = '';
  private _currentFilter: string | null = null;
  private _disposed: boolean = false;
  private _reconnectDelay: number;
  private _serverRetryMs: number | null = null;
  private _stableTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(logger: SudxLogger, config: Partial<SseClientConfig> & { backendUrl: string; authToken: string }) {
    super();
    this.logger = logger;
    this.config = {
      backendUrl: config.backendUrl,
      authToken: config.authToken,
      reconnectBaseDelay: config.reconnectBaseDelay ?? DEFAULT_RECONNECT_BASE_MS,
      reconnectMaxDelay: config.reconnectMaxDelay ?? DEFAULT_RECONNECT_MAX_MS,
      stableConnectionThreshold: config.stableConnectionThreshold ?? DEFAULT_STABLE_THRESHOLD_MS,
      filterDebounceMs: config.filterDebounceMs ?? DEFAULT_FILTER_DEBOUNCE_MS,
    };
    this._reconnectDelay = this.config.reconnectBaseDelay;
    this.logger.debug(MODULE, 'McpLoggerClient created', {
      backendUrl: this.config.backendUrl,
      reconnectBase: this.config.reconnectBaseDelay,
      reconnectMax: this.config.reconnectMaxDelay,
    });
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Connect to the SSE event stream.
   */
  connect(filter?: string | null): void {
    if (this._disposed) {
      this.logger.warn(MODULE, 'connect() called on disposed client');
      return;
    }
    this.logger.debug(MODULE, 'connect() called', { filter });
    this._currentFilter = filter ?? null;
    this._startConnection();
  }

  /**
   * Disconnect from the SSE stream and clean up.
   */
  disconnect(): void {
    this.logger.debug(MODULE, 'disconnect() called');
    this._abortConnection();
    this._clearTimers();
    this._isConnected = false;
    this._reconnectDelay = this.config.reconnectBaseDelay;
    this._emitConnectionStatus();
  }

  /**
   * Update the MCP filter. Debounced — rapid changes are coalesced.
   */
  setFilter(mcpName: string | null): void {
    this.logger.debug(MODULE, 'setFilter() called', { mcpName });
    if (this.filterDebounceTimer) {
      clearTimeout(this.filterDebounceTimer);
    }
    this.filterDebounceTimer = setTimeout(() => {
      this.filterDebounceTimer = null;
      if (this._currentFilter === mcpName) {
        this.logger.debug(MODULE, 'setFilter(): filter unchanged, skipping reconnect');
        return;
      }
      this._currentFilter = mcpName;
      this.logger.debug(MODULE, 'setFilter(): reconnecting with new filter', { mcpName });
      this._abortConnection();
      this._startConnection();
    }, this.config.filterDebounceMs);
  }

  /**
   * Update configuration (e.g., new URL or token after settings change).
   */
  updateConfig(config: Partial<SseClientConfig>): void {
    this.logger.debug(MODULE, 'updateConfig() called', { keys: Object.keys(config) });
    const needsReconnect =
      (config.backendUrl !== undefined && config.backendUrl !== this.config.backendUrl) ||
      (config.authToken !== undefined && config.authToken !== this.config.authToken);

    Object.assign(this.config, config);

    if (needsReconnect && this._isConnected) {
      this.logger.info(MODULE, 'Config changed, reconnecting SSE');
      this._abortConnection();
      this._startConnection();
    }
  }

  /**
   * Get current connection status.
   */
  getConnectionStatus(): ConnectionStatus {
    const now = Date.now();
    const mode: ConnectionMode = this._isConnected ? 'online' : 'offline';
    return {
      isConnected: this._isConnected,
      lastEventTime: this._lastEventTime,
      reconnectCount: this._reconnectCount,
      connectionUptime: this._isConnected ? now - this._connectionStartTime : 0,
      eventsReceived: this._eventsReceived,
      mode,
    };
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  get lastEventTime(): number {
    return this._lastEventTime;
  }

  get reconnectCount(): number {
    return this._reconnectCount;
  }

  get eventsReceived(): number {
    return this._eventsReceived;
  }

  get connectionUptime(): number {
    return this._isConnected ? Date.now() - this._connectionStartTime : 0;
  }

  /**
   * Dispose the client. Cleans up all resources.
   */
  dispose(): void {
    this.logger.debug(MODULE, 'dispose() called');
    this._disposed = true;
    this.disconnect();
    this.removeAllListeners();
  }

  // ─── Private: Connection ─────────────────────────────────────────────────

  private _startConnection(): void {
    if (this._disposed) {
      return;
    }
    this.logger.debug(MODULE, '_startConnection()', {
      filter: this._currentFilter,
      lastEventId: this._lastEventId,
    });

    this._abortConnection();

    let sseUrl: string;
    try {
      const base = this.config.backendUrl.replace(/\/+$/, '');
      sseUrl = `${base}/api/v1/mcp/events/stream`;
      if (this._currentFilter) {
        sseUrl += `?mcp=${encodeURIComponent(this._currentFilter)}`;
      }
    } catch (urlErr) {
      this.logger.error(MODULE, 'Invalid backend URL', urlErr);
      this.emit('error', new Error(`Invalid backend URL: ${this.config.backendUrl}`));
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(sseUrl);
    } catch (parseErr) {
      this.logger.error(MODULE, 'Failed to parse SSE URL', parseErr);
      this.emit('error', new Error(`Invalid SSE URL: ${sseUrl}`));
      return;
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const requestModule = isHttps ? https : http;

    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    };

    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    if (this._lastEventId) {
      headers['Last-Event-ID'] = this._lastEventId;
    }

    this.abortController = new AbortController();

    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers,
      signal: this.abortController.signal as never,
    };

    this.logger.debug(MODULE, 'Opening SSE connection', {
      url: sseUrl,
      hasAuth: !!this.config.authToken,
      hasLastEventId: !!this._lastEventId,
    });

    try {
      this.currentRequest = requestModule.request(options, (res) => {
        this._handleResponse(res);
      });

      this.currentRequest.on('error', (err) => {
        if (this._disposed) {
          return;
        }
        // AbortError is expected on intentional disconnect
        if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR' || err.name === 'AbortError') {
          this.logger.debug(MODULE, 'SSE request aborted (intentional)');
          return;
        }
        this.logger.error(MODULE, 'SSE request error', err);
        this._handleDisconnect('request_error');
      });

      this.currentRequest.end();
    } catch (reqErr) {
      this.logger.error(MODULE, 'Failed to create SSE request', reqErr);
      this._handleDisconnect('request_create_error');
    }
  }

  private _handleResponse(res: http.IncomingMessage): void {
    const statusCode = res.statusCode ?? 0;
    this.logger.debug(MODULE, '_handleResponse()', { statusCode });

    if (statusCode === 401 || statusCode === 403) {
      this.logger.warn(MODULE, 'SSE authentication failed', { statusCode });
      this._isConnected = false;
      this.emit('authFailure', statusCode);
      this._emitConnectionStatus();
      // Don't auto-reconnect on auth failure
      return;
    }

    if (statusCode !== 200) {
      this.logger.warn(MODULE, 'SSE unexpected status code', { statusCode });
      res.destroy();
      this._handleDisconnect('bad_status');
      return;
    }

    // Connection established
    this._isConnected = true;
    this._connectionStartTime = Date.now();
    this._reconnectCount = this._reconnectCount; // preserve count
    this.sseBuffer = '';
    this._resetSseParserState();

    this.logger.info(MODULE, 'SSE connection established', {
      filter: this._currentFilter,
      reconnectCount: this._reconnectCount,
    });
    this._emitConnectionStatus();
    this._resetHeartbeatTimer();

    // Check if connection is stable after threshold
    if (this._stableTimer) {
      clearTimeout(this._stableTimer);
    }
    this._stableTimer = setTimeout(() => {
      if (this._isConnected && !this._disposed) {
        this.logger.debug(MODULE, 'Connection stable, resetting backoff');
        this._reconnectDelay = this.config.reconnectBaseDelay;
        this._serverRetryMs = null;
      }
      this._stableTimer = null;
    }, this.config.stableConnectionThreshold);

    res.setEncoding('utf8');

    res.on('data', (chunk: string) => {
      if (this._disposed) {
        return;
      }
      this._resetHeartbeatTimer();
      this._processSseChunk(chunk);
    });

    res.on('end', () => {
      if (this._stableTimer) {
        clearTimeout(this._stableTimer);
        this._stableTimer = null;
      }
      if (this._disposed) {
        return;
      }
      this.logger.debug(MODULE, 'SSE response ended');
      this._handleDisconnect('stream_end');
    });

    res.on('error', (err) => {
      if (this._stableTimer) {
        clearTimeout(this._stableTimer);
        this._stableTimer = null;
      }
      if (this._disposed) {
        return;
      }
      this.logger.error(MODULE, 'SSE response stream error', err);
      this._handleDisconnect('stream_error');
    });
  }

  private _handleDisconnect(reason: string): void {
    this.logger.debug(MODULE, '_handleDisconnect()', { reason });
    this._isConnected = false;
    this._clearHeartbeatTimer();
    this._emitConnectionStatus();

    if (this._disposed) {
      return;
    }

    this._reconnectCount++;
    const delay = this._serverRetryMs ?? this._reconnectDelay;
    this.logger.info(MODULE, `Scheduling reconnect in ${delay}ms`, {
      reason,
      reconnectCount: this._reconnectCount,
      delay,
    });

    // Exponential backoff (only for client-side delay)
    if (!this._serverRetryMs) {
      this._reconnectDelay = Math.min(
        this._reconnectDelay * 2,
        this.config.reconnectMaxDelay
      );
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this._disposed) {
        this._startConnection();
      }
    }, delay);
  }

  private _abortConnection(): void {
    if (this._stableTimer) {
      clearTimeout(this._stableTimer);
      this._stableTimer = null;
    }
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {
        // Ignore abort errors
      }
      this.abortController = null;
    }
    if (this.currentRequest) {
      try {
        this.currentRequest.destroy();
      } catch {
        // Ignore destroy errors
      }
      this.currentRequest = null;
    }
  }

  // ─── Private: SSE Parser ─────────────────────────────────────────────────

  private _processSseChunk(chunk: string): void {
    this.sseBuffer += chunk;
    const lines = this.sseBuffer.split(SSE_LINE_SEPARATOR);

    // Keep the last incomplete line in the buffer
    this.sseBuffer = lines.pop() ?? '';

    for (const line of lines) {
      this._processSseLine(line);
    }
  }

  private _processSseLine(line: string): void {
    // Empty line = dispatch event
    if (line === '' || line === '\r') {
      this._dispatchSseEvent();
      return;
    }

    // Comment line (starts with :) — used for heartbeat
    if (line.startsWith(':')) {
      this.logger.debug(MODULE, 'SSE heartbeat/comment received');
      return;
    }

    const colonIndex = line.indexOf(':');
    let field: string;
    let value: string;

    if (colonIndex === -1) {
      // Field with no value
      field = line;
      value = '';
    } else {
      field = line.substring(0, colonIndex);
      // Strip leading space after colon per SSE spec
      value = line.substring(colonIndex + 1);
      if (value.startsWith(' ')) {
        value = value.substring(1);
      }
    }
    // Strip trailing \r if present
    if (value.endsWith('\r')) {
      value = value.slice(0, -1);
    }

    switch (field) {
      case 'data':
        this.currentEventData.push(value);
        break;
      case 'event':
        this.currentEventType = value;
        break;
      case 'id':
        // Ignore IDs containing null per SSE spec
        if (!value.includes('\0')) {
          this.currentEventId = value;
        }
        break;
      case 'retry': {
        const retryMs = parseInt(value, 10);
        if (!isNaN(retryMs) && retryMs >= 0) {
          this.logger.debug(MODULE, 'Server requested retry delay', { retryMs });
          this._serverRetryMs = retryMs;
        }
        break;
      }
      default:
        this.logger.debug(MODULE, 'Unknown SSE field ignored', { field });
        break;
    }
  }

  private _dispatchSseEvent(): void {
    if (this.currentEventData.length === 0) {
      this._resetSseParserState();
      return;
    }

    const data = this.currentEventData.join('\n');

    // Update last event ID
    if (this.currentEventId) {
      this._lastEventId = this.currentEventId;
    }

    this._lastEventTime = Date.now();
    this._eventsReceived++;

    // Parse JSON data
    let parsed: McpLogEvent;
    try {
      parsed = JSON.parse(data) as McpLogEvent;
    } catch (parseErr) {
      this.logger.warn(MODULE, 'Failed to parse SSE event data as JSON', {
        dataLength: data.length,
        eventType: this.currentEventType,
        error: (parseErr as Error).message,
      });
      this._resetSseParserState();
      return;
    }

    this.logger.debug(MODULE, 'SSE event dispatched', {
      eventType: this.currentEventType,
      mcpName: parsed.mcp_name,
      severity: parsed.severity,
      eventId: parsed.event_id,
    });

    this.emit('event', parsed);
    this._resetSseParserState();
  }

  private _resetSseParserState(): void {
    this.currentEventType = 'message';
    this.currentEventData = [];
    this.currentEventId = '';
  }

  // ─── Private: Heartbeat ──────────────────────────────────────────────────

  private _resetHeartbeatTimer(): void {
    this._clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      if (this._isConnected && !this._disposed) {
        this.logger.warn(MODULE, 'Heartbeat timeout — no data received, reconnecting');
        this._abortConnection();
        this._handleDisconnect('heartbeat_timeout');
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private _clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Private: Timers ─────────────────────────────────────────────────────

  private _clearTimers(): void {
    this._clearHeartbeatTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.filterDebounceTimer) {
      clearTimeout(this.filterDebounceTimer);
      this.filterDebounceTimer = null;
    }
  }

  // ─── Private: Status ─────────────────────────────────────────────────────

  private _emitConnectionStatus(): void {
    const status = this.getConnectionStatus();
    this.emit('connectionStatus', status);
  }
}
