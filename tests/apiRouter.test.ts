/**
 * ApiRouter tests — exercises the multi-stage routing pipeline
 * for stacking API calls. Uses mocked request queue and API manager.
 */

jest.mock('../src/utils/config', () => ({
  config: {
    getOllamaModel: jest.fn(() => 'llama2'),
    getDefaultTimeout: jest.fn(() => 300),
    getAccuWeatherEndpoint: jest.fn(() => 'https://dataservice.accuweather.com'),
    getAccuWeatherApiKey: jest.fn(() => ''),
    getAccuWeatherDefaultLocation: jest.fn(() => ''),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logError: jest.fn(),
    logWarn: jest.fn(),
  },
}));

jest.mock('../src/utils/requestQueue', () => ({
  requestQueue: {
    execute: jest.fn(),
  },
}));

jest.mock('../src/api', () => ({
  apiManager: {
    executeRequest: jest.fn(),
  },
}));

jest.mock('../src/api/accuweatherClient', () => ({
  accuweatherClient: {
    formatWeatherContextForAI: jest.fn(() => '--- WEATHER DATA ---'),
  },
}));

import { executeRoutedRequest } from '../src/utils/apiRouter';
import { requestQueue } from '../src/utils/requestQueue';
import { KeywordConfig } from '../src/utils/config';

const mockExecute = requestQueue.execute as jest.MockedFunction<typeof requestQueue.execute>;

