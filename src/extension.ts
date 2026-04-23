import * as vscode from 'vscode';
import { DiscoveryService, ConnectionState } from './discovery';
import { ModelManager } from './modelManager';
import { ChatClient } from './chatClient';
import { StatusBarIndicator } from './statusBarIndicator';
import { LMStudioCopilotProvider } from './copilotProvider';

let outputChannel: vscode.LogOutputChannel;
let discoveryService: DiscoveryService;
let modelManager: ModelManager;
let chatClient: ChatClient;
let statusBarIndicator: StatusBarIndicator;
let copilotProvider: LMStudioCopilotProvider;

/**
 * Main extension activation - runs when extension first loads
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize output channel for logging
  outputChannel = vscode.window.createOutputChannel('LM Studio Copilot', { log: true });
  outputChannel.info('LM Studio Copilot extension activated');

  // Initialize services
  discoveryService = new DiscoveryService(outputChannel);
  modelManager = new ModelManager(outputChannel, discoveryService);
  chatClient = new ChatClient(outputChannel);
  statusBarIndicator = new StatusBarIndicator(outputChannel);

  // Get connection settings from configuration
  const config = vscode.workspace.getConfiguration('lmStudioCopilot');
  const host = config.get<string>('serverHost', 'localhost');
  const port = config.get<number>('serverPort', 1234);
  const disableAllTimeouts = config.get<boolean>('disableAllTimeouts', true);
  const requestTimeout = disableAllTimeouts ? 0 : config.get<number>('requestTimeout', 86400000);
  discoveryService.setHost(host);
  discoveryService.setPort(port);
  discoveryService.setRequestTimeout(requestTimeout);
  chatClient.setHost(host);
  chatClient.setPort(port);
  chatClient.setRequestTimeout(requestTimeout);
  outputChannel.info(`Request timeout: ${disableAllTimeouts ? 'disabled (no timeout)' : `${requestTimeout}ms`}`);

  // Register disposables
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(statusBarIndicator);

  // Listen for configuration changes and update services accordingly
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('lmStudioCopilot.showReasoningContent')) {
        chatClient.updateConfiguration();
      }
    })
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('lmstudio.refreshModels', handleRefreshModels)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('lmstudio.toggleSuggestions', handleToggleSuggestions)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('lmstudio.openOutput', () => {
      statusBarIndicator.openOutputChannel();
    })
  );

  // Register Copilot provider
  copilotProvider = new LMStudioCopilotProvider(outputChannel, modelManager, chatClient);
  
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
      async provideInlineCompletionItems(document, position, context) {
        return handleInlineCompletion(document, position, context);
      }
    }
  );
  context.subscriptions.push(completionProvider);

  // React to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('lmStudioCopilot')) {
        const updated = vscode.workspace.getConfiguration('lmStudioCopilot');
        const newHost = updated.get<string>('serverHost', 'localhost');
        const newPort = updated.get<number>('serverPort', 1234);
        const newTimeout = updated.get<number>('requestTimeout', 30000);
        discoveryService.setHost(newHost);
        discoveryService.setPort(newPort);
        discoveryService.setRequestTimeout(newTimeout);
        chatClient.setHost(newHost);
        chatClient.setPort(newPort);
        chatClient.setRequestTimeout(newTimeout);
        outputChannel.info(`Configuration updated: host=${newHost}, port=${newPort}, timeout=${newTimeout}ms`);
        performDiscovery().catch(error => {
          outputChannel.error(`Discovery after config change failed: ${error}`);
        });
      }
    })
  );

  // Re-check when the VS Code window regains focus (e.g. after interacting with LM Studio)
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused) {
        performDiscovery().catch(error => {
          outputChannel.error(`Discovery on window focus failed: ${error}`);
        });
      }
    })
  );

  // Initial discovery
  await performDiscovery();

  outputChannel.info('LM Studio Copilot initialization complete');
}

/**
 * Perform model discovery and update UI
 */
async function performDiscovery(): Promise<void> {
  try {
    await modelManager.updateFromDiscovery();
    
    const status = await discoveryService.checkConnection();
    const modelName = modelManager.getActiveModelName();
    
    statusBarIndicator.updateState(
      status.connectionState,
      modelName,
      status.errorMessage
    );

    // Tell VS Code the model list may have changed so it re-queries the provider
    copilotProvider.notifyModelsChanged();
  } catch (error) {
    outputChannel.error(`Discovery failed: ${error}`);
  }
}

/**
 * Handle refresh models command
 */
async function handleRefreshModels(): Promise<void> {
  outputChannel.debug('Refresh models command triggered');
  statusBarIndicator.showStatusMessage('Refreshing models...');
  await performDiscovery();
}

/**
 * Handle toggle suggestions command
 */
async function handleToggleSuggestions(): Promise<void> {
  const config = vscode.workspace.getConfiguration('lmStudioCopilot');
  const current = config.get<boolean>('enableSuggestions', true);
  
  await config.update('enableSuggestions', !current, vscode.ConfigurationTarget.Global);
  outputChannel.info(`Inline suggestions ${!current ? 'enabled' : 'disabled'}`);
  
  statusBarIndicator.showStatusMessage(
    `Suggestions ${!current ? 'enabled' : 'disabled'}`
  );
}

/**
 * Handle inline completion requests
 */
async function handleInlineCompletion(
  document: vscode.TextDocument,
  position: vscode.Position,
  context: vscode.InlineCompletionContext
): Promise<vscode.InlineCompletionItem[]> {
  try {
    // Check if suggestions are enabled
    const config = vscode.workspace.getConfiguration('lmStudioCopilot');
    if (!config.get<boolean>('enableSuggestions', true)) {
      return [];
    }

    // Check if we have an active model
    if (!modelManager.hasActiveModel()) {
      return [];
    }

    const activeModelId = modelManager.getActiveModelId();
    if (!activeModelId) {
      return [];
    }

    // Get document context
    const startLine = Math.max(0, position.line - 3);
    const contextRange = new vscode.Range(startLine, 0, position.line, position.character);
    const contextText = document.getText(contextRange);

    // Request completion from LM Studio
    const messages = [
      {
        role: 'user' as const,
        content: `Complete the following code:\n${contextText}`
      }
    ];

    let completionText = '';
    
    try {
      for await (const chunk of chatClient.streamCompletion(activeModelId, messages)) {
        completionText += chunk;
        
        // Stop at reasonable length or newlines
        if (completionText.length > 200 || completionText.includes('\n\n')) {
          break;
        }
      }
    } catch (error) {
      outputChannel.debug(`Completion streaming error: ${error}`);
      return [];
    }

    if (!completionText.trim()) {
      return [];
    }

    // Return inline completion item
    const item = new vscode.InlineCompletionItem(
      completionText,
      new vscode.Range(position, position)
    );

    return [item];

  } catch (error) {
    outputChannel.error(`Inline completion error: ${error}`);
    return [];
  }
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  outputChannel.info('LM Studio Copilot extension deactivated');
}
