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
    getOllamaVisionModel: jest.fn(() => 'llava:7b'),
    getOllamaSystemPrompt: jest.fn(() => ''),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
    logDebug: jest.fn(),
    logDebugLazy: jest.fn(),
    log: jest.fn(),
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
    (config.getOllamaVisionModel as jest.Mock).mockReturnValue('llava:7b');
    // Clear the model cache between tests
    (ollamaClient as any).modelCache = { names: new Set(), expiry: 0 };
    (ollamaClient as any).visionCache = new Map();
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

    it('should skip global system prompt when includeSystemPrompt is false', async () => {
      (config.getOllamaModel as jest.Mock).mockReturnValue('llama2');
      (config.getOllamaSystemPrompt as jest.Mock).mockReturnValue('You are a helpful bot.');

      mockInstance.get.mockResolvedValue({
        status: 200,
        data: { models: [{ name: 'llama2', size: 0, details: {} }] },
      });

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { message: { content: 'eval result' } },
      });

      const evalSystemPrompt = [{ role: 'system' as const, content: 'You are an evaluator.' }];
      const result = await ollamaClient.generate(
        'evaluate this',
        'user1',
        undefined,
        evalSystemPrompt,
        undefined,
        { includeSystemPrompt: false }
      );

      expect(result.success).toBe(true);
      const callArgs = mockInstance.post.mock.calls[0][1];
      // Should NOT include the global system prompt, only the caller-supplied one
      expect(callArgs.messages).toEqual([
        { role: 'system', content: 'You are an evaluator.' },
        { role: 'user', content: 'evaluate this' },
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

    it('should clear vision cache on refresh', async () => {
      // Populate vision cache
      (ollamaClient as any).visionCache.set('llama2', { capable: false, expiry: Date.now() + 60000 });

      ollamaClient.refresh();

      expect((ollamaClient as any).visionCache.size).toBe(0);
    });
  });

  describe('isVisionCapable', () => {
    it('should return true when model_info contains vision key', async () => {
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: {
          model_info: {
            'general.architecture': 'llama',
            'llama.vision.image_size': 560,
            'llama.attention.head_count': 32,
          },
          details: { families: ['llama'] },
        },
      });

      expect(await ollamaClient.isVisionCapable('llava:7b')).toBe(true);
    });

    it('should return true when model_info contains projector key', async () => {
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: {
          model_info: {
            'general.architecture': 'llama',
            'projector.type': 'mlp',
          },
          details: { families: ['llama'] },
        },
      });

      expect(await ollamaClient.isVisionCapable('llava:7b')).toBe(true);
    });

    it('should return true when details.families contains clip', async () => {
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: {
          model_info: { 'general.architecture': 'llama' },
          details: { families: ['llama', 'clip'] },
        },
      });

      expect(await ollamaClient.isVisionCapable('llava:7b')).toBe(true);
    });

    it('should return false for a text-only model', async () => {
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: {
          model_info: { 'general.architecture': 'llama' },
          details: { families: ['llama'] },
        },
      });

      expect(await ollamaClient.isVisionCapable('llama2')).toBe(false);
    });

    it('should return false on network error', async () => {
      mockInstance.post.mockRejectedValue(new Error('ECONNREFUSED'));

      expect(await ollamaClient.isVisionCapable('llava:7b')).toBe(false);
    });

    it('should cache vision capability result', async () => {
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: {
          model_info: { 'general.architecture': 'llama' },
          details: { families: ['llama', 'clip'] },
        },
      });

      await ollamaClient.isVisionCapable('llava:7b');
      await ollamaClient.isVisionCapable('llava:7b');

      // Should have only called /api/show once
      expect(mockInstance.post).toHaveBeenCalledTimes(1);
      expect(mockInstance.post).toHaveBeenCalledWith('/api/show', { name: 'llava:7b' });
    });
  });

  describe('generate with images', () => {
    const setupModelExists = () => {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: { models: [{ name: 'llava:7b', size: 0, details: {} }, { name: 'llama2', size: 0, details: {} }] },
      });
    };

    it('should include images in user message when provided', async () => {
      setupModelExists();

      // isVisionCapable → true (has clip family)
      mockInstance.post.mockImplementation((url: string, data: unknown) => {
        if (url === '/api/show') {
          return Promise.resolve({
            status: 200,
            data: {
              model_info: {},
              details: { families: ['llama', 'clip'] },
            },
          });
        }
        return Promise.resolve({
          status: 200,
          data: { message: { content: 'I see a cat in the image.' } },
        });
      });

      const result = await ollamaClient.generate(
        'What is in this image?', 'user1', 'llava:7b',
        undefined, undefined, undefined,
        ['base64imagedata']
      );

      expect(result.success).toBe(true);
      expect(result.data?.text).toBe('I see a cat in the image.');

      // Verify the /api/chat call includes images on the user message
      const chatCall = mockInstance.post.mock.calls.find(
        (c: unknown[]) => c[0] === '/api/chat'
      );
      expect(chatCall).toBeDefined();
      const messages = (chatCall![1] as any).messages;
      const userMsg = messages.find((m: any) => m.role === 'user');
      expect(userMsg.images).toEqual(['base64imagedata']);
    });

    it('should auto-switch to vision model when active model lacks capability', async () => {
      setupModelExists();
      (config.getOllamaModel as jest.Mock).mockReturnValue('llama2');
      (config.getOllamaVisionModel as jest.Mock).mockReturnValue('llava:7b');

      mockInstance.post.mockImplementation((url: string, data: unknown) => {
        if (url === '/api/show') {
          const body = data as { name: string };
          if (body.name === 'llama2') {
            return Promise.resolve({
              status: 200,
              data: { model_info: {}, details: { families: ['llama'] } },
            });
          }
          // llava:7b — vision capable
          return Promise.resolve({
            status: 200,
            data: { model_info: {}, details: { families: ['llama', 'clip'] } },
          });
        }
        return Promise.resolve({
          status: 200,
          data: { message: { content: 'Switched to vision model response.' } },
        });
      });

      const result = await ollamaClient.generate(
        'Describe this', 'user1', 'llama2',
        undefined, undefined, undefined,
        ['imgdata']
      );

      expect(result.success).toBe(true);
      // Should have called /api/chat with the vision model
      const chatCall = mockInstance.post.mock.calls.find(
        (c: unknown[]) => c[0] === '/api/chat'
      );
      expect((chatCall![1] as any).model).toBe('llava:7b');
    });

    it('should return error when model lacks vision and no vision model configured', async () => {
      setupModelExists();
      (config.getOllamaModel as jest.Mock).mockReturnValue('llama2');
      (config.getOllamaVisionModel as jest.Mock).mockReturnValue('llama2'); // same as default — no dedicated vision model

      mockInstance.post.mockImplementation((url: string) => {
        if (url === '/api/show') {
          return Promise.resolve({
            status: 200,
            data: { model_info: {}, details: { families: ['llama'] } },
          });
        }
        return Promise.resolve({ status: 200, data: { message: { content: '' } } });
      });

      const result = await ollamaClient.generate(
        'Describe this', 'user1', 'llama2',
        undefined, undefined, undefined,
        ['imgdata']
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not support images');
      expect(result.error).toContain('OLLAMA_VISION_MODEL');
    });

    it('should not include images field when no images provided', async () => {
      setupModelExists();
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { message: { content: 'Text only response' } },
      });

      await ollamaClient.generate('hello', 'user1', 'llama2');

      const chatCall = mockInstance.post.mock.calls.find(
        (c: unknown[]) => c[0] === '/api/chat'
      );
      const messages = (chatCall![1] as any).messages;
      const userMsg = messages.find((m: any) => m.role === 'user');
      expect(userMsg.images).toBeUndefined();
    });

    it('should forward images from conversation history messages to /api/chat', async () => {
      setupModelExists();

      // Vision-capable model
      mockInstance.post.mockImplementation((url: string) => {
        if (url === '/api/show') {
          return Promise.resolve({
            status: 200,
            data: { model_info: {}, details: { families: ['llama', 'clip'] } },
          });
        }
        return Promise.resolve({
          status: 200,
          data: { message: { content: 'I see an image in your earlier message.' } },
        });
      });

      const history = [
        { role: 'user' as const, content: 'Check this out', images: ['historyBase64Image'] },
        { role: 'assistant' as const, content: 'Nice image!' },
      ];

      const result = await ollamaClient.generate(
        'What was in that earlier image?', 'user1', 'llava:7b',
        history
      );

      expect(result.success).toBe(true);

      const chatCall = mockInstance.post.mock.calls.find(
        (c: unknown[]) => c[0] === '/api/chat'
      );
      expect(chatCall).toBeDefined();
      const messages = (chatCall![1] as any).messages;

      // History message with images should retain them
      const historyUserMsg = messages.find((m: any) => m.role === 'user' && m.content === 'Check this out');
      expect(historyUserMsg).toBeDefined();
      expect(historyUserMsg.images).toEqual(['historyBase64Image']);

      // Assistant message should not have images
      const assistantMsg = messages.find((m: any) => m.role === 'assistant');
      expect(assistantMsg.images).toBeUndefined();
    });

    it('should auto-switch to vision model when only history messages have images', async () => {
      setupModelExists();
      (config.getOllamaModel as jest.Mock).mockReturnValue('llama2');
      (config.getOllamaVisionModel as jest.Mock).mockReturnValue('llava:7b');

      mockInstance.post.mockImplementation((url: string, data: unknown) => {
        if (url === '/api/show') {
          const body = data as { name: string };
          if (body.name === 'llama2') {
            return Promise.resolve({
              status: 200,
              data: { model_info: {}, details: { families: ['llama'] } },
            });
          }
          return Promise.resolve({
            status: 200,
            data: { model_info: {}, details: { families: ['llama', 'clip'] } },
          });
        }
        return Promise.resolve({
          status: 200,
          data: { message: { content: 'Switched to vision for history images.' } },
        });
      });

      const history = [
        { role: 'user' as const, content: 'Here is a photo', images: ['base64data'] },
      ];

      // No direct images param — only history carries images
      const result = await ollamaClient.generate(
        'What was in that photo?', 'user1', 'llama2',
        history
      );

      expect(result.success).toBe(true);
      const chatCall = mockInstance.post.mock.calls.find(
        (c: unknown[]) => c[0] === '/api/chat'
      );
      expect((chatCall![1] as any).model).toBe('llava:7b');
    });

    it('should return error when history has images but no vision model configured', async () => {
      setupModelExists();
      (config.getOllamaModel as jest.Mock).mockReturnValue('llama2');
      (config.getOllamaVisionModel as jest.Mock).mockReturnValue('llama2');

      mockInstance.post.mockImplementation((url: string) => {
        if (url === '/api/show') {
          return Promise.resolve({
            status: 200,
            data: { model_info: {}, details: { families: ['llama'] } },
          });
        }
        return Promise.resolve({ status: 200, data: { message: { content: '' } } });
      });

      const history = [
        { role: 'user' as const, content: 'Photo', images: ['imgdata'] },
      ];

      const result = await ollamaClient.generate(
        'Describe it', 'user1', 'llama2',
        history
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not support images');
    });
  });
});
