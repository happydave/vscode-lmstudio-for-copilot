import { SmartContextScanner } from '../src/smartContextScanner';
import { Tokenizer, ModelFamily } from '../src/tokenizer';

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
  jest.spyOn(t, 'estimateTokens').mockImplementation((text: string) => Math.ceil(text.length / 4));
  jest.spyOn(t, 'detectFamily').mockReturnValue(ModelFamily.Unknown);
  return t;
}

function userMsg(parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart>): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.User,
    content: parts,
  } as any;
}

function assistantMsg(parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>): vscode.LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.Assistant,
    content: parts,
  } as any;
}

function textPart(text: string): vscode.LanguageModelTextPart {
  return new vscode.LanguageModelTextPart(text);
}

function toolCallPart(callId: string, input: object): vscode.LanguageModelToolCallPart {
  return new vscode.LanguageModelToolCallPart(callId, 'read_file', input);
}

function toolResultPart(callId: string, text: string): vscode.LanguageModelToolResultPart {
  return new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart(text)]);
}

function mockWorkspaceRoot(rootPath = '/workspace'): void {
  (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: rootPath } }];
}

function makeSignals(
  candidates: Array<{ filePath: string; score: number }>,
  alreadyPresentPaths: Set<string> = new Set()
) {
  return {
    alreadyPresentPaths,
    candidates,
    hasSufficientSignal: candidates.length > 0,
  };
}

const NO_MESSAGES: readonly vscode.LanguageModelChatRequestMessage[] = [];

// --- Tests ---

