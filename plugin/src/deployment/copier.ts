import * as vscode from 'vscode';
import * as path from 'path';
import {
  ITemplateFile,
  ICopyResult,
  ICopyFileResult,
  ProgressCallback,
} from '../types';
import { SudxLogger } from '../utils/logger';
import { FileOperations } from '../utils/fileOps';
import { PathUtils } from '../utils/paths';
import { BACKUP_DIR_NAME } from '../constants';

const MODULE = 'Copier';

export class FileCopier {
  private logger: SudxLogger;
  private fileOps: FileOperations;
  private paths: PathUtils;

  constructor(logger: SudxLogger, fileOps: FileOperations, paths: PathUtils) {
    this.logger = logger;
    this.fileOps = fileOps;
    this.paths = paths;
  }

  async copyFiles(
    files: ITemplateFile[],
    targetRoot: string,
    onProgress?: ProgressCallback,
    cancellationToken?: vscode.CancellationToken
  ): Promise<ICopyResult> {
    this.logger.info(MODULE, `Starting batch copy: ${files.length} files`, { targetRoot });

    const result: ICopyResult = {
      success: true,
      copied: [],
      skipped: [],
      failed: [],
      backups: [],
    };

    // Ensure all directories first
    const dirs = this.computeDirectories(files, targetRoot);
    for (const dir of dirs) {
      const dirUri = vscode.Uri.file(dir);
      const dirResult = await this.fileOps.createDirectory(dirUri);
      if (!dirResult.success) {
        this.logger.error(MODULE, `Failed to create directory: ${dir}`);
        result.success = false;
        result.failed.push({
          file: dir,
          error: dirResult.error ?? 'Failed to create directory',
          recoverable: false,
        });
        return result;
      }
    }

    // Copy each file
    for (let i = 0; i < files.length; i++) {
      if (cancellationToken?.isCancellationRequested) {
        this.logger.info(MODULE, 'Copy cancelled by user');
        result.success = false;
        break;
      }

      const file = files[i];
      const targetPath = path.join(targetRoot, file.relativePath);

      if (onProgress) {
        onProgress(i + 1, files.length, file.relativePath);
      }

      const copyResult = await this.copySingleFile(file, targetPath, targetRoot);

      if (copyResult.success) {
        result.copied.push(file.relativePath);
        if (copyResult.backedUp) {
          result.backups.push(file.relativePath);
        }
      } else {
        result.failed.push({
          file: file.relativePath,
          error: copyResult.error ?? 'Unknown copy error',
          recoverable: true,
        });
      }
    }

    // Determine overall success
    const failRate = result.failed.length / files.length;
    if (failRate > 0.5) {
      this.logger.error(MODULE, 'More than 50% of files failed — deployment considered failed', {
        failed: result.failed.length,
        total: files.length,
      });
      result.success = false;
    } else if (result.failed.length > 0) {
      this.logger.warn(MODULE, `${result.failed.length} files failed during copy`, {
        failedFiles: result.failed.map((f) => f.file),
      });
    }

    this.logger.info(MODULE, 'Batch copy complete', {
      copied: result.copied.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
      backups: result.backups.length,
    });

    return result;
  }

  private async copySingleFile(
    file: ITemplateFile,
    targetPath: string,
    targetRoot: string
  ): Promise<ICopyFileResult> {
    this.logger.debug(MODULE, `Copying: ${file.relativePath}`, {
      source: file.absolutePath,
      target: targetPath,
    });

    const root = this.paths.getWorkspaceRoot();
    if (root && !this.paths.isInsideWorkspace(targetPath, root)) {
      this.logger.warn(MODULE, 'Copy blocked — target outside workspace', {
        file: file.relativePath,
      });
      return { success: false, backedUp: false, error: 'Target outside workspace' };
    }

    const sourceUri = vscode.Uri.file(file.absolutePath);
    const targetUri = vscode.Uri.file(targetPath);

    // Backup existing file if it exists
    let backedUp = false;
    const exists = await this.fileOps.fileExists(targetUri);
    if (exists) {
      const backupDir = path.join(targetRoot, BACKUP_DIR_NAME);
      const backupResult = await this.fileOps.backupFile(targetUri, backupDir);
      if (backupResult.success) {
        backedUp = true;
      } else {
        this.logger.warn(MODULE, `Backup failed for ${file.relativePath} — continuing anyway`);
      }
    }

    // Copy the file
    const copyResult = await this.fileOps.copyFile(sourceUri, targetUri, true);
    if (!copyResult.success) {
      return {
        success: false,
        backedUp,
        error: copyResult.error ?? 'Copy failed',
      };
    }

    // Verify the copy
    const targetExists = await this.fileOps.fileExists(targetUri);
    if (!targetExists) {
      this.logger.error(MODULE, 'Post-copy verification failed — file does not exist', {
        file: file.relativePath,
      });
      return { success: false, backedUp, error: 'Verification failed' };
    }

    const targetSize = await this.fileOps.getFileSize(targetUri);
    if (targetSize !== file.size) {
      this.logger.warn(MODULE, 'Post-copy size mismatch', {
        file: file.relativePath,
        expected: file.size,
        actual: targetSize,
      });
      // Size mismatch is a warning, not a failure (copy plugin may reformat)
    }

    this.logger.debug(MODULE, `File copied successfully: ${file.relativePath}`);
    return { success: true, backedUp };
  }

  private computeDirectories(files: ITemplateFile[], targetRoot: string): string[] {
    const dirs = new Set<string>();
    for (const file of files) {
      const targetPath = path.join(targetRoot, file.relativePath);
      const dir = path.dirname(targetPath);
      dirs.add(dir);
    }

    // Sort so parent directories are created first
    return Array.from(dirs).sort((a, b) => a.length - b.length);
  }
}
