import * as path from 'path';
import { ContextManager } from '../src/contextManager';
import { Tokenizer, ModelFamily } from '../src/tokenizer';

// fs/promises is mocked per-test using jest.mock
jest.mock('fs/promises');
import * as fsMod from 'fs/promises';
const fs = fsMod as jest.Mocked<typeof fsMod>;

import * as vscode from 'vscode';

// --- Helpers ---

function makeLogger(): any {
  return {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function makeTokenizer(logger: any): Tokenizer {
  const globalState = { get: jest.fn().mockReturnValue({}), update: jest.fn(), keys: jest.fn().mockReturnValue([]) };
  const t = new Tokenizer(logger, globalState);
  // Fixed ratio: 4 chars per token for predictable arithmetic
  jest.spyOn(t, 'estimateTokens').mockImplementation((text: string) => Math.ceil(text.length / 4));
  jest.spyOn(t, 'detectFamily').mockReturnValue(ModelFamily.Unknown);
  return t;
}

function mockConfig(enabled = true, budget = 20000): void {
  (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
    get: jest.fn((key: string, def?: any) => {
      if (key === 'enableContextPrioritization') return enabled;
      if (key === 'contextTokenBudget') return budget;
      return def;
    }),
  });
}

function mockWorkspaceRoot(rootPath = '/workspace'): void {
  (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: rootPath } }];
}

function mockActiveEditor(fsPath: string, scheme = 'file'): void {
  (vscode.window as any).activeTextEditor = {
    document: { uri: { fsPath, scheme } },
  };
}

function clearActiveEditor(): void {
  (vscode.window as any).activeTextEditor = undefined;
}

/** Build a minimal vscode.LanguageModelChatRequestMessage with text content */
function userMsg(text: string): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.User,
    content: [new vscode.LanguageModelTextPart(text)],
  } as any;
}

function assistantMsg(text: string): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.Assistant,
    content: [new vscode.LanguageModelTextPart(text)],
  } as any;
}

function assistantToolCallMsg(filePath: string): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.Assistant,
    content: [new vscode.LanguageModelToolCallPart('c1', 'read_file', { path: filePath })],
  } as any;
}

const NO_MESSAGES: readonly vscode.LanguageModelChatRequestMessage[] = [];

// --- Tests ---