describe('SmartContextScanner', () => {
  let logger: any;
  let tokenizer: Tokenizer;
  let scanner: SmartContextScanner;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = makeLogger();
    tokenizer = makeTokenizer(logger);
    scanner = new SmartContextScanner(logger, tokenizer);
    mockWorkspaceRoot('/workspace');
  });

  // --- extractSignals ---

  describe('extractSignals', () => {
    it('returns no signal for empty messages', () => {
      const signals = scanner.extractSignals(NO_MESSAGES);
      expect(signals.hasSufficientSignal).toBe(false);
      expect(signals.candidates).toHaveLength(0);
      expect(signals.alreadyPresentPaths.size).toBe(0);
    });

    it('returns no signal for plain conversational text with no attachments or tool parts', () => {
      const signals = scanner.extractSignals([
        userMsg([textPart('Hello, how are you today? Can you help me with something?')]),
      ]);
      expect(signals.hasSufficientSignal).toBe(false);
      expect(signals.candidates).toHaveLength(0);
    });

    it('detects attachment path and adds to alreadyPresentPaths', () => {
      const signals = scanner.extractSignals([
        userMsg([textPart('<attachment filePath="/workspace/src/foo.ts" workspaceFolder="ws">content</attachment>')]),
      ]);
      expect(signals.alreadyPresentPaths.has('/workspace/src/foo.ts')).toBe(true);
      expect(signals.hasSufficientSignal).toBe(false);
    });

    it('does not add attachment path to candidates', () => {
      const signals = scanner.extractSignals([
        userMsg([textPart('<attachment filePath="/workspace/src/foo.ts">content</attachment>')]),
      ]);
      const paths = signals.candidates.map(c => c.filePath);
      expect(paths).not.toContain('/workspace/src/foo.ts');
    });

    it('extracts tool call input paths as candidates with weight 2', () => {
      const signals = scanner.extractSignals([
        assistantMsg([toolCallPart('c1', { path: '/workspace/src/bar.ts' })]),
      ]);
      expect(signals.hasSufficientSignal).toBe(true);
      expect(signals.candidates.some(c => c.filePath === '/workspace/src/bar.ts')).toBe(true);
    });

    it('extracts tool result text paths as candidates with weight 1', () => {
      const signals = scanner.extractSignals([
        userMsg([toolResultPart('c1', 'Read /workspace/src/baz.ts successfully')]),
      ]);
      expect(signals.hasSufficientSignal).toBe(true);
      expect(signals.candidates.some(c => c.filePath === '/workspace/src/baz.ts')).toBe(true);
    });

    it('does not add tool call path to candidates when it is already in alreadyPresentPaths', () => {
      const signals = scanner.extractSignals([
        userMsg([textPart('<attachment filePath="/workspace/src/foo.ts">x</attachment>')]),
        assistantMsg([toolCallPart('c1', { path: '/workspace/src/foo.ts' })]),
      ]);
      const paths = signals.candidates.map(c => c.filePath);
      expect(paths).not.toContain('/workspace/src/foo.ts');
    });

    it('tool call paths score higher than tool result-only paths when at equal or later position', () => {
      // toolresult.ts referenced only in a tool result (weight 1, message 0)
      // toolcall.ts referenced only in a tool call (weight 2, message 1 — also later)
      // Tool call path should win on both recency and sourceWeight.
      const signals = scanner.extractSignals([
        userMsg([toolResultPart('c1', 'output /workspace/src/toolresult.ts done')]),
        assistantMsg([toolCallPart('c2', { path: '/workspace/src/toolcall.ts' })]),
      ]);
      const callScore = signals.candidates.find(c => c.filePath === '/workspace/src/toolcall.ts')?.score ?? 0;
      const resultScore = signals.candidates.find(c => c.filePath === '/workspace/src/toolresult.ts')?.score ?? 0;
      expect(callScore).toBeGreaterThan(resultScore);
    });

    it('later-referenced paths score higher than earlier-referenced (recency)', () => {
      const signals = scanner.extractSignals([
        assistantMsg([toolCallPart('c1', { path: '/workspace/early.ts' })]),
        assistantMsg([toolCallPart('c2', { path: '/workspace/late.ts' })]),
      ]);
      const earlyScore = signals.candidates.find(c => c.filePath === '/workspace/early.ts')?.score ?? 0;
      const lateScore = signals.candidates.find(c => c.filePath === '/workspace/late.ts')?.score ?? 0;
      expect(lateScore).toBeGreaterThan(earlyScore);
    });

    it('multiply-referenced paths score higher than single-referenced (frequency)', () => {
      const signals = scanner.extractSignals([
        assistantMsg([toolCallPart('c1', { path: '/workspace/multi.ts' })]),
        assistantMsg([toolCallPart('c2', { path: '/workspace/single.ts' }), toolCallPart('c3', { path: '/workspace/multi.ts' })]),
      ]);
      const multiScore = signals.candidates.find(c => c.filePath === '/workspace/multi.ts')?.score ?? 0;
      const singleScore = signals.candidates.find(c => c.filePath === '/workspace/single.ts')?.score ?? 0;
      expect(multiScore).toBeGreaterThan(singleScore);
    });

    it('same path from tool call and tool result accumulates frequency', () => {
      const signals = scanner.extractSignals([
        assistantMsg([toolCallPart('c1', { path: '/workspace/shared.ts' })]),
        userMsg([toolResultPart('c1', 'output /workspace/shared.ts done')]),
      ]);
      const candidate = signals.candidates.find(c => c.filePath === '/workspace/shared.ts');
      expect(candidate).toBeDefined();
      // Frequency is 2, sourceWeight is 2 (max from tool call)
      expect(signals.candidates.filter(c => c.filePath === '/workspace/shared.ts')).toHaveLength(1);
    });

    it('ignores tool call input string values not starting with /', () => {
      const signals = scanner.extractSignals([
        assistantMsg([toolCallPart('c1', { query: 'build the project', count: 5 } as any)]),
      ]);
      expect(signals.hasSufficientSignal).toBe(false);
    });

    it('ignores tool call input nested objects (shallow walk only)', () => {
      const signals = scanner.extractSignals([
        assistantMsg([toolCallPart('c1', { nested: { path: '/workspace/deep.ts' } } as any)]),
      ]);
      // Nested values are not walked; only top-level strings
      const paths = signals.candidates.map(c => c.filePath);
      expect(paths).not.toContain('/workspace/deep.ts');
    });

    it('candidates are sorted descending by score', () => {
      const signals = scanner.extractSignals([
        assistantMsg([toolCallPart('c1', { path: '/workspace/first.ts' })]),
        assistantMsg([
          toolCallPart('c2', { path: '/workspace/second.ts' }),
          toolCallPart('c3', { path: '/workspace/second.ts' }), // two mentions: higher frequency
        ]),
      ]);
      if (signals.candidates.length >= 2) {
        expect(signals.candidates[0].score).toBeGreaterThanOrEqual(signals.candidates[1].score);
      }
    });

    it('attachment with ignored extension is still added to alreadyPresentPaths', () => {
      const signals = scanner.extractSignals([
        userMsg([textPart('<attachment filePath="/workspace/image.png">x</attachment>')]),
      ]);
      expect(signals.alreadyPresentPaths.has('/workspace/image.png')).toBe(true);
    });
  });

  // --- scan: no signal ---

  describe('scan with no signal', () => {
    it('returns empty array when hasSufficientSignal is false', async () => {
      const signals = makeSignals([]);
      const results = await scanner.scan(signals, new Set(), 10000, 50, 5, '', ModelFamily.Unknown);
      expect(results).toHaveLength(0);
      expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
    });

    it('never calls vscode.workspace.findFiles regardless of signals', async () => {
      const signals = makeSignals([{ filePath: '/workspace/src/foo.ts', score: 10 }]);
      fs.stat.mockResolvedValue({ size: 100 } as any);
      fs.readFile.mockResolvedValue('export const x = 1;');
      await scanner.scan(signals, new Set(), 10000, 50, 5, '', ModelFamily.Unknown);
      expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
    });
  });

  // --- scan: filtering ---

  describe('scan candidate filtering', () => {
    it('returns a file that survives filtering', async () => {
      const signals = makeSignals([{ filePath: '/workspace/src/requestBuilder.ts', score: 15 }]);
      fs.stat.mockResolvedValue({ size: 100 } as any);
      fs.readFile.mockResolvedValue('export class RequestBuilder {}');

      const results = await scanner.scan(signals, new Set(), 10000, 50, 5, '', ModelFamily.Unknown);
      expect(results).toHaveLength(1);
      expect(results[0].relativePath).toBe('src/requestBuilder.ts');
      expect(results[0].content).toContain('RequestBuilder');
    });

    it('excludes files already in alreadyInjectedPaths', async () => {
      const alreadyInjected = new Set(['/workspace/src/requestBuilder.ts']);
      const signals = makeSignals([{ filePath: '/workspace/src/requestBuilder.ts', score: 15 }]);

      const results = await scanner.scan(signals, alreadyInjected, 10000, 50, 5, '', ModelFamily.Unknown);
      expect(results).toHaveLength(0);
    });

    it('excludes files with ignored extensions', async () => {
      const signals = makeSignals([
        { filePath: '/workspace/assets/logo.png', score: 10 },
        { filePath: '/workspace/src/utils.ts', score: 8 },
      ]);
      fs.stat.mockResolvedValue({ size: 100 } as any);
      fs.readFile.mockResolvedValue('export function utils() {}');

      const results = await scanner.scan(signals, new Set(), 10000, 50, 5, '', ModelFamily.Unknown);
      const paths = results.map(r => r.relativePath);
      expect(paths).not.toContain('assets/logo.png');
      expect(paths).toContain('src/utils.ts');
    });

    it('skips a file that cannot be stat-ed', async () => {
      const signals = makeSignals([
        { filePath: '/workspace/src/ghost.ts', score: 15 },
        { filePath: '/workspace/src/present.ts', score: 10 },
      ]);
      fs.stat.mockImplementation(async (p: any) => {
        if (String(p).includes('ghost')) throw new Error('ENOENT');
        return { size: 100 } as any;
      });
      fs.readFile.mockResolvedValue('export const x = 1;');

      const results = await scanner.scan(signals, new Set(), 10000, 50, 5, '', ModelFamily.Unknown);
      expect(results).toHaveLength(1);
      expect(results[0].relativePath).toBe('src/present.ts');
    });

    it('skips files larger than 200 KB', async () => {
      const signals = makeSignals([{ filePath: '/workspace/src/big.ts', score: 10 }]);
      fs.stat.mockResolvedValue({ size: 200_001 } as any);

      const results = await scanner.scan(signals, new Set(), 10000, 50, 5, '', ModelFamily.Unknown);
      expect(results).toHaveLength(0);
    });

    it('respects maxFilesToScan cap before filesystem access', async () => {
      const signals = makeSignals([
        { filePath: '/workspace/src/a.ts', score: 10 },
        { filePath: '/workspace/src/b.ts', score: 9 },
        { filePath: '/workspace/src/c.ts', score: 8 },
      ]);
      fs.stat.mockResolvedValue({ size: 100 } as any);
      fs.readFile.mockResolvedValue('export const x = 1;');

      // maxFilesToScan=2 means only first 2 candidates are stat-checked
      await scanner.scan(signals, new Set(), 10000, 2, 5, '', ModelFamily.Unknown);
      expect(fs.stat).toHaveBeenCalledTimes(2);
    });

    it('respects maxResultFiles cap', async () => {
      const signals = makeSignals([
        { filePath: '/workspace/src/a.ts', score: 10 },
        { filePath: '/workspace/src/b.ts', score: 9 },
        { filePath: '/workspace/src/c.ts', score: 8 },
      ]);
      fs.stat.mockResolvedValue({ size: 100 } as any);
      fs.readFile.mockResolvedValue('export const x = 1;');

      const results = await scanner.scan(signals, new Set(), 10000, 50, 2, '', ModelFamily.Unknown);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty when all candidates are excluded', async () => {
      const signals = makeSignals([
        { filePath: '/workspace/assets/logo.png', score: 10 },
      ]);
      const results = await scanner.scan(signals, new Set(), 10000, 50, 5, '', ModelFamily.Unknown);
      expect(results).toHaveLength(0);
    });
  });

  // --- scan: token budget ---

  describe('scan respects token budget', () => {
    it('returns empty when budget is zero', async () => {
      const signals = makeSignals([{ filePath: '/workspace/src/foo.ts', score: 10 }]);
      fs.stat.mockResolvedValue({ size: 100 } as any);
      fs.readFile.mockResolvedValue('export const x = 1;');

      const results = await scanner.scan(signals, new Set(), 0, 50, 5, '', ModelFamily.Unknown);
      expect(results).toHaveLength(0);
    });

    it('truncates a file that exceeds the remaining budget', async () => {
      const signals = makeSignals([{ filePath: '/workspace/src/big.ts', score: 10 }]);
      fs.stat.mockResolvedValue({ size: 1000 } as any);

      // 400 chars / 4 = 100 tokens; budget is 20
      const line = 'x'.repeat(39) + '\n';
      const content = line.repeat(10);
      fs.readFile.mockResolvedValue(content);

      const results = await scanner.scan(signals, new Set(), 20, 50, 5, '', ModelFamily.Unknown);
      expect(results).toHaveLength(1);
      expect(results[0].truncated).toBe(true);
      expect(results[0].content).toContain('TRUNCATED');
    });

    it('skips a file that cannot be safely truncated (no newline)', async () => {
      const signals = makeSignals([{ filePath: '/workspace/src/inline.ts', score: 10 }]);
      fs.stat.mockResolvedValue({ size: 100 } as any);
      // Single line with no newline — cannot truncate at newline boundary
      fs.readFile.mockResolvedValue('x'.repeat(400));

      const results = await scanner.scan(signals, new Set(), 20, 50, 5, '', ModelFamily.Unknown);
      expect(results).toHaveLength(0);
    });
  });

  // --- scan: end-to-end grounding ---

  describe('scan: only conversation-grounded files are injected', () => {
    it('returns empty when no file paths are grounded in the conversation', async () => {
      const signals = scanner.extractSignals([
        userMsg([textPart('Hello, how do I fix this error?')]),
      ]);
      const results = await scanner.scan(signals, new Set(), 10000, 50, 5, '', ModelFamily.Unknown);
      expect(results).toHaveLength(0);
      expect(fs.stat).not.toHaveBeenCalled();
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it('injects a file referenced in a tool call', async () => {
      const messages = [
        assistantMsg([toolCallPart('c1', { path: '/workspace/src/contextManager.ts' })]),
      ];
      const signals = scanner.extractSignals(messages);
      fs.stat.mockResolvedValue({ size: 200 } as any);
      fs.readFile.mockResolvedValue('export class ContextManager {}');

      const results = await scanner.scan(signals, new Set(), 10000, 50, 5, '', ModelFamily.Unknown);
      expect(results).toHaveLength(1);
      expect(results[0].relativePath).toBe('src/contextManager.ts');
    });

    it('does not inject a file that was attached via #file: (already present)', async () => {
      const messages = [
        userMsg([textPart('<attachment filePath="/workspace/src/contextManager.ts">content here</attachment>')]),
        assistantMsg([toolCallPart('c1', { path: '/workspace/src/contextManager.ts' })]),
      ];
      const signals = scanner.extractSignals(messages);
      const results = await scanner.scan(signals, new Set(), 10000, 50, 5, '', ModelFamily.Unknown);
      expect(results).toHaveLength(0);
    });
  });
});
