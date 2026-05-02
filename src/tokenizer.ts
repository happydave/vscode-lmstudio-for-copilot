import * as vscode from 'vscode';

export enum ModelFamily {
  Llama = 'llama',
  Mistral = 'mistral',
  Gemma = 'gemma',
  Qwen = 'qwen',
  Unknown = 'unknown'
}

export interface CalibrationData {
  ratio: number;
  observations: number;
}

/**
 * Tokenizer service provides model-aware token estimation based on character counts
 * and historical calibration data from LM Studio responses.
 */
export class Tokenizer {
  private static readonly BASE_RATIOS: Record<ModelFamily, number> = {
    [ModelFamily.Llama]: 3.5,
    [ModelFamily.Mistral]: 3.5,
    [ModelFamily.Gemma]: 3.6,
    [ModelFamily.Qwen]: 4.0,
    [ModelFamily.Unknown]: 3.8
  };

  private readonly logger: vscode.LogOutputChannel;
  private readonly globalState: vscode.Memento;
  private familyOverrides: Record<string, string> = {};

  constructor(logger: vscode.LogOutputChannel, globalState: vscode.Memento) {
    this.logger = logger;
    this.globalState = globalState;
    this.loadConfiguration();
  }

  /**
   * Reload configuration from VS Code settings.
   */
  public loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration('lmStudioCopilot');
    this.familyOverrides = config.get<Record<string, string>>('modelFamilyOverrides', {});
  }

  /**
   * Detect model family based on architecture string or model ID pattern matching.
   */
  public detectFamily(modelId: string, architecture?: string): ModelFamily {
    // 1. Check for manual override
    const override = this.familyOverrides[modelId];
    if (override && Object.values(ModelFamily).includes(override as ModelFamily)) {
      return override as ModelFamily;
    }

    // 2. Use architecture field from API if available
    if (architecture) {
      const arch = architecture.toLowerCase();
      if (arch.includes('llama')) return ModelFamily.Llama;
      if (arch.includes('mistral')) return ModelFamily.Mistral;
      if (arch.includes('gemma')) return ModelFamily.Gemma;
      if (arch.includes('qwen')) return ModelFamily.Qwen;
    }

    // 3. Fallback to regex pattern matching on model ID
    const id = modelId.toLowerCase();
    if (/llama/i.test(id)) return ModelFamily.Llama;
    if (/mistral/i.test(id)) return ModelFamily.Mistral;
    if (/gemma/i.test(id)) return ModelFamily.Gemma;
    if (/qwen/i.test(id)) return ModelFamily.Qwen;

    return ModelFamily.Unknown;
  }

  /**
   * Estimate token count for a given text based on model family and calibration.
   */
  public estimateTokens(text: string, modelId: string, family: ModelFamily): number {
    if (!text) return 0;

    // Get base ratio for family
    let ratio = Tokenizer.BASE_RATIOS[family];

    // Check for calibrated ratio in globalState
    const calibration = this.getCalibration(modelId);
    if (calibration) {
      ratio = calibration.ratio;
    }

    return Math.ceil(text.length / ratio);
  }

  /**
   * Estimate token overhead for tool schema definitions.
   */
  public estimateToolTokens(tools: any[], family: ModelFamily): number {
    if (!tools || tools.length === 0) return 0;
    
    // Heuristic: stringify tools and treat as part of context
    const toolsStr = JSON.stringify(tools);
    const ratio = Tokenizer.BASE_RATIOS[family];
    
    return Math.ceil(toolsStr.length / ratio);
  }

  /**
   * Update calibration data for a model based on actual usage reported by API.
   */
  public recordObservation(modelId: string, charCount: number, actualTokens: number): void {
    if (charCount <= 0 || actualTokens <= 0) return;

    const newRatio = charCount / actualTokens;
    const current = this.getCalibration(modelId) || { ratio: newRatio, observations: 0 };

    // Moving average capped at 100 observations
    const weight = Math.min(current.observations, 99);
    const updatedRatio = (current.ratio * weight + newRatio) / (weight + 1);
    
    const updated: CalibrationData = {
      ratio: updatedRatio,
      observations: weight + 1
    };

    const allCalibration = this.globalState.get<Record<string, CalibrationData>>('tokenCalibration', {});
    allCalibration[modelId] = updated;
    this.globalState.update('tokenCalibration', allCalibration);

    this.logger.trace(`Calibration updated for ${modelId}: ratio=${updatedRatio.toFixed(2)} (${updated.observations} obs)`);
  }

  private getCalibration(modelId: string): CalibrationData | undefined {
    const allCalibration = this.globalState.get<Record<string, CalibrationData>>('tokenCalibration', {});
    return allCalibration[modelId];
  }
}
