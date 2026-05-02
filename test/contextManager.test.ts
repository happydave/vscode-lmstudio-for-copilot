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

function mockWorkspace(enabled = true, budget = 20000, rootPath = '/workspace'): void {
  (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
    get: jest.fn((key: string, def?: any) => {
      if (key === 'enableContextPrioritization') return enabled;
      if (key === 'contextTokenBudget') return budget;
      return def;
    }),
  });
  (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: rootPath } }];
}

// Helper to create a stat result
function fakeStat(size: number, mtimeMs = Date.now() - 7_200_000 /* 2h ago */): any {
  return { size, mtimeMs, isFile: () => true, isDirectory: () => false };
}

// Helper to create a dirent-like object
function dirent(name: string, isDir: boolean): any {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
  };
}

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

    // Default: active workspace with no active file
    mockWorkspace(true, 20000, '/workspace');
  });

  describe('buildContext — disabled', () => {
    it('returns empty string when enableContextPrioritization is false', async () => {
      mockWorkspace(false);
      const result = await manager.buildContext();
      expect(result).toBe('');
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Disabled'));
    });
  });

  describe('buildContext — empty workspace', () => {
    it('returns empty string when no workspace folders are open', async () => {
      (vscode.workspace as any).workspaceFolders = [];
      const result = await manager.buildContext();
      expect(result).toBe('');
    });
  });

  describe('buildContext — file exclusions', () => {
    it('excludes node_modules directory', async () => {
      fs.readdir.mockImplementation(async (dir) => {
        if (String(dir) === '/workspace') {
          return [dirent('node_modules', true), dirent('src', true)];
        }
        if (String(dir) === '/workspace/src') {
          return [dirent('index.ts', false)];
        }
        return [];
      });
      fs.stat.mockResolvedValue(fakeStat(100));
      fs.readFile.mockResolvedValue('const x = 1;');

      const result = await manager.buildContext();
      expect(result).toContain('src/index.ts');
      expect(result).not.toContain('node_modules');
    });

    it('excludes .git directory', async () => {
      fs.readdir.mockImplementation(async (dir) => {
        if (String(dir) === '/workspace') {
          return [dirent('.git', true), dirent('main.ts', false)];
        }
        return [];
      });
      fs.stat.mockResolvedValue(fakeStat(100));
      fs.readFile.mockResolvedValue('export {}');

      const result = await manager.buildContext();
      expect(result).not.toContain('.git');
    });

    it('excludes files larger than 100KB', async () => {
      fs.readdir.mockResolvedValue([dirent('big.ts', false)] as any);
      fs.stat.mockResolvedValue(fakeStat(200_000)); // 200KB

      const result = await manager.buildContext();
      expect(result).toBe('');
    });

    it('excludes binary extensions', async () => {
      fs.readdir.mockResolvedValue([dirent('image.png', false), dirent('app.ts', false)] as any);
      fs.stat.mockImplementation(async (p) => {
        return fakeStat(100);
      });
      fs.readFile.mockResolvedValue('const app = true;');

      const result = await manager.buildContext();
      expect(result).not.toContain('image.png');
      expect(result).toContain('app.ts');
    });
  });

  describe('scoring', () => {
    it('ranks a recently modified same-directory file higher than an old distant file', async () => {
      const recentlyModified = Date.now() - 60_000; // 1 minute ago
      const oldMs = Date.now() - 90_000_000;        // ~25 hours ago

      fs.readdir.mockImplementation(async (dir) => {
        if (String(dir) === '/workspace') return [dirent('src', true), dirent('lib', true)];
        if (String(dir) === '/workspace/src') return [dirent('active.ts', false), dirent('nearby.ts', false)];
        if (String(dir) === '/workspace/lib') return [dirent('old.ts', false)];
        return [];
      });

      fs.stat.mockImplementation(async (p) => {
        if (String(p).endsWith('nearby.ts')) return { size: 40, mtimeMs: recentlyModified, isFile: () => true };
        if (String(p).endsWith('old.ts')) return { size: 40, mtimeMs: oldMs, isFile: () => true };
        if (String(p).endsWith('active.ts')) return { size: 20, mtimeMs: oldMs, isFile: () => true };
        return fakeStat(40);
      });

      fs.readFile.mockResolvedValue('const x = 1;');

      // Active file is in /workspace/src
      const result = await manager.buildContext('/workspace/src/active.ts');

      // nearby.ts (same dir + recent) must appear before old.ts (different dir + old)
      const nearbyIdx = result.indexOf('src/nearby.ts');
      const oldIdx = result.indexOf('lib/old.ts');
      expect(nearbyIdx).toBeGreaterThan(-1);
      expect(oldIdx).toBeGreaterThan(-1);
      expect(nearbyIdx).toBeLessThan(oldIdx);
    });
  });

  describe('budgeting & truncation', () => {
    it('does not exceed the global token budget', async () => {
      const budget = 100; // Very tight budget
      mockWorkspace(true, budget);

      // Each file's content is 80 chars → 20 tokens at 4 chars/token
      fs.readdir.mockResolvedValue([
        dirent('a.ts', false), dirent('b.ts', false), dirent('c.ts', false),
        dirent('d.ts', false), dirent('e.ts', false), dirent('f.ts', false),
      ] as any);
      fs.stat.mockResolvedValue(fakeStat(80));
      fs.readFile.mockResolvedValue('x'.repeat(80)); // 20 tokens each

      const result = await manager.buildContext();

      // Count packed files: 100 token budget / 20 per file = 5 files max
      const matches = result.match(/###/g) ?? [];
      expect(matches.length).toBeLessThanOrEqual(5);
    });

    it('includes a truncation marker and lists truncated files in header', async () => {
      const budget = 20000;
      mockWorkspace(true, budget);

      // File content = 44000 chars → 11000 tokens at 4 chars/token.
      // Budget is 20000 but 20000 < 11000*2=22000, so truncation to diversity floor applies.
      // Content has newlines every 100 chars so truncation at newline boundary works.
      const line = 'y'.repeat(99) + '\n';  // 100 chars per line
      const largeContent = line.repeat(440); // 44000 chars total, newline at every 100th char

      fs.readdir.mockResolvedValue([dirent('large.ts', false)] as any);
      fs.stat.mockResolvedValue(fakeStat(40000));
      fs.readFile.mockResolvedValue(largeContent);

      const result = await manager.buildContext();

      expect(result).toContain('TRUNCATED');
      expect(result).toContain('Truncated: large.ts');
    });

    it('includes large file in full when budget permits (2x headroom)', async () => {
      // File is 3000 tokens, remaining budget starts at 20000 — well above 3000*2=6000
      const content = 'z'.repeat(12000) + '\n'; // 3000 tokens at 4 chars/token
      mockWorkspace(true, 20000);

      fs.readdir.mockResolvedValue([dirent('moderate.ts', false)] as any);
      fs.stat.mockResolvedValue(fakeStat(12001));
      fs.readFile.mockResolvedValue(content);

      const result = await manager.buildContext();

      expect(result).not.toContain('TRUNCATED');
      expect(result).toContain('moderate.ts');
    });
  });

  describe('estimateContextSize', () => {
    it('returns 0 when disabled', async () => {
      mockWorkspace(false);
      const size = await manager.estimateContextSize();
      expect(size).toBe(0);
    });

    it('returns a positive estimate without reading file contents', async () => {
      fs.readdir.mockResolvedValue([dirent('types.ts', false)] as any);
      fs.stat.mockResolvedValue(fakeStat(800)); // 800 bytes ≈ 228 tokens at 3.5 chars/token

      const size = await manager.estimateContextSize();
      expect(size).toBeGreaterThan(0);
      expect(fs.readFile).not.toHaveBeenCalled();
    });
  });
});
