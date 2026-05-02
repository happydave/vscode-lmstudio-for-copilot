import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Tokenizer, ModelFamily } from './tokenizer';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.cache', 'coverage', '.turbo',
]);

const IGNORE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.mp4', '.mp3', '.wav', '.pdf', '.zip', '.tar', '.gz',
  '.lock', '.log', '.map',
]);

// Extensions that require suffix matching because path.extname won't catch them
const IGNORE_SUFFIXES = ['.min.js', '.min.css'];

const MAX_FILE_BYTES = 100_000;
const DIVERSITY_FLOOR_TOKENS = 2000;

// Conservative chars-per-token ratio used for fast (no-read) size estimation
const FAST_ESTIMATE_CHARS_PER_TOKEN = 3.5;

interface ScoredFile {
  fullPath: string;
  relativePath: string;
  score: number;
  size: number;
}

interface PackedFile {
  relativePath: string;
  content: string;
  tokens: number;
  truncated: boolean;
}

/**
 * ContextManager builds a ranked, token-budgeted snapshot of workspace files
 * to inject as context when chatting with LM Studio models.
 */
export class ContextManager {
  private readonly logger: vscode.LogOutputChannel;
  private readonly tokenizer: Tokenizer;

  constructor(logger: vscode.LogOutputChannel, tokenizer: Tokenizer) {
    this.logger = logger;
    this.tokenizer = tokenizer;
  }

  /**
   * Build a ranked context block from the workspace, ready to prepend to a prompt.
   * Returns an empty string if the feature is disabled or no files are found.
   */
  public async buildContext(currentFilePath?: string, modelId = ''): Promise<string> {
    const config = vscode.workspace.getConfiguration('lmStudioCopilot');
    if (!config.get<boolean>('enableContextPrioritization', true)) {
      this.logger.debug('Context Prioritization: Disabled');
      return '';
    }

    const budget = config.get<number>('contextTokenBudget', 20000);
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return '';
    }

    const rootPath = folders[0].uri.fsPath;
    const scored = await this.collectAndScore(rootPath, currentFilePath);
    scored.sort((a, b) => b.score - a.score);

    this.logger.debug(`Context Prioritization: Found ${scored.length} candidate files`);

    const family = this.tokenizer.detectFamily(modelId, undefined);
    const packed = await this.pack(scored, budget, modelId, family);

    if (packed.length === 0) {
      this.logger.debug('Context Prioritization: No files packed within budget');
      return '';
    }

    const totalTokens = packed.reduce((sum, f) => sum + f.tokens, 0);
    const truncatedNames = packed
      .filter(f => f.truncated)
      .map(f => path.basename(f.relativePath));

    const truncatedSuffix = truncatedNames.length > 0
      ? ` (Truncated: ${truncatedNames.join(', ')})`
      : '';

    this.logger.info(
      `Context Prioritization: Packed ${packed.length} files, ~${totalTokens} tokens${truncatedSuffix}`
    );

    const sections = packed.map(
      f => `### ${f.relativePath}\n\`\`\`\n${f.content}\n\`\`\``
    );