describe('ContextManager', () => {
  let logger: any;
  let tokenizer: Tokenizer;
  let manager: ContextManager;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = makeLogger();
    tokenizer = makeTokenizer(logger);
    manager = new ContextManager(logger, tokenizer);

    mockConfig(true, 20000);
    mockWorkspaceRoot('/workspace');
    clearActiveEditor();
  });

  // ---------- master switch ----------

  describe('disabled', () => {
    it('returns empty string immediately and does not read any files', async () => {
      mockConfig(false);
      mockActiveEditor('/workspace/src/foo.ts');
      const result = await manager.buildContext(NO_MESSAGES);
      expect(result).toBe('');
      expect(fs.readFile).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Disabled'));
    });
  });

  // ---------- active editor guards ----------

  describe('no active editor', () => {
    it('returns empty string when no editor is open', async () => {
      const result = await manager.buildContext(NO_MESSAGES);
      expect(result).toBe('');
      expect(fs.readFile).not.toHaveBeenCalled();
    });
  });

  describe('non-file editor', () => {
    it('returns empty string for untitled / virtual scheme', async () => {
      mockActiveEditor('/workspace/untitled', 'untitled');
      const result = await manager.buildContext(NO_MESSAGES);
      expect(result).toBe('');
      expect(fs.readFile).not.toHaveBeenCalled();
    });
  });

  describe('binary file extension', () => {
    it.each(['.png', '.jpg', '.svg', '.pdf', '.zip', '.mp3', '.log', '.map'])(
      'returns empty string for %s',
      async (ext) => {
        mockActiveEditor(`/workspace/src/asset${ext}`);
        const result = await manager.buildContext(NO_MESSAGES);
        expect(result).toBe('');
        expect(fs.readFile).not.toHaveBeenCalled();
      }
    );
  });

  // ---------- path detection in messages ----------

  describe('already in messages', () => {
    it('returns empty string when full path appears in a user message', async () => {
      mockActiveEditor('/workspace/src/foo.ts');
      const messages = [userMsg('Here is /workspace/src/foo.ts:\n```\nconst x = 1;\n```')];
      const result = await manager.buildContext(messages);
      expect(result).toBe('');
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it('returns empty string when basename appears in a user message', async () => {
      mockActiveEditor('/workspace/src/bar.ts');
      const messages = [userMsg('The file bar.ts has a bug on line 10.')];
      const result = await manager.buildContext(messages);
      expect(result).toBe('');
    });

    it('returns empty string when path appears in an assistant message', async () => {
      mockActiveEditor('/workspace/src/baz.ts');
      const messages = [assistantMsg('Looking at baz.ts, I see the issue...')];
      const result = await manager.buildContext(messages);
      expect(result).toBe('');
    });

    it('injects when messages mention a different file with a similar name', async () => {
      mockActiveEditor('/workspace/src/contextManager.ts');
      // Only references a different file
      const messages = [userMsg('Please look at requestBuilder.ts')];
      fs.stat.mockResolvedValue({ size: 100 } as any);
      fs.readFile.mockResolvedValue('export class ContextManager {}');

      const result = await manager.buildContext(messages);
      expect(result).toContain('contextManager.ts');
    });
  });

  // ---------- successful injection ----------

  describe('active file injection', () => {
    it('returns a context block containing the active file content', async () => {
      mockActiveEditor('/workspace/src/utils.ts');
      fs.stat.mockResolvedValue({ size: 200 } as any);
      fs.readFile.mockResolvedValue('export function add(a: number, b: number) { return a + b; }');

      const result = await manager.buildContext(NO_MESSAGES);
      expect(result).toContain('src/utils.ts');
      expect(result).toContain('export function add');
      expect(result).toMatch(/\[Workspace Context — 1 file, ~\d+ tokens\]/);
    });

    it('uses a relative path from the workspace root', async () => {
      mockWorkspaceRoot('/home/user/project');
      mockActiveEditor('/home/user/project/src/main.ts');
      fs.stat.mockResolvedValue({ size: 50 } as any);
      fs.readFile.mockResolvedValue('const x = 1;');

      const result = await manager.buildContext(NO_MESSAGES);
      expect(result).toContain('src/main.ts');
      expect(result).not.toContain('/home/user/project/src/main.ts');
    });

    it('uses basename when no workspace folder is available', async () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      mockActiveEditor('/some/path/standalone.ts');
      fs.stat.mockResolvedValue({ size: 50 } as any);
      fs.readFile.mockResolvedValue('const y = 2;');

      const result = await manager.buildContext(NO_MESSAGES);
      expect(result).toContain('standalone.ts');
    });

    it('includes empty file content without omitting the block', async () => {
      mockActiveEditor('/workspace/src/empty.ts');
      fs.stat.mockResolvedValue({ size: 0 } as any);
      fs.readFile.mockResolvedValue('');

      const result = await manager.buildContext(NO_MESSAGES);
      expect(result).toContain('empty.ts');
      expect(result).toContain('```\n\n```');
    });
  });

  // ---------- error paths ----------

  describe('file read errors', () => {
    it('returns empty string when stat fails', async () => {
      mockActiveEditor('/workspace/src/ghost.ts');
      fs.stat.mockRejectedValue(new Error('ENOENT'));

      const result = await manager.buildContext(NO_MESSAGES);
      expect(result).toBe('');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ghost.ts'));
    });

    it('returns empty string when readFile fails', async () => {
      mockActiveEditor('/workspace/src/unreadable.ts');
      fs.stat.mockResolvedValue({ size: 100 } as any);
      fs.readFile.mockRejectedValue(new Error('EACCES'));

      const result = await manager.buildContext(NO_MESSAGES);
      expect(result).toBe('');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unreadable.ts'));
    });
  });

  // ---------- size and budget guards ----------

  describe('large file guard', () => {
    it('returns empty string when file exceeds 500KB', async () => {
      mockActiveEditor('/workspace/src/huge.ts');
      fs.stat.mockResolvedValue({ size: 600_000 } as any);

      const result = await manager.buildContext(NO_MESSAGES);
      expect(result).toBe('');
      expect(fs.readFile).not.toHaveBeenCalled();
    });
  });

  describe('token budget', () => {
    it('returns empty string when contextTokenBudget is 0', async () => {
      mockConfig(true, 0);
      mockActiveEditor('/workspace/src/foo.ts');
      fs.stat.mockResolvedValue({ size: 100 } as any);
      fs.readFile.mockResolvedValue('const x = 1;');

      const result = await manager.buildContext(NO_MESSAGES);
      expect(result).toBe('');
    });

    it('truncates file content when it exceeds the token budget', async () => {
      const budget = 50; // tokens
      mockConfig(true, budget);
      mockActiveEditor('/workspace/src/long.ts');

      // 400 chars / 4 = 100 tokens, exceeds budget of 50
      const line = 'x'.repeat(39) + '\n'; // 40 chars per line
      const content = line.repeat(10);    // 400 chars, 100 tokens
      fs.stat.mockResolvedValue({ size: 400 } as any);
      fs.readFile.mockResolvedValue(content);

      const result = await manager.buildContext(NO_MESSAGES);
      expect(result).toContain('TRUNCATED');
      expect(result).toContain('Truncated: long.ts');
    });

    it('omits file when no safe truncation point exists', async () => {
      const budget = 5;
      mockConfig(true, budget);
      mockActiveEditor('/workspace/src/nolines.ts');

      // Single line, no newlines → no safe truncation point
      const content = 'x'.repeat(200); // 50 tokens, no newlines
      fs.stat.mockResolvedValue({ size: 200 } as any);
      fs.readFile.mockResolvedValue(content);

      const result = await manager.buildContext(NO_MESSAGES);
      expect(result).toBe('');
    });

    it('includes file without truncation when it fits within budget', async () => {
      mockConfig(true, 1000);
      mockActiveEditor('/workspace/src/small.ts');
      const content = 'const small = true;\n'; // 5 tokens
      fs.stat.mockResolvedValue({ size: 20 } as any);
      fs.readFile.mockResolvedValue(content);

      const result = await manager.buildContext(NO_MESSAGES);
      expect(result).not.toContain('TRUNCATED');
      expect(result).toContain('const small = true;');
    });
  });

  // ---------- smart context scanner ----------

  describe('smart context scanner disabled (default)', () => {
    it('does not call findFiles when scanner is disabled', async () => {
      mockActiveEditor('/workspace/src/foo.ts');
      fs.stat.mockResolvedValue({ size: 100 } as any);
      fs.readFile.mockResolvedValue('const x = 1;\n');

      await manager.buildContext([userMsg('Please look at contextManager.ts')]);
      expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
    });
  });

  describe('smart context scanner enabled', () => {
    function mockSmartConfig(budget = 20000): void {
      (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn((key: string, def?: any) => {
          if (key === 'enableContextPrioritization') return true;
          if (key === 'contextTokenBudget') return budget;
          if (key === 'enableSmartContextScanner') return true;
          if (key === 'smartContextScanner.maxFilesToScan') return 50;
          if (key === 'smartContextScanner.maxResultFiles') return 5;
          return def;
        }),
      });
    }

    it('injects a scanner file when conversation references it via tool call', async () => {
      mockSmartConfig();
      clearActiveEditor();
      fs.stat.mockResolvedValue({ size: 100 } as any);
      fs.readFile.mockResolvedValue('export class RequestBuilder {}\n');

      const result = await manager.buildContext([
        assistantToolCallMsg('/workspace/src/requestBuilder.ts'),
      ]);
      expect(result).toContain('RequestBuilder');
      expect(result).toMatch(/\[Workspace Context — 1 file/);
    });

    it('does not inject scanner files when conversation has no signal', async () => {
      mockSmartConfig();
      clearActiveEditor();

      const result = await manager.buildContext([userMsg('Hello, how are you?')]);
      expect(result).toBe('');
      expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
    });

    it('excludes the active editor file from scanner results', async () => {
      mockSmartConfig();
      mockActiveEditor('/workspace/src/contextManager.ts');
      fs.stat.mockResolvedValue({ size: 100 } as any);
      fs.readFile.mockResolvedValue('export class RequestBuilder { buildContext() {} }\n');

      const result = await manager.buildContext([
        assistantToolCallMsg('/workspace/src/contextManager.ts'),
      ]);
      // contextManager.ts is the active file AND referenced in the tool call.
      // It should appear exactly once (active editor injection only, not re-injected by scanner).
      const matches = (result.match(/contextManager\.ts/g) || []).length;
      expect(matches).toBe(1);
    });

    it('returns only scanner results when there is no active editor', async () => {
      mockSmartConfig();
      clearActiveEditor();
      fs.stat.mockResolvedValue({ size: 100 } as any);
      fs.readFile.mockResolvedValue('export class Tokenizer {}\n');

      const result = await manager.buildContext([
        assistantToolCallMsg('/workspace/src/tokenizer.ts'),
      ]);
      expect(result).toContain('tokenizer.ts');
      expect(result).toMatch(/\[Workspace Context — 1 file/);
    });

    it('combines active file and scanner results into a single context block', async () => {
      mockSmartConfig();
      mockActiveEditor('/workspace/src/main.ts');
      fs.stat.mockResolvedValue({ size: 100 } as any);
      fs.readFile.mockResolvedValue('export function helper() {}\n');

      const result = await manager.buildContext([
        assistantToolCallMsg('/workspace/src/utils.ts'),
      ]);
      expect(result).toContain('main.ts');
      expect(result).toContain('utils.ts');
      expect(result).toMatch(/\[Workspace Context — 2 files/);
    });
  });
});
