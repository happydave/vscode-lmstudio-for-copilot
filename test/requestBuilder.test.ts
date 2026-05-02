import * as vscode from 'vscode';
import { RequestBuilder } from '../src/requestBuilder';
import { Tokenizer, ModelFamily } from '../src/tokenizer';
import { ModelInfo } from '../src/discovery';

// Mock VS Code classes that are used with instanceof
(vscode as any).LanguageModelTextPart = class {
  constructor(public value: string) {}
};
(vscode as any).LanguageModelToolCallPart = class {
  constructor(public callId: string, public name: string, public input: any) {}
};
(vscode as any).LanguageModelToolResultPart = class {
  constructor(public callId: string, public content: any[]) {}
};
(vscode as any).LanguageModelChatMessageRole = {
  User: 1,
  Assistant: 2
};

describe('RequestBuilder', () => {
  let requestBuilder: RequestBuilder;
  let mockLogger: any;
  let mockTokenizer: any;
  let mockGlobalState: any;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      trace: jest.fn(),
      error: jest.fn()
    };
    mockGlobalState = {
      get: jest.fn().mockReturnValue({}),
      update: jest.fn()
    };
    mockTokenizer = new Tokenizer(mockLogger, mockGlobalState);
    // Mock detectFamily to return Llama by default
    jest.spyOn(mockTokenizer, 'detectFamily').mockReturnValue(ModelFamily.Llama);
    // Mock estimateTokens to return length / 4
    jest.spyOn(mockTokenizer, 'estimateTokens').mockImplementation(((text: string) => Math.ceil(text.length / 4)) as any);
    
    requestBuilder = new RequestBuilder(mockLogger, mockTokenizer);
    
    // Mock vscode.workspace.getConfiguration
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((key, defaultValue) => {
        if (key === 'toolGuidanceEnabled') return true;
        if (key === 'modelTruncationStrategies') return { '*': 'conservative' };
        if (key === 'truncation.conservativeBuffer') return 15;
        return defaultValue;
      })
    });
  });

  it('should build a basic request', () => {
    const messages: any[] = [
      { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('Hello')] }
    ];
    const options: any = { tools: [] };
    const model: any = { id: 'test-model', maxInputTokens: 4096 };
    const activeModel = new ModelInfo('test-model', 'Test Model', true);

    const result = requestBuilder.buildRequest(messages, options, model, activeModel);

    expect(result.chatMessages.length).toBe(2); // System prompt + User message
    expect(result.chatMessages[0].role).toBe('system');
    expect(result.chatMessages[1].role).toBe('user');
    expect(result.chatMessages[1].content).toBe('Hello');
  });

  it('should handle tool guidance and system prompt', () => {
    const messages: any[] = [];
    const options: any = { tools: [{ name: 'test_tool', description: 'A test tool' }] };
    const model: any = { id: 'test-model', maxInputTokens: 4096 };
    
    const result = requestBuilder.buildRequest(messages, options, model, undefined);

    expect(result.chatMessages[0].content).toContain('test_tool');
    expect(result.tools.length).toBe(1);
    expect(result.tools[0].function.name).toBe('test_tool');
  });

  it('should apply truncation to fit budget', () => {
    // Mock tokenizer to return high token counts to force truncation
    jest.spyOn(mockTokenizer, 'estimateTokens').mockReturnValue(1000);
    
    const messages: any[] = [
      { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('Msg 1')] },
      { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('Msg 2')] },
      { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('Msg 3')] }
    ];
    const options: any = { tools: [] };
    const model: any = { id: 'test-model', maxInputTokens: 2000 }; // Very small budget
    
    // Budget will be 2000 * 0.85 = 1700
    // System prompt = 1000
    // Each message = 1000
    // Only system prompt + 1 message should remain
    
    const result = requestBuilder.buildRequest(messages, options, model, undefined);

    expect(result.chatMessages.length).toBe(2); 
    expect(result.chatMessages[0].role).toBe('system');
    expect(result.chatMessages[1].content).toBe('Msg 3'); // Most recent message kept
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Truncated conversation'));
  });

  it('should convert assistant messages and tool calls', () => {
    const messages: any[] = [
      { 
        role: vscode.LanguageModelChatMessageRole.Assistant, 
        content: [
          new vscode.LanguageModelTextPart('Thinking...'),
          new vscode.LanguageModelToolCallPart('call-1', 'test_tool', { arg: 1 })
        ] 
      }
    ];
    const options: any = { tools: [] };
    const model: any = { id: 'test-model', maxInputTokens: 4096 };

    const result = requestBuilder.buildRequest(messages, options, model, undefined);

    expect(result.chatMessages[1].role).toBe('assistant');
    expect(result.chatMessages[1].content).toBe('Thinking...');
    expect(result.chatMessages[1].tool_calls?.length).toBe(1);
    expect(result.chatMessages[1].tool_calls![0].function.name).toBe('test_tool');
  });

  it('should convert tool results', () => {
    const messages: any[] = [
      { 
        role: vscode.LanguageModelChatMessageRole.User, 
        content: [
          new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('Success')])
        ] 
      }
    ];
    const options: any = { tools: [] };
    const model: any = { id: 'test-model', maxInputTokens: 4096 };

    const result = requestBuilder.buildRequest(messages, options, model, undefined);

    expect(result.chatMessages[1].role).toBe('tool');
    expect(result.chatMessages[1].content).toBe('Success');
    expect(result.chatMessages[1].tool_call_id).toBe('call-1');
  });
});
