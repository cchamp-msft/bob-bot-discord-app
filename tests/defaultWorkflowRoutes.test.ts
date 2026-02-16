/**
 * Default workflow route tests — exercises:
 *   POST /api/config/default-workflow  (save params with validation)
 *   DELETE /api/config/workflow         (remove custom workflow)
 *   GET /api/config/workflow/export     (export active workflow)
 *   GET /api/config/comfyui/samplers    (discovery proxy)
 *   GET /api/config/comfyui/schedulers  (discovery proxy)
 *   GET /api/config/comfyui/checkpoints (discovery proxy)
 *
 * Uses mocked dependencies — no real ComfyUI or filesystem access.
 */

import http from 'http';

// ── Mocks ────────────────────────────────────────────

const mockGetSamplers = jest.fn();
const mockGetSchedulers = jest.fn();
const mockGetCheckpoints = jest.fn();
const mockGetExportWorkflow = jest.fn();

jest.mock('../src/api/comfyuiClient', () => ({
  comfyuiClient: {
    generateImage: jest.fn(),
    isHealthy: jest.fn(),
    validateWorkflow: jest.fn(() => ({ valid: true })),
    refresh: jest.fn(),
    extractImageUrls: jest.fn(() => []),
    getSamplers: mockGetSamplers,
    getSchedulers: mockGetSchedulers,
    getCheckpoints: mockGetCheckpoints,
    getExportWorkflow: mockGetExportWorkflow,
  },
}));

jest.mock('../src/utils/fileHandler', () => ({
  fileHandler: {
    saveFromUrl: jest.fn(),
    saveFile: jest.fn(),
    shouldAttachFile: jest.fn(() => true),
    readFile: jest.fn(),
  },
}));

const mockUpdateEnv = jest.fn();
const mockDeleteWorkflow = jest.fn();

jest.mock('../src/utils/config', () => ({
  config: {
    getHttpPort: jest.fn(() => 0),
    getComfyUIEndpoint: jest.fn(() => 'http://localhost:8190'),
    getComfyUIWorkflow: jest.fn(() => ''),
    hasComfyUIWorkflow: jest.fn(() => false),
    getApiEndpoint: jest.fn(() => 'http://localhost:8190'),
    getOutputBaseUrl: jest.fn(() => 'http://localhost:3003'),
    getFileSizeThreshold: jest.fn(() => 10485760),
    getMaxAttachments: jest.fn(() => 10),
    getPublicConfig: jest.fn(() => ({})),
    reload: jest.fn(() => ({ reloaded: [], requiresRestart: [] })),
    getOllamaModel: jest.fn(() => ''),
    getAdminToken: jest.fn(() => ''),
    getConfiguratorAllowRemote: jest.fn(() => false),
    getConfiguratorAllowedIps: jest.fn(() => []),
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
    getRecentLines: jest.fn(() => []),
  },
}));

jest.mock('../src/utils/configWriter', () => ({
  configWriter: {
    saveWorkflow: jest.fn(),
    updateEnv: mockUpdateEnv,
    updateKeywords: jest.fn(),
    deleteWorkflow: mockDeleteWorkflow,
  },
}));

jest.mock('../src/api', () => ({
  apiManager: {
    checkApiHealth: jest.fn(),
    refreshClients: jest.fn(),
    testOllamaConnection: jest.fn(),
    validateWorkflow: jest.fn(),
  },
}));

jest.mock('../src/bot/discordManager', () => ({
  discordManager: {
    getStatus: jest.fn(() => ({ status: 'stopped', username: null, error: null, tokenConfigured: false })),
    start: jest.fn(),
    stop: jest.fn(),
    testToken: jest.fn(),
  },
}));

// Import after all mocks
import { httpServer } from '../src/utils/httpServer';

// ── HTTP helpers ─────────────────────────────────────

function postJson(
  server: http.Server,
  urlPath: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = JSON.stringify(body);

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 500, body: JSON.parse(data) });
          } catch {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function deleteRequest(
  server: http.Server,
  urlPath: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method: 'DELETE',
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 500, body: JSON.parse(data) });
          } catch {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

function getJson(
  server: http.Server,
  urlPath: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };

    http.get(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 500, body: JSON.parse(data) });
          } catch {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      }
    ).on('error', reject);
  });
}

// ── Tests ────────────────────────────────────────────

