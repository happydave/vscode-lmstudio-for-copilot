import * as vscode from 'vscode';
import { ConnectionState } from './discovery';

/**
 * Status bar item for LM Studio Copilot showing connection state and active model.
 */
export class StatusBarIndicator {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly outputChannel: vscode.LogOutputChannel;
  private isVisible: boolean = false;

  constructor(outputChannel: vscode.LogOutputChannel) {
    this.outputChannel = outputChannel;

    // Create status bar item with initial disabled state
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      1000 // High priority to appear near language indicators
    );
    
    this.updateState(ConnectionState.Disconnected);
    
    // Register click handler
    this.statusBarItem.command = 'lmstudio.refreshModels';
  }

  /**
   * Update the status bar display based on current connection state.
   */
  public updateState(
    connectionState: ConnectionState,
    activeModelName?: string,
    errorMessage?: string
  ): void {
    switch (connectionState) {
      case ConnectionState.Connected:
        this.statusBarItem.text = `LM Studio: ${activeModelName || 'loading...'}`;
        this.statusBarItem.color = undefined; // Use default foreground colour
        this.statusBarItem.tooltip = activeModelName 
          ? `Active model: ${activeModelName}\nClick to refresh models`
          : 'Connected but no model loaded';
        break;

      case ConnectionState.NoModelLoaded:
        this.statusBarItem.text = '$(error) LM Studio: No model loaded';
        this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningBackground'); // Yellow
        this.statusBarItem.tooltip = `No model currently loaded in LM Studio\nClick to refresh models or load a model from LM Studio UI`;
        break;

      case ConnectionState.Disconnected: {
        const config = vscode.workspace.getConfiguration('lmStudioCopilot');
        const host = config.get<string>('serverHost', 'localhost');
        const port = config.get<number>('serverPort', 1234);
        this.statusBarItem.text = '$(error) LM Studio: Disconnected';
        this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorBackground'); // Red
        this.statusBarItem.tooltip = `LM Studio server not running at ${host}:${port}\nClick to retry connection`;
        
        if (errorMessage) {
          this.outputChannel.trace(`Connection error: ${errorMessage}`);
        }
        break;
      }
    }

    this.isVisible = true;
    this.statusBarItem.show();
  }

  /**
   * Show a transient message in the status bar.
   */
  public showStatusMessage(message: string): void {
    const originalText = this.statusBarItem.text;
    
    // Temporarily replace with status message
    this.statusBarItem.text = `$(sync~spin) ${message}`;
    this.outputChannel.trace(message);

    // Restore after short delay
    setTimeout(() => {
      if (this.isVisible) {
        this.statusBarItem.text = originalText;
      }
    }, 3000);
  }

  /**
   * Open the output channel for debugging.
   */
  public openOutputChannel(): void {
    this.outputChannel.show();
  }

  /**
   * Hide the status bar item.
   */
  public hide(): void {    this.isVisible = false;    this.statusBarItem.hide();
  }

  /**
   * Dispose of resources when extension deactivates.
   */
  public dispose(): void {
    this.statusBarItem.dispose();
    this.outputChannel.dispose();
  }
}
