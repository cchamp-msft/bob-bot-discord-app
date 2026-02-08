/**
 * KeywordClassifier tests — exercises AI-based keyword classification
 * fallback logic. Uses mocked Ollama client; no real Ollama instance required.
 */

jest.mock('../src/utils/config', () => ({
  config: {
    getKeywords: jest.fn(() => [
      { keyword: 'generate', api: 'comfyui', timeout: 300, description: 'Generate image using ComfyUI' },
      { keyword: 'chat', api: 'ollama', timeout: 300, description: 'Chat with Ollama AI' },
      { keyword: 'ask', api: 'ollama', timeout: 300, description: 'Ask a question using Ollama' },
    ]),
    getOllamaModel: jest.fn(() => 'llama2'),
    getDefaultTimeout: jest.fn(() => 300),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logError: jest.fn(),
    logWarn: jest.fn(),
  },
}));

jest.mock('../src/api/ollamaClient', () => ({
  ollamaClient: {
    generate: jest.fn(),
  },
}));

jest.mock('../src/utils/requestQueue', () => ({
  requestQueue: {
    execute: jest.fn(),
  },
}));

import { classifyIntent, buildClassificationPrompt, buildAbilitiesContext } from '../src/utils/keywordClassifier';
import { ollamaClient } from '../src/api/ollamaClient';
import { config } from '../src/utils/config';
import { requestQueue } from '../src/utils/requestQueue';

const mockGenerate = ollamaClient.generate as jest.MockedFunction<typeof ollamaClient.generate>;
const mockExecute = requestQueue.execute as jest.MockedFunction<typeof requestQueue.execute>;

