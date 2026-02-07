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
    log: jest.fn(),
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
  },
}));

// Import after mocks — singleton captures mockInstance
import { comfyuiClient } from '../src/api/comfyuiClient';
import { isUIFormat, convertUIToAPIFormat } from '../src/api/comfyuiClient';
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

    it('should detect UI-format workflow and return converted version', () => {
      const uiWorkflow = JSON.stringify({
        nodes: [
          {
            id: 3,
            type: 'CLIPTextEncode',
            inputs: [{ name: 'clip', link: 1 }],
            widgets_values: ['%prompt%'],
          },
          {
            id: 5,
            type: 'KSampler',
            inputs: [{ name: 'model', link: 2 }],
            widgets_values: [42, 20, 8, 'euler', 'normal', 1],
          },
        ],
        links: [
          [1, 10, 0, 3, 0, 'CLIP'],
          [2, 11, 0, 5, 0, 'MODEL'],
        ],
      });

      const result = comfyuiClient.validateWorkflow(uiWorkflow);

      expect(result.valid).toBe(true);
      expect(result.wasConverted).toBe(true);
      expect(result.convertedWorkflow).toBeDefined();

      // The converted workflow should still contain %prompt%
      expect(result.convertedWorkflow).toContain('%prompt%');

      // The converted workflow should be valid JSON in API format
      const parsed = JSON.parse(result.convertedWorkflow!);
      expect(parsed['3']).toBeDefined();
      expect(parsed['3'].class_type).toBe('CLIPTextEncode');
      expect(parsed['5']).toBeDefined();
      expect(parsed['5'].class_type).toBe('KSampler');
    });

    it('should pass through API-format workflow without conversion', () => {
      const apiWorkflow = '{"3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';

      const result = comfyuiClient.validateWorkflow(apiWorkflow);

      expect(result.valid).toBe(true);
      expect(result.wasConverted).toBeUndefined();
      expect(result.convertedWorkflow).toBeUndefined();
    });

    it('should reject UI-format workflow without %prompt% after conversion', () => {
      const uiWorkflow = JSON.stringify({
        nodes: [
          {
            id: 3,
            type: 'CLIPTextEncode',
            inputs: [{ name: 'clip', link: 1 }],
            widgets_values: ['a static prompt without placeholder'],
          },
        ],
        links: [[1, 10, 0, 3, 0, 'CLIP']],
      });

      const result = comfyuiClient.validateWorkflow(uiWorkflow);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('%prompt%');
      expect(result.error).toContain('auto-converted from UI format');
    });
  });

  describe('isUIFormat', () => {
    it('should return true for UI-format workflow with nodes and links arrays', () => {
      expect(isUIFormat({ nodes: [], links: [] })).toBe(true);
      expect(isUIFormat({ nodes: [{ id: 1 }], links: [[1, 2, 0, 3, 0]] })).toBe(true);
    });

    it('should return false for API-format workflow', () => {
      expect(isUIFormat({ '3': { class_type: 'KSampler', inputs: {} } })).toBe(false);
    });

    it('should return false when only nodes or only links present', () => {
      expect(isUIFormat({ nodes: [] })).toBe(false);
      expect(isUIFormat({ links: [] })).toBe(false);
    });
  });

  describe('convertUIToAPIFormat', () => {
    it('should convert nodes array to flat object keyed by node ID', () => {
      const uiWorkflow = {
        nodes: [
          { id: 3, type: 'CLIPTextEncode', inputs: [], widgets_values: ['%prompt%'] },
          { id: 7, type: 'EmptyLatentImage', inputs: [], widgets_values: [512, 512, 1] },
        ],
        links: [],
      };

      const result = convertUIToAPIFormat(uiWorkflow);

      expect(result['3']).toBeDefined();
      expect((result['3'] as Record<string, unknown>).class_type).toBe('CLIPTextEncode');
      expect(result['7']).toBeDefined();
      expect((result['7'] as Record<string, unknown>).class_type).toBe('EmptyLatentImage');
    });

    it('should resolve link connections into [sourceNodeId, sourceSlotIndex] references', () => {
      const uiWorkflow = {
        nodes: [
          {
            id: 3,
            type: 'CLIPTextEncode',
            inputs: [{ name: 'clip', link: 5 }],
            widgets_values: ['test'],
          },
          { id: 10, type: 'CheckpointLoaderSimple', inputs: [], widgets_values: ['model.safetensors'] },
        ],
        links: [
          [5, 10, 1, 3, 0, 'CLIP'],
        ],
      };

      const result = convertUIToAPIFormat(uiWorkflow);

      const node3 = result['3'] as Record<string, Record<string, unknown>>;
      expect(node3.inputs.clip).toEqual(['10', 1]);
    });

    it('should preserve node titles in _meta', () => {
      const uiWorkflow = {
        nodes: [
          { id: 4, type: 'KSampler', title: 'My Sampler', inputs: [], widgets_values: [] },
        ],
        links: [],
      };

      const result = convertUIToAPIFormat(uiWorkflow);

      const node4 = result['4'] as Record<string, unknown>;
      expect(node4._meta).toEqual({ title: 'My Sampler' });
    });

    it('should skip nodes without type', () => {
      const uiWorkflow = {
        nodes: [
          { id: 1 },
          { id: 2, type: 'KSampler', inputs: [] },
        ],
        links: [],
      };

      const result = convertUIToAPIFormat(uiWorkflow);

      expect(result['1']).toBeUndefined();
      expect(result['2']).toBeDefined();
    });

    it('should produce workflow where %prompt% in widgets_values is preserved in JSON output', () => {
      const uiWorkflow = {
        nodes: [
          { id: 6, type: 'CLIPTextEncode', inputs: [], widgets_values: ['%prompt%'] },
        ],
        links: [],
      };

      const result = convertUIToAPIFormat(uiWorkflow);
      const jsonStr = JSON.stringify(result);

      expect(jsonStr).toContain('%prompt%');
    });

    it('should map CLIPTextEncode widgets_values to named "text" input', () => {
      const uiWorkflow = {
        nodes: [
          { id: 6, type: 'CLIPTextEncode', inputs: [], widgets_values: ['%prompt%'] },
        ],
        links: [],
      };

      const result = convertUIToAPIFormat(uiWorkflow);
      const node6 = result['6'] as Record<string, Record<string, unknown>>;

      expect(node6.inputs.text).toBe('%prompt%');
    });

    it('should map KSampler widgets_values to named inputs', () => {
      const uiWorkflow = {
        nodes: [
          { id: 3, type: 'KSampler', inputs: [], widgets_values: [42, 'fixed', 20, 8, 'euler', 'normal', 1] },
        ],
        links: [],
      };

      const result = convertUIToAPIFormat(uiWorkflow);
      const node3 = result['3'] as Record<string, Record<string, unknown>>;

      expect(node3.inputs.seed).toBe(42);
      expect(node3.inputs.steps).toBe(20);
      expect(node3.inputs.cfg).toBe(8);
      expect(node3.inputs.sampler_name).toBe('euler');
      expect(node3.inputs.scheduler).toBe('normal');
      expect(node3.inputs.denoise).toBe(1);
    });

    it('should use generic names for unknown node types', () => {
      const uiWorkflow = {
        nodes: [
          { id: 9, type: 'CustomNodeXYZ', inputs: [], widgets_values: ['%prompt%', 42] },
        ],
        links: [],
      };

      const result = convertUIToAPIFormat(uiWorkflow);
      const node9 = result['9'] as Record<string, Record<string, unknown>>;

      expect(node9.inputs.widget_value_0).toBe('%prompt%');
      expect(node9.inputs.widget_value_1).toBe(42);
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

    it('should include remediation hint in HTTP 500 error message', async () => {
      const workflow = '{"inputs": {"text": "%prompt%"}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      const axiosError = new Error('Request failed with status code 500') as any;
      axiosError.response = { status: 500, data: 'Server got itself in trouble' };
      mockInstance.post.mockRejectedValue(axiosError);

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Save (API Format)');
    });

    it('should auto-convert UI-format workflow and generate successfully', async () => {
      const uiWorkflow = JSON.stringify({
        nodes: [
          { id: 6, type: 'CLIPTextEncode', inputs: [{ name: 'clip', link: 1 }], widgets_values: ['%prompt%'] },
          { id: 10, type: 'CheckpointLoaderSimple', inputs: [], widgets_values: ['model.safetensors'] },
        ],
        links: [[1, 10, 1, 6, 0, 'CLIP']],
      });
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(uiWorkflow);

      mockSuccessfulGeneration([{ filename: 'converted.png', subfolder: '', type: 'output' }]);

      const result = await comfyuiClient.generateImage('a test prompt', 'user1');

      expect(result.success).toBe(true);
      expect(result.data?.images).toHaveLength(1);

      // Verify the submitted prompt uses converted API format with substituted text
      const sentBody = mockInstance.post.mock.calls[0][1];
      expect(sentBody.prompt['6'].class_type).toBe('CLIPTextEncode');
      expect(sentBody.prompt['6'].inputs.text).toBe('a test prompt');
      expect(sentBody.prompt['6'].inputs.clip).toEqual(['10', 1]);
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
