/**
 * ContextEvaluator tests — exercises Ollama-backed context window filtering.
 * Uses mocked Ollama client and requestQueue; no real Ollama instance required.
 */

jest.mock('../src/utils/config', () => ({
  config: {
    getOllamaModel: jest.fn(() => 'llama2'),
    getDefaultTimeout: jest.fn(() => 300),
    getReplyChainMaxDepth: jest.fn(() => 10),
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

import { evaluateContextWindow, buildContextEvalPrompt } from '../src/utils/contextEvaluator';
import { ollamaClient } from '../src/api/ollamaClient';
import { config } from '../src/utils/config';
import { requestQueue } from '../src/utils/requestQueue';
import { ChatMessage } from '../src/types';
import { KeywordConfig } from '../src/utils/config';

const mockGenerate = ollamaClient.generate as jest.MockedFunction<typeof ollamaClient.generate>;
const mockExecute = requestQueue.execute as jest.MockedFunction<typeof requestQueue.execute>;

// Helper to build a simple keyword config
function makeKeyword(overrides: Partial<KeywordConfig> = {}): KeywordConfig {
  return {
    keyword: 'chat',
    api: 'ollama',
    timeout: 300,
    description: 'Chat',
    ...overrides,
  };
}

// Helper to build chat history (oldest to newest)
function makeHistory(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `message ${i + 1}`,
  }));
}

describe('ContextEvaluator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // By default, make requestQueue.execute invoke the executor callback
    mockExecute.mockImplementation((_api, _requester, _keyword, _timeout, executor) =>
      (executor as any)(new AbortController().signal)
    );
  });

  describe('evaluateContextWindow', () => {
    it('should return history unchanged when contextFilterEnabled is false', async () => {
      const history = makeHistory(5);
      const kw = makeKeyword({ contextFilterEnabled: false });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(result).toEqual(history);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('should return history unchanged when contextFilterEnabled is undefined', async () => {
      const history = makeHistory(5);
      const kw = makeKeyword();

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(result).toEqual(history);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('should return empty history unchanged even when filter is enabled', async () => {
      const kw = makeKeyword({ contextFilterEnabled: true, contextFilterMinDepth: 1, contextFilterMaxDepth: 5 });

      const result = await evaluateContextWindow([], 'hello', kw, 'user1');

      expect(result).toEqual([]);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('should return history unchanged when history length <= minDepth', async () => {
      const history = makeHistory(2);
      const kw = makeKeyword({ contextFilterEnabled: true, contextFilterMinDepth: 3, contextFilterMaxDepth: 5 });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(result).toEqual(history);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('should call Ollama and filter based on returned depth', async () => {
      const history = makeHistory(6);
      const kw = makeKeyword({ contextFilterEnabled: true, contextFilterMinDepth: 1, contextFilterMaxDepth: 6 });

      // Ollama says include 3 messages
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '3' },
      });

      const result = await evaluateContextWindow(history, 'what about topic X?', kw, 'user1');

      // Should include the last 3 messages (oldest→newest order)
      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('message 4');
      expect(result[1].content).toBe('message 5');
      expect(result[2].content).toBe('message 6');
    });

    it('should clamp to minDepth when Ollama returns value below min', async () => {
      const history = makeHistory(6);
      const kw = makeKeyword({ contextFilterEnabled: true, contextFilterMinDepth: 3, contextFilterMaxDepth: 6 });

      // Ollama says include 1, but minDepth is 3
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '1' },
      });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('message 4');
    });

    it('should clamp to maxDepth when Ollama returns value above max', async () => {
      const history = makeHistory(10);
      const kw = makeKeyword({ contextFilterEnabled: true, contextFilterMinDepth: 1, contextFilterMaxDepth: 5 });

      // Ollama says include 8, but maxDepth is 5
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '8' },
      });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(result).toHaveLength(5);
      expect(result[0].content).toBe('message 6');
    });

    it('should fall back to full history when Ollama returns non-numeric', async () => {
      const history = makeHistory(5);
      const kw = makeKeyword({ contextFilterEnabled: true, contextFilterMinDepth: 1, contextFilterMaxDepth: 5 });

      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: 'three' },
      });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(result).toEqual(history);
    });

    it('should fall back to full history when Ollama request fails', async () => {
      const history = makeHistory(5);
      const kw = makeKeyword({ contextFilterEnabled: true, contextFilterMinDepth: 1, contextFilterMaxDepth: 5 });

      mockGenerate.mockResolvedValue({
        success: false,
        error: 'Ollama unavailable',
      });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(result).toEqual(history);
    });

    it('should fall back to full history when requestQueue throws', async () => {
      const history = makeHistory(5);
      const kw = makeKeyword({ contextFilterEnabled: true, contextFilterMinDepth: 1, contextFilterMaxDepth: 5 });

      mockExecute.mockRejectedValue(new Error('Queue timeout'));

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(result).toEqual(history);
    });

    it('should preserve system messages at the front', async () => {
      const history: ChatMessage[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'msg 1' },
        { role: 'assistant', content: 'msg 2' },
        { role: 'user', content: 'msg 3' },
        { role: 'assistant', content: 'msg 4' },
      ];
      const kw = makeKeyword({ contextFilterEnabled: true, contextFilterMinDepth: 1, contextFilterMaxDepth: 4 });

      // Ollama says include 2 non-system messages
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '2' },
      });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      // System message + 2 most recent non-system messages
      expect(result).toHaveLength(3);
      expect(result[0].role).toBe('system');
      expect(result[1].content).toBe('msg 3');
      expect(result[2].content).toBe('msg 4');
    });

    it('should use global maxDepth when contextFilterMaxDepth is not set', async () => {
      const history = makeHistory(15);
      const kw = makeKeyword({ contextFilterEnabled: true, contextFilterMinDepth: 1 });
      // config.getReplyChainMaxDepth returns 10

      // Ollama says include 7
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '7' },
      });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      // Should get 7 messages from the candidate window of 10
      expect(result).toHaveLength(7);
      expect(result[0].content).toBe('message 9');
    });

    it('should default minDepth to 1 when not set', async () => {
      const history = makeHistory(5);
      const kw = makeKeyword({ contextFilterEnabled: true, contextFilterMaxDepth: 5 });

      // Ollama says include 0
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '0' },
      });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      // Should clamp to minDepth=1
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('message 5');
    });

    it('should use __ctx_eval__ as the queue keyword', async () => {
      const history = makeHistory(5);
      const kw = makeKeyword({ contextFilterEnabled: true, contextFilterMinDepth: 1, contextFilterMaxDepth: 5 });

      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '3' },
      });

      await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(mockExecute).toHaveBeenCalledWith(
        'ollama',
        'user1',
        '__ctx_eval__',
        300,
        expect.any(Function)
      );
    });

    it('should handle history with only system messages', async () => {
      const history: ChatMessage[] = [
        { role: 'system', content: 'system msg 1' },
        { role: 'system', content: 'system msg 2' },
      ];
      const kw = makeKeyword({ contextFilterEnabled: true, contextFilterMinDepth: 1, contextFilterMaxDepth: 5 });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      // No non-system messages, so returns unchanged
      expect(result).toEqual(history);
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe('buildContextEvalPrompt', () => {
    it('should include min and max depth values', () => {
      const prompt = buildContextEvalPrompt(2, 8);

      expect(prompt).toContain('at least 2 message(s)');
      expect(prompt).toContain('up to 8 message(s)');
    });

    it('should include topic transition directive', () => {
      const prompt = buildContextEvalPrompt(1, 5);

      expect(prompt).toContain('If messages vary topics too greatly');
      expect(prompt).toContain('most recent topic');
      expect(prompt).toContain('transition');
    });

    it('should instruct Ollama to respond with only an integer', () => {
      const prompt = buildContextEvalPrompt(1, 5);

      expect(prompt).toContain('ONLY a single integer');
    });
  });
});
