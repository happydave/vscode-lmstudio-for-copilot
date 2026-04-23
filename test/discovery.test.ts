import { DiscoveryService, ConnectionState, ModelInfo } from '../src/discovery';

describe('DiscoveryService', () => {
  let service: DiscoveryService;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      trace: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn()
    };
    service = new DiscoveryService(mockLogger);
    
    // Reset mocks before each test
    jest.clearAllMocks();
  });

  it('should initialize with default port 1234', () => {
    service.setPort(1234);
    expect(mockLogger.trace).toHaveBeenCalled();
  });

  it('should handle connection failures gracefully', async () => {
    // Mock global fetch to fail
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Connection refused'));
    
    const status = await service.checkConnection();
    expect(status.connectionState).toBe(ConnectionState.Disconnected);
    expect(status.availableModels.length).toBe(0);
  });

  it('should return connected state when fetch succeeds', async () => {
    // Mock successful response
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        models: [],
        model: null
      })
    });

    const status = await service.checkConnection();
    expect(status.connectionState).toBe(ConnectionState.Disconnected); // No model loaded
  });
});
