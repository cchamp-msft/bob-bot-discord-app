/**
 * Image generation test endpoint — exercises POST /api/test/generate-image
 * which submits a prompt to ComfyUI and saves results, bypassing Discord.
 *
 * Uses mocked comfyuiClient and fileHandler; no real ComfyUI instance required.
 * Default test prompt: "a picture of a banana".
 */

import http from 'http';

// ── Mocks ────────────────────────────────────────────

const mockGenerateImage = jest.fn();
const mockIsHealthy = jest.fn();

jest.mock('../src/api/comfyuiClient', () => ({
  comfyuiClient: {
    generateImage: mockGenerateImage,
    isHealthy: mockIsHealthy,
    validateWorkflow: jest.fn(() => ({ valid: true })),
    refresh: jest.fn(),
    extractImageUrls: jest.fn(() => []),
  },
}));

const mockSaveFromUrl = jest.fn();

jest.mock('../src/utils/fileHandler', () => ({
  fileHandler: {
    saveFromUrl: mockSaveFromUrl,
    saveFile: jest.fn(),
    shouldAttachFile: jest.fn(() => true),
    readFile: jest.fn(),
  },
}));

jest.mock('../src/utils/config', () => ({
  config: {
    getHttpPort: jest.fn(() => 0), // port 0 = OS picks a free port
    getComfyUIEndpoint: jest.fn(() => 'http://localhost:8190'),
    getComfyUIWorkflow: jest.fn(() => '{"text": "%prompt%"}'),
    hasComfyUIWorkflow: jest.fn(() => true),
    getApiEndpoint: jest.fn(() => 'http://localhost:8190'),
    getOutputBaseUrl: jest.fn(() => 'http://localhost:3003'),
    getFileSizeThreshold: jest.fn(() => 10485760),
    getMaxAttachments: jest.fn(() => 10),
    getPublicConfig: jest.fn(() => ({})),
    reload: jest.fn(() => ({ reloaded: [], requiresRestart: [] })),
    getOllamaModel: jest.fn(() => 'llama3'),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
    logDebug: jest.fn(),
    logDebugLazy: jest.fn(),
    getRecentLines: jest.fn(() => []),
  },
}));

jest.mock('../src/utils/configWriter', () => ({
  configWriter: {
    saveWorkflow: jest.fn(),
    updateEnv: jest.fn(),
    updateKeywords: jest.fn(),
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

// ── Helpers ──────────────────────────────────────────

const DEFAULT_PROMPT = 'a picture of a banana';

/** Make a JSON POST request to the test server and return parsed response. */
function postJson(
  server: http.Server,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = JSON.stringify(body);

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path,
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

// ── Tests ────────────────────────────────────────────

describe('POST /api/test/generate-image', () => {
  let server: http.Server;

  beforeAll((done) => {
    const app = httpServer.getApp();
    server = app.listen(0, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    mockGenerateImage.mockReset();
    mockSaveFromUrl.mockReset();
  });

  it('should generate an image with the default banana prompt', async () => {
    const imageUrl = 'http://localhost:8190/view?filename=banana_001.png&type=output';

    mockGenerateImage.mockResolvedValue({
      success: true,
      data: { images: [imageUrl] },
    });

    mockSaveFromUrl.mockResolvedValue({
      filePath: '/outputs/2026/02/07T12-00-00/test-a_picture_of.png',
      fileName: 'test-a_picture_of.png',
      url: 'http://localhost:3000/2026/02/07T12-00-00/test-a_picture_of.png',
      size: 12345,
    });

    const res = await postJson(server, '/api/test/generate-image', {
      prompt: DEFAULT_PROMPT,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.images).toHaveLength(1);
    expect((res.body.images as string[])[0]).toContain('test-a_picture_of.png');

    // Verify comfyuiClient was called with correct args
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
    const [prompt, requester] = mockGenerateImage.mock.calls[0];
    expect(prompt).toBe(DEFAULT_PROMPT);
    expect(requester).toBe('test');

    // Verify file was saved
    expect(mockSaveFromUrl).toHaveBeenCalledWith('test', DEFAULT_PROMPT, imageUrl, 'png');
  });

  it('should return multiple images when ComfyUI outputs several', async () => {
    const imageUrls = [
      'http://localhost:8190/view?filename=img_001.png&type=output',
      'http://localhost:8190/view?filename=img_002.png&type=output',
    ];

    mockGenerateImage.mockResolvedValue({
      success: true,
      data: { images: imageUrls },
    });

    mockSaveFromUrl
      .mockResolvedValueOnce({
        filePath: '/outputs/test-1.png',
        fileName: 'test-1.png',
        url: 'http://localhost:3000/test-1.png',
        size: 1000,
      })
      .mockResolvedValueOnce({
        filePath: '/outputs/test-2.png',
        fileName: 'test-2.png',
        url: 'http://localhost:3000/test-2.png',
        size: 2000,
      });

    const res = await postJson(server, '/api/test/generate-image', {
      prompt: DEFAULT_PROMPT,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.images).toHaveLength(2);
    expect(mockSaveFromUrl).toHaveBeenCalledTimes(2);
  });

  it('should return error when ComfyUI generation fails', async () => {
    mockGenerateImage.mockResolvedValue({
      success: false,
      error: 'ComfyUI prompt rejected (HTTP 400): node_errors detected',
    });

    const res = await postJson(server, '/api/test/generate-image', {
      prompt: DEFAULT_PROMPT,
    });

    expect(res.status).toBe(200); // endpoint returns 200 with success: false
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('ComfyUI prompt rejected');
  });

  it('should return 400 when prompt is missing', async () => {
    const res = await postJson(server, '/api/test/generate-image', {});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('non-empty prompt');
  });

  it('should return 400 when prompt is empty string', async () => {
    const res = await postJson(server, '/api/test/generate-image', {
      prompt: '   ',
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('non-empty prompt');
  });

  it('should return 400 when prompt is not a string', async () => {
    const res = await postJson(server, '/api/test/generate-image', {
      prompt: 42,
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('should handle ComfyUI client throwing an exception', async () => {
    mockGenerateImage.mockRejectedValue(new Error('Network timeout'));

    const res = await postJson(server, '/api/test/generate-image', {
      prompt: DEFAULT_PROMPT,
    });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Network timeout');
  });

  it('should still succeed when file save fails for one image', async () => {
    mockGenerateImage.mockResolvedValue({
      success: true,
      data: {
        images: [
          'http://localhost:8190/view?filename=img_001.png&type=output',
          'http://localhost:8190/view?filename=img_002.png&type=output',
        ],
      },
    });

    // First save succeeds, second returns null (download failure)
    mockSaveFromUrl
      .mockResolvedValueOnce({
        filePath: '/outputs/test-1.png',
        fileName: 'test-1.png',
        url: 'http://localhost:3000/test-1.png',
        size: 1000,
      })
      .mockResolvedValueOnce(null);

    const res = await postJson(server, '/api/test/generate-image', {
      prompt: DEFAULT_PROMPT,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Only one image saved successfully
    expect(res.body.images).toHaveLength(1);
  });

  it('should pass an AbortSignal to comfyuiClient.generateImage', async () => {
    mockGenerateImage.mockResolvedValue({
      success: true,
      data: { images: [] },
    });

    await postJson(server, '/api/test/generate-image', {
      prompt: DEFAULT_PROMPT,
    });

    // Third arg should be an AbortSignal
    const signal = mockGenerateImage.mock.calls[0][2];
    expect(signal).toBeDefined();
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
