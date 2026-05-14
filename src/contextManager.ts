import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Tokenizer, ModelFamily } from './tokenizer';
import { SmartContextScanner, ScanResult } from './smartContextScanner';

const IGNORE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.mp4', '.mp3', '.wav', '.pdf', '.zip', '.tar', '.gz',
  '.lock', '.log', '.map',
]);

const MAX_ACTIVE_FILE_BYTES = 500_000;
const TRUNCATION_COMMENT = '// [TRUNCATED: Only first {tokens} tokens shown to preserve context budget]';

/**
 * ContextManager injects the active editor file into the system prompt context
 * when it is not already referenced in the conversation messages. When the
 * smart context scanner is enabled, it also injects workspace files that are
 * relevant to the conversation's content.
 */
export class ContextManager {
  private readonly logger: vscode.LogOutputChannel;
  private readonly tokenizer: Tokenizer;
  private readonly smartScanner: SmartContextScanner;

  constructor(logger: vscode.LogOutputChannel, tokenizer: Tokenizer) {
    this.logger = logger;
    this.tokenizer = tokenizer;
    this.smartScanner = new SmartContextScanner(logger, tokenizer);
  }

  /**
   * Build a context block from the active editor file and (if enabled) smart
   * workspace scan results. Returns an empty string when context injection is
   * disabled, no relevant content is found, or all files are already in messages.
   */
  public async buildContext(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    modelId = ''
  ): Promise<string> {
    const config = vscode.workspace.getConfiguration('lmStudioCopilot');
    if (!config.get<boolean>('enableContextPrioritization', true)) {
      this.logger.debug('Context Prioritization: Disabled');
      return '';
    }

    const budget = config.get<number>('contextTokenBudget', 20000);
    if (budget <= 0) {
      this.logger.debug('Context Prioritization: Token budget is 0, skipping');
      return '';
    }

    const family = this.tokenizer.detectFamily(modelId, undefined);
    const folders = vscode.workspace.workspaceFolders;
    const rootPath = folders?.[0]?.uri.fsPath;


    // --- Active editor injection (WI-95 baseline) ---
    let activeFilePath: string | undefined;
    let activeSection = '';
    let activeTokens = 0;
    let activeTruncated = false;

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
      const filePath = activeEditor.document.uri.fsPath;
      const ext = path.extname(filePath).toLowerCase();
      if (
        !IGNORE_EXTENSIONS.has(ext) &&
        !this.isAlreadyInMessages(filePath, messages)
      ) {
        const result = await this.readAndFitFile(filePath, budget, modelId, family);
        if (result !== null) {
          activeFilePath = filePath;
          activeTruncated = result.truncated;
          const relativePath = rootPath
            ? path.relative(rootPath, filePath)
            : path.basename(filePath);
          const truncatedSuffix = result.truncated ? ` (Truncated: ${path.basename(filePath)})` : '';
          activeSection = `### ${relativePath}\n\`\`\`\n${result.content}\n\`\`\``;
          activeTokens = result.tokens;

          this.logger.info(
            `Context Prioritization: Injected active file ${relativePath}, ~${activeTokens} tokens${truncatedSuffix}`
          );
        }
      }
    }

    // --- Smart context scanner (optional) ---
    let scannerSections: string[] = [];
    let scannerTokens = 0;

    const smartEnabled = config.get<boolean>('enableSmartContextScanner', false);
    if (smartEnabled) {
      const maxFilesToScan = config.get<number>('smartContextScanner.maxFilesToScan', 50);
      const maxResultFiles = config.get<number>('smartContextScanner.maxResultFiles', 5);
      const remainingBudget = budget - activeTokens;

      if (remainingBudget > 0) {
        const signals = this.smartScanner.extractSignals(messages);

        if (signals.hasSufficientSignal) {
          // Build set of paths to exclude from scanner results (active editor path)
          const alreadyInjected = new Set<string>();
          if (activeFilePath) {
            alreadyInjected.add(activeFilePath.replace(/\\/g, '/'));
            alreadyInjected.add(activeFilePath);
          }

          const scanResults = await this.smartScanner.scan(
            signals,
            alreadyInjected,
            remainingBudget,
            maxFilesToScan,
            maxResultFiles,
            modelId,
            family
          );

          for (const r of scanResults) {
            const truncSuffix = r.truncated ? ` (Truncated: ${path.basename(r.relativePath)})` : '';
            scannerSections.push(`### ${r.relativePath}\n\`\`\`\n${r.content}\n\`\`\``);
            scannerTokens += r.tokens;
            this.logger.debug(`SmartContextScanner: Included ${r.relativePath}${truncSuffix}`);
          }
        } else {
          this.logger.debug('SmartContextScanner: No sufficient signal in conversation, skipping scan');
        }
      } else {
        this.logger.debug('SmartContextScanner: No token budget remaining after active file, skipping');
      }
    }

