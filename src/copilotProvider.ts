import * as vscode from 'vscode';
import { ModelManager } from './modelManager';
import { ChatClient, ChatMessage, ToolDefinition } from './chatClient';

/**
 * LM Studio Copilot Provider - Implements VS Code's LanguageModelChatProvider interface
 * to make LM Studio models available in Copilot's model selection menu.
 */
export class LMStudioCopilotProvider implements vscode.LanguageModelChatProvider {
  private readonly logger: vscode.LogOutputChannel;
  private readonly modelManager: ModelManager;
  private readonly chatClient: ChatClient;
  private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
  public readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

  constructor(
    logger: vscode.LogOutputChannel,
    modelManager: ModelManager,
    chatClient: ChatClient
  ) {
    this.logger = logger;
    this.modelManager = modelManager;
    this.chatClient = chatClient;
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
        .map((model) => ({
          id: model.id,
          name: model.id,
          family: 'lmstudio-local',
          version: '1',
          maxInputTokens: model.maxContextLength ?? 4096,
          maxOutputTokens: model.maxContextLength ?? 4096,
          capabilities: { toolCalling: true }
        } satisfies vscode.LanguageModelChatInformation));

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

    // Log raw incoming message structure
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const partTypes = msg.content.map((p: unknown) => (p as object).constructor?.name ?? typeof p).join(', ');
      this.logger.debug(`  msg[${i}] role=${msg.role} parts=${msg.content.length} types=[${partTypes}]`);
    }

    // --- System prompt guidance for native tool usage ---
    // Only inject this fallback guidance when no real tools are being forwarded.
    // When options.tools is non-empty, the tools are sent to LM Studio directly and
    // the model will discover them from the tool definitions; injecting a separate
    // system prompt listing a subset of tool names causes conflicts.
    const config = vscode.workspace.getConfiguration('lmStudioCopilot');
    const enableToolGuidance = config.get<boolean>('toolGuidanceEnabled', true);
    const hasRealTools = (options.tools?.length ?? 0) > 0;
    let systemPrompt: string | undefined;

    if (enableToolGuidance && !hasRealTools) {
      systemPrompt = `You are an AI programming assistant integrated with VS Code. You have access to native tools for file operations that trigger VS Code diff tracking:\n\n- create_file: Create new files with content (triggers VS Code diff tracking)\n- replace_string_in_file: Edit existing files by replacing text blocks (preferred for most edits)\n- insert_edit_into_file: Insert code into files when replacements fail\n\nWhen writing or modifying files, prefer using these tools over shell commands. Shell commands bypass VS Code's file system and will not show diffs in the editor.`;
      this.logger.debug('System prompt guidance enabled (no real tools forwarded)');
    } else if (hasRealTools) {
      this.logger.debug(`Skipping system prompt guidance: ${options.tools!.length} real tools will be forwarded`);
    }

    // --- Path A: full message conversion ---
    let chatMessages: ChatMessage[] = [];
    let conversionError: string | undefined;

    try {
      // Add system prompt if configured
      if (systemPrompt) {
        chatMessages.push({ role: 'system', content: systemPrompt });
      }

      for (const msg of messages) {
        if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
          const textParts: string[] = [];
          const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];

          for (const part of msg.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
              textParts.push(part.value);
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
              toolCalls.push({
                id: part.callId,
                type: 'function',
                function: { name: part.name, arguments: JSON.stringify(part.input) }
              });
            }
          }

