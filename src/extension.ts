import * as vscode from 'vscode';
import { DiscoveryService, ConnectionState } from './discovery';
import { ModelManager } from './modelManager';
import { ChatClient } from './chatClient';
import { LMStudioCopilotProvider } from './copilotProvider';
import { Tokenizer } from './tokenizer';
import { RequestBuilder } from './requestBuilder';
import { ContextManager } from './contextManager';
import { ConnectionStorage } from './connection/storage';
import { ConnectionManager } from './connection/manager';
import { WebviewManager } from './webview/manager';

let outputChannel: vscode.LogOutputChannel;
let discoveryService: DiscoveryService;
let modelManager: ModelManager;
let chatClient: ChatClient;
let copilotProvider: LMStudioCopilotProvider;
let tokenizer: Tokenizer;
let requestBuilder: RequestBuilder;
let contextManager: ContextManager;
let webviewManager: WebviewManager;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('LM Studio Copilot', { log: true });
  outputChannel.info('LM Studio Copilot extension activated');

  // Connection storage and manager
  const connectionStorage = new ConnectionStorage(context);
  await connectionStorage.migrateFromWorkspaceConfig();
  const getToken = (name: string) => connectionStorage.getToken(name);
  const connectionManager = new ConnectionManager(context, connectionStorage, getToken);

  // One-time migration: if no connections are stored and old settings have non-default values,
  // create a "Local" connection from them.
  await migrateLegacySettings(connectionStorage, outputChannel);

  // Initialize services
  discoveryService = new DiscoveryService(outputChannel);
  modelManager = new ModelManager(outputChannel, discoveryService, context.globalState);
  chatClient = new ChatClient(outputChannel);
  tokenizer = new Tokenizer(outputChannel, context.globalState);
  requestBuilder = new RequestBuilder(outputChannel, tokenizer);
  contextManager = new ContextManager(outputChannel, tokenizer);

  // Register Copilot provider early so notifyModelsChanged is available
  copilotProvider = new LMStudioCopilotProvider(outputChannel, modelManager, chatClient, tokenizer, requestBuilder, contextManager);

  // Webview manager
  webviewManager = new WebviewManager(
    context,
    connectionManager,
    connectionStorage,
    modelManager,
    () => copilotProvider.notifyModelsChanged(),
    outputChannel,
  );

  // Apply active connection config to discovery service and chat client
  const activeConfig = connectionManager.getActiveConfig();
  const initialHost = activeConfig?.host ?? 'localhost';
  const initialPort = activeConfig?.port ?? 1234;

  const config = vscode.workspace.getConfiguration('lmStudioCopilot');
  const disableAllTimeouts = config.get<boolean>('disableAllTimeouts', true);
  const requestTimeout = disableAllTimeouts ? 0 : config.get<number>('requestTimeout', 86400000);

  discoveryService.setHost(initialHost);
  discoveryService.setPort(initialPort);
  discoveryService.setRequestTimeout(requestTimeout);
  chatClient.setHost(initialHost);
  chatClient.setPort(initialPort);
  chatClient.setRequestTimeout(requestTimeout);
  const activeConnectionName = connectionManager.getActiveName() ?? '(none)';
  outputChannel.info(`Active connection: "${activeConnectionName}" → ${initialHost}:${initialPort}, timeout: ${disableAllTimeouts ? 'disabled' : `${requestTimeout}ms`}`);

  // Register disposables
  context.subscriptions.push(outputChannel);

  // Configuration change listener (non-host/port settings)
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('lmStudioCopilot.showReasoningContent')) {
        chatClient.updateConfiguration();
      }

      if (
        e.affectsConfiguration('lmStudioCopilot.discoveryMaxRetries') ||
        e.affectsConfiguration('lmStudioCopilot.discoveryBaseRetryDelayMs')
      ) {
        discoveryService.updateRetryConfiguration();
      }

      if (e.affectsConfiguration('lmStudioCopilot.modelFamilyOverrides')) {
        tokenizer.loadConfiguration();
      }

      if (
        e.affectsConfiguration('lmStudioCopilot.requestTimeout') ||
        e.affectsConfiguration('lmStudioCopilot.disableAllTimeouts')
      ) {
        const updated = vscode.workspace.getConfiguration('lmStudioCopilot');
        const newDisable = updated.get<boolean>('disableAllTimeouts', true);
        const newTimeout = newDisable ? 0 : updated.get<number>('requestTimeout', 86400000);
        discoveryService.setRequestTimeout(newTimeout);
        chatClient.setRequestTimeout(newTimeout);
        outputChannel.info(`Timeout updated: ${newDisable ? 'disabled' : `${newTimeout}ms`}`);
      }
    })
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('lmstudio.refreshModels', handleRefreshModels)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('lmstudio.toggleSuggestions', handleToggleSuggestions)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('lmstudio.openOutput', () => {
      outputChannel.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('lmstudio.toggleContextPrioritization', async () => {
      const cfg = vscode.workspace.getConfiguration('lmStudioCopilot');
      const current = cfg.get<boolean>('enableContextPrioritization', true);
      await cfg.update('enableContextPrioritization', !current, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        `LM Studio Context Prioritization: ${!current ? 'Enabled' : 'Disabled'}`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('lmstudio.openConfig', () => {
      webviewManager.show();
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('lmstudio.configView', webviewManager)
  );

  // Register Copilot provider
  try {
    const copilotRegistration = vscode.lm.registerLanguageModelChatProvider(
      'lmstudio',
      copilotProvider
    );
    context.subscriptions.push(copilotRegistration);
    outputChannel.info('LM Studio Copilot provider registered with Copilot');
  } catch (error) {
    outputChannel.warn(`Failed to register Copilot provider: ${error}`);
  }

  // Register inline completion provider
  const completionProvider = vscode.languages.registerInlineCompletionItemProvider(
    { scheme: 'file' },
    {
      async provideInlineCompletionItems(document, position, completionContext) {
        return handleInlineCompletion(document, position, completionContext);
      }
    }
  );
  context.subscriptions.push(completionProvider);

  // Initial discovery (non-blocking)
  performDiscovery().catch(error => {
    outputChannel.error(`Initial discovery failed: ${error}`);
  });

  outputChannel.info('LM Studio Copilot initialization complete');
}

/**
 * Migrate legacy serverHost/serverPort settings to a "Local" connection entry.
 * Runs only if no connections are stored and the settings hold non-default values.
 */
async function migrateLegacySettings(
  storage: ConnectionStorage,
  logger: vscode.LogOutputChannel,
): Promise<void> {
  const existing = storage.getConnections();
  if (existing.length > 0) { return; }

  const cfg = vscode.workspace.getConfiguration('lmStudioCopilot');
  const host = cfg.get<string>('serverHost', 'localhost');
  const port = cfg.get<number>('serverPort', 1234);

  if (host !== 'localhost' || port !== 1234) {
    await storage.saveConnections([{ name: 'Local', scheme: 'http', host, port }]);
    logger.info(`Migrated legacy settings to connection "Local" (${host}:${port})`);
  }
}

async function performDiscovery(): Promise<void> {
  try {
    const status = await modelManager.updateFromDiscovery();
    copilotProvider.notifyModelsChanged();
    const modelCount = modelManager.getAvailableModels().length;
    outputChannel.info(`Discovery: ${status.connectionState} (${modelCount} model(s) available)`);
  } catch (error) {
    outputChannel.error(`Discovery failed: ${error}`);
  }
}

async function handleRefreshModels(): Promise<void> {
  outputChannel.debug('Refresh models command triggered');

  const now = Date.now();
  const cfg = vscode.workspace.getConfiguration('lmStudioCopilot');
  const cooldownMs = cfg.get<number>('refreshCooldownMs', 5000);

  if ((handleRefreshModels as any).lastRefreshTime) {
    const timeSinceLastRefresh = now - (handleRefreshModels as any).lastRefreshTime;
    if (timeSinceLastRefresh < cooldownMs) {
      outputChannel.debug(`Refresh too frequent (${timeSinceLastRefresh}ms since last refresh), ignoring`);
      void vscode.window.showInformationMessage(
        `Refresh ignored. Please wait ${cooldownMs - timeSinceLastRefresh}ms more.`
      );
      return;
    }
  }

  (handleRefreshModels as any).lastRefreshTime = now;
  outputChannel.debug('Proceeding with model refresh');
  await performDiscovery();
}

async function handleToggleSuggestions(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('lmStudioCopilot');
  const current = cfg.get<boolean>('enableSuggestions', true);
  await cfg.update('enableSuggestions', !current, vscode.ConfigurationTarget.Global);
  outputChannel.info(`Inline suggestions ${!current ? 'enabled' : 'disabled'}`);
  void vscode.window.showInformationMessage(`Suggestions ${!current ? 'enabled' : 'disabled'}`);
}

async function handleInlineCompletion(
  document: vscode.TextDocument,
  position: vscode.Position,
  _context: vscode.InlineCompletionContext
): Promise<vscode.InlineCompletionItem[]> {
  try {
    const cfg = vscode.workspace.getConfiguration('lmStudioCopilot');
    if (!cfg.get<boolean>('enableSuggestions', true)) { return []; }
    if (!modelManager.hasActiveModel()) { return []; }

    const activeModelId = modelManager.getActiveModelId();
    if (!activeModelId) { return []; }

    const startLine = Math.max(0, position.line - 3);
    const contextRange = new vscode.Range(startLine, 0, position.line, position.character);
    const contextText = document.getText(contextRange);

    const messages = [
      { role: 'user' as const, content: `Complete the following code:\n${contextText}` }
    ];

    let completionText = '';
    const modelTemperatures = cfg.get<Record<string, number>>('modelTemperatures', {});
    const temperatureOverride = modelTemperatures[activeModelId];

    try {
      for await (const part of chatClient.streamCompletion(activeModelId, messages, undefined, temperatureOverride)) {
        if (part.kind === 'text') { completionText += part.content; }
        if (completionText.length > 200 || completionText.includes('\n\n')) { break; }
      }
    } catch (error) {
      outputChannel.debug(`Completion streaming error: ${error}`);
      return [];
    }

    if (!completionText.trim()) { return []; }

    return [new vscode.InlineCompletionItem(completionText, new vscode.Range(position, position))];
  } catch (error) {
    outputChannel.error(`Inline completion error: ${error}`);
    return [];
  }
}

export function deactivate(): void {
  outputChannel.info('LM Studio Copilot extension deactivated');
}
