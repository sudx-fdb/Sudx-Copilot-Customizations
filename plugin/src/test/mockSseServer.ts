import * as http from 'http';
import { McpEventType, McpSeverity, McpLogEvent } from '../mcp/mcpLoggerTypes';

// ─── Mock SSE Server for Testing ─────────────────────────────────────────────
// Lightweight Node.js HTTP server that emits SSE events on schedule.
// Configurable: event rate, event types, malformed events, connection drops, auth rejection.

export interface MockSseServerConfig {
  port: number;
  authToken?: string;
  eventIntervalMs: number;
  autoStart: boolean;
  malformedRate: number; // 0-1, probability of malformed JSON
  dropAfterEvents: number; // 0 = never drop, N = drop connection after N events
  heartbeatIntervalMs: number;
}

const DEFAULT_CONFIG: MockSseServerConfig = {
  port: 0, // Random available port
  authToken: undefined,
  eventIntervalMs: 500,
  autoStart: true,
  malformedRate: 0,
  dropAfterEvents: 0,
  heartbeatIntervalMs: 15000,
};

const MCP_NAMES = ['pentest-ai', 'crawl4ai', 'playwright', 'code-analyzer'];
const TOOL_NAMES = ['browser_navigate', 'crawl_url', 'scan_target', 'analyze_code'];

export class MockSseServer {
  private server: http.Server | null = null;
  private config: MockSseServerConfig;
  private clients: Set<http.ServerResponse> = new Set();
  private eventCounter: number = 0;
  private eventTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _port: number = 0;

