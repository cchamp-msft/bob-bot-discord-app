/**
 * ApiManager tests — exercises refreshClients, executeRequest routing,
 * health checks, testOllamaConnection, and validateWorkflow delegation.
 */

jest.mock('../src/api/ollamaClient', () => {
  const client = {
    refresh: jest.fn(),
    generate: jest.fn(),
    isHealthy: jest.fn(),
    testConnection: jest.fn(),
  };
  return { ollamaClient: client };
});

jest.mock('../src/api/comfyuiClient', () => {
  const client = {
    refresh: jest.fn(),
    generateImage: jest.fn(),
    isHealthy: jest.fn(),
    validateWorkflow: jest.fn(),
  };
  return { comfyuiClient: client };
});

jest.mock('../src/api/accuweatherClient', () => {
  const client = {
    refresh: jest.fn(),
    getWeather: jest.fn(),
    isHealthy: jest.fn(),
    testConnection: jest.fn(),
  };
  return { accuweatherClient: client };
});

jest.mock('../src/api/nflClient', () => {
  const client = {
    refresh: jest.fn(),
    handleRequest: jest.fn(),
    testConnection: jest.fn(),
  };
  return { nflClient: client };
});

jest.mock('../src/utils/config', () => ({
  config: {
    getOllamaModel: jest.fn(() => 'llama2'),
    getAccuWeatherEndpoint: jest.fn(() => 'https://dataservice.accuweather.com'),
    getAccuWeatherApiKey: jest.fn(() => ''),
    getAccuWeatherDefaultLocation: jest.fn(() => ''),
    getNflEndpoint: jest.fn(() => 'https://site.api.espn.com/apis/site/v2/sports/football/nfl'),
    getNflEnabled: jest.fn(() => false),
  },
}));

import { apiManager } from '../src/api/index';
import { ollamaClient } from '../src/api/ollamaClient';
import { comfyuiClient } from '../src/api/comfyuiClient';
import { nflClient } from '../src/api/nflClient';

describe('ApiManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('refreshClients', () => {
    it('should call refresh() on all clients', () => {
      apiManager.refreshClients();

      expect(ollamaClient.refresh).toHaveBeenCalledTimes(1);
      expect(comfyuiClient.refresh).toHaveBeenCalledTimes(1);
      expect(nflClient.refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('executeRequest', () => {
    it('should route comfyui requests to comfyuiClient', async () => {
      (comfyuiClient.generateImage as jest.Mock).mockResolvedValue({
        success: true,
        data: { images: [] },
      });

      const result = await apiManager.executeRequest('comfyui', 'user1', 'test prompt', 300);

      expect(comfyuiClient.generateImage).toHaveBeenCalledWith('test prompt', 'user1', undefined, 300);
      expect(result.success).toBe(true);
    });

    it('should route ollama requests to ollamaClient with configured model', async () => {
      (ollamaClient.generate as jest.Mock).mockResolvedValue({
        success: true,
        data: { text: 'response' },
      });

      const result = await apiManager.executeRequest('ollama', 'user1', 'hello', 300);

      expect(ollamaClient.generate).toHaveBeenCalledWith('hello', 'user1', 'llama2', undefined, undefined);
      expect(result.success).toBe(true);
    });

    it('should use explicit model when provided for ollama', async () => {
      (ollamaClient.generate as jest.Mock).mockResolvedValue({
        success: true,
        data: { text: 'code' },
      });

      await apiManager.executeRequest('ollama', 'user1', 'write code', 300, 'codellama');

      expect(ollamaClient.generate).toHaveBeenCalledWith('write code', 'user1', 'codellama', undefined, undefined);
    });

    it('should pass conversation history to ollamaClient', async () => {
      (ollamaClient.generate as jest.Mock).mockResolvedValue({
        success: true,
        data: { text: 'follow-up response' },
      });

      const history = [
        { role: 'user' as const, content: 'first message' },
        { role: 'assistant' as const, content: 'first response' },
      ];

      await apiManager.executeRequest('ollama', 'user1', 'follow up', 300, undefined, history);

      expect(ollamaClient.generate).toHaveBeenCalledWith('follow up', 'user1', 'llama2', history, undefined);
    });
  });

  describe('checkApiHealth', () => {
    it('should check comfyui health', async () => {
      (comfyuiClient.isHealthy as jest.Mock).mockResolvedValue(true);
      expect(await apiManager.checkApiHealth('comfyui')).toBe(true);
    });

    it('should check ollama health', async () => {
      (ollamaClient.isHealthy as jest.Mock).mockResolvedValue(false);
      expect(await apiManager.checkApiHealth('ollama')).toBe(false);
    });
  });

  describe('testOllamaConnection', () => {
    it('should delegate to ollamaClient.testConnection', async () => {
      const mockResult = { healthy: true, models: [{ name: 'llama2' }] };
      (ollamaClient.testConnection as jest.Mock).mockResolvedValue(mockResult);

      const result = await apiManager.testOllamaConnection();

      expect(result).toEqual(mockResult);
      expect(ollamaClient.testConnection).toHaveBeenCalledTimes(1);
    });
  });

  describe('validateWorkflow', () => {
    it('should delegate to comfyuiClient.validateWorkflow', () => {
      const mockResult = { valid: true };
      (comfyuiClient.validateWorkflow as jest.Mock).mockReturnValue(mockResult);

      const result = apiManager.validateWorkflow('{"text": "%prompt%"}');

      expect(result).toEqual(mockResult);
      expect(comfyuiClient.validateWorkflow).toHaveBeenCalledWith('{"text": "%prompt%"}');
    });
  });
});