describe('Default Workflow Routes', () => {
  let server: http.Server;

  beforeAll((done) => {
    const app = httpServer.getApp();
    server = app.listen(0, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── POST /api/config/default-workflow ────────────────

  describe('POST /api/config/default-workflow', () => {
    const validPayload = {
      model: 'sd_xl_base_1.0.safetensors',
      width: 1024,
      height: 1024,
      steps: 20,
      cfg: 7.0,
      sampler: 'euler',
      scheduler: 'normal',
      denoise: 0.88,
    };

    it('should save valid default workflow params', async () => {
      mockUpdateEnv.mockResolvedValue(undefined);

      const res = await postJson(server, '/api/config/default-workflow', validPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify updateEnv was called with correct keys
      expect(mockUpdateEnv).toHaveBeenCalledTimes(1);
      const envUpdates = mockUpdateEnv.mock.calls[0][0];
      expect(envUpdates.COMFYUI_DEFAULT_MODEL).toBe('sd_xl_base_1.0.safetensors');
      expect(envUpdates.COMFYUI_DEFAULT_WIDTH).toBe(1024);
      expect(envUpdates.COMFYUI_DEFAULT_HEIGHT).toBe(1024);
      expect(envUpdates.COMFYUI_DEFAULT_STEPS).toBe(20);
      expect(envUpdates.COMFYUI_DEFAULT_CFG).toBe(7.0);
      expect(envUpdates.COMFYUI_DEFAULT_SAMPLER).toBe('euler');
      expect(envUpdates.COMFYUI_DEFAULT_SCHEDULER).toBe('normal');
      expect(envUpdates.COMFYUI_DEFAULT_DENOISE).toBe(0.88);
    });

    it('should reject missing model', async () => {
      const res = await postJson(server, '/api/config/default-workflow', {
        ...validPayload,
        model: '',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.errors).toContain('model is required');
    });

    it('should reject width not divisible by 8', async () => {
      const res = await postJson(server, '/api/config/default-workflow', {
        ...validPayload,
        width: 100,
      });

      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('width must be a positive multiple of 8');
    });

    it('should reject height of 0', async () => {
      const res = await postJson(server, '/api/config/default-workflow', {
        ...validPayload,
        height: 0,
      });

      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('height must be a positive multiple of 8');
    });

    it('should reject negative steps', async () => {
      const res = await postJson(server, '/api/config/default-workflow', {
        ...validPayload,
        steps: -5,
      });

      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('steps must be positive');
    });

    it('should reject cfg of 0', async () => {
      const res = await postJson(server, '/api/config/default-workflow', {
        ...validPayload,
        cfg: 0,
      });

      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('cfg must be positive');
    });

    it('should reject denoise above 1', async () => {
      const res = await postJson(server, '/api/config/default-workflow', {
        ...validPayload,
        denoise: 1.5,
      });

      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('denoise must be between 0 and 1');
    });

    it('should reject denoise below 0', async () => {
      const res = await postJson(server, '/api/config/default-workflow', {
        ...validPayload,
        denoise: -0.1,
      });

      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('denoise must be between 0 and 1');
    });

    it('should coerce string-typed numbers and accept valid payload', async () => {
      mockUpdateEnv.mockResolvedValue(undefined);

      const res = await postJson(server, '/api/config/default-workflow', {
        model: 'model.safetensors',
        width: '512',
        height: '768',
        steps: '30',
        cfg: '5.5',
        sampler: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: '0.88',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const envUpdates = mockUpdateEnv.mock.calls[0][0];
      expect(envUpdates.COMFYUI_DEFAULT_WIDTH).toBe(512);
      expect(envUpdates.COMFYUI_DEFAULT_HEIGHT).toBe(768);
      expect(envUpdates.COMFYUI_DEFAULT_STEPS).toBe(30);
      expect(envUpdates.COMFYUI_DEFAULT_CFG).toBe(5.5);
      expect(envUpdates.COMFYUI_DEFAULT_DENOISE).toBe(0.88);
    });

    it('should reject non-numeric string for width', async () => {
      const res = await postJson(server, '/api/config/default-workflow', {
        ...validPayload,
        width: 'abc',
      });

      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('width must be a positive multiple of 8');
    });

    it('should collect multiple validation errors', async () => {
      const res = await postJson(server, '/api/config/default-workflow', {
        model: '',
        width: 7,
        height: -10,
        steps: 0,
        cfg: -1,
        denoise: 99,
      });

      expect(res.status).toBe(400);
      const errors = res.body.errors as string[];
      expect(errors.length).toBeGreaterThanOrEqual(5);
    });
  });

  // ── DELETE /api/config/workflow ──────────────────────

  describe('DELETE /api/config/workflow', () => {
    it('should return success with message when workflow exists', async () => {
      mockDeleteWorkflow.mockReturnValue(true);

      const res = await deleteRequest(server, '/api/config/workflow');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('Custom workflow removed');
    });

    it('should return success when no workflow exists', async () => {
      mockDeleteWorkflow.mockReturnValue(false);

      const res = await deleteRequest(server, '/api/config/workflow');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('No custom workflow');
    });

    it('should return 500 on filesystem error', async () => {
      mockDeleteWorkflow.mockImplementation(() => {
        throw new Error('EPERM: permission denied');
      });

      const res = await deleteRequest(server, '/api/config/workflow');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal server error');
    });
  });

  // ── GET /api/config/workflow/export ─────────────────

  describe('GET /api/config/workflow/export', () => {
    it('should export default workflow with params', async () => {
      const defaultWorkflow = {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['1', 1] } },
      };
      const params = {
        ckpt_name: 'model.safetensors',
        width: 1024,
        height: 1024,
        steps: 20,
        cfg: 7.0,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 0.88,
      };
      mockGetExportWorkflow.mockResolvedValue({ workflow: defaultWorkflow, source: 'default', params });

      const res = await getJson(server, '/api/config/workflow/export');

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.source).toBe('default');
      expect(body.workflow).toEqual(defaultWorkflow);
      expect(body.params).toEqual(params);
    });

    it('should export custom workflow without params', async () => {
      const customWorkflow = {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'custom.safetensors' } },
      };
      mockGetExportWorkflow.mockResolvedValue({ workflow: customWorkflow, source: 'custom' });

      const res = await getJson(server, '/api/config/workflow/export');

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.source).toBe('custom');
      expect(body.workflow).toEqual(customWorkflow);
      expect(body.params).toBeUndefined();
    });

    it('should return 400 when no workflow is configured', async () => {
      mockGetExportWorkflow.mockResolvedValue(null);

      const res = await getJson(server, '/api/config/workflow/export');

      expect(res.status).toBe(400);
      const body = res.body as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect(body.error).toContain('No workflow configured');
    });

    it('should return 500 when getExportWorkflow throws', async () => {
      mockGetExportWorkflow.mockRejectedValue(new Error('Unexpected error'));

      const res = await getJson(server, '/api/config/workflow/export');

      expect(res.status).toBe(500);
      const body = res.body as Record<string, unknown>;
      expect(body.error).toBe('Internal server error');
    });
  });

  // ── GET /api/config/comfyui/samplers ────────────────

  describe('GET /api/config/comfyui/samplers', () => {
    it('should return sampler list from ComfyUI client', async () => {
      mockGetSamplers.mockResolvedValue(['euler', 'euler_ancestral', 'heun', 'dpmpp_2m']);

      const res = await getJson(server, '/api/config/comfyui/samplers');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(['euler', 'euler_ancestral', 'heun', 'dpmpp_2m']);
    });

    it('should return empty array when ComfyUI is unreachable', async () => {
      mockGetSamplers.mockResolvedValue([]);

      const res = await getJson(server, '/api/config/comfyui/samplers');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('should return 500 when client throws', async () => {
      mockGetSamplers.mockRejectedValue(new Error('unexpected'));

      const res = await getJson(server, '/api/config/comfyui/samplers');

      expect(res.status).toBe(500);
    });
  });

  // ── GET /api/config/comfyui/schedulers ──────────────

  describe('GET /api/config/comfyui/schedulers', () => {
    it('should return scheduler list from ComfyUI client', async () => {
      mockGetSchedulers.mockResolvedValue(['normal', 'karras', 'exponential']);

      const res = await getJson(server, '/api/config/comfyui/schedulers');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(['normal', 'karras', 'exponential']);
    });

    it('should return empty array when ComfyUI is unreachable', async () => {
      mockGetSchedulers.mockResolvedValue([]);

      const res = await getJson(server, '/api/config/comfyui/schedulers');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // ── GET /api/config/comfyui/checkpoints ─────────────

  describe('GET /api/config/comfyui/checkpoints', () => {
    it('should return checkpoint list from ComfyUI client', async () => {
      mockGetCheckpoints.mockResolvedValue(['sd15.safetensors', 'sdxl_base.safetensors']);

      const res = await getJson(server, '/api/config/comfyui/checkpoints');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(['sd15.safetensors', 'sdxl_base.safetensors']);
    });

    it('should return empty array when ComfyUI is unreachable', async () => {
      mockGetCheckpoints.mockResolvedValue([]);

      const res = await getJson(server, '/api/config/comfyui/checkpoints');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});
