import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SudxLogger } from './logger';
import {
  DEPLOY_PATH_BLOCKLIST,
  DEPLOY_PATH_MAX_LENGTH,
  DEPLOY_PATH_ALLOWED_CHARS,
  DEFAULT_DEPLOY_PATH,
} from '../constants';

const MODULE = 'Paths';

export class PathUtils {
  private logger: SudxLogger;

  constructor(logger: SudxLogger) {
    this.logger = logger;
  }

  getWorkspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.logger.warn(MODULE, 'No workspace folder open');
      return null;
    }
    const root = folders[0].uri.fsPath;
    this.logger.debug(MODULE, 'Workspace root resolved', { root });
    return root;
  }

  getDeployTarget(deployPath: string): string | null {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return null;
    }

    const sanitized = this.sanitizePath(deployPath);
    if (!sanitized) {
      this.logger.warn(MODULE, 'Deploy path failed sanitization, using default', { deployPath });
      return path.resolve(root, DEFAULT_DEPLOY_PATH);
    }

    const target = path.resolve(root, sanitized);

    if (!this.isInsideWorkspace(target, root)) {
      this.logger.warn(MODULE, 'Deploy target resolves outside workspace', {
        deployPath: sanitized,
      });
      return null;
    }

    this.logger.debug(MODULE, 'Deploy target resolved', { target });
    return target;
  }

  getTemplatePath(context: vscode.ExtensionContext): string {
    const templatePath = path.join(context.extensionPath, 'dist', 'templates');
    this.logger.debug(MODULE, 'Template path resolved', { templatePath });
    return templatePath;
  }

  getExtensionPath(context: vscode.ExtensionContext): string {
    return context.extensionPath;
  }

  /**
   * Check if a path is inside the workspace, resolving symlinks to prevent bypass.
   * Uses fs.realpathSync() to resolve symlinks for existing paths.
   */
  isInsideWorkspace(targetPath: string, workspaceRoot?: string): boolean {
    const root = workspaceRoot ?? this.getWorkspaceRoot();
    if (!root) {
      this.logger.warn(MODULE, 'Cannot check isInsideWorkspace — no workspace root');
      return false;
    }

    try {
      // Resolve symlinks for existing paths to prevent symlink-based path traversal
      let resolvedTarget: string;
      let resolvedRoot: string;

      try {
        // Try to resolve real paths (resolves symlinks)
        resolvedRoot = fs.realpathSync(root);
      } catch {
        // Workspace root should always exist, but fallback to path.resolve
        resolvedRoot = path.resolve(root);
        this.logger.debug(MODULE, 'Workspace root realpathSync failed, using path.resolve');
      }

      try {
        // Try to resolve target path (resolves symlinks if target exists)
        resolvedTarget = fs.realpathSync(targetPath);
        this.logger.debug(MODULE, 'Target path resolved via realpathSync', {
          original: targetPath,
          resolved: resolvedTarget,
        });
      } catch {
        // Target doesn't exist yet — resolve the parent directory if possible
        const parentDir = path.dirname(targetPath);
        try {
          const resolvedParent = fs.realpathSync(parentDir);
          const basename = path.basename(targetPath);
          resolvedTarget = path.join(resolvedParent, basename);
          this.logger.debug(MODULE, 'Target parent resolved via realpathSync', {
            original: targetPath,
            resolved: resolvedTarget,
          });
        } catch {
          // Parent also doesn't exist — fallback to path.resolve
          resolvedTarget = path.resolve(targetPath);
          this.logger.debug(MODULE, 'Target path resolved via path.resolve (no symlink check possible)');
        }
      }

      // Case-insensitive comparison for Windows compatibility
      const normalizedTarget = resolvedTarget.toLowerCase();
      const normalizedRoot = resolvedRoot.toLowerCase();

      const isInside =
        normalizedTarget === normalizedRoot ||
        normalizedTarget.startsWith(normalizedRoot + path.sep.toLowerCase());

      if (!isInside) {
        this.logger.warn(MODULE, 'Path traversal blocked — target outside workspace', {
          target: this.toRelativeSafe(targetPath, root),
          resolvedTarget,
          resolvedRoot,
        });
      }

      return isInside;
    } catch (err) {
      this.logger.error(MODULE, 'Error checking isInsideWorkspace', err);
      return false;
    }
  }

  sanitizePath(rawPath: string): string | null {
    if (!rawPath || typeof rawPath !== 'string') {
      this.logger.warn(MODULE, 'Empty or non-string path');
      return null;
    }

    if (rawPath.length > DEPLOY_PATH_MAX_LENGTH) {
      this.logger.warn(MODULE, 'Path exceeds max length', { length: rawPath.length });
      return null;
    }

    // Block null bytes
    if (rawPath.includes('\0')) {
      this.logger.warn(MODULE, 'Null byte detected in path');
      return null;
    }

    // Block control characters
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(rawPath)) {
      this.logger.warn(MODULE, 'Control character detected in path');
      return null;
    }

    // Normalize separators
    let normalized = rawPath.replace(/\\/g, '/');

    // Remove leading ./
    if (normalized.startsWith('./')) {
      normalized = normalized.substring(2);
    }

    // Block parent directory traversal
    if (normalized.includes('..')) {
      this.logger.warn(MODULE, 'Path traversal sequence (..) detected');
      return null;
    }

    // Block absolute paths
    if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
      this.logger.warn(MODULE, 'Absolute path rejected');
      return null;
    }

    // Remove duplicate slashes
    normalized = normalized.replace(/\/+/g, '/');

    // Remove trailing slash
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    // Check allowed characters
    if (!DEPLOY_PATH_ALLOWED_CHARS.test(normalized)) {
      this.logger.warn(MODULE, 'Path contains disallowed characters', { path: normalized });
      return null;
    }

    if (normalized.length === 0) {
      this.logger.warn(MODULE, 'Path is empty after sanitization');
      return null;
    }

    this.logger.debug(MODULE, 'Path sanitized', { raw: rawPath, sanitized: normalized });
    return normalized;
  }

  isBlockedDeployTarget(deployPath: string): boolean {
    const normalized = deployPath.toLowerCase().replace(/\\/g, '/');
    const firstSegment = normalized.split('/')[0];

    const blocked = DEPLOY_PATH_BLOCKLIST.some(
      (blocked) => firstSegment === blocked.toLowerCase()
    );

    if (blocked) {
      this.logger.warn(MODULE, 'Deploy target is on blocklist', { deployPath });
    }

    return blocked;
  }

  toRelativePath(absolutePath: string, workspaceRoot?: string): string {
    const root = workspaceRoot ?? this.getWorkspaceRoot();
    if (!root) {
      return absolutePath;
    }
    return path.relative(root, absolutePath).replace(/\\/g, '/');
  }

  toAbsolutePath(relativePath: string, workspaceRoot?: string): string | null {
    const root = workspaceRoot ?? this.getWorkspaceRoot();
    if (!root) {
      return null;
    }

    const sanitized = this.sanitizePath(relativePath);
    if (!sanitized) {
      return null;
    }

    const absolute = path.resolve(root, sanitized);

    if (!this.isInsideWorkspace(absolute, root)) {
      return null;
    }

    return absolute;
  }

  normalizePath(inputPath: string): string {
    return path.resolve(inputPath).replace(/\\/g, '/');
  }

  async pathExists(fsPath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
      return true;
    } catch {
      return false;
    }
  }

  async ensureDirectory(dirPath: string): Promise<boolean> {
    try {
      const uri = vscode.Uri.file(dirPath);
      await vscode.workspace.fs.createDirectory(uri);
      this.logger.debug(MODULE, 'Directory ensured', { dirPath });
      return true;
    } catch (err) {
      this.logger.error(MODULE, 'Failed to ensure directory', err, { dirPath });
      return false;
    }
  }

  private toRelativeSafe(targetPath: string, root: string): string {
    try {
      return path.relative(root, targetPath);
    } catch {
      return '<unresolvable>';
    }
  }
}