          const assistantMsg: ChatMessage = { role: 'assistant', content: textParts.join('') || null };
          if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls;
          }
          chatMessages.push(assistantMsg);

        } else {
          // User role: split tool results and text into separate messages
          const textParts: string[] = [];

          for (const part of msg.content) {
            if (part instanceof vscode.LanguageModelToolResultPart) {
              const resultContent = part.content
                .map(p => p instanceof vscode.LanguageModelTextPart ? p.value : '')
                .join('');
              chatMessages.push({ role: 'tool', content: resultContent, tool_call_id: part.callId });
            } else if (part instanceof vscode.LanguageModelTextPart) {
              textParts.push(part.value);
            }
          }

          const text = textParts.join('');
          if (text) {
            chatMessages.push({ role: 'user', content: text });
          }
        }
      }
    } catch (err) {
      conversionError = err instanceof Error ? err.message : String(err);
      this.logger.error(`Message conversion error: ${conversionError}`);
      chatMessages = [];
    }

    this.logger.debug(`Path A: converted ${messages.length} VS Code messages → ${chatMessages.length} LM Studio messages`);
    for (let i = 0; i < chatMessages.length; i++) {
      const m = chatMessages[i];
      const preview = typeof m.content === 'string' ? m.content.slice(0, 100) : '(null)';
      this.logger.debug(`  chatMsg[${i}] role=${m.role} tool_calls=${m.tool_calls?.length ?? 0} content=${JSON.stringify(preview)}`);
    }

    // Truncate chatMessages from the front if estimated token count exceeds model limit.
    // Keep the last N messages so the most recent context is preserved.
    const maxInputTokens = model.maxInputTokens ?? 4096;
    const tokenBudget = Math.floor(maxInputTokens * 0.75);
    let estimatedTotal = chatMessages.reduce((sum, m) => sum + Math.ceil((m.content?.length ?? 0) / 4), 0);
    while (chatMessages.length > 1 && estimatedTotal > tokenBudget) {
      const removed = chatMessages.shift()!;
      estimatedTotal -= Math.ceil((removed.content?.length ?? 0) / 4);
      this.logger.debug(`Path A: dropped oldest message to fit token budget (≈${estimatedTotal}/${tokenBudget} tokens remaining)`);
    }
    this.logger.debug(`Path A: sending ${chatMessages.length} messages, ≈${estimatedTotal} tokens (budget: ${tokenBudget})`);

    // --- Path B: simple flat-text fallback (runs in parallel for diagnostics) ---
    // Extracts all text from incoming messages ignoring structure, sends as a single user turn.
    const simpleText = messages
      .flatMap(msg => msg.content)
      .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
      .map(p => p.value)
      .join('\n')
      .trim();

    // Truncate if too long (rough estimate: 4 chars per token, keep ~75% of context)
    const simpleEstimated = Math.ceil(simpleText.length / 4);
    let simpleMessages: ChatMessage[];
    if (simpleEstimated > tokenBudget) {
      this.logger.warn(`Path B: text ≈${simpleEstimated} tokens exceeds budget ${tokenBudget}, truncating`);
      const truncated = simpleText.slice(simpleText.length - Math.floor(simpleText.length * (tokenBudget / simpleEstimated)));
      simpleMessages = [{ role: 'user', content: truncated }];
    } else {
      simpleMessages = simpleText ? [{ role: 'user', content: simpleText }] : [];
    }

    this.logger.debug(`Path B: ${simpleMessages.length} message(s), ≈${simpleEstimated} tokens`);

    // Convert VS Code tool definitions to LM Studio format
    const tools: ToolDefinition[] = (options.tools ?? []).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
      }
    }));
    if (tools.length > 0) {
      this.logger.debug(`Forwarding ${tools.length} tools to LM Studio: ${tools.map(t => t.function.name).join(', ')}`);
    }

    // Run both paths concurrently
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

    const simplePath = (async () => {
      if (simpleMessages.length === 0) { return '(no text to probe)'; }
      try {
        const result = await this.chatClient.completion(model.id, simpleMessages);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Surface context-length errors clearly
        if (msg.includes('n_keep') || msg.includes('n_ctx') || msg.includes('context')) {
          this.logger.error(`Path B: context length error: ${msg}`);
          return `(context overflow: model context is too small for this conversation)`;
        }
        return `(probe error: ${msg})`;
      }
    })();

    let streamCount: number;
    let simpleResult: string;

    try {
      [streamCount, simpleResult] = await Promise.all([streamingPath, simplePath]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Streaming path threw: ${errorMessage}`);
      // Detect context overflow specifically
      if (errorMessage.includes('n_keep') || errorMessage.includes('n_ctx') || errorMessage.includes('context')) {
        progress.report(new vscode.LanguageModelTextPart(`[Context overflow: the conversation is too long for this model's context window (${maxInputTokens} tokens). Try starting a new chat.]`));
      } else {
        progress.report(new vscode.LanguageModelTextPart(`\n\n[LM Studio error: ${errorMessage}]`));
      }
      return;
    }

    this.logger.debug(`Path A yielded ${streamCount} parts`);
    this.logger.debug(`Path B result: ${simpleResult.slice(0, 300)}`);

    // If streaming produced nothing, surface the simple probe result so the user sees something
    if (streamCount === 0 && !token.isCancellationRequested) {
      this.logger.warn(`Path A yielded nothing; surfacing Path B result`);
      if (simpleResult && !simpleResult.startsWith('(')) {
        progress.report(new vscode.LanguageModelTextPart(`[Fallback response]\n${simpleResult}`));
      } else {
        const reason = conversionError ? `conversion error: ${conversionError}` : simpleResult;
        progress.report(new vscode.LanguageModelTextPart(`[No response from LM Studio — ${reason}]`));
      }
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

    // Rough estimate: ~4 characters per token (typical for most models)
    const estimatedTokens = Math.ceil(content.length / 4);

    this.logger.trace(`Token count estimate for model ${model.id}: ${estimatedTokens}`);

    return estimatedTokens;
  }
}
