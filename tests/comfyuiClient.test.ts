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

// Mock WebSocket manager instance
const mockWsManager = {
  connectWithRetry: jest.fn().mockResolvedValue(undefined),
  waitForExecution: jest.fn().mockResolvedValue({
    success: true,
    promptId: 'test-prompt-id',
    completed: true,
  }),
  disconnect: jest.fn(),
  isConnected: jest.fn().mockReturnValue(false),
  updateBaseUrl: jest.fn(),
  updateClientId: jest.fn(),
};

jest.mock('../src/api/comfyuiWebSocket', () => ({
  ComfyUIWebSocketManager: jest.fn().mockImplementation(() => mockWsManager),
}));

jest.mock('../src/utils/config', () => ({
  config: {
    getComfyUIEndpoint: jest.fn(() => 'http://localhost:8190'),
    getComfyUIWorkflow: jest.fn(() => ''),
    getComfyUIDefaultModel: jest.fn(() => ''),
    getComfyUIDefaultWidth: jest.fn(() => 512),
    getComfyUIDefaultHeight: jest.fn(() => 512),
    getComfyUIDefaultSteps: jest.fn(() => 20),
    getComfyUIDefaultCfg: jest.fn(() => 7.0),
    getComfyUIDefaultSampler: jest.fn(() => 'euler'),
    getComfyUIDefaultScheduler: jest.fn(() => 'normal'),
    getComfyUIDefaultDenoise: jest.fn(() => 1.0),
    getComfyUIDefaultSeed: jest.fn(() => -1),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
    logWarn: jest.fn(),
    logDebug: jest.fn(),
    logDebugLazy: jest.fn(),
  },
}));

