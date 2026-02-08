/**
 * ApiRouter tests — exercises the simplified API execution + optional
 * final Ollama pass pipeline. Uses mocked request queue and API manager.
 */

jest.mock('../src/utils/config', () => ({
  config: {
    getOllamaModel: jest.fn(() => 'llama2'),
    getOllamaFinalPassModel: jest.fn(() => 'llama2'),
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
import { accuweatherClient } from '../src/api/accuweatherClient';

const mockExecute = requestQueue.execute as jest.MockedFunction<typeof requestQueue.execute>;

describe('ApiRouter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('executeRoutedRequest — single stage (no final pass)', () => {
    it('should execute a single API request when no finalOllamaPass is configured', async () => {
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

    it('should return failure when primary API fails', async () => {
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

    it('should execute accuweather directly without final pass', async () => {
      const keyword: KeywordConfig = {
        keyword: 'weather',
        api: 'accuweather',
        timeout: 60,
        description: 'Get weather',
      };

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Sunny, 72°F' },
      });

      const result = await executeRoutedRequest(keyword, 'weather in Seattle', 'testuser');

      expect(result.finalApi).toBe('accuweather');
      expect(result.finalResponse.success).toBe(true);
      expect(result.stages).toHaveLength(1);
      expect(mockExecute).toHaveBeenCalledTimes(1);
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

      // Primary: ComfyUI
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

    it('should skip final Ollama pass when primary API is already Ollama', async () => {
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

    it('should return primary result when final Ollama pass fails', async () => {
      const keyword: KeywordConfig = {
        keyword: 'generate',
        api: 'comfyui',
        timeout: 300,
        description: 'Generate image',
        finalOllamaPass: true,
      };

      // Primary: Success
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

  describe('executeRoutedRequest — AccuWeather with final Ollama pass', () => {
    it('should use formatWeatherContextForAI for AccuWeather final pass', async () => {
      const keyword: KeywordConfig = {
        keyword: 'weather report',
        api: 'accuweather',
        timeout: 120,
        description: 'AI weather report',
        finalOllamaPass: true,
      };

      // Primary: AccuWeather
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: {
          text: 'Sunny, 72°F',
          location: {
            Key: '351409',
            LocalizedName: 'Seattle',
            Country: { ID: 'US', LocalizedName: 'United States' },
            AdministrativeArea: { ID: 'WA', LocalizedName: 'Washington' },
          },
          current: { WeatherText: 'Sunny' },
          forecast: null,
        },
      });

      // Final pass: Ollama
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Beautiful day in Seattle! Sunny skies with 72°F.' },
      });

      const result = await executeRoutedRequest(keyword, 'weather report for Seattle', 'testuser');

      expect(result.finalApi).toBe('ollama');
      expect(result.stages).toHaveLength(2);
      expect(accuweatherClient.formatWeatherContextForAI).toHaveBeenCalledWith(
        'Seattle, WA, United States',
        { WeatherText: 'Sunny' },
        null
      );
    });

    it('should use "Unknown location" when location data is missing', async () => {
      const keyword: KeywordConfig = {
        keyword: 'weather report',
        api: 'accuweather',
        timeout: 120,
        description: 'AI weather report',
        finalOllamaPass: true,
      };

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Sunny' },
      });

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Weather report' },
      });

      await executeRoutedRequest(keyword, 'weather report', 'testuser');

      expect(accuweatherClient.formatWeatherContextForAI).toHaveBeenCalledWith(
        'Unknown location',
        null,
        null
      );
    });

    it('should fall back to AccuWeather result when final Ollama pass fails', async () => {
      const keyword: KeywordConfig = {
        keyword: 'weather report',
        api: 'accuweather',
        timeout: 120,
        description: 'AI weather report',
        finalOllamaPass: true,
      };

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Raw weather data' },
      });

      mockExecute.mockResolvedValueOnce({
        success: false,
        error: 'Ollama timeout',
      });

      const result = await executeRoutedRequest(keyword, 'weather report', 'testuser');

      expect(result.finalApi).toBe('accuweather');
      expect(result.finalResponse.success).toBe(true);
    });
  });

  describe('executeRoutedRequest — finalOllamaPass model', () => {
    it('should use global final-pass model in final Ollama pass', async () => {
      const keyword: KeywordConfig = {
        keyword: 'generate',
        api: 'comfyui',
        timeout: 300,
        description: 'Generate image',
        finalOllamaPass: true,
      };

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { images: ['http://example.com/img.png'] },
      });

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Described image' },
      });

      await executeRoutedRequest(keyword, 'test', 'testuser');

      // Final pass should be called
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });
  });
});
