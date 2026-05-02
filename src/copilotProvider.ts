import * as vscode from 'vscode';
import { ModelManager } from './modelManager';
import { ChatClient, ChatMessage, ToolDefinition } from './chatClient';
import { Tokenizer } from './tokenizer';
import { RequestBuilder } from './requestBuilder';
import { ContextManager } from './contextManager';
import { isContextOverflowError, isConnectionError, isTimeoutError } from './errors';

/**
 * LM Studio Copilot Provider - Implements VS Code's LanguageModelChatProvider interface
 * to make LM Studio models available in Copilot's model selection menu.
 */
export class LMStudioCopilotProvider implements vscode.LanguageModelChatProvider {
  private readonly logger: vscode.LogOutputChannel;
  private readonly modelManager: ModelManager;
  private readonly chatClient: ChatClient;
  private readonly tokenizer: Tokenizer;
  private readonly requestBuilder: RequestBuilder;
  private readonly contextManager: ContextManager;
  private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
  public readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

  constructor(
    logger: vscode.LogOutputChannel,
    modelManager: ModelManager,
    chatClient: ChatClient,
    tokenizer: Tokenizer,
    requestBuilder: RequestBuilder,
    contextManager: ContextManager
  ) {
    this.logger = logger;
    this.modelManager = modelManager;
    this.chatClient = chatClient;
    this.tokenizer = tokenizer;
    this.requestBuilder = requestBuilder;
    this.contextManager = contextManager;
  }

  /**
   * Provide information about available LM Studio models to Copilot.
   */
  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    this.logger.debug(`provideLanguageModelChatInformation called`);

