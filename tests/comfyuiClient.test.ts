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
  beforeEach(() => {
    mockInstance.get.mockReset();
    mockInstance.post.mockReset();
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

    it('should substitute %prompt% and send to /api/prompt', async () => {
      const workflow = '{"3": {"inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { images: ['http://localhost:8188/output/img_001.png'] },
      });

      const result = await comfyuiClient.generateImage('a beautiful sunset', 'user1');

      expect(result.success).toBe(true);
      expect(result.data?.images).toEqual(['http://localhost:8188/output/img_001.png']);

      // Verify substitution happened
      const sentBody = mockInstance.post.mock.calls[0][1];
      expect(sentBody.prompt).toEqual({ '3': { inputs: { text: 'a beautiful sunset' } } });
      expect(sentBody.client_id).toBe('user1');
    });

    it('should substitute all %prompt% occurrences', async () => {
      const workflow = '{"pos": "%prompt%", "title": "Job: %prompt%"}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { images: [] },
      });

      await comfyuiClient.generateImage('cat', 'user1');

      const sentBody = mockInstance.post.mock.calls[0][1];
      expect(sentBody.prompt.pos).toBe('cat');
      expect(sentBody.prompt.title).toBe('Job: cat');
    });

    it('should JSON-escape prompts with quotes and backslashes', async () => {
      const workflow = '{"inputs": {"text": "%prompt%"}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { images: [] },
      });

      // Prompt with a double-quote and a backslash
      await comfyuiClient.generateImage('say "hello" with back\\slash', 'user1');

      const sentBody = mockInstance.post.mock.calls[0][1];
      // After JSON-escape + JSON.parse round-trip, the original value should survive
      expect(sentBody.prompt.inputs.text).toBe('say "hello" with back\\slash');
    });

    it('should handle API error gracefully', async () => {
      const workflow = '{"inputs": {"text": "%prompt%"}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockInstance.post.mockRejectedValue(new Error('Connection refused'));

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection refused');
    });

    it('should return failure on non-200 response', async () => {
      const workflow = '{"inputs": {"text": "%prompt%"}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockInstance.post.mockResolvedValue({ status: 500, data: {} });

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to generate image');
    });
  });

  describe('isHealthy', () => {
    it('should return true on 200', async () => {
      mockInstance.get.mockResolvedValue({ status: 200 });
      expect(await comfyuiClient.isHealthy()).toBe(true);
    });

    it('should return false on error', async () => {
      mockInstance.get.mockRejectedValue(new Error('down'));
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
