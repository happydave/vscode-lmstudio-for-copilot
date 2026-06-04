import * as vscode from 'vscode';
import { LMStudioCopilotProvider } from '../src/copilotProvider';
import { ModelManager } from '../src/modelManager';
import { ChatClient } from '../src/chatClient';
import { Tokenizer } from '../src/tokenizer';
import { RequestBuilder } from '../src/requestBuilder';
import { ContextManager } from '../src/contextManager';

describe('LMStudioCopilotProvider', () => {
  let provider: LMStudioCopilotProvider;
  let mockLogger: any;
  let mockModelManager: any;
  let mockChatClient: any;
  let mockTokenizer: any;
  let mockRequestBuilder: any;
  let mockContextManager: any;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      trace: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };
    mockModelManager = {
      getAvailableModels: jest.fn().mockReturnValue([{ id: 'test-model', loadedContextLength: 4096 }]),
      getCopilotEnabledModels: jest.fn().mockReturnValue([{ id: 'test-model', loadedContextLength: 4096 }]),
      getActiveModelId: jest.fn().mockReturnValue('test-model')
    };
    mockChatClient = {
      streamCompletion: jest.fn(),
      warmModel: jest.fn().mockResolvedValue(undefined)
    };
    mockTokenizer = {
      recordObservation: jest.fn(),
      detectFamily: jest.fn()
    };
    mockRequestBuilder = {
      buildRequest: jest.fn().mockReturnValue({
        chatMessages: [{ role: 'user', content: 'test' }],
        tools: [],
        totalCharsSent: 100,
        effectiveLimit: 4096
      })
    };
    mockContextManager = {
      buildContext: jest.fn().mockResolvedValue('context')
    };

    provider = new LMStudioCopilotProvider(
      mockLogger,
      mockModelManager,
      mockChatClient,
      mockTokenizer,
      mockRequestBuilder,
      mockContextManager
    );
  });

  it('should provide model information', async () => {
    const info = await provider.provideLanguageModelChatInformation({} as any, {} as any);
    expect(info.length).toBe(1);
    expect(info[0].id).toBe('lmstudio-test-model');
  });

  it('should stream response and report progress', async () => {
    const mockStream = (async function* () {
      yield { kind: 'text', content: 'Hello' };
      yield { kind: 'usage', promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    })();
    mockChatClient.streamCompletion.mockReturnValue(mockStream);

    const progress = { report: jest.fn() };
    const model = { id: 'lmstudio-test-model' } as any;
    const messages = [] as any;
    const options = {} as any;
    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }) } as any;

    await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

    expect(progress.report).toHaveBeenCalledWith(expect.any(vscode.LanguageModelTextPart));
    expect(mockTokenizer.recordObservation).toHaveBeenCalledWith('lmstudio-test-model', 100, 10);
  });

  it('should handle XML tool calls', async () => {
    const mockStream = (async function* () {
      yield { kind: 'text', content: '<tool_call>{"name": "test_tool", "arguments": {"x": 1}}</tool_call>' };
    })();
    mockChatClient.streamCompletion.mockReturnValue(mockStream);

    const progress = { report: jest.fn() };
    const model = { id: 'lmstudio-test-model' } as any;
    const messages = [] as any;
    const options = {} as any;
    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }) } as any;

    await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

    expect(progress.report).toHaveBeenCalledWith(expect.any(vscode.LanguageModelToolCallPart));
    const toolCall = (progress.report.mock.calls.find(c => c[0] instanceof vscode.LanguageModelToolCallPart) as any)[0];
    expect(toolCall.name).toBe('test_tool');
    expect(toolCall.input).toEqual({ x: 1 });
  });

  it('should pass model temperature override if configured', async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key, defaultValue) => {
        if (key === 'modelTemperatures') return { 'test-model': 0.1 };
        return defaultValue;
      })
    });

    const mockStream = (async function* () {
      yield { kind: 'text', content: 'Hi' };
    })();
    mockChatClient.streamCompletion.mockReturnValue(mockStream);

    const progress = { report: jest.fn() };
    const model = { id: 'lmstudio-test-model' } as any;
    const messages = [] as any;
    const options = {} as any;
    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }) } as any;

    await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

    expect(mockChatClient.streamCompletion).toHaveBeenCalledWith(
      'lmstudio-test-model',
      expect.any(Array),
      undefined,
      0.1,
      expect.any(AbortSignal)
    );
  });
  it('should detect and halt tool-call loops', async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key, defaultValue) => {
        if (key === 'loopDetection.enabled') return true;
        if (key === 'loopDetection.consecutiveCallThreshold') return 2;
        return defaultValue;
      })
    });

    const mockStream = (async function* () {
      // First call
      yield { kind: 'text', content: '<tool_call>{"name": "test_tool", "arguments": {"x": 1}}</tool_call>' };
      // Second call (identical) - should trigger detection
      yield { kind: 'text', content: '<tool_call>{"name": "test_tool", "arguments": {"x": 1}}</tool_call>' };
      // Third call - should never be reached if detection works
      yield { kind: 'text', content: 'This should be blocked' };
    })();
    mockChatClient.streamCompletion.mockReturnValue(mockStream);

    const progress = { report: jest.fn() };
    const model = { id: 'lmstudio-test-model' } as any;
    const messages = [] as any;
    const options = {} as any;
    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }) } as any;

    await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

    // Should have reported: 1 tool call, 1 loop error message
    expect(progress.report).toHaveBeenCalledWith(expect.any(vscode.LanguageModelToolCallPart));
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({
      value: expect.stringContaining('[Loop detected')
    }));
    
    // Should NOT have reported 'This should be blocked'
    const textParts = progress.report.mock.calls
      .filter(c => c[0] instanceof vscode.LanguageModelTextPart)
      .map(c => c[0].value);
    expect(textParts).not.toContain('This should be blocked');
  });

  it('should detect and halt native tool-call loops', async () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key, defaultValue) => {
        if (key === 'loopDetection.enabled') return true;
        if (key === 'loopDetection.consecutiveCallThreshold') return 2;
        return defaultValue;
      })
    });

    const mockStream = (async function* () {
      yield { kind: 'toolCall', id: 'c1', name: 't1', arguments: '{"x":1}' };
      yield { kind: 'toolCall', id: 'c2', name: 't1', arguments: '{"x":1}' };
      yield { kind: 'text', content: 'Blocked' };
    })();
    mockChatClient.streamCompletion.mockReturnValue(mockStream);

    const progress = { report: jest.fn() };
    const model = { id: 'lmstudio-test-model' } as any;
    const messages = [] as any;
    const options = {} as any;
    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }) } as any;

    await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);

    expect(progress.report).toHaveBeenCalledWith(expect.any(vscode.LanguageModelToolCallPart));
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({
      value: expect.stringContaining('[Loop detected')
    }));
    
    const textParts = progress.report.mock.calls
      .filter(c => c[0] instanceof vscode.LanguageModelTextPart)
      .map(c => c[0].value);
    expect(textParts).not.toContain('Blocked');
  });

  it('should notify models changed', () => {
    mockModelManager.getCopilotEnabledModels.mockReturnValue([{ id: 'model-a' }]);
    provider.notifyModelsChanged();
    expect(mockModelManager.getCopilotEnabledModels).toHaveBeenCalled();
  });

  it('should handle errors in provideLanguageModelChatResponse', async () => {
    mockRequestBuilder.buildRequest.mockImplementation(() => { throw new Error('Test Error'); });
    const progress = { report: jest.fn() };
    const model = { id: 'lmstudio-test-model' } as any;
    const messages = [] as any;
    const options = {} as any;
    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }) } as any;

    await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Test Error'));
  });

  it('should call warmModel before streaming', async () => {
    const mockStream = (async function* () {
      yield { kind: 'text', content: 'Hello' };
    })();
    mockChatClient.streamCompletion.mockReturnValue(mockStream);

    const progress = { report: jest.fn() };
    const model = { id: 'lmstudio-test-model' } as any;
    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }) } as any;

    await provider.provideLanguageModelChatResponse(model, [], {} as any, progress, token);

    expect(mockChatClient.warmModel).toHaveBeenCalledWith('test-model');
  });

  it('should report TTFT cancellation message when token is cancelled after warm-up', async () => {
    mockChatClient.warmModel.mockImplementation(async () => {
      // simulate token being cancelled by VS Code during warm-up
    });

    const progress = { report: jest.fn() };
    const model = { id: 'lmstudio-test-model' } as any;
    const token = { isCancellationRequested: true, onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }) } as any;

    await provider.provideLanguageModelChatResponse(model, [], {} as any, progress, token);

    const textParts = progress.report.mock.calls
      .filter((c: any[]) => c[0] instanceof vscode.LanguageModelTextPart)
      .map((c: any[]) => c[0].value);
    expect(textParts.some((v: string) => v.includes('cancelled the request before the first token'))).toBe(true);
    expect(mockChatClient.streamCompletion).not.toHaveBeenCalled();
  });

  it('should report TTFT cancellation message when stream yields nothing and token is cancelled', async () => {
    const mockStream = (async function* () {
      // yields nothing — simulates VS Code cancelling before first token arrives
    })();
    mockChatClient.streamCompletion.mockReturnValue(mockStream);

    const progress = { report: jest.fn() };
    const model = { id: 'lmstudio-test-model' } as any;
    const token = { isCancellationRequested: true, onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }) } as any;

    // warmModel completes fine; token is cancelled immediately afterwards
    await provider.provideLanguageModelChatResponse(model, [], {} as any, progress, token);

    const textParts = progress.report.mock.calls
      .filter((c: any[]) => c[0] instanceof vscode.LanguageModelTextPart)
      .map((c: any[]) => c[0].value);
    expect(textParts.some((v: string) => v.includes('cancelled the request before the first token'))).toBe(true);
  });

  it('should pass an AbortSignal to streamCompletion', async () => {
    const mockStream = (async function* () {
      yield { kind: 'text', content: 'Hello' };
    })();
    mockChatClient.streamCompletion.mockReturnValue(mockStream);

    const progress = { report: jest.fn() };
    const model = { id: 'lmstudio-test-model' } as any;
    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }) } as any;

    await provider.provideLanguageModelChatResponse(model, [], {} as any, progress, token);

    const signalArg = mockChatClient.streamCompletion.mock.calls[0][4];
    expect(signalArg).toBeDefined();
    expect(signalArg).toHaveProperty('aborted');
  });

it('should dispose the onCancellationRequested listener after streaming completes', async () => {
    const mockStream = (async function* () {
      yield { kind: 'text', content: 'Hello' };
    })();
    mockChatClient.streamCompletion.mockReturnValue(mockStream);

    const disposable = { dispose: jest.fn() };
    const progress = { report: jest.fn() };
    const model = { id: 'lmstudio-test-model' } as any;
    const token = { isCancellationRequested: false, onCancellationRequested: jest.fn().mockReturnValue(disposable) } as any;

    await provider.provideLanguageModelChatResponse(model, [], {} as any, progress, token);

    expect(disposable.dispose).toHaveBeenCalled();
  });
});
