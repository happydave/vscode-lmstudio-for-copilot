import * as vscode from 'vscode';

export enum ConnectionState {
  Connected = 'connected',
  Disconnected = 'disconnected',
  NoModelLoaded = 'no_model_loaded'
}

export class ModelInfo {
  constructor(
    public id: string,
    public name: string,
    public loaded: boolean,
    public object?: string,
    public maxContextLength?: number,
    public quantizationInfo?: string
  ) {}
}

export interface LMStudioStatus {
  connectionState: ConnectionState;
  activeModelId?: string;
  availableModels: ModelInfo[];
  errorMessage?: string;
}

/**
 * DiscoveryService handles automatic detection of LM Studio presence and connectivity.
 * Queries the /api/models/list endpoint to discover available models and their status.
 */
export class DiscoveryService {
  private readonly logger: vscode.LogOutputChannel;
  private host: string = 'localhost';
  private port: number = 1234;
  private requestTimeout: number = 30000;

  constructor(logger: vscode.LogOutputChannel) {
    this.logger = logger;
  }

  /**
   * Set the LM Studio server host (default: localhost)
   */
  public setHost(host: string): void {
    this.host = host;
    this.logger.trace(`Set LM Studio host to ${host}`);
  }

  /**
   * Set the LM Studio server port (default: 1234)
   */
  public setPort(port: number): void {
    this.port = port;
    this.logger.trace(`Set LM Studio port to ${port}`);
  }

  /**
   * Set the request timeout in milliseconds (default: 30000)
   */
  public setRequestTimeout(timeout: number): void {
    this.requestTimeout = timeout;
    this.logger.trace(`Set LM Studio request timeout to ${timeout}ms`);
  }

  /**
   * Check connection status and retrieve available models from LM Studio.
   * Returns the current connection state and list of discovered models.
   */
  public async checkConnection(): Promise<LMStudioStatus> {
    this.logger.trace('Checking LM Studio connection...');

    try {
      const url = `http://${this.host}:${this.port}/api/v0/models`;
      this.logger.debug(`Fetching model list from ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        signal: this.requestTimeout > 0 ? AbortSignal.timeout(this.requestTimeout) : undefined
      });

      if (!response.ok) {
        throw new Error(`HTTP status ${response.status}: ${response.statusText}`);
      }

      const body = await response.json() as LMStudioModelsResponse;
      const modelsData = body.data;
      this.logger.debug(`Found ${modelsData.length} models in LM Studio`);

      // Parse model data into ModelInfo objects
      const availableModels: ModelInfo[] = modelsData.map(model => ({
        id: model.id,
        name: model.id,
        loaded: model.state === 'loaded',
        object: model.object,
        maxContextLength: model.max_context_length || undefined,
        quantizationInfo: model.quantization || undefined
      }));

      // Determine connection state based on whether models are available and loaded
      if (availableModels.length === 0) {
        return {
          connectionState: ConnectionState.NoModelLoaded,
          availableModels: []
        };
      }

      const activeModel = availableModels.find(m => m.loaded);
      
      if (!activeModel) {
        this.logger.debug('No model currently loaded in LM Studio');
        return {
          connectionState: ConnectionState.NoModelLoaded,
          availableModels
        };
      }

      this.logger.trace(`Active model selected: ${activeModel.name} (${activeModel.id})`);

      return {
        connectionState: ConnectionState.Connected,
        activeModelId: activeModel.id,
        availableModels
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`LM Studio connection check failed: ${errorMessage}`);

      return {
        connectionState: ConnectionState.Disconnected,
        availableModels: [],
        errorMessage
      };
    }
  }

  /**
   * Attempt to load a specific model in LM Studio.
   * @param modelId The ID of the model to load
   */
  public async loadModel(modelId: string): Promise<boolean> {
    this.logger.debug(`Attempting to load model: ${modelId}`);

    try {
      const url = `http://${this.host}:${this.port}/api/v1/models/load`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelId
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP status ${response.status}: ${response.statusText}`);
      }

      this.logger.debug(`Successfully loaded model: ${modelId}`);
      return true;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to load model ${modelId}: ${errorMessage}`);
      return false;
    }
  }

  /**
   * Unload the currently active model from LM Studio.
   */
  public async unloadModel(): Promise<boolean> {
    this.logger.debug('Attempting to unload current model');

    try {
      const url = `http://${this.host}:${this.port}/api/v1/models/unload`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP status ${response.status}: ${response.statusText}`);
      }

      this.logger.debug('Successfully unloaded current model');
      return true;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to unload model: ${errorMessage}`);
      return false;
    }
  }
}

/**
 * A single model entry in the LM Studio /api/v0/models response.
 */
interface LMStudioModelEntry {
  id: string;
  object?: string;
  type?: string;
  publisher?: string;
  arch?: string;
  compatibility_type?: string;
  quantization?: string;
  /** "loaded" when the model is in memory, "not-loaded" otherwise */
  state: string;
  max_context_length?: number;
}

/**
 * Response envelope for LM Studio GET /api/v0/models.
 */
interface LMStudioModelsResponse {
  object: string;
  data: LMStudioModelEntry[];
}