  constructor(config?: Partial<MockSseServerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://localhost:${this._port}`;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this._handleRequest(req, res);
      });

      this.server.listen(this.config.port, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
        }
        this._startEventLoop();
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    this._stopEventLoop();

    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Manually emit a specific event to all connected clients.
   */
  emitEvent(event: McpLogEvent): void {
    const data = JSON.stringify(event);
    const ssePayload = `id:${event.event_id}\nevent:message\ndata:${data}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(ssePayload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /**
   * Emit a malformed SSE event (invalid JSON).
   */
  emitMalformed(): void {
    const ssePayload = `id:malformed-${Date.now()}\ndata:{invalid json\n\n`;
    for (const client of this.clients) {
      try {
        client.write(ssePayload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /**
   * Drop all connected clients (simulate connection loss).
   */
  dropConnections(): void {
    for (const client of this.clients) {
      try {
        client.destroy();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }

  /**
   * Send a retry: field to all clients.
   */
  sendRetryField(retryMs: number): void {
    const ssePayload = `retry:${retryMs}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(ssePayload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://localhost:${this._port}`);

    // Health endpoint
    if (url.pathname === '/api/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Metrics endpoint
    if (url.pathname === '/api/v1/mcp/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        timestamp: Date.now(),
        servers: [],
        global_total_calls: this.eventCounter,
        global_total_errors: 0,
        global_error_rate: 0,
        global_avg_latency_ms: 50,
      }));
      return;
    }

    // SSE stream endpoint
    if (url.pathname !== '/api/v1/mcp/events/stream') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // Auth check
    if (this.config.authToken) {
      const authHeader = req.headers['authorization'] ?? '';
      const expectedToken = `Bearer ${this.config.authToken}`;
      if (authHeader !== expectedToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Check for Last-Event-ID
    const lastEventId = req.headers['last-event-id'];
    if (lastEventId) {
      // Replay events since that ID (simplified: just note it)
      res.write(`:replay from ${lastEventId}\n\n`);
    }

    this.clients.add(res);

    req.on('close', () => {
      this.clients.delete(res);
    });

    // Send initial heartbeat
    res.write(':ok\n\n');
  }

  private _startEventLoop(): void {
    let eventsEmitted = 0;

    this.eventTimer = setInterval(() => {
      if (this.clients.size === 0) {
        return;
      }

      // Check if we should drop connection
      if (this.config.dropAfterEvents > 0 && eventsEmitted >= this.config.dropAfterEvents) {
        this.dropConnections();
        eventsEmitted = 0;
        return;
      }

      // Check if we should emit malformed
      if (this.config.malformedRate > 0 && Math.random() < this.config.malformedRate) {
        this.emitMalformed();
        eventsEmitted++;
        return;
      }

      const event = this._generateEvent();
      this.emitEvent(event);
      eventsEmitted++;
    }, this.config.eventIntervalMs);

    // Heartbeat
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.write(':heartbeat\n\n');
        } catch {
          this.clients.delete(client);
        }
      }
    }, this.config.heartbeatIntervalMs);
  }

  private _stopEventLoop(): void {
    if (this.eventTimer) {
      clearInterval(this.eventTimer);
      this.eventTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _pendingStarts: Map<string, McpLogEvent> = new Map();

  private _generateEvent(): McpLogEvent {
    this.eventCounter++;
    const mcpName = MCP_NAMES[this.eventCounter % MCP_NAMES.length];
    const toolName = TOOL_NAMES[this.eventCounter % TOOL_NAMES.length];
    const correlationId = `corr-${this.eventCounter}-${Date.now()}`;

    // Every ~5th event is an error, ~40% START, ~40% END, ~15% other, ~5% ERROR
    const roll = Math.random();
    const isError = roll < 0.05;
    const isStart = roll >= 0.05 && roll < 0.45;
    const isEnd = roll >= 0.45 && roll < 0.85;
    // Remaining 15% is OTHER type (SERVER_LOG, MCP_NOTIFICATION, etc.)

    if (isStart || (isEnd && this._pendingStarts.size === 0)) {
      // Generate a TOOL_CALL_START event
      const startEvent: McpLogEvent = {
        event_id: `mock-${this.eventCounter}-${Date.now()}`,
        timestamp: Date.now() / 1000,
        mcp_name: mcpName,
        event_type: McpEventType.TOOL_CALL_START,
        severity: McpSeverity.INFO,
        data: {
          tool_name: toolName,
          tokens_in: Math.round(Math.random() * 200),
        },
        correlation_id: correlationId,
      };
      this._pendingStarts.set(correlationId, startEvent);
      return startEvent;
    }

    if (isEnd && this._pendingStarts.size > 0) {
      // Complete a pending START with a matching END
      const [pendingCorrId] = this._pendingStarts.keys();
      const pendingStart = this._pendingStarts.get(pendingCorrId)!;
      this._pendingStarts.delete(pendingCorrId);

      return {
        event_id: `mock-${this.eventCounter}-${Date.now()}`,
        timestamp: Date.now() / 1000,
        mcp_name: pendingStart.mcp_name,
        event_type: McpEventType.TOOL_CALL_END,
        severity: McpSeverity.INFO,
        data: {
          tool_name: (pendingStart.data?.tool_name as string) ?? toolName,
          latency_ms: Math.round(Math.random() * 500 + 50),
          tokens_in: pendingStart.data?.tokens_in ?? 0,
          tokens_out: Math.round(Math.random() * 500),
          success: true,
        },
        correlation_id: pendingCorrId,
      };
    }

    if (isError) {
      // Emit an error — optionally complete a pending START as error
      let errCorrId = correlationId;
      let errMcpName = mcpName;
      let errToolName = toolName;
      if (this._pendingStarts.size > 0) {
        const [pendingCorrId] = this._pendingStarts.keys();
        const pendingStart = this._pendingStarts.get(pendingCorrId)!;
        this._pendingStarts.delete(pendingCorrId);
        errCorrId = pendingCorrId;
        errMcpName = pendingStart.mcp_name;
        errToolName = (pendingStart.data?.tool_name as string) ?? toolName;
      }

      return {
        event_id: `mock-${this.eventCounter}-${Date.now()}`,
        timestamp: Date.now() / 1000,
        mcp_name: errMcpName,
        event_type: McpEventType.TOOL_CALL_ERROR,
        severity: McpSeverity.ERROR,
        data: {
          tool_name: errToolName,
          latency_ms: Math.round(Math.random() * 500 + 50),
          error: 'Mock error for testing',
          success: false,
        },
        correlation_id: errCorrId,
      };
    }

    // Other event types (~15%)
    const otherTypes = [McpEventType.SERVER_LOG, McpEventType.MCP_NOTIFICATION, McpEventType.HEALTH_CHECK_OK];
    const otherType = otherTypes[this.eventCounter % otherTypes.length];
    return {
      event_id: `mock-${this.eventCounter}-${Date.now()}`,
      timestamp: Date.now() / 1000,
      mcp_name: mcpName,
      event_type: otherType,
      severity: McpSeverity.INFO,
      data: {
        message: `Mock ${otherType} event`,
      },
      correlation_id: correlationId,
    };
  }
}
