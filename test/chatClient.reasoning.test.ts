import { ChatClient } from '../src/chatClient';
import * as vscode from 'vscode';

describe('ChatClient - Reasoning Content', () => {
  let client: ChatClient;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      trace: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn()
    };

    client = new ChatClient(mockLogger);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should yield reasoning content before regular content', async () => {
    const mockStreamChunks = [
      {
        choices: [{
          delta: { reasoning_content: 'Thinking step by step...' },
          finish_reason: null
        }]
      },
      {
        choices: [{
          delta: { content: 'The answer is 42.' },
          finish_reason: 'stop'
        }]
      }
    ];

    const results: string[] = [];
    
    // Mock fetch to return our test stream
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: {
        getReader: jest.fn().mockReturnValue({
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: ' + JSON.stringify(mockStreamChunks[0]) + '\n') })
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: ' + JSON.stringify(mockStreamChunks[1]) + '\n') })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          close: jest.fn()
        })
      }
    });

    for await (const part of client.streamCompletion('test-model', [])) {
      if (part.kind === 'text') {
        results.push(part.content);
      }
    }

    expect(results).toHaveLength(2);
    expect(results[0]).toContain('Thinking step by step...');
    expect(results[1]).toContain('The answer is 42.');
  });

  it('should skip reasoning content when showReasoningContent is false', async () => {
    // Mock configuration to disable reasoning content for this specific test
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'showReasoningContent') return false;
        return true;
      })
    });

    // Reinitialize client with new config
    client = new ChatClient(mockLogger);

    const mockStreamChunks = [
      {
        choices: [{
          delta: { reasoning_content: 'Thinking...' },
          finish_reason: null
        }]
      },
      {
        choices: [{
          delta: { content: 'Hello world' },
          finish_reason: 'stop'
        }]
      }
    ];

    const results: string[] = [];
    
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: {
        getReader: jest.fn().mockReturnValue({
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: ' + JSON.stringify(mockStreamChunks[0]) + '\n') })
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: ' + JSON.stringify(mockStreamChunks[1]) + '\n') })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          close: jest.fn()
        })
      }
    });

    for await (const part of client.streamCompletion('test-model', [])) {
      if (part.kind === 'text') {
        results.push(part.content);
      }
    }

    // Should only yield regular content, not reasoning
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('Hello world');
  });

  it('should handle models without reasoning_content', async () => {
    const mockStreamChunks = [
      {
        choices: [{
          delta: { content: 'Regular response' },
          finish_reason: null
        }]
      },
      {
        choices: [{
          finish_reason: 'stop'
        }]
      }
    ];

    const results: string[] = [];
    
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: {
        getReader: jest.fn().mockReturnValue({
          read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: ' + JSON.stringify(mockStreamChunks[0]) + '\n') })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          close: jest.fn()
        })
      }
    });

    for await (const part of client.streamCompletion('test-model', [])) {
      if (part.kind === 'text') {
        results.push(part.content);
      }
    }

    expect(results).toHaveLength(1);
    expect(results[0]).toContain('Regular response');
  });
});