    try {
      const availableModels = this.modelManager.getAvailableModels();
      const activeModelId = this.modelManager.getActiveModelId();

      this.logger.debug(
        `Providing ${availableModels.length} models to Copilot (active: ${activeModelId})`
      );

      const modelInfo: vscode.LanguageModelChatInformation[] = availableModels
        .map((model) => {
          const totalContext = model.loadedContextLength ?? model.maxContextLength ?? 4096;
          // Reserve room for large code generation (up to 32k) while keeping total display accurate
          const outputReservation = Math.min(32768, Math.floor(totalContext / 4));
          
          return {
            id: model.id,
            name: model.id,
            family: 'lmstudio-local',
            version: '1',
            maxInputTokens: totalContext - outputReservation,
            maxOutputTokens: outputReservation,
            capabilities: { toolCalling: true }
          } satisfies vscode.LanguageModelChatInformation;
        });

      return modelInfo;
    } catch (error) {
      this.logger.error(`Error providing model information: ${error}`);
      return [];
    }
  }

  /**
   * Notify VS Code that the set of available models has changed.
   * Must be called whenever model discovery updates the model list.
   */
  private lastModelIds: string = '';

  /**
   * Notify VS Code that the set of available models has changed.
   * Only fires the event if the model set has actually changed since the last call.
   */
  public notifyModelsChanged(): void {
    const currentIds = this.modelManager.getAvailableModels().map(m => m.id).sort().join(',');
    if (currentIds !== this.lastModelIds) {
      this.lastModelIds = currentIds;
      this._onDidChangeLanguageModelChatInformation.fire();
    }
  }

  /**
   * Handle chat requests from Copilot and stream responses from LM Studio.
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    this.logger.debug(`provideLanguageModelChatResponse: model=${model.id}, messages=${messages.length}, tools=${options.tools?.length ?? 0}`);

    // 1. Gather workspace context (async, non-blocking — empty string if disabled or unavailable)
    const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    const workspaceContext = await this.contextManager.buildContext(activeFilePath, model.id);

    // 2. Prepare request using RequestBuilder
    const activeModel = this.modelManager.getAvailableModels().find(m => m.id === model.id);
    const { 
      chatMessages, 
      tools, 
      totalCharsSent, 
      effectiveLimit 
    } = this.requestBuilder.buildRequest(messages, options, model, activeModel, workspaceContext);

    // 2. Execute streaming completion request
    const streamingPath = (async () => {
      if (chatMessages.length === 0) {
        this.logger.warn(`Path A: no converted messages to send`);
        return 0;
      }
      let count = 0;

      // Buffer used to detect <tool_call>...</tool_call> XML emitted by models
      // that use the Qwen/Mistral XML tool-call format instead of structured deltas.
      let textBuffer = '';
      let inToolCall = false;
      let toolCallBuffer = '';
      let toolCallSeq = 0;
      const OPEN_TAG = '<tool_call>';
      const CLOSE_TAG = '</tool_call>';

      const flushTextBuffer = (buf: string) => {
        if (buf) {
          count++;
          progress.report(new vscode.LanguageModelTextPart(buf));
        }
      };

      const parseToolCallBody = (raw: string): { name: string; input: object } | null => {
        const trimmed = raw.trim();

        // Format 1: JSON {"name": "...", "arguments": {...}}
        if (trimmed.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmed) as { name?: string; arguments?: unknown };
            return {
              name: parsed.name ?? 'unknown',
              input: (typeof parsed.arguments === 'object' && parsed.arguments !== null)
                ? parsed.arguments as object
                : {}
            };
          } catch {
            return null;
          }
        }

        // Format 2: <function=name><parameter=x>value</parameter>...</function>
        // Used by models trained on the VS Code Copilot system prompt format.
        const funcMatch = trimmed.match(/<function=([^>\s]+)/);
        if (funcMatch) {
          const name = funcMatch[1].trim();
          const input: Record<string, string> = {};
          const paramRegex = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;
          let m: RegExpExecArray | null;
          while ((m = paramRegex.exec(trimmed)) !== null) {
            input[m[1].trim()] = m[2].trim();
          }
          return { name, input };
        }

        return null;
      };

      const emitToolCall = (raw: string) => {
        const result = parseToolCallBody(raw);
        if (result) {
          const callId = `xml-tool-${++toolCallSeq}`;
          this.logger.debug(`Parsed XML tool call: name=${result.name} callId=${callId} input=${JSON.stringify(result.input).slice(0, 200)}`);
          count++;
          progress.report(new vscode.LanguageModelToolCallPart(callId, result.name, result.input));
        } else {
          this.logger.warn(`Failed to parse <tool_call> body — raw: ${raw.slice(0, 200)}`);
          // Fall back to emitting as text so content isn't lost
          flushTextBuffer(`<tool_call>${raw}</tool_call>`);
        }
      };

      for await (const part of this.chatClient.streamCompletion(model.id, chatMessages, tools.length > 0 ? tools : undefined)) {
        if (token.isCancellationRequested) { break; }

        if (part.kind === 'usage') {
          this.tokenizer.recordObservation(model.id, totalCharsSent, part.promptTokens);
          continue;
        }

        if (part.kind !== 'text') {
          // Native structured tool call delta — emit directly
          let inputObj: object;
          try { inputObj = JSON.parse(part.arguments) as object; }
          catch { inputObj = {}; }
          count++;
          progress.report(new vscode.LanguageModelToolCallPart(part.id, part.name, inputObj));
          continue;
        }

        textBuffer += part.content;

        // Process buffer, scanning for <tool_call> / </tool_call> tags
        while (true) {
          if (!inToolCall) {
            const start = textBuffer.indexOf(OPEN_TAG);
            if (start === -1) {
              // No open tag — safe to flush all but the last few chars (partial tag guard)
              const safe = textBuffer.length > OPEN_TAG.length
                ? textBuffer.slice(0, textBuffer.length - OPEN_TAG.length)
                : '';
              flushTextBuffer(safe);
              textBuffer = textBuffer.slice(safe.length);
              break;
            }
            // Flush text before the tag, then enter tool-call mode
            flushTextBuffer(textBuffer.slice(0, start));
            textBuffer = textBuffer.slice(start + OPEN_TAG.length);
            inToolCall = true;
            toolCallBuffer = '';
          } else {
            const end = textBuffer.indexOf(CLOSE_TAG);
            if (end === -1) {
              // Still inside <tool_call> — accumulate
              toolCallBuffer += textBuffer;
              textBuffer = '';
              break;
            }
            toolCallBuffer += textBuffer.slice(0, end);
            textBuffer = textBuffer.slice(end + CLOSE_TAG.length);
            inToolCall = false;
            emitToolCall(toolCallBuffer);
            toolCallBuffer = '';
          }
        }
      }

      // Flush any remaining buffered text
      if (inToolCall) {
        // Unclosed tag — emit raw so content isn't lost
        flushTextBuffer(`${OPEN_TAG}${toolCallBuffer}`);
      }
      flushTextBuffer(textBuffer);

      return count;
    })();



    let streamCount: number;

    try {
      streamCount = await streamingPath;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Streaming path threw: ${errorMessage}`);
      
      if (isContextOverflowError(error)) {
        progress.report(new vscode.LanguageModelTextPart(`[Context overflow: the conversation is too long for this model's context window (${effectiveLimit} tokens). Try starting a new chat.]`));
      } else if (isTimeoutError(error)) {
        progress.report(new vscode.LanguageModelTextPart(`\n\n[LM Studio error: Request timed out. The model might be too slow for this task or LM Studio is unresponsive.]`));
      } else if (isConnectionError(error)) {
        progress.report(new vscode.LanguageModelTextPart(`\n\n[LM Studio error: Could not connect to LM Studio. Ensure the server is running at ${vscode.workspace.getConfiguration('lmStudioCopilot').get('serverHost')}:${vscode.workspace.getConfiguration('lmStudioCopilot').get('serverPort')}.]`));
      } else {
        progress.report(new vscode.LanguageModelTextPart(`\n\n[LM Studio error: ${errorMessage}]`));
      }
      return;
    }

    this.logger.debug(`Path A yielded ${streamCount} parts`);

    // If streaming produced nothing, surface an error to the user
    if (streamCount === 0 && !token.isCancellationRequested) {
      this.logger.warn(`Path A yielded nothing; reporting no response.`);
      progress.report(new vscode.LanguageModelTextPart(`[No response from LM Studio — model generated no content]`));
    }
  }

  /**
   * Estimate token count for a message or text.
   * This is a rough estimate since we don't have access to LM Studio's tokenizer.
   */
  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    let content: string;

    if (typeof text === 'string') {
      content = text;
    } else {
      content = text.content
        .map(part => {
          if (part instanceof vscode.LanguageModelTextPart) {
            return part.value;
          }
          return '';
        })
        .join('');
    }

    // Use model-aware tokenizer for more accurate count
    const activeModel = this.modelManager.getAvailableModels().find(m => m.id === model.id);
    const family = this.tokenizer.detectFamily(model.id, activeModel?.architecture);
    const estimatedTokens = this.tokenizer.estimateTokens(content, model.id, family);

    this.logger.trace(`Token count estimate for model ${model.id}: ${estimatedTokens}`);

    return estimatedTokens;
  }
}
