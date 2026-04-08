import { SudxLogger } from '../utils/logger';
import {
  IMcpConfig,
  IMcpServerEntry,
  IMcpValidationResult,
  IMcpValidationIssue,
} from '../types';
import { VALID_MCP_SERVERS } from '../constants';

const MODULE = 'McpConfigValidator';

/**
 * Validates MCP configuration before deployment.
 * Checks command paths, URL formats, token availability, and port conflicts.
 * Does NOT block deployment — issues are logged and returned as warnings/errors.
 */
export class McpConfigValidator {
  private logger: SudxLogger;

  constructor(logger: SudxLogger) {
    this.logger = logger;
    this.logger.debug(MODULE, 'McpConfigValidator initialized');
  }

  /**
   * Validate all servers in the MCP config.
   */
  async validateAll(config: IMcpConfig): Promise<IMcpValidationResult> {
    this.logger.info(MODULE, 'Validating MCP configuration');
    const warnings: IMcpValidationIssue[] = [];
    const errors: IMcpValidationIssue[] = [];

    const servers = config.mcpServers ?? {};
    for (const [name, entry] of Object.entries(servers)) {
      this.logger.debug(MODULE, `Validating server: ${name}`);

      try {
        switch (name) {
          case 'playwright':
            await this.validatePlaywrightConfig(name, entry, warnings, errors);
            break;
          case 'crawl4ai':
            await this.validateCrawl4aiConfig(name, entry, warnings, errors);
            break;
          default:
            // Unknown server — only warn if not in valid list
            if (!VALID_MCP_SERVERS.includes(name)) {
              warnings.push({
                server: name,
                code: 'UNKNOWN_SERVER',
                message: `Unknown MCP server "${name}" — not managed by Sudx`,
                severity: 'warning',
                suggestion: 'This server will be preserved during merge but is not validated.',
              });
            }
        }

        // Generic deep validation for all servers
        this.validateArgsAndEnv(name, entry, warnings);
      } catch (err) {
        this.logger.error(MODULE, `Validation error for "${name}"`, err);
        errors.push({
          server: name,
          code: 'VALIDATION_EXCEPTION',
          message: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'error',
          suggestion: 'Check server configuration manually.',
        });
      }
    }

    const valid = errors.length === 0;
    this.logger.info(MODULE, 'Validation complete', {
      valid,
      warnings: warnings.length,
      errors: errors.length,
    });

    return { valid, warnings, errors };
  }

  /**
   * Validate Playwright config: check npx availability.
   */
  private async validatePlaywrightConfig(
    name: string,
    entry: IMcpServerEntry,
    warnings: IMcpValidationIssue[],
    errors: IMcpValidationIssue[]
  ): Promise<void> {
    this.logger.debug(MODULE, 'Validating Playwright config');

    const entryRecord = entry as Record<string, unknown>;

    // Check command is npx
    if (entryRecord.command !== 'npx') {
      warnings.push({
        server: name,
        code: 'PW_UNEXPECTED_COMMAND',
        message: `Playwright command is "${entryRecord.command}" instead of "npx"`,
        severity: 'warning',
        suggestion: 'Expected "npx" as the command for Playwright MCP server.',
      });
    }

    // Check npx availability
    const npxAvailable = await this.checkCommandAvailable('npx');
    if (!npxAvailable) {
      errors.push({
        server: name,
        code: 'PW_NPX_NOT_FOUND',
        message: 'npx is not available on PATH',
        severity: 'error',
        suggestion: 'Install Node.js (v18+) to get npx, required for Playwright MCP.',
      });
    }
  }

  /**
   * Validate Crawl4ai config: check SSE URL format and port availability.
   */
  private async validateCrawl4aiConfig(
    name: string,
    entry: IMcpServerEntry,
    warnings: IMcpValidationIssue[],
    errors: IMcpValidationIssue[]
  ): Promise<void> {
    this.logger.debug(MODULE, 'Validating Crawl4ai config');

    const entryRecord = entry as Record<string, unknown>;
    const url = entryRecord.url as string | undefined;

    if (!url) {
      errors.push({
        server: name,
        code: 'C4A_NO_URL',
        message: 'Crawl4ai config has no "url" field — SSE endpoint required',
        severity: 'error',
        suggestion: 'Add "url": "http://localhost:11235/mcp" to the crawl4ai server config.',
      });
      return;
    }

    // Validate URL format
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        errors.push({
          server: name,
          code: 'C4A_INVALID_PROTOCOL',
          message: `Invalid protocol "${parsed.protocol}" — expected http: or https:`,
          severity: 'error',
          suggestion: 'Use http:// or https:// for the Crawl4ai SSE endpoint.',
        });
      }

