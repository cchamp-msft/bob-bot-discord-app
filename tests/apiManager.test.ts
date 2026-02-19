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

jest.mock('../src/api/memeClient', () => {
  const client = {
    refresh: jest.fn(),
    handleRequest: jest.fn(),
    testConnection: jest.fn(),
    initialise: jest.fn(),
    destroy: jest.fn(),
  };
  return { memeClient: client };
});

jest.mock('../src/utils/config', () => ({
  config: {
    getOllamaModel: jest.fn(() => 'llama2'),
    getAccuWeatherEndpoint: jest.fn(() => 'https://dataservice.accuweather.com'),
    getAccuWeatherApiKey: jest.fn(() => ''),
    getAccuWeatherDefaultLocation: jest.fn(() => ''),
    getAccuWeatherDefaultWeatherType: jest.fn(() => 'full'),
    getNflEndpoint: jest.fn(() => 'https://site.api.espn.com/apis/site/v2/sports/football/nfl'),
    getNflEnabled: jest.fn(() => false),
    getSerpApiEndpoint: jest.fn(() => 'https://serpapi.com'),
    getSerpApiKey: jest.fn(() => ''),
    getMemeEndpoint: jest.fn(() => 'https://api.memegen.link'),
    getMemeEnabled: jest.fn(() => true),
  },
}));

import { apiManager } from '../src/api/index';
import { ollamaClient } from '../src/api/ollamaClient';
import { comfyuiClient } from '../src/api/comfyuiClient';
import { nflClient } from '../src/api/nflClient';
import { memeClient } from '../src/api/memeClient';

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
      expect(memeClient.refresh).toHaveBeenCalledTimes(1);
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

      expect(ollamaClient.generate).toHaveBeenCalledWith('hello', 'user1', 'llama2', undefined, undefined, undefined, undefined);
      expect(result.success).toBe(true);
    });

    it('should use explicit model when provided for ollama', async () => {
      (ollamaClient.generate as jest.Mock).mockResolvedValue({
        success: true,
        data: { text: 'code' },
      });

      await apiManager.executeRequest('ollama', 'user1', 'write code', 300, 'codellama');

      expect(ollamaClient.generate).toHaveBeenCalledWith('write code', 'user1', 'codellama', undefined, undefined, undefined, undefined);
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

      expect(ollamaClient.generate).toHaveBeenCalledWith('follow up', 'user1', 'llama2', history, undefined, undefined, undefined);
    });

    it('should forward ollamaOptions to ollamaClient.generate', async () => {
      (ollamaClient.generate as jest.Mock).mockResolvedValue({
        success: true,
        data: { text: 'response' },
      });

      await apiManager.executeRequest(
        'ollama', 'user1', 'hello', 300, undefined, undefined, undefined, undefined,
        { includeSystemPrompt: false }
      );

      expect(ollamaClient.generate).toHaveBeenCalledWith(
        'hello', 'user1', 'llama2', undefined, undefined, { includeSystemPrompt: false }, undefined
      );
    });

    it('should forward images through ollamaOptions to ollamaClient.generate', async () => {
      (ollamaClient.generate as jest.Mock).mockResolvedValue({
        success: true,
        data: { text: 'I see a cat in the image' },
      });

      const images = ['base64img1', 'base64img2'];

      const result = await apiManager.executeRequest(
        'ollama', 'user1', 'describe this image', 300, undefined, undefined, undefined, undefined,
        { images }
      );

      expect(ollamaClient.generate).toHaveBeenCalledWith(
        'describe this image', 'user1', 'llama2', undefined, undefined, { images }, images
      );
      expect(result.success).toBe(true);
    });

    it('should forward both includeSystemPrompt and images in ollamaOptions', async () => {
      (ollamaClient.generate as jest.Mock).mockResolvedValue({
        success: true,
        data: { text: 'vision response' },
      });

      const images = ['base64data'];

      await apiManager.executeRequest(
        'ollama', 'user1', 'what is this?', 300, undefined, undefined, undefined, undefined,
        { includeSystemPrompt: false, images }
      );

      expect(ollamaClient.generate).toHaveBeenCalledWith(
        'what is this?', 'user1', 'llama2', undefined, undefined,
        { includeSystemPrompt: false, images }, images
      );
    });

    it('should not pass images for non-ollama API requests', async () => {
      (comfyuiClient.generateImage as jest.Mock).mockResolvedValue({
        success: true,
        data: { images: [] },
      });

      await apiManager.executeRequest('comfyui', 'user1', 'test prompt', 300);

      expect(ollamaClient.generate).not.toHaveBeenCalled();
      expect(comfyuiClient.generateImage).toHaveBeenCalledWith('test prompt', 'user1', undefined, 300);
    });
    it('should route meme requests to memeClient', async () => {
      (memeClient.handleRequest as jest.Mock).mockResolvedValue({
        success: true,
        data: { text: 'One does not simply walk into Mordor', imageUrl: 'https://api.memegen.link/images/mordor.png' },
      });

      const result = await apiManager.executeRequest('meme', 'user1', 'mordor | one does not simply', 60);

      expect(memeClient.handleRequest).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('checkMemeHealth', () => {
    it('should delegate to memeClient.testConnection', async () => {
      const mockResult = { healthy: true, templateCount: 100 };
      (memeClient.testConnection as jest.Mock).mockResolvedValue(mockResult);

      const result = await apiManager.checkMemeHealth();

      expect(result).toEqual(mockResult);
      expect(memeClient.testConnection).toHaveBeenCalledTimes(1);
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
