/**
 * xAI Client tests — exercises generateImage (POST /images/generations)
 * and generateVideo (POST /videos/generations + polling) methods.
 *
 * Uses mocked axios to verify request shape, response parsing, and error handling.
 */

const mockPost = jest.fn();
const mockGet = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({
      post: mockPost,
      get: mockGet,
      defaults: { headers: { common: {} } },
    })),
  },
}));

jest.mock('../src/utils/config', () => ({
  config: {
    getXaiEndpoint: jest.fn(() => 'https://api.x.ai/v1'),
    getXaiApiKey: jest.fn(() => 'test-key'),
    getXaiTimeout: jest.fn(() => 120000),
    getXaiModel: jest.fn(() => 'grok-2'),
    getXaiImageModel: jest.fn(() => 'grok-imagine-image'),
    getXaiVideoModel: jest.fn(() => 'grok-imagine-video'),
    getOllamaSystemPrompt: jest.fn(() => ''),
    getXaiEncourageBuiltinTools: jest.fn(() => false),
    getXaiDebugLogging: jest.fn(() => false),
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
    logXaiDebug: jest.fn(),
    logXaiDebugLazy: jest.fn(),
  },
}));

import { xaiClient } from '../src/api/xaiClient';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('XaiClient', () => {
  describe('generateImage', () => {
    it('should POST to /images/generations with correct payload', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: {
          data: [{ url: 'https://cdn.x.ai/img/abc.png' }],
        },
      });

      const result = await xaiClient.generateImage('a sunset over mountains', 'user1');

      expect(result.success).toBe(true);
      expect(result.data?.images).toHaveLength(1);
      expect(result.data?.images[0]).toBe('https://cdn.x.ai/img/abc.png');

      expect(mockPost).toHaveBeenCalledWith(
        '/images/generations',
        expect.objectContaining({
          model: 'grok-imagine-image',
          prompt: 'a sunset over mountains',
          response_format: 'url',
        }),
        undefined,
      );
    });

    it('should handle b64_json response format', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: {
          data: [{ b64_json: 'iVBORw0KGgo=' }],
        },
      });

      const result = await xaiClient.generateImage('a cat', 'user1');

      expect(result.success).toBe(true);
      expect(result.data?.images[0]).toBe('data:image/png;base64,iVBORw0KGgo=');
    });

    it('should handle multiple images', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: {
          data: [
            { url: 'https://cdn.x.ai/img/1.png' },
            { url: 'https://cdn.x.ai/img/2.png' },
          ],
        },
      });

      const result = await xaiClient.generateImage('two cats', 'user1');

      expect(result.success).toBe(true);
      expect(result.data?.images).toHaveLength(2);
    });

    it('should return error when response has no images', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: { data: [] },
      });

      const result = await xaiClient.generateImage('nothing', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No images returned');
    });

    it('should return error on HTTP failure status', async () => {
      mockPost.mockResolvedValue({ status: 400, data: null });

      const result = await xaiClient.generateImage('bad request', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('status 400');
    });

    it('should return error on network exception', async () => {
      mockPost.mockRejectedValue(new Error('Request failed with status code 400'));

      const result = await xaiClient.generateImage('error prompt', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Request failed with status code 400');
    });

    it('should pass abort signal to request config', async () => {
      const controller = new AbortController();
      mockPost.mockResolvedValue({
        status: 200,
        data: { data: [{ url: 'https://cdn.x.ai/img.png' }] },
      });

      await xaiClient.generateImage('test', 'user1', controller.signal);

      const callArgs = mockPost.mock.calls[0];
      expect(callArgs[2]).toEqual(expect.objectContaining({ signal: controller.signal }));
    });
  });

  describe('generateVideo', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    function advancePolling() {
      return jest.advanceTimersByTimeAsync(6_000);
    }

    it('should POST to /videos/generations and poll until done', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: { request_id: 'vid-123' },
      });

      mockGet.mockResolvedValue({
        status: 200,
        data: {
          status: 'done',
          video: { url: 'https://cdn.x.ai/vid/abc.mp4', duration: 5 },
        },
      });

      const promise = xaiClient.generateVideo('a flower blooming', 'user1');
      await advancePolling();
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.data?.url).toBe('https://cdn.x.ai/vid/abc.mp4');
      expect(result.data?.duration).toBe(5);

      expect(mockPost).toHaveBeenCalledWith(
        '/videos/generations',
        expect.objectContaining({
          model: 'grok-imagine-video',
          prompt: 'a flower blooming',
        }),
        undefined,
      );
      expect(mockGet).toHaveBeenCalledWith('/videos/vid-123', undefined);
    });

    it('should return error when no request_id is returned', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: {},
      });

      const result = await xaiClient.generateVideo('test', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('request_id');
    });

    it('should return error when video expires', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: { request_id: 'vid-expired' },
      });

      mockGet.mockResolvedValue({
        status: 200,
        data: { status: 'expired' },
      });

      const promise = xaiClient.generateVideo('expired test', 'user1');
      await advancePolling();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('expired');
    });

    it('should return error when done but no video URL', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: { request_id: 'vid-nourl' },
      });

      mockGet.mockResolvedValue({
        status: 200,
        data: { status: 'done', video: {} },
      });

      const promise = xaiClient.generateVideo('no url', 'user1');
      await advancePolling();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('no URL');
    });

    it('should return error on network exception', async () => {
      mockPost.mockRejectedValue(new Error('Connection refused'));

      const result = await xaiClient.generateVideo('fail', 'user1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection refused');
    });

    it('should handle abort signal', async () => {
      const controller = new AbortController();
      controller.abort();

      mockPost.mockResolvedValue({
        status: 200,
        data: { request_id: 'vid-abort' },
      });

      const promise = xaiClient.generateVideo('abort test', 'user1', controller.signal);
      await advancePolling();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('aborted');
    });
  });
});
