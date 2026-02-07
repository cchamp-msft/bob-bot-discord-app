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
    getOllamaSystemPrompt: jest.fn(() => ''),
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
    (config.getOllamaSystemPrompt as jest.Mock).mockReturnValue('');
    // Clear the model cache between tests
    (ollamaClient as any).modelCache = { names: new Set(), expiry: 0 };
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

    it('should cache model list and not call /api/tags again within TTL', async () => {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          models: [{ name: 'llama2', size: 0, details: {} }],
        },
      });

      // First call — fetches from server
      await ollamaClient.validateModel('llama2');
      expect(mockInstance.get).toHaveBeenCalledTimes(1);

      // Second call — should use cache
      await ollamaClient.validateModel('llama2');
      expect(mockInstance.get).toHaveBeenCalledTimes(1); // still 1
    });

    it('should invalidate cache after refresh()', async () => {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          models: [{ name: 'llama2', size: 0, details: {} }],
        },
      });

      await ollamaClient.validateModel('llama2');
      expect(mockInstance.get).toHaveBeenCalledTimes(1);

      // Refresh clears cache
      ollamaClient.refresh();

      await ollamaClient.validateModel('llama2');
      expect(mockInstance.get).toHaveBeenCalledTimes(2); // re-fetched
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
        data: { message: { content: 'Hello! How can I help?' } },
      });

      const result = await ollamaClient.generate('hello', 'user1');

      expect(result.success).toBe(true);
      expect(result.data?.text).toBe('Hello! How can I help?');
      expect(mockInstance.post).toHaveBeenCalledWith('/api/chat', {
        model: 'llama2',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }, undefined);
    });

    it('should include system prompt in request when configured', async () => {
      (config.getOllamaModel as jest.Mock).mockReturnValue('llama2');
      (config.getOllamaSystemPrompt as jest.Mock).mockReturnValue('You are a helpful bot.');

      mockInstance.get.mockResolvedValue({
        status: 200,
        data: { models: [{ name: 'llama2', size: 0, details: {} }] },
      });

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { message: { content: 'Hi there!' } },
      });

      const result = await ollamaClient.generate('hello', 'user1');

      expect(result.success).toBe(true);
      expect(mockInstance.post).toHaveBeenCalledWith('/api/chat', {
        model: 'llama2',
        messages: [
          { role: 'system', content: 'You are a helpful bot.' },
          { role: 'user', content: 'hello' },
        ],
        stream: false,
      }, undefined);
    });

    it('should omit system message when system prompt is empty', async () => {
      (config.getOllamaModel as jest.Mock).mockReturnValue('llama2');
      (config.getOllamaSystemPrompt as jest.Mock).mockReturnValue('');

      mockInstance.get.mockResolvedValue({
        status: 200,
        data: { models: [{ name: 'llama2', size: 0, details: {} }] },
      });

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { message: { content: 'Raw response' } },
      });

      const result = await ollamaClient.generate('hello', 'user1');

      expect(result.success).toBe(true);
      const callArgs = mockInstance.post.mock.calls[0][1];
      // Should only have user message, no system message
      expect(callArgs.messages).toEqual([
        { role: 'user', content: 'hello' },
      ]);
    });

    it('should use explicit model parameter over configured default', async () => {
      (config.getOllamaModel as jest.Mock).mockReturnValue('llama2');

      mockInstance.get.mockResolvedValue({
        status: 200,
        data: { models: [{ name: 'codellama', size: 0, details: {} }] },
      });

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { message: { content: 'code result' } },
      });

      const result = await ollamaClient.generate('write code', 'user1', 'codellama');

      expect(result.success).toBe(true);
      expect(mockInstance.post).toHaveBeenCalledWith('/api/chat', {
        model: 'codellama',
        messages: [{ role: 'user', content: 'write code' }],
        stream: false,
      }, undefined);
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

    it('should include conversation history in messages when provided', async () => {
      (config.getOllamaModel as jest.Mock).mockReturnValue('llama2');
      (config.getOllamaSystemPrompt as jest.Mock).mockReturnValue('Be helpful.');

      mockInstance.get.mockResolvedValue({
        status: 200,
        data: { models: [{ name: 'llama2', size: 0, details: {} }] },
      });

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { message: { content: 'Sure, here is the follow-up.' } },
      });

      const history = [
        { role: 'user' as const, content: 'What is 2+2?' },
        { role: 'assistant' as const, content: '4' },
      ];

      const result = await ollamaClient.generate('And 3+3?', 'user1', undefined, history);

      expect(result.success).toBe(true);
      expect(result.data?.text).toBe('Sure, here is the follow-up.');
      expect(mockInstance.post).toHaveBeenCalledWith('/api/chat', {
        model: 'llama2',
        messages: [
          { role: 'system', content: 'Be helpful.' },
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: '4' },
          { role: 'user', content: 'And 3+3?' },
        ],
        stream: false,
      }, undefined);
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

    it('should return healthy true with empty models when server returns none', async () => {
      mockInstance.get.mockResolvedValue({ status: 200, data: { models: [] } });

      const result = await ollamaClient.testConnection();
      expect(result.healthy).toBe(true);
      expect(result.models).toEqual([]);
    });

    it('should return unhealthy on network error (ECONNREFUSED)', async () => {
      mockInstance.get.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'));

      const result = await ollamaClient.testConnection();

      expect(result.healthy).toBe(false);
      expect(result.models).toEqual([]);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('should return unhealthy on timeout', async () => {
      mockInstance.get.mockRejectedValue(new Error('timeout of 5000ms exceeded'));

      const result = await ollamaClient.testConnection();

      expect(result.healthy).toBe(false);
      expect(result.models).toEqual([]);
      expect(result.error).toContain('timeout');
    });

    it('should return unhealthy on generic network error', async () => {
      mockInstance.get.mockRejectedValue(new Error('Network Error'));

      const result = await ollamaClient.testConnection();

      expect(result.healthy).toBe(false);
      expect(result.models).toEqual([]);
      expect(result.error).toBe('Network Error');
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