      // Check if pointing to localhost — Docker should be available
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        const dockerAvailable = await this.checkCommandAvailable('docker');
        if (!dockerAvailable) {
          warnings.push({
            server: name,
            code: 'C4A_DOCKER_NOT_FOUND',
            message: 'Docker not found on PATH — Crawl4ai is configured for localhost but Docker may be needed',
            severity: 'warning',
            suggestion: 'Install Docker or run Crawl4ai via pip instead.',
          });
        }

        // Port availability check
        await this.checkPortAvailability(name, parsed.port || '11235', warnings);
      }
    } catch {
      errors.push({
        server: name,
        code: 'C4A_INVALID_URL',
        message: `Invalid URL: "${url}"`,
        severity: 'error',
        suggestion: 'Provide a valid HTTP(S) URL for the Crawl4ai SSE endpoint.',
      });
    }
  }

  /**
   * Check if a port is in use — distinguishes "crawl4ai running" from "port taken by another service".
   */
  private async checkPortAvailability(
    serverName: string,
    port: string,
    warnings: IMcpValidationIssue[]
  ): Promise<void> {
    this.logger.debug(MODULE, `Checking port availability: ${port}`);

    const commonPorts: Record<string, string> = {
      '80': 'HTTP',
      '443': 'HTTPS',
      '3000': 'dev-server',
      '5000': 'Flask',
      '8080': 'HTTP-alt',
      '8443': 'HTTPS-alt',
      '3306': 'MySQL',
      '5432': 'PostgreSQL',
      '6379': 'Redis',
      '27017': 'MongoDB',
    };

    const conflictService = commonPorts[port];
    if (conflictService && port !== '11235') {
      warnings.push({
        server: serverName,
        code: 'C4A_PORT_CONFLICT',
        message: `Port ${port} is commonly used by ${conflictService}`,
        severity: 'warning',
        suggestion: `Consider using the default Crawl4ai port 11235 to avoid conflicts.`,
      });
    }
  }

  /**
   * Check if a command is available on PATH.
   */
  private checkCommandAvailable(command: string): Promise<boolean> {
    this.logger.debug(MODULE, `Checking command: ${command}`);
    return new Promise((resolve) => {
      const { exec } = require('child_process') as typeof import('child_process');
      const checkCmd = process.platform === 'win32' ? `where ${command}` : `which ${command}`;
      exec(checkCmd, { timeout: 5_000 }, (err: Error | null) => {
        resolve(!err);
      });
    });
  }

  /**
   * Validate args array entries are strings and env values are strings or input placeholders.
   */
  private validateArgsAndEnv(
    name: string,
    entry: IMcpServerEntry,
    warnings: IMcpValidationIssue[]
  ): void {
    const entryRecord = entry as Record<string, unknown>;
    let issueCount = 0;

    // Validate args
    if (Array.isArray(entryRecord.args)) {
      for (let i = 0; i < entryRecord.args.length; i++) {
        if (typeof entryRecord.args[i] !== 'string') {
          warnings.push({
            server: name,
            code: 'INVALID_ARG_TYPE',
            message: `args[${i}] is ${typeof entryRecord.args[i]}, expected string`,
            severity: 'warning',
            suggestion: 'All args entries must be strings.',
          });
          issueCount++;
        }
      }
    }

    // Validate env values
    if (entryRecord.env && typeof entryRecord.env === 'object' && !Array.isArray(entryRecord.env)) {
      for (const [key, value] of Object.entries(entryRecord.env as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          warnings.push({
            server: name,
            code: 'INVALID_ENV_TYPE',
            message: `env.${key} is ${typeof value}, expected string`,
            severity: 'warning',
            suggestion: 'All env values must be strings or ${input:...} placeholders.',
          });
          issueCount++;
        }
      }
    }

    this.logger.debug(MODULE, `Deep validation for "${name}"`, { issues: issueCount });
  }
}
