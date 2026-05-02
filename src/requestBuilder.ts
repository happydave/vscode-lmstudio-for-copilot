import * as vscode from 'vscode';
import { ChatMessage, ToolDefinition } from './chatClient';
import { ModelInfo } from './discovery';
import { Tokenizer } from './tokenizer';

/**
 * Result of the request building process.
 */
export interface BuiltRequest {
  chatMessages: ChatMessage[];
  tools: ToolDefinition[];
  totalCharsSent: number;
  contextBudget: number;
  estimatedTotalTokens: number;
  effectiveLimit: number;
}

/**
 * RequestBuilder handles the transformation of VS Code language model messages
 * into LM Studio compatible messages, including system prompt injection,
 * tool conversion, and token-aware truncation.
 */
export class RequestBuilder {
  private readonly logger: vscode.LogOutputChannel;
  private readonly tokenizer: Tokenizer;

  constructor(logger: vscode.LogOutputChannel, tokenizer: Tokenizer) {
    this.logger = logger;
    this.tokenizer = tokenizer;
  }

  /**
   * Build a complete request for LM Studio from VS Code parameters.
   */
  public buildRequest(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    model: vscode.LanguageModelChatInformation,
    activeModel: ModelInfo | undefined,
    workspaceContext?: string
  ): BuiltRequest {
    const config = vscode.workspace.getConfiguration('lmStudioCopilot');
    
    // 1. Generate System Prompt
    const systemPrompt = this.generateSystemPrompt(options, config, workspaceContext);

    // 2. Convert VS Code messages to LM Studio format
    let chatMessages = this.convertMessages(messages, systemPrompt);

    // 3. Resolve budget parameters
    const totalLimit = activeModel?.loadedContextLength ?? (model.maxInputTokens + model.maxOutputTokens);
    const outputReservation = Math.min(32768, Math.floor(totalLimit / 4));
    const effectiveLimit = totalLimit - outputReservation;
    const modelFamily = this.tokenizer.detectFamily(model.id, activeModel?.architecture);
    
    const stratMap = config.get<Record<string, string>>('modelTruncationStrategies', { '*': 'conservative' });
    const strategy = stratMap[model.id] || stratMap['*'] || 'conservative';
    const bufferSetting = strategy === 'aggressive' ? 'truncation.aggressiveBuffer' : 'truncation.conservativeBuffer';
    const bufferPercent = config.get<number>(bufferSetting, strategy === 'aggressive' ? 35 : 15);
    const contextBudget = Math.floor(effectiveLimit * (1 - bufferPercent / 100));

    // 4. Convert Tools
    const tools: ToolDefinition[] = (options.tools ?? []).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
      }
    }));

    // 5. Calculate overhead
    const systemPromptTokens = systemPrompt ? this.tokenizer.estimateTokens(systemPrompt, model.id, modelFamily) : 0;
    const toolTokens = this.tokenizer.estimateToolTokens(tools, modelFamily);
    const overheadTokens = systemPromptTokens + toolTokens;
    const messageBudget = contextBudget - overheadTokens;

    this.logger.debug(`Token budget: limit=${effectiveLimit}, strategy=${strategy}, buffer=${bufferPercent}%, contextBudget=${contextBudget}`);
    this.logger.debug(`Overhead: systemPrompt=${systemPromptTokens}, tools=${toolTokens}, messageBudget=${messageBudget}`);

    if (overheadTokens > contextBudget) {
      this.logger.error(`Overhead (${overheadTokens}) exceeds context budget (${contextBudget})! Truncation may be severe.`);
    }

    // 6. Apply Truncation
    const { truncatedMessages, estimatedTotal } = this.applyTruncation(
      chatMessages, 
      model.id, 
      modelFamily, 
      messageBudget, 
      systemPromptTokens
    );

    // 7. Calculate stats for calibration
    const totalCharsSent = (systemPrompt?.length ?? 0) + 
      truncatedMessages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) +
      JSON.stringify(tools).length;

    return {
      chatMessages: truncatedMessages,
      tools,
      totalCharsSent,
      contextBudget,
      estimatedTotalTokens: estimatedTotal,
      effectiveLimit
    };
  }

  private generateSystemPrompt(
    options: vscode.ProvideLanguageModelChatResponseOptions,
    config: vscode.WorkspaceConfiguration,
    workspaceContext?: string
  ): string | undefined {
    const enableToolGuidance = config.get<boolean>('toolGuidanceEnabled', true);
    const hasRealTools = (options.tools?.length ?? 0) > 0;
    const contextPrefix = workspaceContext ? `${workspaceContext}\n\n` : '';

    if (!enableToolGuidance) {
      return workspaceContext ? workspaceContext : undefined;
    }

    if (hasRealTools) {
      const toolList = options.tools!
        .map(t => `- ${t.name}: ${t.description}`)
        .join('\n');
      this.logger.debug(`Injecting dynamic tool-listing system prompt for ${options.tools!.length} tools`);
      return `${contextPrefix}You are an AI programming assistant integrated with VS Code.\n\nYou have access to the following tools:\n\n${toolList}\n\nUse these tools to complete tasks. Prefer them over shell commands for file operations.`;
    } else {
      this.logger.debug('Static tool guidance enabled (no real tools forwarded)');
      return `${contextPrefix}You are an AI programming assistant integrated with VS Code. You have access to native tools for file operations that trigger VS Code diff tracking:\n\n- create_file: Create new files with content (triggers VS Code diff tracking)\n- replace_string_in_file: Edit existing files by replacing text blocks (preferred for most edits)\n- insert_edit_into_file: Insert code into files when replacements fail\n\nWhen writing or modifying files, prefer using these tools over shell commands. Shell commands bypass VS Code's file system and will not show diffs in the editor.`;
    }
  }

  private convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    systemPrompt?: string
  ): ChatMessage[] {
    const chatMessages: ChatMessage[] = [];
    
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
        for (const part of msg.content) {
          if (part instanceof vscode.LanguageModelToolResultPart) {
            const resultContent = part.content
              .map(p => p instanceof vscode.LanguageModelTextPart ? p.value : '')
              .join('');
            chatMessages.push({ role: 'tool', content: resultContent, tool_call_id: part.callId });
          } else if (part instanceof vscode.LanguageModelTextPart) {
            chatMessages.push({ role: 'user', content: part.value });
          }
        }
      }
    }

    return chatMessages;
  }

  private applyTruncation(
    chatMessages: ChatMessage[],
    modelId: string,
    modelFamily: any,
    messageBudget: number,
    systemPromptTokens: number
  ): { truncatedMessages: ChatMessage[]; estimatedTotal: number } {
    let estimatedTotal = chatMessages.reduce((sum, m) => 
      sum + this.tokenizer.estimateTokens(m.content || '', modelId, modelFamily), 0
    );

    // We never drop the system prompt (first message) if it exists
    const systemPromptMsg = (chatMessages.length > 0 && chatMessages[0].role === 'system') ? chatMessages[0] : null;
    if (systemPromptMsg) {
      chatMessages.shift(); // Temporarily remove to truncate the rest
      estimatedTotal -= systemPromptTokens;
    }

    const initialCount = chatMessages.length;
    while (chatMessages.length > 1 && estimatedTotal > messageBudget) {
      const removed = chatMessages.shift()!;
      estimatedTotal -= this.tokenizer.estimateTokens(removed.content || '', modelId, modelFamily);
    }

    // Re-add system prompt
    if (systemPromptMsg) {
      chatMessages.unshift(systemPromptMsg);
      estimatedTotal += systemPromptTokens;
    }

    if (initialCount !== chatMessages.length - (systemPromptMsg ? 1 : 0)) {
      const dropped = initialCount - (chatMessages.length - (systemPromptMsg ? 1 : 0));
      this.logger.info(`Truncated conversation: dropped ${dropped} messages to fit budget (≈${estimatedTotal} tokens)`);
    }

    return { truncatedMessages: chatMessages, estimatedTotal };
  }
}
