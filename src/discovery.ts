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
    public loadedContextLength?: number,
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

  // Race condition prevention with configurable settings
  private isQuerying = false;
  private lastRefreshTime = 0;
  private readonly REFRESH_COOLDOWN_MS = 5000; // Default 5 seconds between refreshes
  private MAX_RETRIES = 3;
  private BASE_RETRY_DELAY_MS = 1000;

  constructor(logger: vscode.LogOutputChannel) {
    this.logger = logger;
    this.loadRetryConfiguration();
  }

  /**
   * Load retry configuration from VS Code settings.
   */
  private loadRetryConfiguration(): void {
    const config = vscode.workspace.getConfiguration('lmStudioCopilot');
    this.MAX_RETRIES = config.get<number>('discoveryMaxRetries', 3);
    this.BASE_RETRY_DELAY_MS = config.get<number>('discoveryBaseRetryDelayMs', 1000);
    this.logger.trace(
      `Loaded discovery retry configuration: maxRetries=${this.MAX_RETRIES}, baseDelay=${this.BASE_RETRY_DELAY_MS}ms`
    );
  }

  /**
   * Update retry configuration from VS Code settings.
   */
  public updateRetryConfiguration(): void {
    const config = vscode.workspace.getConfiguration('lmStudioCopilot');
    this.MAX_RETRIES = config.get<number>('discoveryMaxRetries', 3);
    this.BASE_RETRY_DELAY_MS = config.get<number>('discoveryBaseRetryDelayMs', 1000);
    this.logger.trace(
      `Updated discovery retry configuration: maxRetries=${this.MAX_RETRIES}, baseDelay=${this.BASE_RETRY_DELAY_MS}ms`
    );
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
   * Check if a refresh is allowed based on the cooldown period.
   * Returns true if the refresh should proceed, false if it should be throttled.
   */
  private isRefreshAllowed(): boolean {
    const now = Date.now();
    if (now - this.lastRefreshTime < this.REFRESH_COOLDOWN_MS) {
      this.logger.debug(
        `Refresh throttled: only ${now - this.lastRefreshTime}ms since last refresh`
      );
      return false;
    }
    return true;
  }

  /**
   * Acquire a mutex lock to prevent concurrent discovery queries.
   * Returns true if the lock was acquired, false if another query is in progress.
   */
  private async acquireQueryLock(): Promise<boolean> {
    if (this.isQuerying) {
      this.logger.warn('Discovery query already in progress, queuing...');
      // Wait for previous query to complete with a timeout
      let attempts = 0;
      const maxWaitAttempts = 10; // Max 10 seconds wait
      while (this.isQuerying && attempts < maxWaitAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      }
      if (this.isQuerying) {
        this.logger.warn('Timeout waiting for query lock, proceeding anyway');
        return true; // Proceed anyway to avoid indefinite blocking
      }
    }
    this.isQuerying = true;
    return true;
  }

  /**
   * Release the query mutex lock.
   */
  private releaseQueryLock(): void {
    this.isQuerying = false;
  }

  private lastWarnedModelId: string | undefined;

  /**
   * Perform the actual HTTP request to LM Studio and return the connection status.
   */
  private async fetchConnectionStatus(): Promise<LMStudioStatus> {
    this.logger.trace('Checking LM Studio connection (v1 API)...');

    const url = `http://${this.host}:${this.port}/api/v1/models`;
    this.logger.debug(`Fetching model list from ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: this.requestTimeout > 0 ? AbortSignal.timeout(this.requestTimeout) : undefined
    });

    if (!response.ok) {
      throw new Error(`HTTP status ${response.status}: ${response.statusText}`);
    }

    const body = await response.json() as LMStudioModelsResponse;
    const modelsData = body.models;
    this.logger.debug(`Found ${modelsData.length} models in LM Studio`);

    const availableModels: ModelInfo[] = modelsData.map(model => {
      const loadedInstance = model.loaded_instances?.[0];
      return {
        id: model.key,
        name: model.display_name || model.key,
        loaded: !!loadedInstance,
        object: 'model',
        maxContextLength: model.max_context_length || undefined,
        loadedContextLength: loadedInstance?.config?.context_length || undefined,
        quantizationInfo: model.quantization?.name || undefined
      };
    });

    if (availableModels.length === 0) {
      return { connectionState: ConnectionState.NoModelLoaded, availableModels: [] };
    }

    const activeModel = availableModels.find(m => m.loaded);
    if (!activeModel) {
      this.logger.debug('No model currently loaded in LM Studio');
      return { connectionState: ConnectionState.NoModelLoaded, availableModels };
    }

    // Check for reduced context length and warn once
    if (activeModel.loadedContextLength && activeModel.maxContextLength && 
        activeModel.loadedContextLength < activeModel.maxContextLength) {
      if (this.lastWarnedModelId !== activeModel.id) {
        this.logger.warn(
          `Model ${activeModel.name} is loaded with reduced context (${activeModel.loadedContextLength} tokens) ` +
          `vs architectural max (${activeModel.maxContextLength} tokens). This will limit conversation length.`
        );
        this.lastWarnedModelId = activeModel.id;
      }
    } else {
      this.lastWarnedModelId = undefined;
    }

    this.logger.trace(`Active model selected: ${activeModel.name} (${activeModel.id})`);
    return { connectionState: ConnectionState.Connected, activeModelId: activeModel.id, availableModels };
  }

  /**
   * Perform a discovery query with exponential backoff retry logic.
   * Retries failed connection attempts with increasing delays.
   */
  private async checkConnectionWithRetry(): Promise<LMStudioStatus> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        return await this.fetchConnectionStatus();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt === this.MAX_RETRIES - 1) {
          // Last attempt, throw the error
          break;
        }

        const delay = this.BASE_RETRY_DELAY_MS * Math.pow(2, attempt); // 1s, 2s, 4s
        this.logger.debug(
          `Connection check failed (attempt ${attempt + 1}/${this.MAX_RETRIES}), retrying in ${delay}ms: ${lastError.message}`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // All retries exhausted, return disconnected state with error
    this.logger.warn(`Connection check failed after ${this.MAX_RETRIES} attempts: ${lastError?.message}`);
    
    return {
      connectionState: ConnectionState.Disconnected,
      availableModels: [],
      errorMessage: lastError?.message || 'Unknown connection error'
    };
  }

  /**
   * Check connection status and retrieve available models from LM Studio.
   * Returns the current connection state and list of discovered models.
   */
  public async checkConnection(): Promise<LMStudioStatus> {
    // Acquire mutex lock to prevent concurrent queries
    if (!(await this.acquireQueryLock())) {
      return this.getCachedResult();
    }

    try {
      return await this.checkConnectionWithRetry();
    } finally {
      this.releaseQueryLock();
    }
  }

  /**
   * Get cached connection result for quick response when queries are queued.
   */
  private getCachedResult(): LMStudioStatus {
    // Return a minimal cached result indicating we're busy
    return {
      connectionState: ConnectionState.Disconnected,
      availableModels: [],
      errorMessage: 'Discovery query already in progress'
    };
  }

  /**
   * Check if refresh is allowed and perform discovery with retry logic.
   * This should be called by external handlers to ensure proper throttling.
   */
  public async checkConnectionWithThrottle(): Promise<LMStudioStatus> {
    if (!this.isRefreshAllowed()) {
      this.logger.debug('Refresh throttled, returning cached result');
      return this.getCachedResult();
    }

    // Acquire mutex lock FIRST to prevent race condition
    if (!(await this.acquireQueryLock())) {
      return this.getCachedResult();
    }

    try {
      const now = Date.now();
      this.lastRefreshTime = now; // Protected by lock - only modified when actually refreshing
      
      return await this.checkConnectionWithRetry();
    } finally {
      this.releaseQueryLock();
    }
  }

  /**
   * Attempt to load a specific model in LM Studio.
   * @param modelId The ID of the model to load
   * @param contextLength Optional context length to set on load
   */
  public async loadModel(modelId: string, contextLength?: number): Promise<boolean> {
    this.logger.debug(`Attempting to load model: ${modelId} (context_length: ${contextLength ?? 'default'})`);

    try {
      const url = `http://${this.host}:${this.port}/api/v1/models/load`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelId,
          context_length: contextLength
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
 * A single model entry in the LM Studio /api/v1/models response.
 */
interface LMStudioModelEntry {
  key: string;
  display_name?: string;
  type?: string;
  publisher?: string;
  architecture?: string;
  quantization?: {
    name: string;
    bits_per_weight?: number;
  };
  max_context_length?: number;
  loaded_instances: Array<{
    id: string;
    config?: {
      context_length?: number;
    };
  }>;
}

/**
 * Response envelope for LM Studio GET /api/v1/models.
 */
interface LMStudioModelsResponse {
  models: LMStudioModelEntry[];
}
