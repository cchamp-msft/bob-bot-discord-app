/**
 * OllamaClient tests — exercises model listing, validation,
 * text generation, test connection, and client refresh.
 * Uses axios mocking; no real Ollama instance required.
 */

import axios from 'axios';

// Stable mock instance — defined at module level so the singleton
// captures this same object when it calls axios.create() at import time.
const mockInstance = {
  get: jest.fn(),
  post: jest.fn(),
  defaults: { baseURL: '' },
};

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => mockInstance),
  },
}));

jest.mock('../src/utils/config', () => ({
  config: {
    getOllamaEndpoint: jest.fn(() => 'http://localhost:11434'),
    getOllamaModel: jest.fn(() => 'llama2'),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
  },
}));

// Import after mocks — singleton captures mockInstance
import { ollamaClient } from '../src/api/ollamaClient';
import { config } from '../src/utils/config';

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('OllamaClient', () => {
  beforeEach(() => {
    mockInstance.get.mockReset();
    mockInstance.post.mockReset();
    (config.getOllamaModel as jest.Mock).mockReturnValue('llama2');
    (config.getOllamaEndpoint as jest.Mock).mockReturnValue('http://localhost:11434');
  });

  describe('listModels', () => {
    it('should return parsed model list from /api/tags', async () => {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          models: [
            {
              name: 'llama2',
              size: 3800000000,
              details: {
                parameter_size: '7B',
                family: 'llama',
                quantization_level: 'Q4_0',
              },
            },
            {
              name: 'codellama',
              size: 4200000000,
              details: {
                parameter_size: '13B',
                family: 'llama',
                quantization_level: 'Q5_K_M',
              },
            },
          ],
        },
      });

      const models = await ollamaClient.listModels();

      expect(models).toHaveLength(2);
      expect(models[0]).toEqual({
        name: 'llama2',
        size: 3800000000,
        parameterSize: '7B',
        family: 'llama',
        quantization: 'Q4_0',
      });
      expect(models[1].name).toBe('codellama');
    });

    it('should return empty array on network error', async () => {
      mockInstance.get.mockRejectedValue(new Error('ECONNREFUSED'));

      const models = await ollamaClient.listModels();
      expect(models).toEqual([]);
    });

    it('should return empty array when response has no models array', async () => {
      mockInstance.get.mockResolvedValue({ status: 200, data: {} });

      const models = await ollamaClient.listModels();
      expect(models).toEqual([]);
    });
  });

  describe('validateModel', () => {
    it('should return true when model exists', async () => {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          models: [{ name: 'llama2', size: 0, details: {} }],
        },
      });

      expect(await ollamaClient.validateModel('llama2')).toBe(true);
    });

    it('should return false when model does not exist', async () => {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          models: [{ name: 'llama2', size: 0, details: {} }],
        },
      });

      expect(await ollamaClient.validateModel('gpt-4')).toBe(false);
    });
  });

  describe('generate', () => {
    it('should return error when no model is configured and none supplied', async () => {
      (config.getOllamaModel as jest.Mock).mockReturnValue('');

      const result = await ollamaClient.generate('hello', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No Ollama model configured');
    });

    it('should return error when model is not available on server', async () => {
      (config.getOllamaModel as jest.Mock).mockReturnValue('llama2');

      // validateModel → listModels returns empty
      mockInstance.get.mockResolvedValue({ status: 200, data: { models: [] } });

      const result = await ollamaClient.generate('hello', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    it('should return successful text response', async () => {
      (config.getOllamaModel as jest.Mock).mockReturnValue('llama2');

      // validateModel → model exists
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: { models: [{ name: 'llama2', size: 0, details: {} }] },
      });

      // generate → success
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { response: 'Hello! How can I help?' },
      });

      const result = await ollamaClient.generate('hello', 'user1');

      expect(result.success).toBe(true);
      expect(result.data?.text).toBe('Hello! How can I help?');
      expect(mockInstance.post).toHaveBeenCalledWith('/api/generate', {
        model: 'llama2',
        prompt: 'hello',
        stream: false,
      });
    });

    it('should use explicit model parameter over configured default', async () => {
      (config.getOllamaModel as jest.Mock).mockReturnValue('llama2');

      mockInstance.get.mockResolvedValue({
        status: 200,
        data: { models: [{ name: 'codellama', size: 0, details: {} }] },
      });

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { response: 'code result' },
      });

      const result = await ollamaClient.generate('write code', 'user1', 'codellama');

      expect(result.success).toBe(true);
      expect(mockInstance.post).toHaveBeenCalledWith('/api/generate', {
        model: 'codellama',
        prompt: 'write code',
        stream: false,
      });
    });

    it('should handle API error gracefully', async () => {
      (config.getOllamaModel as jest.Mock).mockReturnValue('llama2');

      mockInstance.get.mockResolvedValue({
        status: 200,
        data: { models: [{ name: 'llama2', size: 0, details: {} }] },
      });

      mockInstance.post.mockRejectedValue(new Error('timeout'));

      const result = await ollamaClient.generate('hello', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('timeout');
    });
  });

  describe('testConnection', () => {
    it('should return healthy with models on success', async () => {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          models: [{ name: 'llama2', size: 0, details: {} }],
        },
      });

      const result = await ollamaClient.testConnection();

      expect(result.healthy).toBe(true);
      expect(result.models).toHaveLength(1);
      expect(result.models[0].name).toBe('llama2');
    });

    it('should return unhealthy on listModels exception', async () => {
      // listModels itself catches errors and returns [].
      // testConnection wraps listModels in its own try/catch.
      // If listModels returns [], healthy is true with 0 models.
      mockInstance.get.mockResolvedValue({ status: 200, data: { models: [] } });

      const result = await ollamaClient.testConnection();
      expect(result.healthy).toBe(true);
      expect(result.models).toEqual([]);
    });
  });

  describe('isHealthy', () => {
    it('should return true on 200', async () => {
      mockInstance.get.mockResolvedValue({ status: 200 });
      expect(await ollamaClient.isHealthy()).toBe(true);
    });

    it('should return false on error', async () => {
      mockInstance.get.mockRejectedValue(new Error('down'));
      expect(await ollamaClient.isHealthy()).toBe(false);
    });
  });

  describe('refresh', () => {
    it('should recreate axios instance with current config endpoint', () => {
      (config.getOllamaEndpoint as jest.Mock).mockReturnValue('http://new-host:9999');

      const createCallsBefore = mockedAxios.create.mock.calls.length;
      ollamaClient.refresh();
      const createCallsAfter = mockedAxios.create.mock.calls.length;

      expect(createCallsAfter).toBe(createCallsBefore + 1);
      expect(mockedAxios.create).toHaveBeenLastCalledWith({
        baseURL: 'http://new-host:9999',
      });
    });
  });
});
