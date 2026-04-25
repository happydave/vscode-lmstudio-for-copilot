import { DiscoveryService, ConnectionState } from '../src/discovery';

describe('DiscoveryService v1 API', () => {
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

  it('should parse v1 model list with loaded instances', async () => {
    const mockResponse = {
      models: [
        {
          key: 'google/gemma-4-26b-a4b',
          display_name: 'Gemma 4 26B A4B',
          max_context_length: 262144,
          quantization: { name: 'Q4_K_M' },
          loaded_instances: [
            {
              id: 'google/gemma-4-26b-a4b',
              config: {
                context_length: 65536
              }
            }
          ]
        }
      ]
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(mockResponse)
    });

    const status = await service.checkConnection();
    
    expect(status.connectionState).toBe(ConnectionState.Connected);
    expect(status.activeModelId).toBe('google/gemma-4-26b-a4b');
    expect(status.availableModels.length).toBe(1);
    
    const model = status.availableModels[0];
    expect(model.id).toBe('google/gemma-4-26b-a4b');
    expect(model.maxContextLength).toBe(262144);
    expect(model.loadedContextLength).toBe(65536);
    expect(model.loaded).toBe(true);
  });

  it('should parse v1 model list with no loaded instances', async () => {
    const mockResponse = {
      models: [
        {
          key: 'deepseek-r1',
          display_name: 'DeepSeek R1',
          max_context_length: 131072,
          loaded_instances: []
        }
      ]
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(mockResponse)
    });

    const status = await service.checkConnection();
    
    expect(status.connectionState).toBe(ConnectionState.NoModelLoaded);
    expect(status.availableModels.length).toBe(1);
    
    const model = status.availableModels[0];
    expect(model.loaded).toBe(false);
    expect(model.loadedContextLength).toBeUndefined();
  });

  it('should warn when loaded context is less than architectural max', async () => {
    const mockResponse = {
      models: [
        {
          key: 'test-model',
          max_context_length: 10000,
          loaded_instances: [
            {
              id: 'test-model',
              config: {
                context_length: 5000
              }
            }
          ]
        }
      ]
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(mockResponse)
    });

    await service.checkConnection();
    
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('is loaded with reduced context (5000 tokens) vs architectural max (10000 tokens)')
    );
  });

  it('should send context_length when loading a model', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200
    });

    const success = await service.loadModel('test-model', 16384);
    
    expect(success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/models/load'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'test-model',
          context_length: 16384
        })
      })
    );
  });
});