describe('ApiRouter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('executeRoutedRequest — single stage (no routing)', () => {
    it('should execute a single API request when no routeApi is configured', async () => {
      const keyword: KeywordConfig = {
        keyword: 'chat',
        api: 'ollama',
        timeout: 300,
        description: 'Chat with AI',
      };

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Hello!' },
      });

      const result = await executeRoutedRequest(keyword, 'hello', 'testuser');

      expect(result.finalApi).toBe('ollama');
      expect(result.finalResponse.success).toBe(true);
      expect(result.stages).toHaveLength(1);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('should return failure when stage 1 fails', async () => {
      const keyword: KeywordConfig = {
        keyword: 'generate',
        api: 'comfyui',
        timeout: 300,
        description: 'Generate image',
      };

      mockExecute.mockResolvedValueOnce({
        success: false,
        error: 'ComfyUI is down',
      });

      const result = await executeRoutedRequest(keyword, 'a sunset', 'testuser');

      expect(result.finalResponse.success).toBe(false);
      expect(result.stages).toHaveLength(1);
    });
  });

  describe('executeRoutedRequest — two stages (with routeApi)', () => {
    it('should execute stage 1 then route to stage 2', async () => {
      const keyword: KeywordConfig = {
        keyword: 'analyze',
        api: 'ollama',
        timeout: 300,
        description: 'Analyze with AI',
        routeApi: 'comfyui',
      };

      // Stage 1: Ollama analysis
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'A beautiful sunset over the ocean' },
      });

      // Stage 2: ComfyUI generation
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { images: ['http://example.com/sunset.png'] },
      });

      const result = await executeRoutedRequest(keyword, 'describe and draw a sunset', 'testuser');

      expect(result.finalApi).toBe('comfyui');
      expect(result.finalResponse.success).toBe(true);
      expect(result.stages).toHaveLength(2);
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it('should return stage 1 result when stage 2 fails', async () => {
      const keyword: KeywordConfig = {
        keyword: 'analyze',
        api: 'ollama',
        timeout: 300,
        description: 'Analyze with AI',
        routeApi: 'comfyui',
      };

      // Stage 1: Success
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Analysis complete' },
      });

      // Stage 2: Failure
      mockExecute.mockResolvedValueOnce({
        success: false,
        error: 'ComfyUI timeout',
      });

      const result = await executeRoutedRequest(keyword, 'analyze this', 'testuser');

      // Should gracefully fall back to stage 1 result
      expect(result.finalApi).toBe('ollama');
      expect(result.finalResponse.success).toBe(true);
      expect(result.stages).toHaveLength(2);
    });

    it('should not execute stage 2 when routeApi equals api', async () => {
      const keyword: KeywordConfig = {
        keyword: 'chat',
        api: 'ollama',
        timeout: 300,
        description: 'Chat',
        routeApi: 'ollama', // same as api — no actual routing
      };

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Response' },
      });

      const result = await executeRoutedRequest(keyword, 'hello', 'testuser');

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result.stages).toHaveLength(1);
    });
  });

  describe('executeRoutedRequest — with finalOllamaPass', () => {
    it('should add final Ollama refinement pass after comfyui', async () => {
      const keyword: KeywordConfig = {
        keyword: 'generate',
        api: 'comfyui',
        timeout: 300,
        description: 'Generate image',
        finalOllamaPass: true,
      };

      // Stage 1: ComfyUI
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { images: ['http://example.com/img.png'] },
      });

      // Final pass: Ollama
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'I generated a beautiful image for you!' },
      });

      const result = await executeRoutedRequest(keyword, 'draw a cat', 'testuser');

      expect(result.finalApi).toBe('ollama');
      expect(result.stages).toHaveLength(2);
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it('should skip final Ollama pass when last stage was already Ollama without routing', async () => {
      const keyword: KeywordConfig = {
        keyword: 'chat',
        api: 'ollama',
        timeout: 300,
        description: 'Chat',
        finalOllamaPass: true,
      };

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Direct response' },
      });

      const result = await executeRoutedRequest(keyword, 'hello', 'testuser');

      // Should only have 1 stage since final pass would be redundant
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result.stages).toHaveLength(1);
    });

    it('should return previous result when final Ollama pass fails', async () => {
      const keyword: KeywordConfig = {
        keyword: 'generate',
        api: 'comfyui',
        timeout: 300,
        description: 'Generate image',
        finalOllamaPass: true,
      };

      // Stage 1: Success
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { images: ['http://example.com/img.png'] },
      });

      // Final pass: Failure
      mockExecute.mockResolvedValueOnce({
        success: false,
        error: 'Ollama down',
      });

      const result = await executeRoutedRequest(keyword, 'draw a cat', 'testuser');

      // Should fall back to ComfyUI result
      expect(result.finalApi).toBe('comfyui');
      expect(result.finalResponse.success).toBe(true);
      expect(result.stages).toHaveLength(2);
    });
  });

  describe('executeRoutedRequest — three stages (routeApi + finalOllamaPass)', () => {
    it('should execute all three stages when both routeApi and finalOllamaPass are set', async () => {
      const keyword: KeywordConfig = {
        keyword: 'analyze-generate',
        api: 'ollama',
        timeout: 300,
        description: 'Analyze then generate',
        routeApi: 'comfyui',
        finalOllamaPass: true,
      };

      // Stage 1: Ollama analysis
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'A sunset scene' },
      });

      // Stage 2: ComfyUI generation
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { images: ['http://example.com/sunset.png'] },
      });

      // Stage 3: Final Ollama refinement
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Here is your sunset image!' },
      });

      const result = await executeRoutedRequest(keyword, 'make a sunset picture', 'testuser');

      expect(result.finalApi).toBe('ollama');
      expect(result.stages).toHaveLength(3);
      expect(mockExecute).toHaveBeenCalledTimes(3);
    });
  });

  describe('executeRoutedRequest — external API stub', () => {
    it('should skip stage 2 when routeApi is external (not yet implemented)', async () => {
      const keyword: KeywordConfig = {
        keyword: 'external-test',
        api: 'ollama',
        timeout: 300,
        description: 'Test external',
        routeApi: 'external',
      };

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Stage 1 result' },
      });

      const result = await executeRoutedRequest(keyword, 'test', 'testuser');

      // Should only execute stage 1 since external is not implemented
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result.finalApi).toBe('ollama');
    });
  });

  describe('executeRoutedRequest — routeModel', () => {
    it('should use routeModel in stage 2 queue keyword', async () => {
      const keyword: KeywordConfig = {
        keyword: 'analyze',
        api: 'ollama',
        timeout: 300,
        description: 'Analyze',
        routeApi: 'comfyui',
        routeModel: 'specialized-model',
      };

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Analyzed' },
      });

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { images: ['http://example.com/img.png'] },
      });

      await executeRoutedRequest(keyword, 'test', 'testuser');

      // Stage 2 should be called
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });
  });
});
