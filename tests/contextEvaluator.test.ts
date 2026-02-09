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
    logDebug: jest.fn(),
    logDebugLazy: jest.fn(),
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

import { evaluateContextWindow, buildContextEvalPrompt, parseEvalResponse, formatHistoryForEval } from '../src/utils/contextEvaluator';
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

  describe('parseEvalResponse', () => {
    it('should parse a valid JSON array of indices', () => {
      expect(parseEvalResponse('[1, 3, 5]', 6, 1, 6)).toEqual([1, 3, 5]);
    });

    it('should enforce minDepth by adding missing newest indices', () => {
      // minDepth=2 means indices 1 and 2 must be present
      expect(parseEvalResponse('[3]', 5, 2, 5)).toEqual([1, 2, 3]);
    });

    it('should enforce maxDepth by dropping oldest (highest) indices', () => {
      expect(parseEvalResponse('[1, 2, 3, 4, 5]', 5, 1, 3)).toEqual([1, 2, 3]);
    });

    it('should deduplicate indices', () => {
      expect(parseEvalResponse('[1, 1, 3, 3]', 5, 1, 5)).toEqual([1, 3]);
    });

    it('should filter out-of-range indices', () => {
      expect(parseEvalResponse('[0, 1, 7]', 5, 1, 5)).toEqual([1]);
    });

    it('should fall back to legacy integer parse', () => {
      // "3" → include most recent 3 → [1, 2, 3]
      expect(parseEvalResponse('3', 6, 1, 6)).toEqual([1, 2, 3]);
    });

    it('should clamp legacy integer to minDepth', () => {
      expect(parseEvalResponse('0', 5, 2, 5)).toEqual([1, 2]);
    });

    it('should clamp legacy integer to maxDepth', () => {
      expect(parseEvalResponse('10', 6, 1, 4)).toEqual([1, 2, 3, 4]);
    });

    it('should return null for unparseable text', () => {
      expect(parseEvalResponse('three messages', 5, 1, 5)).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(parseEvalResponse('', 5, 1, 5)).toBeNull();
    });

    it('should handle JSON array with single element', () => {
      expect(parseEvalResponse('[2]', 5, 1, 5)).toEqual([1, 2]);
    });

    it('should sort indices ascending', () => {
      expect(parseEvalResponse('[4, 1, 3]', 5, 1, 5)).toEqual([1, 3, 4]);
    });
  });

  describe('evaluateContextWindow', () => {
    it('should evaluate even when deprecated contextFilterEnabled is false', async () => {
      const history = makeHistory(5);
      const kw = makeKeyword({ contextFilterEnabled: false });

      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '[1, 2, 3]' },
      });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(mockExecute).toHaveBeenCalled();
      expect(result).toHaveLength(3);
    });

    it('should evaluate even when deprecated contextFilterEnabled is undefined', async () => {
      const history = makeHistory(5);
      const kw = makeKeyword();

      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '[1, 2]' },
      });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(mockExecute).toHaveBeenCalled();
      expect(result).toHaveLength(2);
    });

    it('should return empty array for empty history', async () => {
      const kw = makeKeyword({ contextFilterMinDepth: 1, contextFilterMaxDepth: 5 });

      const result = await evaluateContextWindow([], 'hello', kw, 'user1');

      expect(result).toEqual([]);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('should return history unchanged when history length <= minDepth', async () => {
      const history = makeHistory(2);
      const kw = makeKeyword({ contextFilterMinDepth: 3, contextFilterMaxDepth: 5 });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(result).toEqual(history);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('should select sparse messages via JSON array response', async () => {
      const history = makeHistory(6);
      const kw = makeKeyword({ contextFilterMinDepth: 1, contextFilterMaxDepth: 6 });

      // Select indices 1 and 3 (newest and third-newest)
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '[1, 3]' },
      });

      const result = await evaluateContextWindow(history, 'what about topic X?', kw, 'user1');

      // Index 1 = message 6 (newest), index 3 = message 4
      // Returned in chronological order (oldest→newest)
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('message 4');
      expect(result[1].content).toBe('message 6');
    });

    it('should handle legacy integer response (contiguous window)', async () => {
      const history = makeHistory(6);
      const kw = makeKeyword({ contextFilterMinDepth: 1, contextFilterMaxDepth: 6 });

      // Ollama says include 3 messages (legacy integer)
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '3' },
      });

      const result = await evaluateContextWindow(history, 'what about topic X?', kw, 'user1');

      // Should include the 3 most recent messages in chronological order
      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('message 4');
      expect(result[1].content).toBe('message 5');
      expect(result[2].content).toBe('message 6');
    });

    it('should clamp to minDepth when Ollama returns value below min', async () => {
      const history = makeHistory(6);
      const kw = makeKeyword({ contextFilterMinDepth: 3, contextFilterMaxDepth: 6 });

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
      const kw = makeKeyword({ contextFilterMinDepth: 1, contextFilterMaxDepth: 5 });

      // Ollama says include 8, but maxDepth is 5
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '8' },
      });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(result).toHaveLength(5);
      expect(result[0].content).toBe('message 6');
    });

    it('should fall back to full non-system history when Ollama returns unparseable text', async () => {
      const history = makeHistory(5);
      const kw = makeKeyword({ contextFilterMinDepth: 1, contextFilterMaxDepth: 5 });

      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: 'three' },
      });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(result).toEqual(history);
    });

    it('should fall back to full non-system history when Ollama request fails', async () => {
      const history = makeHistory(5);
      const kw = makeKeyword({ contextFilterMinDepth: 1, contextFilterMaxDepth: 5 });

      mockGenerate.mockResolvedValue({
        success: false,
        error: 'Ollama unavailable',
      });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(result).toEqual(history);
    });

    it('should fall back to full non-system history when requestQueue throws', async () => {
      const history = makeHistory(5);
      const kw = makeKeyword({ contextFilterMinDepth: 1, contextFilterMaxDepth: 5 });

      mockExecute.mockRejectedValue(new Error('Queue timeout'));

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      expect(result).toEqual(history);
    });

    it('should exclude system messages from evaluation and return', async () => {
      const history: ChatMessage[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'msg 1' },
        { role: 'assistant', content: 'msg 2' },
        { role: 'user', content: 'msg 3' },
        { role: 'assistant', content: 'msg 4' },
      ];
      const kw = makeKeyword({ contextFilterMinDepth: 1, contextFilterMaxDepth: 4 });

      // Select indices 1 and 2 (newest two non-system messages)
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '[1, 2]' },
      });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      // No system messages in result, just the 2 selected non-system messages
      expect(result).toHaveLength(2);
      expect(result.every(m => m.role !== 'system')).toBe(true);
      expect(result[0].content).toBe('msg 3');
      expect(result[1].content).toBe('msg 4');
    });

    it('should return empty array for history with only system messages', async () => {
      const history: ChatMessage[] = [
        { role: 'system', content: 'system msg 1' },
        { role: 'system', content: 'system msg 2' },
      ];
      const kw = makeKeyword({ contextFilterMinDepth: 1, contextFilterMaxDepth: 5 });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      // No non-system messages → empty result
      expect(result).toEqual([]);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('should use global maxDepth when contextFilterMaxDepth is not set', async () => {
      const history = makeHistory(15);
      const kw = makeKeyword({ contextFilterMinDepth: 1 });
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
      const kw = makeKeyword({ contextFilterMaxDepth: 5 });

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
      const kw = makeKeyword({ contextFilterMinDepth: 1, contextFilterMaxDepth: 5 });

      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '[1, 2, 3]' },
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

    it('should select sparse non-contiguous messages correctly', async () => {
      // 6 messages: msg1 (oldest) through msg6 (newest)
      const history = makeHistory(6);
      const kw = makeKeyword({ contextFilterMinDepth: 1, contextFilterMaxDepth: 6 });

      // Select indices 1, 4, 6 — newest, 4th newest, 6th newest (oldest)
      mockGenerate.mockResolvedValue({
        success: true,
        data: { text: '[1, 4, 6]' },
      });

      const result = await evaluateContextWindow(history, 'hello', kw, 'user1');

      // Index 1 = message 6, index 4 = message 3, index 6 = message 1
      // Returned in chronological order (oldest→newest)
      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('message 1');
      expect(result[1].content).toBe('message 3');
      expect(result[2].content).toBe('message 6');
    });
  });

  describe('buildContextEvalPrompt', () => {
    it('should include min and max depth values', () => {
      const prompt = buildContextEvalPrompt(2, 8);

      expect(prompt).toContain('indices 1 through 2');
      expect(prompt).toContain('up to 8 message(s)');
    });

    it('should include topic transition directive', () => {
      const prompt = buildContextEvalPrompt(1, 5);

      expect(prompt).toContain('If messages vary topics too greatly');
      expect(prompt).toContain('most recent topic');
    });

    it('should instruct Ollama to respond with a JSON array', () => {
      const prompt = buildContextEvalPrompt(1, 5);

      expect(prompt).toContain('JSON array of integer indices');
      expect(prompt).toContain('[1, 2, 4]');
    });

    it('should mention non-contiguous selection', () => {
      const prompt = buildContextEvalPrompt(1, 5);

      expect(prompt).toContain('non-contiguous');
    });
  });
});
