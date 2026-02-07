/**
 * ComfyUIClient tests — exercises workflow validation,
 * image generation with prompt substitution, and client refresh.
 * Uses axios mocking; no real ComfyUI instance required.
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
    getComfyUIEndpoint: jest.fn(() => 'http://localhost:8188'),
    getComfyUIWorkflow: jest.fn(() => ''),
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
import { comfyuiClient } from '../src/api/comfyuiClient';
import { config } from '../src/utils/config';

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('ComfyUIClient', () => {
  // Mock baseURL so extractImageUrls can build full /view URLs
  beforeEach(() => {
    mockInstance.get.mockReset();
    mockInstance.post.mockReset();
    mockInstance.defaults.baseURL = 'http://localhost:8188';
    (config.getComfyUIWorkflow as jest.Mock).mockReturnValue('');
    (config.getComfyUIEndpoint as jest.Mock).mockReturnValue('http://localhost:8188');
  });

  describe('validateWorkflow', () => {
    it('should reject invalid JSON', () => {
      const result = comfyuiClient.validateWorkflow('not json at all');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });

    it('should reject valid JSON without %prompt% placeholder', () => {
      const result = comfyuiClient.validateWorkflow('{"node": {"text": "hello"}}');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('%prompt%');
      expect(result.error).toContain('case-sensitive');
    });

    it('should reject %PROMPT% (wrong case)', () => {
      const result = comfyuiClient.validateWorkflow('{"node": {"text": "%PROMPT%"}}');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('%prompt%');
    });

    it('should accept valid JSON with %prompt% placeholder', () => {
      const result = comfyuiClient.validateWorkflow('{"node": {"text": "%prompt%"}}');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept workflow with multiple %prompt% occurrences', () => {
      const workflow = '{"pos": "%prompt%", "neg": "not %prompt%"}';
      const result = comfyuiClient.validateWorkflow(workflow);
      expect(result.valid).toBe(true);
    });
  });

  describe('generateImage', () => {
    /** Helper: mock a successful prompt submit + history poll cycle. */
    function mockSuccessfulGeneration(outputImages: Array<Record<string, string>> = [{ filename: 'img_001.png', subfolder: '', type: 'output' }]) {
      const promptId = 'test-prompt-id-123';

      // POST /api/prompt → prompt_id
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { prompt_id: promptId, number: 1, node_errors: {} },
      });

      // GET /history/{promptId} → completed result
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          [promptId]: {
            outputs: {
              '9': { images: outputImages },
            },
          },
        },
      });

      return promptId;
    }

    it('should return error when no workflow is configured', async () => {
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue('');

      const result = await comfyuiClient.generateImage('sunset', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No ComfyUI workflow configured');
    });

    it('should return error when workflow has no %prompt% placeholder', async () => {
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue('{"node": "no placeholder"}');

      const result = await comfyuiClient.generateImage('sunset', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('validation failed');
    });

    it('should substitute %prompt%, submit, poll history, and return image URLs', async () => {
      const workflow = '{"3": {"inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockSuccessfulGeneration([{ filename: 'sunset_001.png', subfolder: '', type: 'output' }]);

      const result = await comfyuiClient.generateImage('a beautiful sunset', 'user1');

      expect(result.success).toBe(true);
      expect(result.data?.images).toHaveLength(1);
      expect(result.data?.images?.[0]).toContain('/view?filename=sunset_001.png');

      // Verify substitution in POST body
      const sentBody = mockInstance.post.mock.calls[0][1];
      expect(sentBody.prompt).toEqual({ '3': { inputs: { text: 'a beautiful sunset' } } });
      expect(sentBody.client_id).toBe('user1');
    });

    it('should substitute all %prompt% occurrences', async () => {
      const workflow = '{"pos": "%prompt%", "title": "Job: %prompt%"}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockSuccessfulGeneration();

      await comfyuiClient.generateImage('cat', 'user1');

      const sentBody = mockInstance.post.mock.calls[0][1];
      expect(sentBody.prompt.pos).toBe('cat');
      expect(sentBody.prompt.title).toBe('Job: cat');
    });

    it('should JSON-escape prompts with quotes and backslashes', async () => {
      const workflow = '{"inputs": {"text": "%prompt%"}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockSuccessfulGeneration();

      await comfyuiClient.generateImage('say "hello" with back\\slash', 'user1');

      const sentBody = mockInstance.post.mock.calls[0][1];
      expect(sentBody.prompt.inputs.text).toBe('say "hello" with back\\slash');
    });

    it('should return failure when prompt submit returns node_errors', async () => {
      const workflow = '{"inputs": {"text": "%prompt%"}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: {
          prompt_id: undefined,
          node_errors: { '3': { class_type: 'KSampler', errors: ['Invalid seed'] } },
        },
      });

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('workflow errors');
    });

    it('should extract error details from ComfyUI HTTP 500 response', async () => {
      const workflow = '{"inputs": {"text": "%prompt%"}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      // Axios throws on non-2xx with a response property
      const axiosError = new Error('Request failed with status code 500') as any;
      axiosError.response = {
        status: 500,
        data: { error: 'Prompt outputs failed validation', node_errors: { '3': 'bad value' } },
      };
      mockInstance.post.mockRejectedValue(axiosError);

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 500');
      expect(result.error).toContain('Prompt outputs failed validation');
    });

    it('should handle network error on prompt submit gracefully', async () => {
      const workflow = '{"inputs": {"text": "%prompt%"}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockInstance.post.mockRejectedValue(new Error('Connection refused'));

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection refused');
    });

    it('should collect images from multiple output nodes', async () => {
      const workflow = '{"inputs": {"text": "%prompt%"}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      const promptId = 'multi-node-id';
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { prompt_id: promptId },
      });

      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          [promptId]: {
            outputs: {
              '9': { images: [{ filename: 'img_a.png', subfolder: '', type: 'output' }] },
              '12': { images: [{ filename: 'img_b.png', subfolder: 'previews', type: 'temp' }] },
            },
          },
        },
      });

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(true);
      expect(result.data?.images).toHaveLength(2);
      expect(result.data?.images?.[0]).toContain('filename=img_a.png');
      expect(result.data?.images?.[1]).toContain('filename=img_b.png');
      expect(result.data?.images?.[1]).toContain('subfolder=previews');
      expect(result.data?.images?.[1]).toContain('type=temp');
    });
  });

  describe('pollForCompletion', () => {
    it('should return history data when prompt completes on first poll', async () => {
      const promptId = 'quick-id';
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          [promptId]: { outputs: { '9': { images: [] } } },
        },
      });

      const result = await comfyuiClient.pollForCompletion(promptId);

      expect(result).not.toBeNull();
      expect(result?.outputs).toBeDefined();
      expect(mockInstance.get).toHaveBeenCalledWith(`/history/${promptId}`);
    });

    it('should return null when aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await comfyuiClient.pollForCompletion('any-id', controller.signal);

      expect(result).toBeNull();
    });
  });

  describe('extractImageUrls', () => {
    it('should build /view URLs from output images', () => {
      const historyData = {
        outputs: {
          '9': {
            images: [
              { filename: 'img_001.png', subfolder: '', type: 'output' },
            ],
          },
        },
      };

      const urls = comfyuiClient.extractImageUrls(historyData);

      expect(urls).toHaveLength(1);
      expect(urls[0]).toBe('http://localhost:8188/view?filename=img_001.png&type=output');
    });

    it('should include subfolder when present', () => {
      const historyData = {
        outputs: {
          '9': {
            images: [
              { filename: 'preview.png', subfolder: '2026-02-07', type: 'temp' },
            ],
          },
        },
      };

      const urls = comfyuiClient.extractImageUrls(historyData);

      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('subfolder=2026-02-07');
      expect(urls[0]).toContain('type=temp');
    });

    it('should return empty array when no outputs exist', () => {
      const urls = comfyuiClient.extractImageUrls({});
      expect(urls).toEqual([]);
    });

    it('should skip nodes without images array', () => {
      const historyData = {
        outputs: {
          '5': { text: ['some text output'] },
          '9': { images: [{ filename: 'real.png', subfolder: '', type: 'output' }] },
        },
      };

      const urls = comfyuiClient.extractImageUrls(historyData);

      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('filename=real.png');
    });
  });

  describe('isHealthy', () => {
    it('should return true on 200 from /queue', async () => {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: { queue_running: [], queue_pending: [] },
      });

      expect(await comfyuiClient.isHealthy()).toBe(true);
      expect(mockInstance.get).toHaveBeenCalledWith('/queue');
    });

    it('should return false on connection error', async () => {
      mockInstance.get.mockRejectedValue(new Error('connect ECONNREFUSED'));
      expect(await comfyuiClient.isHealthy()).toBe(false);
    });

    it('should return false on non-200 response', async () => {
      mockInstance.get.mockResolvedValue({ status: 500 });
      expect(await comfyuiClient.isHealthy()).toBe(false);
    });
  });

  describe('refresh', () => {
    it('should recreate axios instance with current config endpoint', () => {
      (config.getComfyUIEndpoint as jest.Mock).mockReturnValue('http://new-comfy:7777');

      const createCallsBefore = mockedAxios.create.mock.calls.length;
      comfyuiClient.refresh();
      const createCallsAfter = mockedAxios.create.mock.calls.length;

      expect(createCallsAfter).toBe(createCallsBefore + 1);
      expect(mockedAxios.create).toHaveBeenLastCalledWith({
        baseURL: 'http://new-comfy:7777',
      });
    });
  });
});