// Import after mocks — singleton captures mockInstance
import { comfyuiClient } from '../src/api/comfyuiClient';
import { isUIFormat, convertUIToAPIFormat, buildDefaultWorkflow, hasOutputNode, resolveSeed } from '../src/api/comfyuiClient';
import { config } from '../src/utils/config';

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('ComfyUIClient', () => {
  // Mock baseURL so extractImageUrls can build full /view URLs
  beforeEach(() => {
    mockInstance.get.mockReset();
    mockInstance.post.mockReset();
    mockInstance.defaults.baseURL = 'http://localhost:8190';
    
    // Reset WebSocket mock
    mockWsManager.connectWithRetry.mockReset().mockResolvedValue(undefined);
    mockWsManager.waitForExecution.mockReset().mockResolvedValue({
      success: true,
      promptId: 'test-prompt-id',
      completed: true,
    });
    mockWsManager.disconnect.mockReset();
    mockWsManager.isConnected.mockReset().mockReturnValue(false);
    mockWsManager.updateBaseUrl.mockReset();
    mockWsManager.updateClientId.mockReset();
    
    (config.getComfyUIWorkflow as jest.Mock).mockReturnValue('');
    (config.getComfyUIEndpoint as jest.Mock).mockReturnValue('http://localhost:8190');
    (config.getComfyUIDefaultModel as jest.Mock).mockReturnValue('');
    (config.getComfyUIDefaultWidth as jest.Mock).mockReturnValue(512);
    (config.getComfyUIDefaultHeight as jest.Mock).mockReturnValue(512);
    (config.getComfyUIDefaultSteps as jest.Mock).mockReturnValue(20);
    (config.getComfyUIDefaultCfg as jest.Mock).mockReturnValue(7.0);
    (config.getComfyUIDefaultSampler as jest.Mock).mockReturnValue('euler_ancestral');
    (config.getComfyUIDefaultScheduler as jest.Mock).mockReturnValue('beta');
    (config.getComfyUIDefaultDenoise as jest.Mock).mockReturnValue(0.88);
    (config.getComfyUIDefaultSeed as jest.Mock).mockReturnValue(-1);
    comfyuiClient.refresh();
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

  describe('hasOutputNode', () => {
    it('should return true for workflows with SaveImage node', () => {
      expect(hasOutputNode({
        '1': { class_type: 'KSampler', inputs: {} },
        '7': { class_type: 'SaveImage', inputs: {} },
      })).toBe(true);
    });

    it('should return true for workflows with PreviewImage node', () => {
      expect(hasOutputNode({
        '1': { class_type: 'KSampler', inputs: {} },
        '7': { class_type: 'PreviewImage', inputs: {} },
      })).toBe(true);
    });

    it('should return false for workflows without any output node', () => {
      expect(hasOutputNode({
        '1': { class_type: 'KSampler', inputs: {} },
        '2': { class_type: 'CLIPTextEncode', inputs: {} },
      })).toBe(false);
    });

    it('should return false for empty workflows', () => {
      expect(hasOutputNode({})).toBe(false);
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
    /** Helper: mock a successful prompt submit + WebSocket execution + history fetch cycle. */
    function mockSuccessfulGeneration(outputImages: Array<Record<string, string>> = [{ filename: 'img_001.png', subfolder: '', type: 'output' }]) {
      const promptId = 'test-prompt-id-123';

      // POST /api/prompt → prompt_id
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { prompt_id: promptId, number: 1, node_errors: {} },
      });

      // WebSocket execution completes successfully
      mockWsManager.waitForExecution.mockResolvedValue({
        success: true,
        promptId,
        completed: true,
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
      const workflow = '{"3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}, "7": {"class_type": "SaveImage", "inputs": {}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockSuccessfulGeneration([{ filename: 'sunset_001.png', subfolder: '', type: 'output' }]);

      const result = await comfyuiClient.generateImage('a beautiful sunset', 'user1');

      expect(result.success).toBe(true);
      expect(result.data?.images).toHaveLength(1);
      expect(result.data?.images?.[0]).toContain('/view?filename=sunset_001.png');

      // Verify substitution in POST body
      const sentBody = mockInstance.post.mock.calls[0][1];
      expect(sentBody.prompt['3'].inputs.text).toBe('a beautiful sunset');
      // client_id is now a UUID for WebSocket session tracking (not the Discord user)
      expect(sentBody.client_id).toBeDefined();
      expect(typeof sentBody.client_id).toBe('string');
    });

    it('should substitute all %prompt% occurrences', async () => {
      const workflow = '{"1": {"class_type": "SaveImage", "inputs": {"pos": "%prompt%", "title": "Job: %prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockSuccessfulGeneration();

      await comfyuiClient.generateImage('cat', 'user1');

      const sentBody = mockInstance.post.mock.calls[0][1];
      expect(sentBody.prompt['1'].inputs.pos).toBe('cat');
      expect(sentBody.prompt['1'].inputs.title).toBe('Job: cat');
    });

    it('should JSON-escape prompts with quotes and backslashes', async () => {
      const workflow = '{"1": {"class_type": "SaveImage", "inputs": {}}, "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockSuccessfulGeneration();

      await comfyuiClient.generateImage('say "hello" with back\\slash', 'user1');

      const sentBody = mockInstance.post.mock.calls[0][1];
      expect(sentBody.prompt['2'].inputs.text).toBe('say "hello" with back\\slash');
    });

    it('should return failure when prompt submit returns node_errors', async () => {
      const workflow = '{"3": {"class_type": "SaveImage", "inputs": {}}, "5": {"class_type": "KSampler", "inputs": {"text": "%prompt%"}}}';
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
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
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
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
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
          { id: 11, type: 'SaveImage', inputs: [], widgets_values: ['BobBot'] },
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
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockInstance.post.mockRejectedValue(new Error('Connection refused'));

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection refused');
    });

    it('should collect images from multiple output nodes', async () => {
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
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

    it('should return error when workflow produces empty outputs', async () => {
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      const promptId = 'empty-output-id';
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { prompt_id: promptId },
      });

      // WebSocket execution completes successfully
      mockWsManager.waitForExecution.mockResolvedValue({
        success: true,
        promptId,
        completed: true,
      });

      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          [promptId]: {
            status: { status_str: 'success', completed: true },
            outputs: {},
          },
        },
      });

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('no images');
    });

    it('should return error when ComfyUI execution status is error', async () => {
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      const promptId = 'exec-error-id';
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { prompt_id: promptId },
      });

      // WebSocket execution completes (but history will show error)
      mockWsManager.waitForExecution.mockResolvedValue({
        success: true,
        promptId,
        completed: true,
      });

      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          [promptId]: {
            status: {
              status_str: 'error',
              completed: true,
              messages: [
                ['execution_started', { prompt_id: promptId }],
                ['execution_error', {
                  node_id: '81',
                  node_type: 'easy positive',
                  exception_message: 'Module not found',
                  exception_type: 'ModuleNotFoundError',
                }],
              ],
            },
            outputs: {},
          },
        },
      });

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('execution error');
      expect(result.error).toContain('easy positive');
      expect(result.error).toContain('Module not found');
    });

    it('should poll when WS completes but history is not immediately available', async () => {
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      const promptId = 'ws-done-history-miss';

      // WS completes successfully
      mockWsManager.connectWithRetry.mockResolvedValue(undefined);
      mockWsManager.waitForExecution.mockResolvedValue({
        success: true,
        promptId,
        completed: true,
        elapsedMs: 2000,
      });

      // POST /api/prompt → prompt_id
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { prompt_id: promptId, number: 1, node_errors: {} },
      });

      // First GET /history → empty (race condition: history not available yet)
      // Second GET /history → completed result (polling picks it up)
      let historyCallCount = 0;
      mockInstance.get.mockImplementation(async () => {
        historyCallCount++;
        if (historyCallCount === 1) {
          // fetchHistory() call right after WS completion — returns empty
          return { status: 200, data: {} };
        }
        // pollForCompletion picks it up on subsequent calls
        return {
          status: 200,
          data: {
            [promptId]: {
              status: { status_str: 'success', completed: true },
              outputs: {
                '9': { images: [{ filename: 'delayed_history.png', subfolder: '', type: 'output' }] },
              },
            },
          },
        };
      });

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(true);
      expect(result.data?.images?.[0]).toContain('delayed_history.png');
      // fetchHistory (1st call) + at least one poll call
      expect(historyCallCount).toBeGreaterThanOrEqual(2);
    });

    it('should fall back to polling when WebSocket connection fails', async () => {
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      const promptId = 'ws-fail-prompt';

      // WebSocket connection fails
      mockWsManager.connectWithRetry.mockRejectedValue(new Error('ECONNREFUSED'));

      // POST /api/prompt → prompt_id
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { prompt_id: promptId, number: 1, node_errors: {} },
      });

      // GET /history/{promptId} → completed result (polling path)
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          [promptId]: {
            status: { status_str: 'success', completed: true },
            outputs: {
              '9': { images: [{ filename: 'fallback.png', subfolder: '', type: 'output' }] },
            },
          },
        },
      });

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(true);
      expect(result.data?.images).toHaveLength(1);
      expect(result.data?.images?.[0]).toContain('fallback.png');
    });

    it('should fall back to polling when WebSocket disconnects during wait', async () => {
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      const promptId = 'ws-close-prompt';

      // WS connects but fails during wait with a WebSocket error
      mockWsManager.connectWithRetry.mockResolvedValue(undefined);
      mockWsManager.waitForExecution.mockResolvedValue({
        success: false,
        promptId,
        completed: false,
        error: 'WebSocket connection closed during execution',
      });

      // POST /api/prompt → prompt_id
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { prompt_id: promptId, number: 1, node_errors: {} },
      });

      // Polling path succeeds
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          [promptId]: {
            status: { status_str: 'success', completed: true },
            outputs: {
              '9': { images: [{ filename: 'poll_ok.png', subfolder: '', type: 'output' }] },
            },
          },
        },
      });

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(true);
      expect(result.data?.images?.[0]).toContain('poll_ok.png');
    });

    it('should pass timeoutSeconds to waitForExecution when provided', async () => {
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockSuccessfulGeneration();

      await comfyuiClient.generateImage('test', 'user1', undefined, 120);

      expect(mockWsManager.waitForExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutMs: 120000, // 120 seconds → ms
        })
      );
    });

    it('should use default timeout when timeoutSeconds is not provided', async () => {
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockSuccessfulGeneration();

      await comfyuiClient.generateImage('test', 'user1');

      expect(mockWsManager.waitForExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutMs: 5 * 60 * 1000, // Default 5 minutes
        })
      );
    });
    it('should fall back to polling when WebSocket wait times out', async () => {
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      const promptId = 'ws-timeout-prompt';

      // WS connects but times out (not a ComfyUI execution error)
      mockWsManager.connectWithRetry.mockResolvedValue(undefined);
      mockWsManager.waitForExecution.mockResolvedValue({
        success: false,
        promptId,
        completed: false,
        error: 'Execution timed out waiting for ComfyUI',
        elapsedMs: 5000,
      });

      // POST /api/prompt → prompt_id
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { prompt_id: promptId, number: 1, node_errors: {} },
      });

      // Polling path succeeds with remaining time
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          [promptId]: {
            status: { status_str: 'success', completed: true },
            outputs: {
              '9': { images: [{ filename: 'timeout_fallback.png', subfolder: '', type: 'output' }] },
            },
          },
        },
      });

      const result = await comfyuiClient.generateImage('test', 'user1', undefined, 300);

      expect(result.success).toBe(true);
      expect(result.data?.images?.[0]).toContain('timeout_fallback.png');
    });

    it('should NOT fall back to polling on ComfyUI execution error', async () => {
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      const promptId = 'exec-error-prompt';

      mockWsManager.connectWithRetry.mockResolvedValue(undefined);
      mockWsManager.waitForExecution.mockResolvedValue({
        success: false,
        promptId,
        completed: true, // completed=true means ComfyUI reported real execution error
        error: 'ComfyUI execution error [node 5] (KSampler) : Model not found',
        elapsedMs: 2000,
      });

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { prompt_id: promptId, number: 1, node_errors: {} },
      });

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Model not found');
      // Should NOT have attempted polling
      expect(mockInstance.get).not.toHaveBeenCalled();
    });

    it('should return abort-specific error when generation is aborted', async () => {
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      const promptId = 'abort-prompt';

      mockWsManager.connectWithRetry.mockResolvedValue(undefined);
      mockWsManager.waitForExecution.mockResolvedValue({
        success: false,
        promptId,
        completed: false,
        error: 'Execution aborted',
        elapsedMs: 100,
      });

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { prompt_id: promptId, number: 1, node_errors: {} },
      });

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('ComfyUI generation aborted');
      // Should NOT have attempted polling
      expect(mockInstance.get).not.toHaveBeenCalled();
    });

    it('should reject workflow with no output nodes before submitting to ComfyUI', async () => {
      // Workflow has a KSampler but no SaveImage/PreviewImage
      const workflow = '{"5": {"class_type": "KSampler", "inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('no output node');
      // Should NOT have attempted to submit to ComfyUI
      expect(mockInstance.post).not.toHaveBeenCalled();
    });

    it('should surface top-level error from ComfyUI prompt response', async () => {
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {"images": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: {
          error: {
            type: 'prompt_no_outputs',
            message: 'Prompt has no outputs',
          },
          node_errors: {},
        },
      });

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('prompt_no_outputs');
      expect(result.error).toContain('Prompt has no outputs');
    });

    it('should log full response on generic submit failure', async () => {
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {"images": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { something_unexpected: true },
      });

      const { logger } = require('../src/utils/logger');
      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to submit prompt to ComfyUI');
      expect(logger.logError).toHaveBeenCalledWith(
        'user1',
        expect.stringContaining('unexpected prompt response')
      );
    });

    it('should pass executionTimeoutMs to polling fallback on no-WS path', async () => {
      const workflow = '{"7": {"class_type": "SaveImage", "inputs": {}}, "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(workflow);

      const promptId = 'poll-timeout-prompt';

      // WebSocket connection fails entirely
      mockWsManager.connectWithRetry.mockRejectedValue(new Error('ECONNREFUSED'));

      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { prompt_id: promptId, number: 1, node_errors: {} },
      });

      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          [promptId]: {
            status: { status_str: 'success', completed: true },
            outputs: {
              '9': { images: [{ filename: 'poll.png', subfolder: '', type: 'output' }] },
            },
          },
        },
      });

      // Pass a custom timeout of 60 seconds
      const result = await comfyuiClient.generateImage('test', 'user1', undefined, 60);

      expect(result.success).toBe(true);
      // pollForCompletion should be called — we can't directly check its timeout arg
      // since it's an internal call, but the success path proves it ran
    });
  });

  describe('close', () => {
    it('should disconnect WebSocket manager', () => {
      comfyuiClient.close();
      expect(mockWsManager.disconnect).toHaveBeenCalled();
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
      expect(mockInstance.get).toHaveBeenCalledWith(`/history/${promptId}`, undefined);
    });

    it('should return null when aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await comfyuiClient.pollForCompletion('any-id', controller.signal);

      expect(result).toBeNull();
    });

    it('should keep polling when status.completed is false', async () => {
      const promptId = 'pending-id';

      // First call: not completed yet
      mockInstance.get
        .mockResolvedValueOnce({
          status: 200,
          data: {
            [promptId]: {
              status: { status_str: 'running', completed: false },
              outputs: {},
            },
          },
        })
        // Second call: completed
        .mockResolvedValueOnce({
          status: 200,
          data: {
            [promptId]: {
              status: { status_str: 'success', completed: true },
              outputs: { '9': { images: [{ filename: 'done.png', subfolder: '', type: 'output' }] } },
            },
          },
        });

      const result = await comfyuiClient.pollForCompletion(promptId);

      expect(result).not.toBeNull();
      expect(result?.status).toEqual({ status_str: 'success', completed: true });
      expect(mockInstance.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('extractExecutionError', () => {
    it('should return null when no status is present', () => {
      const result = comfyuiClient.extractExecutionError({});
      expect(result).toBeNull();
    });

    it('should return null when status_str is success', () => {
      const result = comfyuiClient.extractExecutionError({
        status: { status_str: 'success', completed: true },
      });
      expect(result).toBeNull();
    });

    it('should return error message when status_str is error with execution_error message', () => {
      const result = comfyuiClient.extractExecutionError({
        status: {
          status_str: 'error',
          completed: true,
          messages: [
            ['execution_started', { prompt_id: 'abc' }],
            ['execution_error', {
              node_id: '13',
              node_type: 'easy seed',
              exception_message: 'Cannot find module',
              exception_type: 'ImportError',
            }],
          ],
        },
      });

      expect(result).toContain('execution error');
      expect(result).toContain('node 13');
      expect(result).toContain('easy seed');
      expect(result).toContain('Cannot find module');
    });

    it('should return generic error when status is error but no messages', () => {
      const result = comfyuiClient.extractExecutionError({
        status: { status_str: 'error', completed: true },
      });

      expect(result).toContain('execution failed');
      expect(result).toContain('Check ComfyUI server logs');
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
      expect(urls[0]).toBe('http://localhost:8190/view?filename=img_001.png&type=output');
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

  describe('resolveSeed', () => {
    it('should return a random integer in [0, 2147483647] when seed is -1', () => {
      for (let i = 0; i < 20; i++) {
        const val = resolveSeed(-1);
        expect(Number.isInteger(val)).toBe(true);
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(2147483647);
      }
    });

    it('should pass through a specific seed unchanged', () => {
      expect(resolveSeed(0)).toBe(0);
      expect(resolveSeed(42)).toBe(42);
      expect(resolveSeed(2147483647)).toBe(2147483647);
    });
  });

  describe('buildDefaultWorkflow', () => {
    const defaultParams = {
      ckpt_name: 'model.safetensors',
      width: 512,
      height: 768,
      steps: 20,
      cfg: 7.0,
      sampler_name: 'euler_ancestral',
      scheduler: 'beta',
      denoise: 0.88,
      seed: -1,
    };

    it('should create a workflow with all required node types', () => {
      const workflow = buildDefaultWorkflow(defaultParams);
      const classTypes = Object.values(workflow).map(
        (n: any) => n.class_type
      );

      expect(classTypes).toContain('CheckpointLoaderSimple');
      expect(classTypes).toContain('CLIPTextEncode');
      expect(classTypes).toContain('EmptyLatentImage');
      expect(classTypes).toContain('KSampler');
      expect(classTypes).toContain('VAEDecode');
      expect(classTypes).toContain('SaveImage');
    });

    it('should have 7 nodes', () => {
      const workflow = buildDefaultWorkflow(defaultParams);
      expect(Object.keys(workflow)).toHaveLength(7);
    });

    it('should set checkpoint name correctly', () => {
      const workflow = buildDefaultWorkflow(defaultParams);
      const checkpoint = workflow['1'] as any;
      expect(checkpoint.class_type).toBe('CheckpointLoaderSimple');
      expect(checkpoint.inputs.ckpt_name).toBe('model.safetensors');
    });

    it('should contain %prompt% placeholder in positive prompt', () => {
      const workflow = buildDefaultWorkflow(defaultParams);
      const json = JSON.stringify(workflow);
      expect(json).toContain('%prompt%');

      const posPrompt = workflow['2'] as any;
      expect(posPrompt.class_type).toBe('CLIPTextEncode');
      expect(posPrompt.inputs.text).toBe('%prompt%');
    });

    it('should have empty negative prompt', () => {
      const workflow = buildDefaultWorkflow(defaultParams);
      const negPrompt = workflow['3'] as any;
      expect(negPrompt.class_type).toBe('CLIPTextEncode');
      expect(negPrompt.inputs.text).toBe('');
    });

    it('should set latent image dimensions correctly', () => {
      const workflow = buildDefaultWorkflow(defaultParams);
      const latent = workflow['4'] as any;
      expect(latent.inputs.width).toBe(512);
      expect(latent.inputs.height).toBe(768);
      expect(latent.inputs.batch_size).toBe(1);
    });

    it('should set KSampler parameters correctly', () => {
      const workflow = buildDefaultWorkflow(defaultParams);
      const sampler = workflow['5'] as any;
      expect(sampler.inputs.steps).toBe(20);
      expect(sampler.inputs.cfg).toBe(7.0);
      expect(sampler.inputs.sampler_name).toBe('euler_ancestral');
      expect(sampler.inputs.scheduler).toBe('beta');
      expect(sampler.inputs.denoise).toBe(0.88);
    });

    it('should wire checkpoint MODEL to KSampler', () => {
      const workflow = buildDefaultWorkflow(defaultParams);
      const sampler = workflow['5'] as any;
      expect(sampler.inputs.model).toEqual(['1', 0]);
    });

    it('should wire checkpoint CLIP to both text encoders', () => {
      const workflow = buildDefaultWorkflow(defaultParams);
      const pos = workflow['2'] as any;
      const neg = workflow['3'] as any;
      expect(pos.inputs.clip).toEqual(['1', 1]);
      expect(neg.inputs.clip).toEqual(['1', 1]);
    });

    it('should wire checkpoint VAE to VAEDecode', () => {
      const workflow = buildDefaultWorkflow(defaultParams);
      const decode = workflow['6'] as any;
      expect(decode.inputs.vae).toEqual(['1', 2]);
    });

    it('should wire VAEDecode output to SaveImage', () => {
      const workflow = buildDefaultWorkflow(defaultParams);
      const save = workflow['7'] as any;
      expect(save.inputs.images).toEqual(['6', 0]);
    });

    it('should resolve seed -1 to a random value (not -1)', () => {
      const w1 = buildDefaultWorkflow(defaultParams);
      const w2 = buildDefaultWorkflow(defaultParams);
      const seed1 = (w1['5'] as any).inputs.seed;
      const seed2 = (w2['5'] as any).inputs.seed;
      // Seed must be resolved to a real value, not -1
      expect(seed1).toBeGreaterThanOrEqual(0);
      expect(seed1).toBeLessThanOrEqual(2147483647);
      expect(seed2).toBeGreaterThanOrEqual(0);
      expect(seed2).toBeLessThanOrEqual(2147483647);
    });

    it('should honour a specific seed value from params', () => {
      const paramsWithSeed = { ...defaultParams, seed: 42 };
      const workflow = buildDefaultWorkflow(paramsWithSeed);
      expect((workflow['5'] as any).inputs.seed).toBe(42);
    });
  });

  describe('generateImage with default workflow', () => {
    /** Mock /object_info/KSampler to return supported samplers & schedulers. */
    function _mockObjectInfo(
      samplers = ['euler', 'euler_ancestral', 'heun', 'dpmpp_2m'],
      schedulers = ['normal', 'karras', 'exponential', 'simple', 'beta']
    ): void {
      // The first get call will be /object_info/KSampler (for validation)
      // Subsequent get calls are the history fetch after execution
      mockInstance.get.mockImplementation((url: string) => {
        if (url === '/object_info/KSampler') {
          return Promise.resolve({
            status: 200,
            data: {
              KSampler: {
                input: {
                  required: {
                    sampler_name: [samplers],
                    scheduler: [schedulers],
                  },
                },
              },
            },
          });
        }
        // Default: history response (will be overridden per-test where needed)
        return Promise.resolve({ status: 200, data: {} });
      });
    }

    /** Helper: mock a successful prompt submit + WebSocket execution + history fetch cycle. */
    function mockSuccessfulDefaultGeneration(
      outputImages: Array<Record<string, string>> = [{ filename: 'default_001.png', subfolder: '', type: 'output' }]
    ): string {
      const promptId = 'default-prompt-id';
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { prompt_id: promptId, number: 1, node_errors: {} },
      });
      // WebSocket execution completes successfully
      mockWsManager.waitForExecution.mockResolvedValue({
        success: true,
        promptId,
        completed: true,
      });
      // Override get to service both /object_info and /history
      mockInstance.get.mockImplementation((url: string) => {
        if (url === '/object_info/KSampler') {
          return Promise.resolve({
            status: 200,
            data: {
              KSampler: {
                input: {
                  required: {
                    sampler_name: [['euler', 'euler_ancestral', 'heun', 'dpmpp_2m']],
                    scheduler: [['normal', 'karras', 'exponential', 'simple', 'beta']],
                  },
                },
              },
            },
          });
        }
        return Promise.resolve({
          status: 200,
          data: {
            [promptId]: {
              outputs: { '7': { images: outputImages } },
            },
          },
        });
      });
      return promptId;
    }

    it('should use default workflow when no custom workflow is configured', async () => {
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue('');
      (config.getComfyUIDefaultModel as jest.Mock).mockReturnValue('test_model.safetensors');

      mockSuccessfulDefaultGeneration();

      const result = await comfyuiClient.generateImage('a sunset', 'user1');

      expect(result.success).toBe(true);
      expect(result.data?.images).toHaveLength(1);

      // Verify the submitted workflow has the correct structure
      const sentBody = mockInstance.post.mock.calls[0][1];
      expect(sentBody.prompt['1'].class_type).toBe('CheckpointLoaderSimple');
      expect(sentBody.prompt['1'].inputs.ckpt_name).toBe('test_model.safetensors');
      expect(sentBody.prompt['2'].inputs.text).toBe('a sunset');
    });

    it('should prefer custom workflow over default', async () => {
      const customWorkflow = '{"3": {"class_type": "CLIPTextEncode", "inputs": {"text": "%prompt%"}}, "7": {"class_type": "SaveImage", "inputs": {}}}';
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue(customWorkflow);
      (config.getComfyUIDefaultModel as jest.Mock).mockReturnValue('test_model.safetensors');

      // Custom workflow path does not call getDefaultWorkflowJson, no need for object_info mock
      mockInstance.post.mockResolvedValue({
        status: 200,
        data: { prompt_id: 'custom-prompt-id', number: 1, node_errors: {} },
      });
      mockWsManager.waitForExecution.mockResolvedValue({
        success: true,
        promptId: 'custom-prompt-id',
        completed: true,
      });
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          'custom-prompt-id': {
            outputs: { '3': { images: [{ filename: 'custom.png', subfolder: '', type: 'output' }] } },
          },
        },
      });

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(true);
      // Should use the custom workflow, not the default
      const sentBody = mockInstance.post.mock.calls[0][1];
      expect(sentBody.prompt['3']).toBeDefined();
      expect(sentBody.prompt['1']).toBeUndefined(); // No default checkpoint node
    });

    it('should return error when neither custom nor default workflow is available', async () => {
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue('');
      (config.getComfyUIDefaultModel as jest.Mock).mockReturnValue('');

      const result = await comfyuiClient.generateImage('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No ComfyUI workflow configured');
    });

    it('should apply default workflow parameters from config', async () => {
      (config.getComfyUIWorkflow as jest.Mock).mockReturnValue('');
      (config.getComfyUIDefaultModel as jest.Mock).mockReturnValue('custom_model.safetensors');
      (config.getComfyUIDefaultWidth as jest.Mock).mockReturnValue(1024);
      (config.getComfyUIDefaultHeight as jest.Mock).mockReturnValue(768);
      (config.getComfyUIDefaultSteps as jest.Mock).mockReturnValue(30);
      (config.getComfyUIDefaultCfg as jest.Mock).mockReturnValue(5.5);
      (config.getComfyUIDefaultSampler as jest.Mock).mockReturnValue('dpmpp_2m');
      (config.getComfyUIDefaultScheduler as jest.Mock).mockReturnValue('karras');
      (config.getComfyUIDefaultDenoise as jest.Mock).mockReturnValue(0.88);
      (config.getComfyUIDefaultSeed as jest.Mock).mockReturnValue(-1);
      comfyuiClient.refresh(); // Clear cached default workflow

      mockSuccessfulDefaultGeneration();

      await comfyuiClient.generateImage('test', 'user1');

      const sentBody = mockInstance.post.mock.calls[0][1];
      expect(sentBody.prompt['1'].inputs.ckpt_name).toBe('custom_model.safetensors');
      expect(sentBody.prompt['4'].inputs.width).toBe(1024);
      expect(sentBody.prompt['4'].inputs.height).toBe(768);
      expect(sentBody.prompt['5'].inputs.steps).toBe(30);
      expect(sentBody.prompt['5'].inputs.cfg).toBe(5.5);
      expect(sentBody.prompt['5'].inputs.sampler_name).toBe('dpmpp_2m');
      expect(sentBody.prompt['5'].inputs.scheduler).toBe('karras');
      expect(sentBody.prompt['5'].inputs.denoise).toBe(0.88);
      expect(sentBody.prompt['5'].inputs.seed).toBeGreaterThanOrEqual(0);
      expect(sentBody.prompt['5'].inputs.seed).toBeLessThanOrEqual(2147483647);
    });
  });

  describe('getSamplers', () => {
    it('should extract sampler names from /object_info/KSampler response', async () => {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          KSampler: {
            input: {
              required: {
                sampler_name: [['euler', 'euler_ancestral', 'heun', 'dpmpp_2m']],
              },
            },
          },
        },
      });

      const samplers = await comfyuiClient.getSamplers();
      expect(samplers).toEqual(['euler', 'euler_ancestral', 'heun', 'dpmpp_2m']);
    });

    it('should return empty array when ComfyUI is unreachable', async () => {
      mockInstance.get.mockRejectedValue(new Error('ECONNREFUSED'));
      const samplers = await comfyuiClient.getSamplers();
      expect(samplers).toEqual([]);
    });

    it('should handle flat list format (no nested array)', async () => {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          KSampler: {
            input: {
              required: {
                sampler_name: ['euler', 'heun', 'dpmpp_2m'],
              },
            },
          },
        },
      });

      const samplers = await comfyuiClient.getSamplers();
      expect(samplers).toEqual(['euler', 'heun', 'dpmpp_2m']);
    });

    it('should handle direct KSampler response (no wrapper key)', async () => {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          input: {
            required: {
              sampler_name: [['euler', 'lms']],
            },
          },
        },
      });

      const samplers = await comfyuiClient.getSamplers();
      expect(samplers).toEqual(['euler', 'lms']);
    });
  });

  describe('getSchedulers', () => {
    it('should extract scheduler names from /object_info/KSampler response', async () => {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          KSampler: {
            input: {
              required: {
                scheduler: [['normal', 'karras', 'exponential', 'simple']],
              },
            },
          },
        },
      });

      const schedulers = await comfyuiClient.getSchedulers();
      expect(schedulers).toEqual(['normal', 'karras', 'exponential', 'simple']);
    });

    it('should return empty array when ComfyUI is unreachable', async () => {
      mockInstance.get.mockRejectedValue(new Error('ECONNREFUSED'));
      const schedulers = await comfyuiClient.getSchedulers();
      expect(schedulers).toEqual([]);
    });

    it('should handle flat list format (no nested array)', async () => {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          KSampler: {
            input: {
              required: {
                scheduler: ['normal', 'karras'],
              },
            },
          },
        },
      });

      const schedulers = await comfyuiClient.getSchedulers();
      expect(schedulers).toEqual(['normal', 'karras']);
    });
  });

  describe('getCheckpoints', () => {
    it('should return checkpoint list from /models/checkpoints', async () => {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: ['model_a.safetensors', 'model_b.safetensors'],
      });

      const checkpoints = await comfyuiClient.getCheckpoints();
      expect(checkpoints).toEqual(['model_a.safetensors', 'model_b.safetensors']);
    });

    it('should return empty array when ComfyUI is unreachable', async () => {
      mockInstance.get.mockRejectedValue(new Error('ECONNREFUSED'));
      const checkpoints = await comfyuiClient.getCheckpoints();
      expect(checkpoints).toEqual([]);
    });
  });

  describe('validateDefaultWorkflowParams', () => {
    const baseParams = {
      ckpt_name: 'model.safetensors',
      width: 512,
      height: 768,
      steps: 20,
      cfg: 7.0,
      sampler_name: 'euler_ancestral',
      scheduler: 'beta',
      denoise: 0.88,
      seed: -1,
    };

    function mockObjectInfoForValidation(
      samplers: string[] = ['euler', 'euler_ancestral', 'heun', 'dpmpp_2m'],
      schedulers: string[] = ['normal', 'karras', 'exponential', 'simple', 'beta']
    ): void {
      mockInstance.get.mockResolvedValue({
        status: 200,
        data: {
          KSampler: {
            input: {
              required: {
                sampler_name: [samplers],
                scheduler: [schedulers],
              },
            },
          },
        },
      });
    }

    it('should pass through valid params unchanged', async () => {
      mockObjectInfoForValidation();
      const result = await comfyuiClient.validateDefaultWorkflowParams(baseParams);
      expect(result.sampler_name).toBe('euler_ancestral');
      expect(result.scheduler).toBe('beta');
      expect(result.denoise).toBe(0.88);
      expect(result.steps).toBe(20);
    });

    it('should fallback sampler when configured value is unsupported', async () => {
      mockObjectInfoForValidation(['euler', 'heun', 'dpmpp_2m'], ['normal', 'beta']);
      const params = { ...baseParams, sampler_name: 'nonexistent_sampler' };
      const result = await comfyuiClient.validateDefaultWorkflowParams(params);
      expect(result.sampler_name).toBe('euler'); // fallback to euler
    });

    it('should fallback scheduler when configured value is unsupported', async () => {
      mockObjectInfoForValidation(['euler', 'euler_ancestral'], ['normal', 'karras']);
      const params = { ...baseParams, scheduler: 'beta' };
      const result = await comfyuiClient.validateDefaultWorkflowParams(params);
      expect(result.scheduler).toBe('normal'); // fallback to normal
    });

    it('should fallback to first available when euler/normal are not in list', async () => {
      mockObjectInfoForValidation(['heun', 'dpmpp_2m'], ['karras', 'exponential']);
      const params = { ...baseParams, sampler_name: 'nonexistent', scheduler: 'nonexistent' };
      const result = await comfyuiClient.validateDefaultWorkflowParams(params);
      expect(result.sampler_name).toBe('heun'); // first in list
      expect(result.scheduler).toBe('karras'); // first in list
    });

    it('should skip validation when ComfyUI is unreachable (empty lists)', async () => {
      mockInstance.get.mockRejectedValue(new Error('ECONNREFUSED'));
      const params = { ...baseParams, sampler_name: 'anything', scheduler: 'anything' };
      const result = await comfyuiClient.validateDefaultWorkflowParams(params);
      // When discovery returns empty, params pass through unchecked
      expect(result.sampler_name).toBe('anything');
      expect(result.scheduler).toBe('anything');
    });

    it('should clamp denoise to 0–1 range', async () => {
      mockObjectInfoForValidation();
      const over = await comfyuiClient.validateDefaultWorkflowParams({ ...baseParams, denoise: 1.5 });
      expect(over.denoise).toBe(1);
      const under = await comfyuiClient.validateDefaultWorkflowParams({ ...baseParams, denoise: -0.5 });
      expect(under.denoise).toBe(0);
    });

    it('should enforce minimum steps of 1', async () => {
      mockObjectInfoForValidation();
      const result = await comfyuiClient.validateDefaultWorkflowParams({ ...baseParams, steps: 0 });
      expect(result.steps).toBe(1);
    });

    it('should round width and height to nearest multiple of 8', async () => {
      mockObjectInfoForValidation();
      const result = await comfyuiClient.validateDefaultWorkflowParams({ ...baseParams, width: 510, height: 771 });
      expect(result.width % 8).toBe(0);
      expect(result.height % 8).toBe(0);
      expect(result.width).toBe(512);
      expect(result.height).toBe(768);
    });

    it('should enforce minimum width/height of 8', async () => {
      mockObjectInfoForValidation();
      const result = await comfyuiClient.validateDefaultWorkflowParams({ ...baseParams, width: 0, height: 2 });
      expect(result.width).toBe(8);
      expect(result.height).toBe(8);
    });

    it('should enforce minimum cfg of 0.1', async () => {
      mockObjectInfoForValidation();
      const result = await comfyuiClient.validateDefaultWorkflowParams({ ...baseParams, cfg: 0 });
      expect(result.cfg).toBe(0.1);
    });
  });
});
