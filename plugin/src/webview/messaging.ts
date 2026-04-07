import * as vscode from 'vscode';
import {
  IWebviewMessage,
  IWebviewResponse,
  WebviewMessageType,
  WebviewResponseType,
  IUpdateHookPayload,
  IHookConfig,
} from '../types';
import { SudxLogger } from '../utils/logger';
import {
  MESSAGE_RATE_LIMIT,
  DEPLOY_DEBOUNCE_MS,
  VALID_HOOKS,
  HOOK_NAME_MAX_LENGTH,
  RATE_LIMIT_WINDOW_MS,
} from '../constants';

const MODULE = 'Messaging';

type MessageHandlerFn = (payload: unknown, requestId?: string) => Promise<void>;

const VALID_MESSAGE_TYPES: WebviewMessageType[] = [
  'getConfig',
  'updateHook',
  'updateAllHooks',
  'toggleAgent',
  'deploy',
  'cancelDeploy',
  'getStatus',
  'getHistory',
  'resetConfig',
  'openLog',
  'pushUiSettings',
  'getLogData',
];

const VALID_HOOK_NAMES = VALID_HOOKS;

// ─── Rate Limiter (Sliding Window) ───────────────────────────────────────────

interface IRateLimiterRule {
  limit: number;
  windowMs: number;
}

class RateLimiter {
  private timestamps: Map<string, number[]> = new Map();
  private rules: Map<string, IRateLimiterRule> = new Map();
  private defaultRule: IRateLimiterRule;

  constructor(defaultRule: IRateLimiterRule) {
    this.defaultRule = defaultRule;
  }

  addRule(type: string, rule: IRateLimiterRule): void {
    this.rules.set(type, rule);
  }

  check(type: string): { allowed: boolean; retryAfterMs: number; cooldownMs: number } {
    const rule = this.rules.get(type) ?? this.defaultRule;
    const now = Date.now();
    const windowStart = now - rule.windowMs;

    let times = this.timestamps.get(type) ?? [];
    times = times.filter(t => t > windowStart);

    if (times.length >= rule.limit) {
      const oldest = times[0];
      const retryAfterMs = Math.max(0, oldest + rule.windowMs - now);
      this.timestamps.set(type, times);
      return { allowed: false, retryAfterMs, cooldownMs: retryAfterMs };
    }

    times.push(now);
    this.timestamps.set(type, times);
    return { allowed: true, retryAfterMs: 0, cooldownMs: 0 };
  }

  dispose(): void {
    this.timestamps.clear();
    this.rules.clear();
  }
}

// ─── Message Handler ─────────────────────────────────────────────────────────

export class MessageHandler {
  private logger: SudxLogger;
  private handlers: Map<WebviewMessageType, MessageHandlerFn> = new Map();
  private panel: vscode.WebviewPanel | null = null;
  private rateLimiter: RateLimiter;

  constructor(logger: SudxLogger) {
    this.logger = logger;
    this.rateLimiter = new RateLimiter({
      limit: MESSAGE_RATE_LIMIT,
      windowMs: RATE_LIMIT_WINDOW_MS,
    });
    this.rateLimiter.addRule('deploy', { limit: 1, windowMs: DEPLOY_DEBOUNCE_MS });
    this.logger.debug(MODULE, 'MessageHandler initialized with sliding-window rate limiter');
  }

  setPanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;

    panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        this.handleIncoming(message);
      },
      undefined,
      []
    );
  }

  registerHandler(type: WebviewMessageType, handler: MessageHandlerFn): void {
    this.handlers.set(type, handler);
    this.logger.debug(MODULE, `Handler registered for: ${type}`);
  }

  async sendToWebview(message: IWebviewResponse): Promise<void> {
    if (!this.panel) {
      this.logger.warn(MODULE, 'Cannot send — no active panel');
      return;
    }

    try {
      await this.panel.webview.postMessage(message);
      this.logger.debug(MODULE, 'Message sent to webview', { type: message.type });
    } catch (err) {
      this.logger.error(MODULE, 'Failed to send message to webview', err);
    }
  }

  dispose(): void {
    this.logger.debug(MODULE, 'Disposing MessageHandler');
    this.handlers.clear();
    this.panel = null;
    this.rateLimiter.dispose();
  }

  private async handleIncoming(raw: unknown): Promise<void> {
    const receiveTime = Date.now();

    // Validate message structure
    if (!this.isValidMessage(raw)) {
      this.logger.warn(MODULE, 'Invalid message structure received', {
        type: typeof raw,
      });
      return;
    }

    const message = raw as IWebviewMessage;

    // Debug-mode request logging (type + payload size, not payload content)
    this.logger.debug(MODULE, `Received: ${message.type}`, {
      requestId: message.requestId,
      payloadSize: message.payload ? JSON.stringify(message.payload).length : 0,
      timestamp: receiveTime,
    });

    // Handle heartbeat silently — separate from general rate limit
    if (message.type === '__heartbeat__' as WebviewMessageType) {
      await this.sendToWebview({
        type: '__heartbeat__' as WebviewResponseType,
        success: true,
        payload: {
          alive: true,
          uptime: process.uptime(),
          memUsage: process.memoryUsage().heapUsed,
        },
      });
      return;
    }

    // Sliding-window rate limiting (general)
    const generalCheck = this.rateLimiter.check('__general__');
    if (!generalCheck.allowed) {
      this.logger.warn(MODULE, 'General rate limit exceeded', {
        retryAfterMs: generalCheck.retryAfterMs,
      });
      await this.sendErrorResponse(
        'RATE_LIMIT',
        'Too many requests — please slow down',
        message.requestId,
        generalCheck.retryAfterMs,
        generalCheck.cooldownMs
      );
      return;
    }

    // Validate message type
    if (!VALID_MESSAGE_TYPES.includes(message.type)) {
      this.logger.warn(MODULE, `Unknown message type: ${message.type}`);
      await this.sendErrorResponse(
        'UNKNOWN_TYPE',
        `Unknown message type: ${message.type}`,
        message.requestId
      );
      return;
    }

    // Per-type rate limiting (e.g., deploy debounce)
    const typeCheck = this.rateLimiter.check(message.type);
    if (!typeCheck.allowed) {
      this.logger.warn(MODULE, `Type rate limit for ${message.type}`, {
        retryAfterMs: typeCheck.retryAfterMs,
      });
      await this.sendErrorResponse(
        'RATE_LIMIT',
        message.type === 'deploy'
          ? 'Please wait before deploying again'
          : 'Too many requests — please slow down',
        message.requestId,
        typeCheck.retryAfterMs,
        typeCheck.cooldownMs
      );
      return;
    }

    // Validate payload
    const validationError = this.validatePayload(message);
    if (validationError) {
      this.logger.warn(MODULE, `Payload validation failed for ${message.type}: ${validationError}`);
      await this.sendErrorResponse(
        'INVALID_PAYLOAD',
        validationError,
        message.requestId
      );
      return;
    }

    // Dispatch to handler
    const handler = this.handlers.get(message.type);
    if (!handler) {
      this.logger.warn(MODULE, `No handler registered for: ${message.type}`);
      await this.sendErrorResponse(
        'NO_HANDLER',
        `No handler for: ${message.type}`,
        message.requestId
      );
      return;
    }

    try {
      await handler(message.payload, message.requestId);
      this.logger.debug(MODULE, `Handler completed: ${message.type}`, {
        durationMs: Date.now() - receiveTime,
      });
    } catch (err) {
      this.logger.error(MODULE, `Handler error for ${message.type}`, err);
      await this.sendErrorResponse(
        'HANDLER_ERROR',
        'Internal error',
        message.requestId
      );
    }
  }

  private async sendErrorResponse(
    code: string,
    message: string,
    requestId?: string,
    retryAfterMs?: number,
    cooldownMs?: number,
  ): Promise<void> {
    await this.sendToWebview({
      type: 'error',
      success: false,
      error: message,
      payload: {
        code,
        message,
        ...(retryAfterMs !== undefined && { retryAfter: retryAfterMs }),
        ...(cooldownMs !== undefined && { cooldownMs }),
      },
      requestId,
    });
  }

  private isValidMessage(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') {
      return false;
    }
    const msg = raw as Record<string, unknown>;
    return typeof msg.type === 'string';
  }

  /** Returns null if valid, or an error message string if invalid. */
  private validatePayload(message: IWebviewMessage): string | null {
    switch (message.type) {
      case 'updateHook': {
        const payload = message.payload as IUpdateHookPayload | undefined;
        if (!payload || typeof payload !== 'object') {
          return 'Missing payload for updateHook';
        }
        if (typeof payload.hookName !== 'string') {
          return 'hookName must be a string';
        }
        if (payload.hookName.length > HOOK_NAME_MAX_LENGTH) {
          return `hookName exceeds maximum length of ${HOOK_NAME_MAX_LENGTH}`;
        }
        if (!VALID_HOOK_NAMES.includes(payload.hookName)) {
          return `Unknown hook: '${payload.hookName}'. Valid: ${VALID_HOOK_NAMES.join(', ')}`;
        }
        if (typeof payload.enabled !== 'boolean') {
          return 'enabled must be a boolean';
        }
        return null;
      }

      case 'updateAllHooks': {
        const payload = message.payload as IHookConfig | undefined;
        if (!payload || typeof payload !== 'object') {
          return 'Missing payload for updateAllHooks';
        }
        for (const key of VALID_HOOK_NAMES) {
          if (typeof (payload as Record<string, unknown>)[key] !== 'boolean') {
            return `Hook '${key}' must be a boolean`;
          }
        }
        return null;
      }

      case 'toggleAgent': {
        const payload = message.payload as { enabled?: boolean } | undefined;
        if (!payload || typeof payload !== 'object') {
          return 'Missing payload for toggleAgent';
        }
        if (typeof payload.enabled !== 'boolean') {
          return 'enabled must be a boolean';
        }
        return null;
      }

      case 'getConfig':
      case 'deploy':
      case 'cancelDeploy':
      case 'getStatus':
      case 'getHistory':
      case 'resetConfig':
      case 'openLog':
      case 'pushUiSettings':
      case 'getLogData':
        return null;

      default:
        return 'Unknown message type';
    }
  }

}
