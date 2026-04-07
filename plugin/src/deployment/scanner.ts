import * as vscode from 'vscode';
import * as path from 'path';
import { ITemplateFile, TemplateCategory } from '../types';
import { SudxLogger } from '../utils/logger';
import { FileOperations } from '../utils/fileOps';
import { PathUtils } from '../utils/paths';
import { FILE_PATTERNS_EXCLUDE, TEMPLATE_DIRS, MAX_FILE_SIZE } from '../constants';

const MODULE = 'Scanner';

export class TemplateScanner {
  private logger: SudxLogger;
  private fileOps: FileOperations;
  private paths: PathUtils;
  private cache: ITemplateFile[] | null = null;

  constructor(logger: SudxLogger, fileOps: FileOperations, paths: PathUtils) {
    this.logger = logger;
    this.fileOps = fileOps;
    this.paths = paths;
  }

  async scan(context: vscode.ExtensionContext): Promise<ITemplateFile[]> {
    if (this.cache) {
      this.logger.debug(MODULE, 'Returning cached scan result', { count: this.cache.length });
      return this.cache;
    }

    this.logger.info(MODULE, 'Starting template scan');
    const templateRoot = this.paths.getTemplatePath(context);
    const templateRootUri = vscode.Uri.file(templateRoot);

    const exists = await this.fileOps.directoryExists(templateRootUri);
    if (!exists) {
      this.logger.error(MODULE, 'Template directory not found', undefined, { templateRoot });
      return [];
    }

    const files: ITemplateFile[] = [];

    for (const dir of TEMPLATE_DIRS) {
      const dirUri = vscode.Uri.joinPath(templateRootUri, dir);
      const dirExists = await this.fileOps.directoryExists(dirUri);
      if (!dirExists) {
        this.logger.warn(MODULE, `Template category directory missing: ${dir}`);
        continue;
      }

      const category = this.resolveCategory(dir);
      if (!category) {
        this.logger.warn(MODULE, `Unknown template category: ${dir}`);
        continue;
      }

      const result = await this.fileOps.listFilesRecursive(dirUri);
      if (!result.success || !result.data) {
        this.logger.error(MODULE, `Failed to scan category: ${dir}`);
        continue;
      }

      for (const fileUri of result.data) {
        const fileName = path.basename(fileUri.fsPath);

        if (this.isExcluded(fileName)) {
          this.logger.debug(MODULE, `Excluded file: ${fileName}`);
          continue;
        }

        const size = await this.fileOps.getFileSize(fileUri);
        if (size === 0) {
          this.logger.warn(MODULE, `Empty template file skipped: ${fileUri.fsPath}`);
          continue;
        }

        if (size > MAX_FILE_SIZE) {
          this.logger.warn(MODULE, `Template file exceeds size limit: ${fileUri.fsPath}`, {
            size,
            limit: MAX_FILE_SIZE,
          });
          continue;
        }

        const relativePath = path.relative(templateRoot, fileUri.fsPath).replace(/\\/g, '/');

        files.push({
          relativePath,
          absolutePath: fileUri.fsPath,
          category,
          size,
        });
      }
    }

    this.cache = files;
    this.logger.info(MODULE, `Scan complete: ${files.length} files found`, {
      agents: files.filter((f) => f.category === TemplateCategory.Agents).length,
      instructions: files.filter((f) => f.category === TemplateCategory.Instructions).length,
      prompts: files.filter((f) => f.category === TemplateCategory.Prompts).length,
      skills: files.filter((f) => f.category === TemplateCategory.Skills).length,
      hooks: files.filter((f) => f.category === TemplateCategory.Hooks).length,
    });

    return files;
  }

  async scanCategory(
    context: vscode.ExtensionContext,
    category: TemplateCategory
  ): Promise<ITemplateFile[]> {
    const all = await this.scan(context);
    return all.filter((f) => f.category === category);
  }

  async getHookFiles(context: vscode.ExtensionContext): Promise<ITemplateFile[]> {
    return this.scanCategory(context, TemplateCategory.Hooks);
  }

  async getNonHookFiles(context: vscode.ExtensionContext): Promise<ITemplateFile[]> {
    const all = await this.scan(context);
    return all.filter((f) => f.category !== TemplateCategory.Hooks);
  }

  invalidateCache(): void {
    this.cache = null;
    this.logger.debug(MODULE, 'Scan cache invalidated');
  }

  private resolveCategory(dirName: string): TemplateCategory | null {
    const map: Record<string, TemplateCategory> = {
      agents: TemplateCategory.Agents,
      instructions: TemplateCategory.Instructions,
      prompts: TemplateCategory.Prompts,
      skills: TemplateCategory.Skills,
      hooks: TemplateCategory.Hooks,
    };
    return map[dirName] ?? null;
  }

  private isExcluded(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    return FILE_PATTERNS_EXCLUDE.some((pattern) => lower === pattern.toLowerCase());
  }
}
