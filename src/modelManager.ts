import * as vscode from 'vscode';
import { ModelInfo, ConnectionState, DiscoveryService, LMStudioStatus } from './discovery';

const COPILOT_ENABLED_KEY = 'lmstudioCopilot.copilotEnabledModels';

/**
 * ModelManager handles the selection and management of models for use with LM Studio.
 * Tracks the currently active model and provides methods to switch between available models.
 */
export class ModelManager {
  private readonly logger: vscode.LogOutputChannel;
  private discoveryService: DiscoveryService;
  private readonly globalState: vscode.Memento;

  private activeModelId: string | undefined;
  private availableModels: ModelInfo[] = [];
  private copilotEnabledModels: Record<string, boolean>;

  constructor(logger: vscode.LogOutputChannel, discoveryService: DiscoveryService, globalState: vscode.Memento) {
    this.logger = logger;
    this.discoveryService = discoveryService;
    this.globalState = globalState;
    this.copilotEnabledModels = globalState.get<Record<string, boolean>>(COPILOT_ENABLED_KEY, {});
  }

  /**
   * Update the list of available models and set active model based on LM Studio state.
   */
  public async updateFromDiscovery(): Promise<LMStudioStatus> {
    const status = await this.discoveryService.checkConnection();
    
    switch (status.connectionState) {
      case ConnectionState.Connected:
        this.availableModels = status.availableModels;
        if (status.activeModelId) {
          this.setActiveModel(status.activeModelId);
        }
        break;

      case ConnectionState.NoModelLoaded:
        this.availableModels = status.availableModels;
        this.activeModelId = undefined;
        break;

      case ConnectionState.Disconnected:
        this.availableModels = [];
        this.activeModelId = undefined;
        break;
    }

    this.logger.trace(`ModelManager updated. Active model: ${this.activeModelId || 'none'}`);
    return status;
  }

  /**
   * Get the currently active model ID, or undefined if no model is loaded.
   */
  public getActiveModelId(): string | undefined {
    return this.activeModelId;
  }

  /**
   * Get the list of available models discovered from LM Studio.
   */
  public getAvailableModels(): ModelInfo[] {
    return [...this.availableModels];
  }

  /**
   * Set a specific model as active.
   * @param modelId The ID of the model to activate
   */
  public setActiveModel(modelId: string): void {
    const model = this.availableModels.find(m => m.id === modelId || m.name === modelId);
    
    if (!model) {
      this.logger.warn(`Attempted to set unknown active model: ${modelId}`);
      return;
    }

    this.activeModelId = modelId;
    this.logger.debug(`Set active model to: ${model.name} (${model.id})`);
  }

  /**
   * Load a specific model in LM Studio and set it as active.
   * @param modelId The ID of the model to load
   */
  public async loadModel(modelId: string): Promise<boolean> {
    const model = this.availableModels.find(m => m.id === modelId || m.name === modelId);
    const maxContext = model?.maxContextLength;

    const success = await this.discoveryService.loadModel(modelId, maxContext);
    
    if (success) {
      // Wait a moment for LM Studio to process the load request
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Refresh model list and update active model
      await this.updateFromDiscovery();
      
      return true;
    }

    return false;
  }

  /**
   * Unload the currently active model from LM Studio.
   */
  public async unloadCurrentModel(): Promise<boolean> {
    const success = await this.discoveryService.unloadModel();
    
    if (success) {
      // Wait a moment for LM Studio to process the unload request
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Refresh model list and clear active model
      await this.updateFromDiscovery();
      
      return true;
    }

    return false;
  }

  /**
   * Check if a specific model is currently loaded in LM Studio.
   */
  public isModelLoaded(modelId: string): boolean {
    const model = this.availableModels.find(m => m.id === modelId || m.name === modelId);
    return !!model?.loaded;
  }

  /**
   * Check if any models are currently available and loaded.
   */
  public hasActiveModel(): boolean {
    return !!this.activeModelId && this.isModelLoaded(this.activeModelId);
  }

  /**
   * Get the name of the active model, or a descriptive message if none is selected.
   */
  public getActiveModelName(): string {
    if (!this.activeModelId) {
      return 'No model loaded';
    }

    const model = this.availableModels.find(m => m.id === this.activeModelId || m.name === this.activeModelId);
    return model ? model.name : this.activeModelId;
  }

  /**
   * Set the copilot-enabled state for a model key and persist it.
   */
  public setCopilotEnabled(modelKey: string, enabled: boolean): void {
    this.copilotEnabledModels[modelKey] = enabled;
    void this.globalState.update(COPILOT_ENABLED_KEY, this.copilotEnabledModels);
    this.logger.debug(`Copilot enabled for "${modelKey}": ${enabled}`);
  }

  /**
   * Returns available models filtered to those whose copilot-enabled state is true.
   * Absent key defaults to true (all-enabled on first use).
   */
  public getCopilotEnabledModels(): ModelInfo[] {
    return this.availableModels.filter(m => {
      const val = this.copilotEnabledModels[m.id];
      return val === undefined ? true : val;
    });
  }

  /**
   * Returns the full copilotEnabled map for sending to the webview.
   */
  public getCopilotEnabledMap(): Record<string, boolean> {
    return { ...this.copilotEnabledModels };
  }
}
