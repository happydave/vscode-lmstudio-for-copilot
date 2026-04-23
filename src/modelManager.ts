import * as vscode from 'vscode';
import { ModelInfo, ConnectionState, DiscoveryService } from './discovery';

/**
 * ModelManager handles the selection and management of models for use with LM Studio.
 * Tracks the currently active model and provides methods to switch between available models.
 */
export class ModelManager {
  private readonly logger: vscode.LogOutputChannel;
  private discoveryService: DiscoveryService;
  
  private activeModelId: string | undefined;
  private availableModels: ModelInfo[] = [];

  constructor(logger: vscode.LogOutputChannel, discoveryService: DiscoveryService) {
    this.logger = logger;
    this.discoveryService = discoveryService;
  }

  /**
   * Update the list of available models and set active model based on LM Studio state.
   */
  public async updateFromDiscovery(): Promise<void> {
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
    const success = await this.discoveryService.loadModel(modelId);
    
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
}
