import * as vscode from 'vscode';
import * as fs from 'fs';
import { SudxLogger } from './logger';
import { PathUtils } from './paths';
import { IFileOpResult } from '../types';
import {
  MAX_FILE_SIZE,
  FILE_OP_RETRY_COUNT,
  FILE_OP_RETRY_DELAY_MS,
  MAX_BACKUPS_PER_FILE,
} from '../constants';

const MODULE = 'FileOps';

/** Maximum recursion depth for directory traversal to prevent stack overflow */
const MAX_RECURSION_DEPTH = 20;

export class FileOperations {
  private logger: SudxLogger;
  private paths: PathUtils;

  constructor(logger: SudxLogger, paths: PathUtils) {
    this.logger = logger;
    this.paths = paths;
  }

  async readFile(uri: vscode.Uri): Promise<IFileOpResult<string>> {
    this.logger.debug(MODULE, 'Reading file', { path: uri.fsPath });
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(data).toString('utf-8');
      this.logger.debug(MODULE, 'File read successfully', {
        path: uri.fsPath,
        size: data.byteLength,
      });
      return { success: true, data: content };
    } catch (err) {
      this.logger.error(MODULE, 'Failed to read file', err, { path: uri.fsPath });
      return { success: false, error: `Failed to read file: ${this.safeErrorMsg(err)}` };
    }
  }

  async writeFile(uri: vscode.Uri, content: string): Promise<IFileOpResult> {
    this.logger.debug(MODULE, 'Writing file', { path: uri.fsPath, size: content.length });

    const root = this.paths.getWorkspaceRoot();
    if (root && !this.paths.isInsideWorkspace(uri.fsPath, root)) {
      this.logger.warn(MODULE, 'Write blocked — path outside workspace');
      return { success: false, error: 'Path outside workspace' };
    }

    try {
      const encoded = Buffer.from(content, 'utf-8');
      if (encoded.byteLength > MAX_FILE_SIZE) {
        this.logger.warn(MODULE, 'File exceeds size limit', {
          size: encoded.byteLength,
          limit: MAX_FILE_SIZE,
        });
        return { success: false, error: 'File exceeds size limit' };
      }

      await vscode.workspace.fs.writeFile(uri, encoded);
      this.logger.debug(MODULE, 'File written successfully', { path: uri.fsPath });
      return { success: true };
    } catch (err) {
      this.logger.error(MODULE, 'Failed to write file', err, { path: uri.fsPath });
      return { success: false, error: `Failed to write: ${this.safeErrorMsg(err)}` };
    }
  }

  async copyFile(
    source: vscode.Uri,
    target: vscode.Uri,
    overwrite: boolean = true
  ): Promise<IFileOpResult> {
    this.logger.debug(MODULE, 'Copying file', {
      source: source.fsPath,
      target: target.fsPath,
    });

    const root = this.paths.getWorkspaceRoot();
    if (root && !this.paths.isInsideWorkspace(target.fsPath, root)) {
      this.logger.warn(MODULE, 'Copy blocked — target outside workspace');
      return { success: false, error: 'Target path outside workspace' };
    }

    return this.retryOperation(async () => {
      await vscode.workspace.fs.copy(source, target, { overwrite });
      this.logger.debug(MODULE, 'File copied successfully', { target: target.fsPath });
      return { success: true };
    }, `copy ${source.fsPath}`);
  }

  async deleteFile(uri: vscode.Uri): Promise<IFileOpResult> {
    this.logger.debug(MODULE, 'Deleting file', { path: uri.fsPath });
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: false });
      this.logger.debug(MODULE, 'File deleted', { path: uri.fsPath });
      return { success: true };
    } catch (err) {
      this.logger.error(MODULE, 'Failed to delete file', err, { path: uri.fsPath });
      return { success: false, error: `Failed to delete: ${this.safeErrorMsg(err)}` };
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<IFileOpResult> {
    this.logger.debug(MODULE, 'Creating directory', { path: uri.fsPath });
    try {
      await vscode.workspace.fs.createDirectory(uri);
      this.logger.debug(MODULE, 'Directory created', { path: uri.fsPath });
      return { success: true };
    } catch (err) {
      this.logger.error(MODULE, 'Failed to create directory', err, { path: uri.fsPath });
      return { success: false, error: `Failed to create directory: ${this.safeErrorMsg(err)}` };
    }
  }

  async fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.type === vscode.FileType.File;
    } catch {
      return false;
    }
  }

  async directoryExists(uri: vscode.Uri): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.type === vscode.FileType.Directory;
    } catch {
      return false;
    }
  }

  async readDirectory(
    uri: vscode.Uri
  ): Promise<IFileOpResult<[string, vscode.FileType][]>> {
    this.logger.debug(MODULE, 'Reading directory', { path: uri.fsPath });
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      this.logger.debug(MODULE, 'Directory read', {
        path: uri.fsPath,
        count: entries.length,
      });
      return { success: true, data: entries };
    } catch (err) {
      this.logger.error(MODULE, 'Failed to read directory', err, { path: uri.fsPath });
      return { success: false, error: `Failed to read directory: ${this.safeErrorMsg(err)}` };
    }
  }

  async listFilesRecursive(dirUri: vscode.Uri): Promise<IFileOpResult<vscode.Uri[]>> {
    this.logger.debug(MODULE, 'Listing files recursively', { path: dirUri.fsPath });
    try {
      const files: vscode.Uri[] = [];
      const visitedPaths = new Set<string>(); // Track visited real paths to detect symlink loops
      await this.walkDirectory(dirUri, files, visitedPaths, 0);
      this.logger.debug(MODULE, 'Recursive listing complete', {
        path: dirUri.fsPath,
        count: files.length,
      });
      return { success: true, data: files };
    } catch (err) {
      this.logger.error(MODULE, 'Failed to list files recursively', err);
      return { success: false, error: `Failed to list files: ${this.safeErrorMsg(err)}` };
    }
  }

  async backupFile(fileUri: vscode.Uri, backupBaseDir: string): Promise<IFileOpResult<string>> {
    this.logger.debug(MODULE, 'Creating backup', { file: fileUri.fsPath });

    try {
      const exists = await this.fileExists(fileUri);
      if (!exists) {
        this.logger.debug(MODULE, 'No backup needed — file does not exist');
        return { success: true, data: '' };
      }

      const backupDir = vscode.Uri.file(backupBaseDir);
      await this.createDirectory(backupDir);

      const fileName = fileUri.fsPath.split(/[\\/]/).pop() ?? 'unknown';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupName = `${fileName}.${timestamp}.bak`;
      const backupUri = vscode.Uri.joinPath(backupDir, backupName);

      await vscode.workspace.fs.copy(fileUri, backupUri, { overwrite: false });

      this.logger.info(MODULE, 'Backup created', { backup: backupUri.fsPath });

      await this.cleanOldBackups(backupDir, fileName);

      return { success: true, data: backupUri.fsPath };
    } catch (err) {
      this.logger.error(MODULE, 'Backup failed', err);
      return { success: false, error: `Backup failed: ${this.safeErrorMsg(err)}` };
    }
  }

  async getFileSize(uri: vscode.Uri): Promise<number> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.size;
    } catch {
      return 0;
    }
  }

  /**
   * Recursively walk a directory, collecting file URIs.
   * Includes symlink loop detection and depth limit to prevent stack overflow.
   */
  private async walkDirectory(
    dirUri: vscode.Uri,
    results: vscode.Uri[],
    visitedPaths: Set<string>,
    depth: number
  ): Promise<void> {
    // Guard against excessive recursion depth
    if (depth > MAX_RECURSION_DEPTH) {
      this.logger.warn(MODULE, 'Max recursion depth reached, skipping deeper traversal', {
        path: dirUri.fsPath,
        depth,
      });
      return;
    }

    // Resolve real path to detect symlink loops
    let realPath: string;
    try {
      realPath = fs.realpathSync(dirUri.fsPath);
    } catch {
      // Directory might not exist or be inaccessible — skip
      this.logger.debug(MODULE, 'Cannot resolve real path, skipping', { path: dirUri.fsPath });
      return;
    }

    // Check for symlink loop (already visited this real path)
    if (visitedPaths.has(realPath)) {
      this.logger.warn(MODULE, 'Symlink loop detected, skipping', {
        path: dirUri.fsPath,
        realPath,
      });
      return;
    }

    // Mark as visited
    visitedPaths.add(realPath);

    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    for (const [name, type] of entries) {
      const childUri = vscode.Uri.joinPath(dirUri, name);

      if (type === vscode.FileType.Directory || type === vscode.FileType.SymbolicLink) {
        // For symlinks pointing to directories, recurse but check for loops
        try {
          const childStat = await vscode.workspace.fs.stat(childUri);
          if (childStat.type === vscode.FileType.Directory) {
            await this.walkDirectory(childUri, results, visitedPaths, depth + 1);
          }
        } catch {
          // Broken symlink or inaccessible — skip silently
          this.logger.debug(MODULE, 'Skipping inaccessible entry', { path: childUri.fsPath });
        }
      } else if (type === vscode.FileType.File) {
        results.push(childUri);
      }
    }
  }

  private async cleanOldBackups(backupDir: vscode.Uri, originalName: string): Promise<void> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(backupDir);
      const backups = entries
        .filter(
          ([name, type]) =>
            type === vscode.FileType.File && name.startsWith(originalName + '.')
        )
        .map(([name]) => name)
        .sort()
        .reverse();

      if (backups.length > MAX_BACKUPS_PER_FILE) {
        const toDelete = backups.slice(MAX_BACKUPS_PER_FILE);
        for (const name of toDelete) {
          const uri = vscode.Uri.joinPath(backupDir, name);
          await vscode.workspace.fs.delete(uri);
          this.logger.debug(MODULE, 'Old backup removed', { name });
        }
      }
    } catch (err) {
      this.logger.warn(MODULE, 'Failed to clean old backups', { error: this.safeErrorMsg(err) });
    }
  }

  private async retryOperation(
    operation: () => Promise<IFileOpResult>,
    label: string
  ): Promise<IFileOpResult> {
    const MAX_RETRY_DELAY_MS = 30_000; // Cap at 30 seconds to prevent overflow
    let lastError = '';
    for (let attempt = 1; attempt <= FILE_OP_RETRY_COUNT; attempt++) {
      try {
        const result = await operation();
        if (result.success) {
          return result;
        }
        lastError = result.error ?? 'Unknown error';
      } catch (err) {
        lastError = this.safeErrorMsg(err);
      }

      if (attempt < FILE_OP_RETRY_COUNT) {
        // Exponential backoff with cap to prevent overflow
        const delay = Math.min(
          FILE_OP_RETRY_DELAY_MS * Math.pow(2, attempt - 1),
          MAX_RETRY_DELAY_MS
        );
        this.logger.debug(MODULE, `Retry ${attempt}/${FILE_OP_RETRY_COUNT} for ${label} in ${delay}ms`);
        await this.sleep(delay);
      }
    }

    this.logger.error(MODULE, `All retries exhausted for ${label}`);
    return { success: false, error: lastError };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private safeErrorMsg(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}
