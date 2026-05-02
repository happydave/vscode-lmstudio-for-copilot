import { 
  LMStudioError, 
  ConnectionError, 
  TimeoutError, 
  ContextOverflowError, 
  ModelNotFoundError, 
  APIError, 
  ParseError,
  isLMStudioError,
  isContextOverflowError,
  isRetryableError
} from '../src/errors';

describe('Error Classes', () => {
  it('LMStudioError should be an instance of Error', () => {
    const error = new LMStudioError('test');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('LMStudioError');
    expect(error.retryable).toBe(true);
  });

  it('ConnectionError should set retryable to true', () => {
    const error = new ConnectionError('test');
    expect(error.retryable).toBe(true);
    expect(error.name).toBe('ConnectionError');
  });

  it('TimeoutError should set retryable to true', () => {
    const error = new TimeoutError(1000);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('1000ms');
  });

  it('ContextOverflowError should set retryable to false', () => {
    const error = new ContextOverflowError('overflow');
    expect(error.retryable).toBe(false);
  });

  it('APIError should store status code', () => {
    const error = new APIError('error', 404);
    expect(error.statusCode).toBe(404);
  });
});

describe('Type Guards', () => {
  it('isLMStudioError should work correctly', () => {
    expect(isLMStudioError(new LMStudioError('test'))).toBe(true);
    expect(isLMStudioError(new ConnectionError('test'))).toBe(true);
    expect(isLMStudioError(new Error('test'))).toBe(false);
  });

  it('isContextOverflowError should work correctly', () => {
    expect(isContextOverflowError(new ContextOverflowError('test'))).toBe(true);
    expect(isContextOverflowError(new LMStudioError('test'))).toBe(false);
  });

  it('isRetryableError should work correctly', () => {
    expect(isRetryableError(new ConnectionError('test'))).toBe(true);
    expect(isRetryableError(new ContextOverflowError('test'))).toBe(false);
    expect(isRetryableError(new Error('test'))).toBe(true); // Default
  });
});