    return `[Workspace Context — ${packed.length} files, ~${totalTokens} tokens${truncatedSuffix}]\n\n${sections.join('\n\n')}`;
  }

  /**
   * Estimate the token count of context that would be built, without reading file
   * contents. Uses file sizes and a conservative chars-per-token ratio for speed.
   */
  public async estimateContextSize(currentFilePath?: string): Promise<number> {
    const config = vscode.workspace.getConfiguration('lmStudioCopilot');
    if (!config.get<boolean>('enableContextPrioritization', true)) {
      return 0;
    }

    const budget = config.get<number>('contextTokenBudget', 20000);
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return 0;
    }

    const rootPath = folders[0].uri.fsPath;
    const scored = await this.collectAndScore(rootPath, currentFilePath);
    scored.sort((a, b) => b.score - a.score);

    let total = 0;
    for (const f of scored) {
      const estimated = Math.ceil(f.size / FAST_ESTIMATE_CHARS_PER_TOKEN);
      const contribution = Math.min(estimated, DIVERSITY_FLOOR_TOKENS);
      if (total + contribution > budget) break;
      total += contribution;
    }

    return total;
  }

  private async collectAndScore(rootPath: string, currentFilePath?: string): Promise<ScoredFile[]> {
    const results: ScoredFile[] = [];
    const currentDir = currentFilePath ? path.dirname(currentFilePath) : null;
    await this.walk(rootPath, rootPath, currentDir, results);
    return results;
  }

  private async walk(
    dir: string,
    rootPath: string,
    currentDir: string | null,
    results: ScoredFile[]
  ): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true }) as import('fs').Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = String(entry.name);
      const fullPath = path.join(dir, name);

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(name) && !name.startsWith('.')) {
          await this.walk(fullPath, rootPath, currentDir, results);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (IGNORE_EXTENSIONS.has(ext)) continue;
        if (IGNORE_SUFFIXES.some(suffix => name.endsWith(suffix))) continue;

        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > MAX_FILE_BYTES) continue;

          const relativePath = path.relative(rootPath, fullPath);
          const score = this.scoreFile(fullPath, relativePath, stat.mtimeMs, currentDir);
          results.push({ fullPath, relativePath, score, size: stat.size });
        } catch {
          // Skip files that cannot be stat'd (permissions, broken symlinks, etc.)
        }
      }
    }
  }

  private scoreFile(
    fullPath: string,
    relativePath: string,
    mtimeMs: number,
    currentDir: string | null
  ): number {
    let score = 0;

    // Recency: recently modified files are more likely to be relevant
    const ageMs = Date.now() - mtimeMs;
    if (ageMs < 3_600_000) score += 10;       // < 1 hour
    else if (ageMs < 86_400_000) score += 5;  // < 24 hours

    // Proximity: same directory as the active editor file
    if (currentDir && path.dirname(fullPath) === currentDir) score += 8;

    // Depth penalty: prefer shallower files (root-level files tend to be more structural)
    const depth = relativePath.split(path.sep).length;
    score -= depth;

    // Identity: well-known high-value filenames
    const name = path.basename(fullPath);
    if (/^(index|main|app|extension)\.[a-z]+$/i.test(name)) score += 3;
    if (name === 'types.ts' || name === 'types.d.ts') score += 4;
    if (name.endsWith('.config.ts') || name.endsWith('.config.js')) score += 2;

    return score;
  }

  private async pack(
    scoredFiles: ScoredFile[],
    budget: number,
    modelId: string,
    family: ModelFamily
  ): Promise<PackedFile[]> {
    const packed: PackedFile[] = [];
    let remaining = budget;

    for (const f of scoredFiles) {
      if (remaining <= 0) break;

      let content: string;
      try {
        content = await fs.readFile(f.fullPath, 'utf-8');
      } catch {
        continue;
      }

      const tokens = this.tokenizer.estimateTokens(content, modelId, family);

      if (tokens <= DIVERSITY_FLOOR_TOKENS) {
        // Small file: include in full if it fits
        if (tokens <= remaining) {
          packed.push({ relativePath: f.relativePath, content, tokens, truncated: false });
          remaining -= tokens;
        }
      } else if (remaining >= tokens * 2) {
        // Large file with ample budget: include in full
        if (tokens <= remaining) {
          packed.push({ relativePath: f.relativePath, content, tokens, truncated: false });
          remaining -= tokens;
        }
      } else if (remaining >= DIVERSITY_FLOOR_TOKENS) {
        // Budget is constrained: truncate to diversity floor
        const truncated = this.truncateToTokens(content, DIVERSITY_FLOOR_TOKENS, modelId, family);
        if (truncated === null) continue; // Zero-line safety: skip rather than emit broken content

        packed.push({
          relativePath: f.relativePath,
          content: truncated,
          tokens: DIVERSITY_FLOOR_TOKENS,
          truncated: true,
        });
        remaining -= DIVERSITY_FLOOR_TOKENS;
      }
    }

    return packed;
  }

  /**
   * Truncate content to approximately targetTokens, cutting only at a newline
   * boundary. Returns null if no safe truncation point exists (zero-line safety).
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
    return `${head}\n// [TRUNCATED: Only first ${targetTokens} tokens shown to preserve context budget]`;
  }
}
