import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Tokenizer, ModelFamily } from './tokenizer';

const IGNORE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.mp4', '.mp3', '.wav', '.pdf', '.zip', '.tar', '.gz',
  '.lock', '.log', '.map',
]);

const MAX_CONTENT_READ_BYTES = 200_000;

// Matches <attachment filePath="..."> with tolerance for attribute ordering/whitespace
const ATTACHMENT_RE = /\battachment\b[^>]*\bfilePath\s*=\s*"([^"]+)"/g;

// Path heuristic: starts with '/', length 2–512
const PATH_TOKEN_RE = /(?:^|\s)(\/[^\s]{1,511})(?=\s|$)/g;

export interface ScanResult {
  relativePath: string;
  content: string;
  tokens: number;
  truncated: boolean;
}

export interface ConversationSignals {
  alreadyPresentPaths: Set<string>;
  candidates: Array<{ filePath: string; score: number }>;
  hasSufficientSignal: boolean;
}

interface CandidateAccum {
  lastMessageIndex: number;
  frequency: number;
  sourceWeight: number;
}

export class SmartContextScanner {
  private readonly logger: vscode.LogOutputChannel;
  private readonly tokenizer: Tokenizer;

  constructor(logger: vscode.LogOutputChannel, tokenizer: Tokenizer) {
    this.logger = logger;
    this.tokenizer = tokenizer;
  }

  extractSignals(messages: readonly vscode.LanguageModelChatRequestMessage[]): ConversationSignals {
    const alreadyPresentPaths = new Set<string>();
    // Map from filePath -> accumulator for scoring
    const accumMap = new Map<string, CandidateAccum>();
    const totalMessages = messages.length;

    const addCandidate = (filePath: string, messageIndex: number, weight: number): void => {
      if (alreadyPresentPaths.has(filePath)) return;
      const existing = accumMap.get(filePath);
      if (existing) {
        if (messageIndex > existing.lastMessageIndex) {
          existing.lastMessageIndex = messageIndex;
        }
        existing.frequency += 1;
        if (weight > existing.sourceWeight) {
          existing.sourceWeight = weight;
        }
      } else {
        accumMap.set(filePath, { lastMessageIndex: messageIndex, frequency: 1, sourceWeight: weight });
      }
    };

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (
        msg.role !== vscode.LanguageModelChatMessageRole.User &&
        msg.role !== vscode.LanguageModelChatMessageRole.Assistant
      ) {
        continue;
      }

      for (const part of msg.content) {
        // Extract attachment paths from text parts (adds to already-present set)
        if (part instanceof vscode.LanguageModelTextPart) {
          ATTACHMENT_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = ATTACHMENT_RE.exec(part.value)) !== null) {
            alreadyPresentPaths.add(m[1]);
          }
        }

        // Extract tool call input paths (assistant messages)
        if (part instanceof vscode.LanguageModelToolCallPart) {
          const input = part.input as Record<string, unknown>;
          for (const val of Object.values(input)) {
            if (typeof val === 'string' && val.startsWith('/') && val.length >= 2 && val.length <= 512) {
              addCandidate(val, i, 2);
            }
          }
        }

