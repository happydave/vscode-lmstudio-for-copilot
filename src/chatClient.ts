import * as vscode from 'vscode';
import { ConnectionError, TimeoutError, ContextOverflowError, APIError, ParseError } from './errors';

/**
 * Chat message for LM Studio API.
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * A tool definition in OpenAI function-calling format.
 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: object;
  };
}

/**
 * A part yielded by the streaming completion generator.
 */
export type StreamPart =
  | { kind: 'text'; content: string }
  | { kind: 'toolCall'; id: string; name: string; arguments: string }
  | { kind: 'usage'; promptTokens: number; completionTokens: number; totalTokens: number };

/**
 * Request body for LM Studio chat completion endpoint.
 */
interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
}

/**
 * A single chunk from an SSE streaming chat completion response.
 */
interface StreamingChunk {
  id?: string;
  object?: string;
  choices: Array<{
    index: number;
    delta: {
      content?: string;
      role?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
}

/**
 * Final response from chat completion (when stream=false).
 */
export interface ChatCompletionResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * ChatClient handles communication with LM Studio's OpenAI-compatible chat endpoint.
 * Supports both streaming (SSE) and non-streaming responses.
 */
export class ChatClient {
  private static readonly DEFAULT_TEMPERATURE = 0.7;

  private readonly logger: vscode.LogOutputChannel;
  private host: string = 'localhost';
  private port: number = 1234;
  private requestTimeout: number = 0; // 0 = no timeout
  private showReasoningContent: boolean = true;

  constructor(logger: vscode.LogOutputChannel) {
    this.logger = logger;
    this.loadConfiguration();
  }

  /**
   * Load configuration settings from VS Code.
   */
  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration('lmStudioCopilot');
    this.showReasoningContent = config.get<boolean>('showReasoningContent', true);
    this.logger.trace(`ChatClient showReasoningContent: ${this.showReasoningContent}`);
  }

  /**
   * Update the showReasoningContent setting dynamically.
   */
  public updateConfiguration(): void {
    const config = vscode.workspace.getConfiguration('lmStudioCopilot');
    this.showReasoningContent = config.get<boolean>('showReasoningContent', true);
    this.logger.trace(`ChatClient showReasoningContent updated: ${this.showReasoningContent}`);
  }

  /**
   * Set the LM Studio server host.
   */
  public setHost(host: string): void {
    this.host = host;
    this.logger.trace(`ChatClient host set to ${host}`);
  }

  /**
   * Set the LM Studio server port.
   */
  public setPort(port: number): void {
    this.port = port;
    this.logger.trace(`ChatClient port set to ${port}`);
  }

  /**
   * Set the request timeout in milliseconds.
   */
  public setRequestTimeout(timeout: number): void {
    this.requestTimeout = timeout;
    this.logger.trace(`ChatClient request timeout set to ${timeout}ms`);
  }

  /**
   * Send a chat request to LM Studio and receive streaming completion.
   * Returns an async generator that yields completion chunks as they arrive.
   * 
   * @param modelId The ID of the model to use for completion
   * @param messages Array of chat messages (user, assistant, system)
   */
  public async* streamCompletion(
    modelId: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[]
  ): AsyncGenerator<StreamPart> {
    this.logger.debug(`Streaming completion request for model ${modelId}`);
    
    // Reload configuration at start of each request
    this.loadConfiguration();

    const request: ChatCompletionRequest = {
      model: modelId,
      messages,
      stream: true,
      temperature: ChatClient.DEFAULT_TEMPERATURE,
      max_tokens: -1, // Use model default
      ...(tools && tools.length > 0 ? { tools } : {})
    };

    this.logger.debug(`streamCompletion: ${messages.length} messages, ${tools?.length ?? 0} tools`);
    this.logger.trace(`streamCompletion request body: ${JSON.stringify(request)}`);

    try {
      const url = `http://${this.host}:${this.port}/v1/chat/completions`;
      this.logger.debug(`POST ${url}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request),
        signal: this.requestTimeout > 0 ? AbortSignal.timeout(this.requestTimeout) : undefined
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`LM Studio returned HTTP ${response.status}: ${errorText}`);
        
        if (errorText.includes('Context size has been exceeded')) {
          throw new ContextOverflowError(errorText);
        }
        
        throw new APIError(`HTTP ${response.status}: ${errorText}`, response.status);
      }

      this.logger.debug(`Response status: ${response.status}, content-type: ${response.headers?.get('content-type')}`);

      if (!response.body) {
        throw new Error('Response body is null');
      }

      // Parse SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let totalChunks = 0;
      let totalYielded = 0;
      let contentDeltas = 0;
      let reasoningDeltas = 0;

      // Accumulated tool call fragments keyed by delta index
      const toolCallAccumulator = new Map<number, { id: string; name: string; arguments: string }>();

      this.logger.debug(`SSE stream started`);

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          this.logger.debug(`SSE stream ended (done=true) after ${totalChunks} chunks, ${totalYielded} text yields`);
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        
        // Process complete SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          // SSE events are prefixed with "data: "
          const dataMatch = line.match(/^data:\s*(.*)$/);
          if (!dataMatch) {
            continue;
          }

          const rawData = dataMatch[1].trim();
          this.logger.trace(`SSE raw: ${rawData.slice(0, 300)}`);

          // The stream ends with the [DONE] sentinel
          if (rawData === '[DONE]') {
            for (const [, tc] of toolCallAccumulator) {
              yield { kind: 'toolCall', id: tc.id, name: tc.name, arguments: tc.arguments };
            }
            return;
          }

          try {
            const parsed = JSON.parse(rawData) as StreamingChunk & { 
              error?: { message?: string },
              usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
            };
            totalChunks++;

            if (parsed.error) {
              this.logger.error(`LM Studio error in stream: ${parsed.error.message}`);
              const msg = parsed.error.message ?? 'Unknown LM Studio error';
              if (msg.includes('Context size has been exceeded')) {
                throw new ContextOverflowError(msg);
              }
              throw new APIError(msg, 400); // SSE errors are usually 400s or 500s
            }

            // Yield usage data if present (often in the final chunk)
            if (parsed.usage) {
              yield { 
                kind: 'usage', 
                promptTokens: parsed.usage.prompt_tokens, 
                completionTokens: parsed.usage.completion_tokens,
                totalTokens: parsed.usage.total_tokens
              };
            }

            const chunk = parsed;

            for (const choice of chunk.choices) {
              // Accumulate tool call fragments
              if (choice.delta?.tool_calls) {
                for (const tc of choice.delta.tool_calls) {
                  const existing = toolCallAccumulator.get(tc.index) ?? { id: '', name: '', arguments: '' };
                  toolCallAccumulator.set(tc.index, {
                    id: existing.id || (tc.id ?? ''),
                    name: existing.name + (tc.function?.name ?? ''),
                    arguments: existing.arguments + (tc.function?.arguments ?? '')
                  });
                }
              }

              // Yield reasoning/thinking tokens if enabled and present
              const reasoningContent = (choice.delta as any)?.reasoning_content as string | undefined;
              if (this.showReasoningContent && reasoningContent) {
                reasoningDeltas++;
                totalYielded++;
                yield { kind: 'text', content: reasoningContent };
              }

              if (choice.delta?.content) {
                contentDeltas++;
                totalYielded++;
                yield { kind: 'text', content: choice.delta.content };
              }

              if (choice.finish_reason !== null) {
                this.logger.debug(`Stream complete: finish_reason=${choice.finish_reason}, chunks=${totalChunks}, content_deltas=${contentDeltas}, reasoning_deltas=${reasoningDeltas}, yields=${totalYielded}, tools=${toolCallAccumulator.size}`);
                for (const [, tc] of toolCallAccumulator) {
                  yield { kind: 'toolCall', id: tc.id, name: tc.name, arguments: tc.arguments };
                }
                return;
              }
            }
          } catch (jsonError) {
            this.logger.warn(`Failed to parse SSE chunk (${jsonError}): ${rawData.slice(0, 200)}`);
            continue;
          }
        }
      }

    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (error instanceof ContextOverflowError || error instanceof APIError) {
        throw error;
      }

      this.logger.error(`Chat completion streaming failed: ${errorMessage}`);

      // Check for fetch/network errors
      if (error.name === 'AbortError' || errorMessage.includes('terminated') || errorMessage.includes('timed out')) {
        throw new TimeoutError(this.requestTimeout);
      }
      
      if (errorMessage.includes('fetch failed') || errorMessage.includes('ECONNREFUSED')) {
        throw new ConnectionError(errorMessage, error);
      }

      // Re-throw as generic LMStudioError if not already specialized
      throw new APIError(`LM Studio chat error: ${errorMessage}`, 500);
    }
  }

  /**
   * Send a non-streaming chat request and receive complete response.
   * This is less efficient for inline suggestions but useful for debugging.
   */
  public async completion(
    modelId: string,
    messages: ChatMessage[]
  ): Promise<{ content: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    this.logger.debug(`Non-streaming completion request for model ${modelId}`);

    const request: ChatCompletionRequest = {
      model: modelId,
      messages,
      stream: false,
      temperature: ChatClient.DEFAULT_TEMPERATURE,
      max_tokens: -1
    };

    try {
      const url = `http://${this.host}:${this.port}/v1/chat/completions`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request),
        signal: this.requestTimeout > 0 ? AbortSignal.timeout(this.requestTimeout) : undefined
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (errorText.includes('Context size has been exceeded')) {
          throw new ContextOverflowError(errorText);
        }
        throw new APIError(`HTTP status ${response.status}: ${errorText}`, response.status);
      }

      const result = await response.json() as ChatCompletionResponse;
      
      if (result.choices && result.choices.length > 0) {
        return {
          content: result.choices[0].message.content,
          usage: result.usage ? {
            promptTokens: result.usage.prompt_tokens,
            completionTokens: result.usage.completion_tokens,
            totalTokens: result.usage.total_tokens
          } : undefined
        };
      }

      throw new ParseError('No choices in chat completion response');

    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (error instanceof ContextOverflowError || error instanceof APIError || error instanceof ParseError) {
        throw error;
      }

      this.logger.error(`Chat completion failed: ${errorMessage}`);
      
      if (error.name === 'AbortError' || errorMessage.includes('terminated') || errorMessage.includes('timed out')) {
        throw new TimeoutError(this.requestTimeout);
      }

      if (errorMessage.includes('fetch failed') || errorMessage.includes('ECONNREFUSED')) {
        throw new ConnectionError(errorMessage, error);
      }

      throw new APIError(errorMessage, 500);
    }
  }

  /**
   * Build a prompt from the current document context for inline suggestions.
   */
  public buildInlinePrompt(documentText: string, cursorPosition: number): string {
    const lines = documentText.split('\n');
    
    // Get current line and up to 3 preceding lines as context
    let contextStart = Math.max(0, cursorPosition - 150);
    const contextEnd = cursorPosition;

    const contextLines = lines.slice(contextStart, cursorPosition + 1);
    const currentLine = contextLines[contextLines.length - 1] || '';

    // Build prompt with context
    return `Current line: ${currentLine}\nPrevious lines:\n${contextLines.slice(0, -1).reverse().join('\n')}`;
  }
}
