import * as vscode from 'vscode';
import { ChatClient } from '../src/chatClient';
import { ContextOverflowError, APIError, ConnectionError, TimeoutError } from '../src/errors';

describe('ChatClient', () => {
  let client: ChatClient;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      trace: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };
    client = new ChatClient(mockLogger);
    (global as any).fetch = jest.fn();
    jest.clearAllMocks();
  });

  it('should stream text content from SSE chunks', async () => {
    const mockChunks = [
      'data: {"choices": [{"index": 0, "delta": {"content": "Hello"}, "finish_reason": null}]}\n\n',
      'data: {"choices": [{"index": 0, "delta": {"content": " world"}, "finish_reason": "stop"}]}\n\n',
      'data: [DONE]\n\n'
    ];

    const stream = createMockStream(mockChunks);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: stream
    });

    const results = [];
    for await (const part of client.streamCompletion('test-model', [])) {
      results.push(part);
    }

    expect(results).toEqual([
      { kind: 'text', content: 'Hello' },
      { kind: 'text', content: ' world' }
    ]);
  });

  it('should handle reasoning content', async () => {
    const mockChunks = [
      'data: {"choices": [{"index": 0, "delta": {"reasoning_content": "Thinking..."}, "finish_reason": null}]}\n\n',
      'data: {"choices": [{"index": 0, "delta": {"content": "Response"}, "finish_reason": "stop"}]}\n\n'
    ];

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: createMockStream(mockChunks)
    });

    const results = [];
    for await (const part of client.streamCompletion('test-model', [])) {
      results.push(part);
    }

    expect(results).toContainEqual({ kind: 'text', content: 'Thinking...' });
    expect(results).toContainEqual({ kind: 'text', content: 'Response' });
  });

  it('should accumulate tool call deltas', async () => {
    const mockChunks = [
      'data: {"choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": "call-1", "function": {"name": "test_tool", "arguments": "{\\"arg\\""}}] }, "finish_reason": null}]}\n\n',
      'data: {"choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "function": {"arguments": ": 1}"}}] }, "finish_reason": "stop"}]}\n\n'
    ];

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: createMockStream(mockChunks)
    });

    const results = [];
    for await (const part of client.streamCompletion('test-model', [])) {
      results.push(part);
    }

    expect(results).toContainEqual({ 
      kind: 'toolCall', 
      id: 'call-1', 
      name: 'test_tool', 
      arguments: '{"arg": 1}' 
    });
  });

  it('should yield usage data', async () => {
    const mockChunks = [
      'data: {"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}\n\n',
      'data: [DONE]\n\n'
    ];

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: createMockStream(mockChunks)
    });

    const results = [];
    for await (const part of client.streamCompletion('test-model', [])) {
      results.push(part);
    }

    expect(results).toContainEqual({ 
      kind: 'usage', 
      promptTokens: 10, 
      completionTokens: 5, 
      totalTokens: 15 
    });
  });

  it('should throw ContextOverflowError on context exceeded message', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      text: jest.fn().mockResolvedValue('Context size has been exceeded')
    });

    try {
      for await (const _ of client.streamCompletion('test-model', [])) {}
      throw new Error('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ContextOverflowError);
    }
  });

  it('should throw APIError for other HTTP errors', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue('Internal Server Error')
    });

    try {
      for await (const _ of client.streamCompletion('test-model', [])) {}
      throw new Error('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(APIError);
    }
  });

  it('should handle malformed JSON in SSE stream', async () => {
    const mockChunks = [
      'data: {invalid json}\n\n',
      'data: {"choices": [{"index": 0, "delta": {"content": "Ok"}, "finish_reason": "stop"}]}\n\n'
    ];

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: createMockStream(mockChunks)
    });

    const results = [];
    for await (const part of client.streamCompletion('test-model', [])) {
      results.push(part);
    }

    expect(results).toContainEqual({ kind: 'text', content: 'Ok' });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to parse SSE chunk'));
  });

  it('should handle API errors inside stream', async () => {
    const mockChunks = [
      'data: {"error": {"message": "Context size has been exceeded"}}\n\n'
    ];

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: createMockStream(mockChunks)
    });

    try {
      for await (const _ of client.streamCompletion('test-model', [])) {}
      throw new Error('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ContextOverflowError);
    }
  });

  it('should use configured temperature in request body', async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key, defaultValue) => {
        if (key === 'temperature') return 0.5;
        return defaultValue;
      })
    });

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: createMockStream(['data: [DONE]\n\n'])
    });

    for await (const _ of client.streamCompletion('test-model', [])) {}

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.temperature).toBe(0.5);
  });

  it('should allow overriding temperature per request', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      body: createMockStream(['data: [DONE]\n\n'])
    });

    for await (const _ of client.streamCompletion('test-model', [], undefined, 0.2)) {}

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.temperature).toBe(0.2);
  });

  describe('AbortSignal', () => {
    it('should forward signal to fetch', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        body: createMockStream(['data: [DONE]\n\n'])
      });

      const controller = new AbortController();
      for await (const _ of client.streamCompletion('test-model', [], undefined, undefined, controller.signal)) {}

      const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(fetchCall[1].signal).toBe(controller.signal);
    });

    it('should end the generator cleanly when fetch is aborted', async () => {
      const abortError = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      (global.fetch as jest.Mock).mockRejectedValue(abortError);

      const parts: any[] = [];
      for await (const part of client.streamCompletion('test-model', [], undefined, undefined, new AbortController().signal)) {
        parts.push(part);
      }

      expect(parts).toHaveLength(0);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('warmModel', () => {
    it('should send a non-streaming request with max_tokens 1', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

      await client.warmModel('my-model');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toContain('/v1/chat/completions');
      const body = JSON.parse(init.body);
      expect(body.model).toBe('my-model');
      expect(body.stream).toBe(false);
      expect(body.max_tokens).toBe(1);
    });

    it('should swallow fetch errors without throwing', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(client.warmModel('my-model')).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('pre-flight failed'));
    });

    it('should swallow non-OK responses without throwing', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 503 });

      await expect(client.warmModel('my-model')).resolves.toBeUndefined();
    });
  });
});

function createMockStream(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (index < chunks.length) {
          return { done: false, value: encoder.encode(chunks[index++]) };
        }
        return { done: true, value: undefined };
      }
    })
  };
}