        // Extract tool result text paths (user messages)
        if (part instanceof vscode.LanguageModelToolResultPart) {
          for (const resultPart of part.content) {
            if (resultPart instanceof vscode.LanguageModelTextPart) {
              PATH_TOKEN_RE.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = PATH_TOKEN_RE.exec(resultPart.value)) !== null) {
                const tok = m[1];
                if (tok.length >= 2 && tok.length <= 512) {
                  addCandidate(tok, i, 1);
                }
              }
            }
          }
        }
      }
    }

    // Remove from accumMap any paths that ended up in alreadyPresentPaths
    for (const p of alreadyPresentPaths) {
      accumMap.delete(p);
    }

    // Score and sort candidates
    const candidates = Array.from(accumMap.entries()).map(([filePath, acc]) => {
      const recency = totalMessages > 0 ? acc.lastMessageIndex / totalMessages : 0;
      const score = recency * 10 + acc.frequency * 5 + acc.sourceWeight;
      return { filePath, score };
    });

    candidates.sort((a, b) => b.score - a.score);

    return {
      alreadyPresentPaths,
      candidates,
      hasSufficientSignal: candidates.length > 0,
    };
  }

  async scan(
    signals: ConversationSignals,
    alreadyInjectedPaths: Set<string>,
    tokenBudget: number,
    maxFilesToScan: number,
    maxResultFiles: number,
    modelId: string,
    family: ModelFamily
  ): Promise<ScanResult[]> {
    if (!signals.hasSufficientSignal) {
      return [];
    }

    const folders = vscode.workspace.workspaceFolders;
    const rootPath = folders?.[0]?.uri.fsPath ?? '';

    // Filter candidates: remove already-injected, ignored extensions
    const filtered = signals.candidates.filter(c => {
      const ext = path.extname(c.filePath).toLowerCase();
      if (IGNORE_EXTENSIONS.has(ext)) return false;
      const norm = c.filePath.replace(/\\/g, '/');
      if (alreadyInjectedPaths.has(norm) || alreadyInjectedPaths.has(c.filePath)) return false;
      return true;
    });

    // Cap to maxFilesToScan before any filesystem access
    const toScan = filtered.slice(0, maxFilesToScan);

    // Stat check + size filter
    const statPassed: Array<{ filePath: string }> = [];
    for (const c of toScan) {
      try {
        const stat = await fs.stat(c.filePath);
        if (stat.size > MAX_CONTENT_READ_BYTES) {
          this.logger.debug(`SmartContextScanner: ${c.filePath} too large, skipping`);
          continue;
        }
        statPassed.push({ filePath: c.filePath });
      } catch {
        this.logger.debug(`SmartContextScanner: Cannot stat ${c.filePath}, skipping`);
      }
    }

    // Take top maxResultFiles for injection
    const toInject = statPassed.slice(0, maxResultFiles);

    if (toInject.length === 0) {
      this.logger.debug('SmartContextScanner: No candidates survived filtering');
      return [];
    }

    const results: ScanResult[] = [];
    let budgetUsed = 0;

    for (const entry of toInject) {
      const remaining = tokenBudget - budgetUsed;
      if (remaining <= 0) break;

      const result = await this.readAndFit(entry.filePath, rootPath, remaining, modelId, family);
      if (result === null) continue;

      results.push(result);
      budgetUsed += result.tokens;
    }

    this.logger.info(
      `SmartContextScanner: Injected ${results.length} file(s), ~${budgetUsed} tokens`
    );

    return results;
  }

  private async readAndFit(
    filePath: string,
    rootPath: string,
    budget: number,
    modelId: string,
    family: ModelFamily
  ): Promise<ScanResult | null> {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      this.logger.debug(`SmartContextScanner: Cannot read ${filePath}: ${err}`);
      return null;
    }

    const tokens = this.tokenizer.estimateTokens(content, modelId, family);
    const relativePath = rootPath
      ? path.relative(rootPath, filePath).replace(/\\/g, '/')
      : path.basename(filePath);

    if (tokens <= budget) {
      return { relativePath, content, tokens, truncated: false };
    }

    // Attempt truncation at newline boundary
    const ratio = budget / tokens;
    const charLimit = Math.floor(content.length * ratio);
    const newlineIndex = content.lastIndexOf('\n', charLimit);

    if (newlineIndex <= 0) {
      this.logger.debug(`SmartContextScanner: Cannot safely truncate ${filePath}, skipping`);
      return null;
    }

    const truncated = content.slice(0, newlineIndex);
    const marker = `// [TRUNCATED: Only first ${budget} tokens shown to preserve context budget]`;
    return {
      relativePath,
      content: `${truncated}\n${marker}`,
      tokens: budget,
      truncated: true,
    };
  }
}
