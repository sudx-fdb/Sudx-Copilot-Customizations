import * as vscode from 'vscode';
import { SudxLogger } from '../utils/logger';
import { VALID_MCP_SERVERS } from '../constants';

const MODULE = 'McpTokenManager';

/** Secret storage key prefix for MCP tokens */
const SECRET_KEY_PREFIX = 'sudxAi.mcpToken.';

/** Minimum token length for Figma personal access tokens */
const FIGMA_TOKEN_MIN_LENGTH = 40;

/** Required prefix for Figma personal access tokens */
const FIGMA_TOKEN_PREFIX = 'figd_';

/** Allowed characters in Figma personal access tokens (after prefix) */
const FIGMA_TOKEN_PATTERN = /^figd_[a-zA-Z0-9_-]+$/;

/**
 * Manages secure storage of MCP server tokens using VS Code's SecretStorage API.
 * Tokens are encrypted at rest and never appear in plain-text configuration files.
 * Currently supports Figma personal access tokens; extensible for other servers.
 */
export class McpTokenManager implements vscode.Disposable {
  private logger: SudxLogger;
  private secrets: vscode.SecretStorage;
  private disposables: vscode.Disposable[] = [];

  constructor(logger: SudxLogger, secrets: vscode.SecretStorage) {
    this.logger = logger;
    this.secrets = secrets;
    this.logger.debug(MODULE, 'McpTokenManager initialized');
  }

  /**
   * Store a token for the given MCP server after validating its format.
   * @param serverName - The server name (must be in VALID_MCP_SERVERS)
   * @param token - The raw token string to validate and store
   * @returns Object with success flag and optional error message
   */
  async storeToken(serverName: string, token: string): Promise<{ success: boolean; error?: string }> {
    this.logger.debug(MODULE, 'storeToken called', { serverName, tokenLength: token?.length ?? 0 });

    if (!VALID_MCP_SERVERS.includes(serverName)) {
      this.logger.warn(MODULE, 'Unknown server name for token storage', { serverName });
      return { success: false, error: `Unknown MCP server: ${serverName}` };
    }

    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      this.logger.warn(MODULE, 'Empty or invalid token provided', { serverName });
      return { success: false, error: 'Token must be a non-empty string' };
    }

    // Server-specific validation
    const validationError = this.validateTokenFormat(serverName, token);
    if (validationError) {
      this.logger.warn(MODULE, 'Token format validation failed', { serverName, error: validationError });
      return { success: false, error: validationError };
    }

    try {
      const key = this.getSecretKey(serverName);
      await this.secrets.store(key, token);
      this.logger.info(MODULE, 'Token stored successfully', { serverName });
      return { success: true };
    } catch (err) {
      this.logger.error(MODULE, 'Failed to store token in SecretStorage', err);
      return { success: false, error: err instanceof Error ? err.message : 'Secret storage write failed' };
    }
  }

  /**
   * Retrieve a stored token for the given server.
   * @returns The token string or null if not set
   */
  async getToken(serverName: string): Promise<string | null> {
    this.logger.debug(MODULE, 'getToken called', { serverName });

    if (!VALID_MCP_SERVERS.includes(serverName)) {
      this.logger.warn(MODULE, 'Unknown server name for token retrieval', { serverName });
      return null;
    }

    try {
      const key = this.getSecretKey(serverName);
      const token = await this.secrets.get(key);
      this.logger.debug(MODULE, 'getToken result', { serverName, hasToken: !!token });
      return token ?? null;
    } catch (err) {
      this.logger.error(MODULE, 'Failed to retrieve token from SecretStorage', err);
      return null;
    }
  }

  /**
   * Delete a stored token for the given server.
   */
  async deleteToken(serverName: string): Promise<{ success: boolean; error?: string }> {
    this.logger.debug(MODULE, 'deleteToken called', { serverName });

    if (!VALID_MCP_SERVERS.includes(serverName)) {
      this.logger.warn(MODULE, 'Unknown server name for token deletion', { serverName });
      return { success: false, error: `Unknown MCP server: ${serverName}` };
    }

    try {
      const key = this.getSecretKey(serverName);
      await this.secrets.delete(key);
      this.logger.info(MODULE, 'Token deleted successfully', { serverName });
      return { success: true };
    } catch (err) {
      this.logger.error(MODULE, 'Failed to delete token from SecretStorage', err);
      return { success: false, error: err instanceof Error ? err.message : 'Secret storage delete failed' };
    }
  }

  /**
   * Check if a token is stored for the given server without retrieving its value.
   */
  async hasToken(serverName: string): Promise<boolean> {
    this.logger.debug(MODULE, 'hasToken called', { serverName });

    if (!VALID_MCP_SERVERS.includes(serverName)) {
      this.logger.debug(MODULE, 'hasToken — unknown server', { serverName });
      return false;
    }

    try {
      const key = this.getSecretKey(serverName);
      const token = await this.secrets.get(key);
      const has = typeof token === 'string' && token.length > 0;
      this.logger.debug(MODULE, 'hasToken result', { serverName, hasToken: has });
      return has;
    } catch (err) {
      this.logger.error(MODULE, 'Failed to check token existence in SecretStorage', err);
      return false;
    }
  }

  /**
   * Validate token format based on server-specific requirements.
   * @returns Error message if invalid, or null if valid
   */
  private validateTokenFormat(serverName: string, token: string): string | null {
    this.logger.debug(MODULE, 'validateTokenFormat', { serverName, tokenLength: token.length });

    if (serverName === 'figma') {
      if (!token.startsWith(FIGMA_TOKEN_PREFIX)) {
        return `Figma token must start with "${FIGMA_TOKEN_PREFIX}" prefix`;
      }
      if (token.length < FIGMA_TOKEN_MIN_LENGTH) {
        return `Figma token must be at least ${FIGMA_TOKEN_MIN_LENGTH} characters long (got ${token.length})`;
      }
      if (!FIGMA_TOKEN_PATTERN.test(token)) {
        return 'Figma token may only contain alphanumeric characters, hyphens, and underscores';
      }
    }

    // Other servers: no specific format validation (yet)
    return null;
  }

  /**
   * Build the secret storage key for a given server.
   */
  private getSecretKey(serverName: string): string {
    return `${SECRET_KEY_PREFIX}${serverName}`;
  }

  dispose(): void {
    this.logger.debug(MODULE, 'Disposing McpTokenManager');
    for (const d of this.disposables) {
      try { d.dispose(); } catch { /* best-effort cleanup */ }
    }
    this.disposables = [];
  }
}
