// ─── MCP Logger Types ────────────────────────────────────────────────────────
// TypeScript interfaces matching Python Cat 13 dataclasses for the
// Central MCP Logger SSE event stream consumed by the VS Code extension.

// ─── Event Type Enum ─────────────────────────────────────────────────────────

export enum McpEventType {
  TOOL_CALL_START = 'TOOL_CALL_START',
  TOOL_CALL_END = 'TOOL_CALL_END',
  TOOL_CALL_ERROR = 'TOOL_CALL_ERROR',
  TOOL_CALL_TIMEOUT = 'TOOL_CALL_TIMEOUT',
  SERVER_START = 'SERVER_START',
  SERVER_STOP = 'SERVER_STOP',
  SERVER_CRASH = 'SERVER_CRASH',
  SERVER_RESTART = 'SERVER_RESTART',
  SERVER_LOG = 'SERVER_LOG',
  HEALTH_CHECK_OK = 'HEALTH_CHECK_OK',
  HEALTH_CHECK_FAIL = 'HEALTH_CHECK_FAIL',
  CONFIG_RELOAD = 'CONFIG_RELOAD',
  DESTRUCTIVE_ACTION = 'DESTRUCTIVE_ACTION',
  DEPLOY_EVENT = 'DEPLOY_EVENT',
  LOGGER_ERROR = 'LOGGER_ERROR',
  SYSTEM_WARNING = 'SYSTEM_WARNING',
  MCP_INITIALIZE = 'MCP_INITIALIZE',
  MCP_TOOLS_LIST = 'MCP_TOOLS_LIST',
  MCP_RESOURCE_READ = 'MCP_RESOURCE_READ',
  MCP_PROMPT_GET = 'MCP_PROMPT_GET',
  MCP_NOTIFICATION = 'MCP_NOTIFICATION',
  MCP_CANCEL = 'MCP_CANCEL',
  MCP_SAMPLING_REQUEST = 'MCP_SAMPLING_REQUEST',
  ALERT_TRIGGERED = 'ALERT_TRIGGERED',
  ALERT_RESOLVED = 'ALERT_RESOLVED',
}

// ─── Severity Enum ───────────────────────────────────────────────────────────

export enum McpSeverity {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

// ─── Core Event Interface ────────────────────────────────────────────────────

export interface McpLogEvent {
  event_id: string;
  timestamp: number;
  mcp_name: string;
  event_type: McpEventType;
  severity: McpSeverity;
  data: Record<string, unknown>;
  correlation_id?: string;
  repeat_count?: number;
  schema_version?: number;
}

// ─── Metrics Interfaces ──────────────────────────────────────────────────────

export interface ToolMetrics {
  tool_name: string;
  call_count: number;
  error_count: number;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  last_call_time: number;
  tokens_in: number;
  tokens_out: number;
}

export interface McpServerMetrics {
  mcp_name: string;
  uptime_seconds: number;
  total_calls: number;
  total_errors: number;
  error_rate: number;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  tokens_in_total: number;
  tokens_out_total: number;
  tools: ToolMetrics[];
  health_status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  last_health_check: number;
}

export interface MetricsSnapshot {
  timestamp: number;
  servers: McpServerMetrics[];
  global_total_calls: number;
  global_total_errors: number;
  global_error_rate: number;
  global_avg_latency_ms: number;
}

// ─── Connection Status ───────────────────────────────────────────────────────

export type ConnectionMode = 'online' | 'offline' | 'cached' | 'hybrid';

export interface ConnectionStatus {
  isConnected: boolean;
  lastEventTime: number;
  reconnectCount: number;
  connectionUptime: number;
  eventsReceived: number;
  mode: ConnectionMode;
}

// ─── Detail Metrics (per-MCP drill-down) ─────────────────────────────────────

export interface McpDetailMetrics {
  mcp_name: string;
  metrics: McpServerMetrics;
  recent_events: McpLogEvent[];
  tool_call_history: ToolCallRecord[];
}

export interface ToolCallRecord {
  tool_name: string;
  timestamp: number;
  latency_ms: number;
  success: boolean;
  error?: string;
  tokens_in: number;
  tokens_out: number;
}

// ─── Webview Message Protocol ────────────────────────────────────────────────
// Extension → Webview (inbound to webview)

export type WebviewInboundMessage =
  | { type: 'mcpEvent'; payload: McpLogEvent }
  | { type: 'mcpEventBatch'; payload: McpLogEvent[] }
  | { type: 'metricsSnapshot'; payload: MetricsSnapshot }
  | { type: 'connectionStatus'; payload: ConnectionStatus }
  | { type: 'mcpDetailResponse'; payload: McpDetailMetrics }
  | { type: 'authRequired'; payload: { message: string } }
  | { type: 'backendOffline'; payload: { lastUpdated: number } };

// Webview → Extension (outbound from webview)

export type WebviewOutboundMessage =
  | { type: 'requestSnapshot' }
  | { type: 'requestMcpDetail'; mcp: string }
  | { type: 'requestHistory'; mcp: string; limit: number }
  | { type: 'setFilter'; mcp: string | null }
  | { type: 'connectBackend' }
  | { type: 'disconnectBackend' };

// ─── SSE Client Configuration ────────────────────────────────────────────────

export interface SseClientConfig {
  backendUrl: string;
  authToken: string;
  reconnectBaseDelay: number;
  reconnectMaxDelay: number;
  stableConnectionThreshold: number;
  filterDebounceMs: number;
}

// ─── Data Bridge Configuration ───────────────────────────────────────────────

export interface DataBridgeConfig {
  eventBufferSize: number;
  refreshRateMs: number;
  metricsHistoryLimit: number;
  tDigestCentroidLimit: number;
}

// ─── Extension Telemetry ─────────────────────────────────────────────────────

export interface BridgeTelemetry {
  eventsReceivedPerSec: number;
  postMessageCallsPerSec: number;
  processingLatencyP50Ms: number;
  processingLatencyP95Ms: number;
  memoryUsageBytes: number;
  bufferUtilization: number;
}