    // --- Assemble final context block ---
    const allSections: string[] = [];
    if (activeSection) allSections.push(activeSection);
    allSections.push(...scannerSections);

    if (allSections.length === 0) {
      return '';
    }

    const totalTokens = activeTokens + scannerTokens;
    const fileCount = allSections.length;
    const fileWord = fileCount === 1 ? 'file' : 'files';
    const truncatedSuffix = activeTruncated ? ` (Truncated: ${path.basename(activeFilePath!)})` : '';

    return `[Workspace Context — ${fileCount} ${fileWord}, ~${totalTokens} tokens${truncatedSuffix}]\n\n${allSections.join('\n\n')}`;
  }

  /**
   * Returns true if the given file path (or its basename) appears anywhere in the
   * text content of the conversation messages.
   */
  private isAlreadyInMessages(
    activeFilePath: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[]
  ): boolean {
    const normalizedPath = activeFilePath.replace(/\\/g, '/');
    const basename = path.basename(activeFilePath);

    for (const msg of messages) {
      if (
        msg.role !== vscode.LanguageModelChatMessageRole.User &&
        msg.role !== vscode.LanguageModelChatMessageRole.Assistant
      ) {
        continue;
      }
      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          const text = part.value;
          if (text.includes(normalizedPath) || text.includes(activeFilePath) || text.includes(basename)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Read a file and fit it within the token budget. Returns null if the file
   * cannot be read, is too large, or has no safe truncation point.
   */
  private async readAndFitFile(
    filePath: string,
    budget: number,
    modelId: string,
    family: ModelFamily
  ): Promise<{ content: string; tokens: number; truncated: boolean } | null> {
    let stat: { size: number };
    try {
      stat = await fs.stat(filePath);
    } catch (err) {
      this.logger.warn(`Context Prioritization: Cannot stat active file ${filePath}: ${err}`);
      return null;
    }

    if (stat.size > MAX_ACTIVE_FILE_BYTES) {
      this.logger.debug(`Context Prioritization: Active file too large (${stat.size} bytes), skipping`);
      return null;
    }

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      this.logger.warn(`Context Prioritization: Cannot read active file ${filePath}: ${err}`);
      return null;
    }

    const tokens = this.tokenizer.estimateTokens(content, modelId, family);

    if (tokens <= budget) {
      return { content, tokens, truncated: false };
    }

    const truncated = this.truncateToTokens(content, budget, modelId, family);
    if (truncated === null) {
      this.logger.debug(`Context Prioritization: Cannot safely truncate ${filePath}, skipping`);
      return null;
    }

    return { content: truncated, tokens: budget, truncated: true };
  }

  /**
   * Truncate content to approximately targetTokens, cutting only at a newline
   * boundary. Returns null if no safe truncation point exists.
   */
  private truncateToTokens(
    content: string,
    targetTokens: number,
    modelId: string,
    family: ModelFamily
  ): string | null {
    const totalTokens = this.tokenizer.estimateTokens(content, modelId, family);
    if (totalTokens <= targetTokens) return content;

    const ratio = targetTokens / totalTokens;
    const charLimit = Math.floor(content.length * ratio);
    const newlineIndex = content.lastIndexOf('\n', charLimit);

    if (newlineIndex <= 0) return null;

    const head = content.slice(0, newlineIndex);
    const marker = TRUNCATION_COMMENT.replace('{tokens}', String(targetTokens));
    return `${head}\n${marker}`;
  }
}