describe('KeywordClassifier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // By default, make requestQueue.execute invoke the executor callback
    mockExecute.mockImplementation((_api, _requester, _keyword, _timeout, executor) =>
      (executor as any)(new AbortController().signal)
    );
  });

  describe('classifyIntent', () => {
    it('should return matched keyword config when Ollama identifies a keyword', async () => {
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: 'generate' },
      });

      const result = await classifyIntent('can you draw a sunset for me?', 'testuser');

      expect(result.wasClassified).toBe(true);
      expect(result.keywordConfig).not.toBeNull();
      expect(result.keywordConfig!.keyword).toBe('generate');
      expect(result.keywordConfig!.api).toBe('comfyui');
    });

    it('should return null when Ollama responds with NONE', async () => {
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: 'NONE' },
      });

      const result = await classifyIntent('what is the weather like?', 'testuser');

      expect(result.wasClassified).toBe(true);
      expect(result.keywordConfig).toBeNull();
    });

    it('should handle case-insensitive keyword matching', async () => {
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: 'GENERATE' },
      });

      const result = await classifyIntent('make me a picture', 'testuser');

      expect(result.keywordConfig).not.toBeNull();
      expect(result.keywordConfig!.keyword).toBe('generate');
    });

    it('should strip punctuation from Ollama response', async () => {
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '"chat."' },
      });

      const result = await classifyIntent('hello there', 'testuser');

      expect(result.keywordConfig).not.toBeNull();
      expect(result.keywordConfig!.keyword).toBe('chat');
    });

    it('should return null for unrecognized keyword from Ollama', async () => {
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: 'unknown_keyword' },
      });

      const result = await classifyIntent('do something weird', 'testuser');

      expect(result.wasClassified).toBe(true);
      expect(result.keywordConfig).toBeNull();
    });

    it('should return wasClassified=false when Ollama fails', async () => {
      mockGenerate.mockResolvedValue({
        success: false,
        error: 'Connection refused',
      });

      const result = await classifyIntent('hello', 'testuser');

      expect(result.wasClassified).toBe(false);
      expect(result.keywordConfig).toBeNull();
    });

    it('should return wasClassified=false when Ollama returns no text', async () => {
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '' },
      });

      const result = await classifyIntent('hello', 'testuser');

      expect(result.wasClassified).toBe(false);
      expect(result.keywordConfig).toBeNull();
    });

    it('should return wasClassified=false when Ollama throws', async () => {
      mockGenerate.mockRejectedValue(new Error('Network error'));

      const result = await classifyIntent('hello', 'testuser');

      expect(result.wasClassified).toBe(false);
      expect(result.keywordConfig).toBeNull();
    });

    it('should skip classification when no keywords are configured', async () => {
      (config.getKeywords as jest.Mock).mockReturnValueOnce([]);

      const result = await classifyIntent('hello', 'testuser');

      expect(result.wasClassified).toBe(false);
      expect(result.keywordConfig).toBeNull();
      expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('should pass the content as user prompt and classification system prompt', async () => {
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: 'chat' },
      });

      await classifyIntent('tell me a joke', 'testuser');

      expect(mockGenerate).toHaveBeenCalledWith(
        'tell me a joke',
        'testuser',
        'llama2',
        expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('keyword classifier'),
          }),
        ]),
        expect.anything() // queue signal or caller signal
      );
    });

    it('should pass abort signal to Ollama when provided', async () => {
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: 'chat' },
      });

      const controller = new AbortController();
      await classifyIntent('hello', 'testuser', controller.signal);

      // The executor should call generate with a combined signal (AbortSignal.any)
      // that fires on either caller abort or queue timeout
      const passedSignal = mockGenerate.mock.calls[0][4] as AbortSignal;
      expect(passedSignal).toBeDefined();
      // The combined signal is not the same object as either source signal
      // but should not be aborted yet
      expect(passedSignal.aborted).toBe(false);
    });

    it('should abort Ollama request when caller signal fires', async () => {
      mockGenerate.mockImplementation(async (_c, _r, _m, _h, sig?: AbortSignal) => {
        // Verify the signal is already aborted when caller aborts
        expect(sig?.aborted).toBe(true);
        return { success: false, error: 'aborted' };
      });

      const controller = new AbortController();
      controller.abort();
      await classifyIntent('hello', 'testuser', controller.signal);

      expect(mockGenerate).toHaveBeenCalled();
    });

    it('should route classification through the request queue', async () => {
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: 'chat' },
      });

      await classifyIntent('hello', 'testuser');

      expect(mockExecute).toHaveBeenCalledWith(
        'ollama',
        'testuser',
        '__classify__',
        300, // default timeout from mock
        expect.any(Function)
      );
    });

    it('should handle whitespace-only Ollama response', async () => {
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '   \n  ' },
      });

      const result = await classifyIntent('hello', 'testuser');

      // After trim and clean, empty string won't match any keyword
      expect(result.keywordConfig).toBeNull();
    });
  });

  describe('buildClassificationPrompt', () => {
    it('should include all keyword descriptions', () => {
      const keywords = [
        { keyword: 'generate', api: 'comfyui' as const, timeout: 300, description: 'Generate image' },
        { keyword: 'chat', api: 'ollama' as const, timeout: 300, description: 'Chat with AI' },
      ];

      const prompt = buildClassificationPrompt(keywords);

      expect(prompt).toContain('"generate": Generate image');
      expect(prompt).toContain('"chat": Chat with AI');
      expect(prompt).toContain('NONE');
      expect(prompt).toContain('keyword classifier');
    });

    it('should produce a prompt that instructs single-word response', () => {
      const keywords = [
        { keyword: 'test', api: 'ollama' as const, timeout: 300, description: 'Test keyword' },
      ];

      const prompt = buildClassificationPrompt(keywords);

      expect(prompt).toContain('ONLY the keyword value');
      expect(prompt).toContain('no explanation');
    });
  });

  describe('buildAbilitiesContext', () => {
    it('should return empty string when no keywords have abilityText', () => {
      (config.getKeywords as jest.Mock).mockReturnValueOnce([
        { keyword: 'chat', api: 'ollama', timeout: 300, description: 'Chat' },
        { keyword: 'ask', api: 'ollama', timeout: 300, description: 'Ask' },
      ]);

      const context = buildAbilitiesContext();
      expect(context).toBe('');
    });

    it('should include abilities from keywords with abilityText', () => {
      (config.getKeywords as jest.Mock).mockReturnValueOnce([
        { keyword: 'generate', api: 'comfyui', timeout: 300, description: 'Gen image', abilityText: 'generate images from text descriptions' },
        { keyword: 'weather', api: 'accuweather', timeout: 60, description: 'Get weather', abilityText: 'check weather for any location' },
        { keyword: 'chat', api: 'ollama', timeout: 300, description: 'Chat' },
      ]);

      const context = buildAbilitiesContext();

      expect(context).toContain('generate images from text descriptions');
      expect(context).toContain('keyword: "generate"');
      expect(context).toContain('check weather for any location');
      expect(context).toContain('keyword: "weather"');
      expect(context).toContain('You have access to the following abilities');
    });

    it('should exclude ollama keywords even if they have abilityText', () => {
      (config.getKeywords as jest.Mock).mockReturnValueOnce([
        { keyword: 'chat', api: 'ollama', timeout: 300, description: 'Chat', abilityText: 'chat with AI' },
        { keyword: 'generate', api: 'comfyui', timeout: 300, description: 'Gen', abilityText: 'generate images' },
      ]);

      const context = buildAbilitiesContext();

      expect(context).toContain('generate images');
      expect(context).not.toContain('chat with AI');
    });

    it('should deduplicate abilities with identical text', () => {
      (config.getKeywords as jest.Mock).mockReturnValueOnce([
        { keyword: 'generate', api: 'comfyui', timeout: 300, description: 'Gen 1', abilityText: 'generate images from text descriptions' },
        { keyword: 'imagine', api: 'comfyui', timeout: 300, description: 'Gen 2', abilityText: 'generate images from text descriptions' },
      ]);

      const context = buildAbilitiesContext();

      // Each unique ability should appear only once (by full line including keyword)
      const lines = context.split('\n').filter(l => l.startsWith('- '));
      expect(lines).toHaveLength(2); // "generate" and "imagine" have different keyword names
    });

    it('should return empty string when no keywords are configured', () => {
      (config.getKeywords as jest.Mock).mockReturnValueOnce([]);

      const context = buildAbilitiesContext();
      expect(context).toBe('');
    });

    it('should exclude disabled keywords from abilities context', () => {
      (config.getKeywords as jest.Mock).mockReturnValueOnce([
        { keyword: 'generate', api: 'comfyui', timeout: 300, description: 'Gen', abilityText: 'generate images', enabled: false },
        { keyword: 'weather', api: 'accuweather', timeout: 60, description: 'Weather', abilityText: 'check weather' },
      ]);

      const context = buildAbilitiesContext();

      expect(context).toContain('check weather');
      expect(context).not.toContain('generate images');
    });

    it('should return empty when all keywords with abilityText are disabled', () => {
      (config.getKeywords as jest.Mock).mockReturnValueOnce([
        { keyword: 'generate', api: 'comfyui', timeout: 300, description: 'Gen', abilityText: 'generate images', enabled: false },
      ]);

      const context = buildAbilitiesContext();
      expect(context).toBe('');
    });

    it('should include instruction to state keyword on its own line', () => {
      (config.getKeywords as jest.Mock).mockReturnValueOnce([
        { keyword: 'weather', api: 'accuweather', timeout: 60, description: 'Weather', abilityText: 'check weather' },
      ]);

      const context = buildAbilitiesContext();

      expect(context).toContain('include ONLY the keyword on its own line');
      expect(context).toContain('Do not fabricate data');
    });
  });
});
