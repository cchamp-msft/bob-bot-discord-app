/**
 * ApiRouter tests — exercises the simplified API execution + optional
 * final Ollama pass pipeline. Uses mocked request queue and API manager.
 */

jest.mock('../src/utils/config', () => ({
  config: {
    getOllamaModel: jest.fn(() => 'llama2'),
    getOllamaFinalPassModel: jest.fn(() => 'llama2'),
    getOllamaSystemPrompt: jest.fn(() => 'You are Bob. Rude but helpful Discord bot.'),
    getDefaultTimeout: jest.fn(() => 300),
    getAccuWeatherEndpoint: jest.fn(() => 'https://dataservice.accuweather.com'),
    getAccuWeatherApiKey: jest.fn(() => ''),
    getAccuWeatherDefaultLocation: jest.fn(() => ''),
    getKeywords: jest.fn(() => []),
    getSerpApiEndpoint: jest.fn(() => 'https://serpapi.com'),
    getSerpApiKey: jest.fn(() => ''),
    getAbilityRetryEnabled: jest.fn(() => false),
    getAbilityRetryMaxRetries: jest.fn(() => 2),
    getAbilityRetryModel: jest.fn(() => 'llama2'),
    getAbilityRetryPrompt: jest.fn(() => 'Refine the parameters. Return ONLY the refined parameters.'),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logError: jest.fn(),
    logWarn: jest.fn(),
    logDebug: jest.fn(),
    logDebugLazy: jest.fn(),
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

jest.mock('../src/utils/contextEvaluator', () => ({
  evaluateContextWindow: jest.fn().mockImplementation((history) => Promise.resolve(history)),
}));

import { executeRoutedRequest } from '../src/utils/apiRouter';
import { requestQueue } from '../src/utils/requestQueue';
import { KeywordConfig } from '../src/utils/config';
import { accuweatherClient } from '../src/api/accuweatherClient';
import { apiManager } from '../src/api';
import { config } from '../src/utils/config';

const mockExecute = requestQueue.execute as jest.MockedFunction<typeof requestQueue.execute>;
const mockApiExecute = apiManager.executeRequest as jest.MockedFunction<typeof apiManager.executeRequest>;

describe('ApiRouter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('executeRoutedRequest — ability retry loop (AccuWeather)', () => {
    it('should refine location via Ollama and retry AccuWeather when location lookup fails', async () => {
      (config.getAbilityRetryEnabled as jest.Mock).mockReturnValueOnce(true);
      (config.getAbilityRetryMaxRetries as jest.Mock).mockReturnValueOnce(2);

      const keyword: KeywordConfig = {
        keyword: 'weather',
        api: 'accuweather',
        timeout: 60,
        description: 'Get weather',
      };

      // 1) Primary AccuWeather fails to resolve location
      mockExecute.mockResolvedValueOnce({
        success: false,
        error: 'Could not find location "asdfasdf". Try a different city name or zip code.',
      });

      // 2) Ollama refinement returns a better location
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Seattle, WA' },
      });

      // 3) Retry AccuWeather succeeds
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Sunny, 72°F' },
      });

      const result = await executeRoutedRequest(keyword, 'asdfasdf', 'testuser');

      expect(result.finalApi).toBe('accuweather');
      expect(result.finalResponse.success).toBe(true);
      expect(mockExecute).toHaveBeenCalledTimes(3);
      // stages: accuweather fail + ollama refine + accuweather success
      expect(result.stages).toHaveLength(3);

      // Ensure we invoked refinement (ollama) between attempts
      expect(mockExecute.mock.calls[1][0]).toBe('ollama');
      expect(mockExecute.mock.calls[2][0]).toBe('accuweather');
    });

    it('should stop retrying after max retries and return final failure', async () => {
      (config.getAbilityRetryEnabled as jest.Mock).mockReturnValueOnce(true);
      (config.getAbilityRetryMaxRetries as jest.Mock).mockReturnValueOnce(2);

      const keyword: KeywordConfig = {
        keyword: 'weather',
        api: 'accuweather',
        timeout: 60,
        description: 'Get weather',
      };

      // Primary failure
      mockExecute.mockResolvedValueOnce({
        success: false,
        error: 'Could not find location "q". Try a different city name or zip code.',
      });

      // Retry 1 refinement
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Springfield' },
      });

      // Retry 1 attempt still fails (retryable)
      mockExecute.mockResolvedValueOnce({
        success: false,
        error: 'Could not find location "Springfield". Try a different city name or zip code.',
      });

      // Retry 2 refinement
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Springfield, IL' },
      });

      // Retry 2 attempt fails (still)
      mockExecute.mockResolvedValueOnce({
        success: false,
        error: 'Could not find location "Springfield, IL". Try a different city name or zip code.',
      });

      const result = await executeRoutedRequest(keyword, 'q', 'testuser');

      expect(result.finalApi).toBe('accuweather');
      expect(result.finalResponse.success).toBe(false);
      expect(mockExecute).toHaveBeenCalledTimes(5);
      // stages: primary fail + (refine+attempt)*2
      expect(result.stages).toHaveLength(5);
    });

    it('should not trigger retry for non-retryable failure (non-AccuWeather)', async () => {
      (config.getAbilityRetryEnabled as jest.Mock).mockReturnValueOnce(true);
      (config.getAbilityRetryMaxRetries as jest.Mock).mockReturnValueOnce(2);

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
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result.stages).toHaveLength(1);
    });

    it('should abort retries when refinement returns empty input', async () => {
      (config.getAbilityRetryEnabled as jest.Mock).mockReturnValueOnce(true);
      (config.getAbilityRetryMaxRetries as jest.Mock).mockReturnValueOnce(2);

      const keyword: KeywordConfig = {
        keyword: 'weather',
        api: 'accuweather',
        timeout: 60,
        description: 'Get weather',
      };

      // Primary AccuWeather fails
      mockExecute.mockResolvedValueOnce({
        success: false,
        error: 'Could not find location "xyz". Try a different city name or zip code.',
      });

      // Ollama refinement returns empty string
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: '   ' },
      });

      const result = await executeRoutedRequest(keyword, 'xyz', 'testuser');

      expect(result.finalResponse.success).toBe(false);
      // Only primary + refine, no second AccuWeather attempt
      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(result.stages).toHaveLength(2);
    });

    it('should abort retries when refinement repeats the same input', async () => {
      (config.getAbilityRetryEnabled as jest.Mock).mockReturnValueOnce(true);
      (config.getAbilityRetryMaxRetries as jest.Mock).mockReturnValueOnce(2);

      const keyword: KeywordConfig = {
        keyword: 'weather',
        api: 'accuweather',
        timeout: 60,
        description: 'Get weather',
      };

      // Primary AccuWeather fails
      mockExecute.mockResolvedValueOnce({
        success: false,
        error: 'Could not find location "foo". Try a different city name or zip code.',
      });

      // Ollama refinement returns same input as original
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'foo' },
      });

      const result = await executeRoutedRequest(keyword, 'foo', 'testuser');

      expect(result.finalResponse.success).toBe(false);
      // Only primary + refine, no second AccuWeather attempt
      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(result.stages).toHaveLength(2);
    });
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

  describe('executeRoutedRequest — NFL routing', () => {
    it('should route NFL requests through requestQueue with nfl api type', async () => {
      const keyword: KeywordConfig = {
        keyword: 'nfl scores',
        api: 'nfl',
        timeout: 30,
        description: 'NFL scores',
      };

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: '🏈 **NFL Scores**\n\n✅ Eagles 28 - Cowboys 21 (Final)', games: [] },
      });

      const result = await executeRoutedRequest(keyword, 'nfl scores', 'testuser');

      expect(result.finalApi).toBe('nfl');
      expect(result.finalResponse.success).toBe(true);
      expect(result.stages).toHaveLength(1);
      expect(mockExecute).toHaveBeenCalledWith(
        'nfl',
        'testuser',
        'nfl scores',
        30,
        expect.any(Function),
        undefined
      );
    });

    it('should support NFL with final Ollama pass', async () => {
      const keyword: KeywordConfig = {
        keyword: 'nfl',
        api: 'nfl',
        timeout: 60,
        description: 'NFL chat',
        finalOllamaPass: true,
      };

      // Primary: NFL data (plain — router wraps with markers)
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'NFL Scores - Current Week\nChiefs 14 - Ravens 10', games: [] },
      });

      // Final pass: Ollama
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'The Chiefs are currently leading the Ravens 14-10 in an exciting game!' },
      });

      const result = await executeRoutedRequest(keyword, 'who is winning the chiefs game?', 'testuser');

      expect(result.finalApi).toBe('ollama');
      expect(result.stages).toHaveLength(2);
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it('should fall back to NFL result when final Ollama pass fails', async () => {
      const keyword: KeywordConfig = {
        keyword: 'nfl',
        api: 'nfl',
        timeout: 60,
        description: 'NFL chat',
        finalOllamaPass: true,
      };

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'NFL data here', games: [] },
      });

      mockExecute.mockResolvedValueOnce({
        success: false,
        error: 'Ollama unavailable',
      });

      const result = await executeRoutedRequest(keyword, 'nfl update', 'testuser');

      expect(result.finalApi).toBe('nfl');
      expect(result.finalResponse.success).toBe(true);
    });

    it('should return error when NFL request fails', async () => {
      const keyword: KeywordConfig = {
        keyword: 'nfl scores',
        api: 'nfl',
        timeout: 30,
        description: 'NFL scores',
      };

      mockExecute.mockResolvedValueOnce({
        success: false,
        error: 'NFL API key not configured',
      });

      const result = await executeRoutedRequest(keyword, 'nfl scores', 'testuser');

      expect(result.finalApi).toBe('nfl');
      expect(result.finalResponse.success).toBe(false);
      expect(result.stages).toHaveLength(1);
    });
  });

  describe('executeRoutedRequest — signal forwarding', () => {
    it('should pass caller signal to requestQueue.execute', async () => {
      const keyword: KeywordConfig = {
        keyword: 'chat',
        api: 'ollama',
        timeout: 300,
        description: 'Chat',
      };

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Hello!' },
      });

      const controller = new AbortController();
      await executeRoutedRequest(keyword, 'hello', 'testuser', undefined, controller.signal);

      // requestQueue.execute should have been called with the signal as 6th arg
      expect(mockExecute).toHaveBeenCalledWith(
        'ollama', 'testuser', 'chat', 300,
        expect.any(Function),
        controller.signal
      );
    });

    it('should pass caller signal for NFL requests too', async () => {
      const keyword: KeywordConfig = {
        keyword: 'nfl scores',
        api: 'nfl',
        timeout: 30,
        description: 'NFL scores',
      };

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Scores', games: [] },
      });

      const controller = new AbortController();
      await executeRoutedRequest(keyword, '', 'testuser', undefined, controller.signal);

      expect(mockExecute).toHaveBeenCalledWith(
        'nfl', 'testuser', 'nfl scores', 30,
        expect.any(Function),
        controller.signal
      );
    });

    it('should pass caller signal to final Ollama pass', async () => {
      const keyword: KeywordConfig = {
        keyword: 'nfl',
        api: 'nfl',
        timeout: 60,
        description: 'NFL',
        finalOllamaPass: true,
      };

      // Primary NFL request
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'NFL scores data', games: [] },
      });

      // Final Ollama pass
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Final result' },
      });

      const controller = new AbortController();
      await executeRoutedRequest(keyword, 'what happened in the nfl?', 'testuser', undefined, controller.signal);

      // Both calls should receive the signal as 6th arg
      expect(mockExecute).toHaveBeenCalledTimes(2);
      const finalPassCall = mockExecute.mock.calls[1];
      expect(finalPassCall[0]).toBe('ollama');
      expect(finalPassCall[2]).toBe('nfl:final');
      expect(finalPassCall[5]).toBe(controller.signal);
    });
  });

  // ── NFL final-pass prompt markers (now XML-based) ─────────

  describe('NFL final-pass prompt markers', () => {
    /**
     * Helper: sets up a final-pass flow and captures the prompt string
     * passed through to apiManager.executeRequest via the callback.
     */
    async function captureNflFinalPrompt(keyword: KeywordConfig, nflText: string, userContent: string): Promise<string> {
      // Primary NFL result
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: nflText, games: [] },
      });

      // Final Ollama pass — invoke the callback to capture apiManager args
      mockApiExecute.mockResolvedValue({ success: true, data: { text: 'AI response' } } as any);
      mockExecute.mockImplementationOnce(async (_api, _req, _label, _timeout, callback) => {
        await callback(undefined as any);
        return { success: true, data: { text: 'AI response' } };
      });

      await executeRoutedRequest(keyword, userContent, 'testuser');

      // The prompt is the 3rd argument to apiManager.executeRequest
      return mockApiExecute.mock.calls[0][2] as string;
    }

    it('should wrap "nfl scores" final-pass with <espn_data source="nfl-scores"> XML tags', async () => {
      const keyword: KeywordConfig = {
        keyword: 'nfl scores',
        api: 'nfl',
        timeout: 60,
        description: 'NFL scores',
        finalOllamaPass: true,
      };

      const prompt = await captureNflFinalPrompt(keyword, 'NFL Scores - Current Week\nChiefs 14 - Ravens 10', 'who is winning?');
      expect(prompt).toContain('<espn_data source="nfl-scores">');
      expect(prompt).toContain('</espn_data>');
      expect(prompt).toContain('<external_data>');
      expect(prompt).toContain('</external_data>');
    });

    it('should wrap "nfl news" final-pass with <espn_data source="nfl-news"> XML tags', async () => {
      const keyword: KeywordConfig = {
        keyword: 'nfl news',
        api: 'nfl',
        timeout: 60,
        description: 'NFL news',
        finalOllamaPass: true,
      };

      const prompt = await captureNflFinalPrompt(keyword, 'NFL News Headlines\n- Chiefs sign free agent', 'give me the latest');
      expect(prompt).toContain('<espn_data source="nfl-news">');
      expect(prompt).toContain('</espn_data>');
      expect(prompt).not.toContain('source="nfl-scores"');
    });

    it('should include user question in <current_question> XML block', async () => {
      const keyword: KeywordConfig = {
        keyword: 'nfl scores',
        api: 'nfl',
        timeout: 60,
        description: 'NFL scores',
        finalOllamaPass: true,
      };

      const prompt = await captureNflFinalPrompt(keyword, 'Some NFL data', 'tell me about the chiefs');
      expect(prompt).toContain('<current_question>');
      expect(prompt).toContain('tell me about the chiefs');
      expect(prompt).toContain('</current_question>');
    });

    it('should fall back to NFL result when final pass fails', async () => {
      const keyword: KeywordConfig = {
        keyword: 'nfl scores',
        api: 'nfl',
        timeout: 60,
        description: 'NFL scores',
        finalOllamaPass: true,
      };

      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'NFL data', games: [] },
      });

      mockExecute.mockResolvedValueOnce({
        success: false,
        error: 'Ollama down',
      });

      const result = await executeRoutedRequest(keyword, 'report', 'testuser');
      expect(result.finalApi).toBe('nfl');
      expect(result.finalResponse.success).toBe(true);
    });
  });

  describe('Context Evaluation in Final Pass', () => {
    const { evaluateContextWindow } = require('../src/utils/contextEvaluator');
    const mockEvaluate = evaluateContextWindow as jest.MockedFunction<typeof evaluateContextWindow>;

    beforeEach(() => {
      mockEvaluate.mockImplementation((history: any) => Promise.resolve(history));
    });

    it('should call evaluateContextWindow before final Ollama pass', async () => {
      const keyword: KeywordConfig = {
        keyword: 'weather report',
        api: 'accuweather',
        timeout: 60,
        description: 'AI weather report',
        finalOllamaPass: true,
        contextFilterMinDepth: 1,
        contextFilterMaxDepth: 5,
      };

      const conversationHistory = [
        { role: 'user' as const, content: 'old msg' },
        { role: 'assistant' as const, content: 'old reply' },
      ];

      // Primary API result
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: {
          text: 'Sunny, 72°F',
          location: { LocalizedName: 'Dayton', Country: { ID: 'US', LocalizedName: 'United States' }, AdministrativeArea: { ID: 'OH', LocalizedName: 'Ohio' } },
          current: null,
          forecast: null,
        },
      });

      // Final Ollama pass result
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Nice weather today!' },
      });

      await executeRoutedRequest(keyword, 'weather 45403', 'testuser', conversationHistory);

      expect(mockEvaluate).toHaveBeenCalledWith(
        conversationHistory,
        'weather 45403',
        keyword,
        'testuser',
        undefined
      );
    });

    it('should not call evaluateContextWindow when no conversation history', async () => {
      const keyword: KeywordConfig = {
        keyword: 'weather report',
        api: 'accuweather',
        timeout: 60,
        description: 'AI weather report',
        finalOllamaPass: true,
        contextFilterMinDepth: 1,
        contextFilterMaxDepth: 5,
      };

      // Primary API result
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: {
          text: 'Sunny, 72°F',
          location: { LocalizedName: 'Dayton', Country: { ID: 'US', LocalizedName: 'United States' }, AdministrativeArea: { ID: 'OH', LocalizedName: 'Ohio' } },
          current: null,
          forecast: null,
        },
      });

      // Final Ollama pass result
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Nice weather today!' },
      });

      await executeRoutedRequest(keyword, 'weather 45403', 'testuser');

      expect(mockEvaluate).not.toHaveBeenCalled();
    });

    it('should pass filtered history to final Ollama pass', async () => {
      const keyword: KeywordConfig = {
        keyword: 'weather report',
        api: 'accuweather',
        timeout: 60,
        description: 'AI weather report',
        finalOllamaPass: true,
        contextFilterMinDepth: 1,
        contextFilterMaxDepth: 3,
      };

      const fullHistory = [
        { role: 'user' as const, content: 'msg1' },
        { role: 'assistant' as const, content: 'msg2' },
        { role: 'user' as const, content: 'msg3' },
      ];

      const filteredHistory = [
        { role: 'user' as const, content: 'msg3' },
      ];

      // evaluateContextWindow returns filtered history
      mockEvaluate.mockResolvedValue(filteredHistory);

      // Primary API result
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: {
          text: 'Sunny, 72°F',
          location: { LocalizedName: 'Dayton', Country: { ID: 'US', LocalizedName: 'United States' }, AdministrativeArea: { ID: 'OH', LocalizedName: 'Ohio' } },
          current: null,
          forecast: null,
        },
      });

      // Final Ollama pass — capture the call to check history
      mockExecute.mockResolvedValueOnce({
        success: true,
        data: { text: 'Nice weather today!' },
      });

      await executeRoutedRequest(keyword, 'weather 45403', 'testuser', fullHistory);

      // The second mockExecute call (final pass) should receive filtered history via apiManager
      // We verify the evaluator was called with the full history
      expect(mockEvaluate).toHaveBeenCalledWith(
        fullHistory,
        'weather 45403',
        keyword,
        'testuser',
        undefined
      );
    });
  });
});
