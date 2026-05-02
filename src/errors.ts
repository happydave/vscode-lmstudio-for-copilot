/**
 * Base class for all LM Studio related errors.
 */
export class LMStudioError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean = true,
    public readonly statusCode?: number,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = 'LMStudioError';
    // Ensure correct prototype chain for inheritance
    Object.setPrototypeOf(this, LMStudioError.prototype);
  }
}

/**
 * Error thrown when a network connection cannot be established.
 */
export class ConnectionError extends LMStudioError {
  constructor(message: string, originalError?: unknown) {
    super(`Connection failed: ${message}`, true, undefined, originalError);
    this.name = 'ConnectionError';
    Object.setPrototypeOf(this, ConnectionError.prototype);
  }
}

/**
 * Error thrown when a request times out.
 */
export class TimeoutError extends LMStudioError {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`, true);
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * Error thrown when the conversation exceeds the model's context window.
 */
export class ContextOverflowError extends LMStudioError {
  constructor(message: string, public readonly contextLimit?: number) {
    super(message, false); // Not retryable without changing input
    this.name = 'ContextOverflowError';
    Object.setPrototypeOf(this, ContextOverflowError.prototype);
  }
}

/**
 * Error thrown when a requested model is not found or loaded.
 */
export class ModelNotFoundError extends LMStudioError {
  constructor(modelId: string) {
    super(`Model not found or not loaded: ${modelId}`, false);
    this.name = 'ModelNotFoundError';
    Object.setPrototypeOf(this, ModelNotFoundError.prototype);
  }
}

/**
 * Error thrown when the API returns an error response.
 */
export class APIError extends LMStudioError {
  constructor(message: string, statusCode: number, retryable: boolean = true) {
    super(message, retryable, statusCode);
    this.name = 'APIError';
    Object.setPrototypeOf(this, APIError.prototype);
  }
}

/**
 * Error thrown when parsing a response fails.
 */
export class ParseError extends LMStudioError {
  constructor(message: string, public readonly rawData?: string) {
    super(`Failed to parse response: ${message}`, false);
    this.name = 'ParseError';
    Object.setPrototypeOf(this, ParseError.prototype);
  }
}

// --- Type Guards ---

export function isLMStudioError(error: unknown): error is LMStudioError {
  return error instanceof LMStudioError;
}

export function isContextOverflowError(error: unknown): error is ContextOverflowError {
  return error instanceof ContextOverflowError;
}

export function isConnectionError(error: unknown): error is ConnectionError {
  return error instanceof ConnectionError;
}

export function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError;
}

export function isRetryableError(error: unknown): boolean {
  if (isLMStudioError(error)) {
    return error.retryable;
  }
  // Generic errors are assumed retryable unless we know better
  return true;
}
