/**
 * SerpApiClient tests — exercises search handling, text/AI formatting,
 * health checks, and error handling.
 * Uses axios mocking; no real SerpAPI instance required.
 */

import axios from 'axios';

// Stable mock instance — defined at module level so the singleton
// captures this same object when it calls axios.create() at import time.
const mockInstance = {
  get: jest.fn(),
  defaults: { baseURL: '' },
};

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => mockInstance),
    isAxiosError: jest.fn((err: any) => err?.isAxiosError === true),
  },
}));

jest.mock('../src/utils/config', () => ({
  config: {
    getSerpApiEndpoint: jest.fn(() => 'https://serpapi.com'),
    getSerpApiKey: jest.fn(() => 'test-serpapi-key'),
    getSerpApiHl: jest.fn(() => 'en'),
    getSerpApiGl: jest.fn(() => 'us'),
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
import { serpApiClient } from '../src/api/serpApiClient';
import { config } from '../src/utils/config';

// --- Test data fixtures ---
const sampleSearchResponse = {
  search_metadata: { status: 'Success' },
  search_parameters: { q: 'what is TypeScript' },
  answer_box: {
    type: 'organic_result',
    title: 'TypeScript',
    answer: 'TypeScript is a strongly typed programming language that builds on JavaScript.',
    link: 'https://typescriptlang.org',
  },
  knowledge_graph: {
    title: 'TypeScript',
    type: 'Programming language',
    description: 'TypeScript is a free and open-source programming language developed by Microsoft.',
    source: { name: 'Wikipedia', link: 'https://en.wikipedia.org/wiki/TypeScript' },
  },
  ai_overview: {
    text_blocks: [
      {
        type: 'paragraph',
        snippet: 'TypeScript is a superset of JavaScript that adds static typing.',
        reference_indexes: [0],
      },
      {
        type: 'list',
        list: [
          { snippet: 'It compiles to plain JavaScript.' },
          { snippet: 'It supports modern ES features.' },
        ],
      },
    ],
    references: [
      { title: 'TypeScript Docs', link: 'https://typescriptlang.org/docs', snippet: 'Official docs', source: 'TypeScript', index: 0 },
    ],
  },
  organic_results: [
    { position: 1, title: 'TypeScript: JavaScript With Syntax For Types', link: 'https://www.typescriptlang.org/', snippet: 'TypeScript extends JavaScript by adding types.' },
    { position: 2, title: 'TypeScript - Wikipedia', link: 'https://en.wikipedia.org/wiki/TypeScript', snippet: 'TypeScript is a programming language.' },
    { position: 3, title: 'TypeScript Tutorial', link: 'https://www.w3schools.com/typescript/', snippet: 'TypeScript is JavaScript with added syntax for types.' },
  ],
};

const minimalSearchResponse = {
  search_metadata: { status: 'Success' },
  search_parameters: { q: 'obscure query' },
  organic_results: [
    { position: 1, title: 'Some Result', link: 'https://example.com', snippet: 'A snippet.' },
  ],
};

const emptySearchResponse = {
  search_metadata: { status: 'Success' },
  search_parameters: { q: 'nothing' },
};

// ── Tests ────────────────────────────────────────────────────────

describe('SerpApiClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── handleRequest ───────────────────────────────────────────

  describe('handleRequest', () => {
    it('should return formatted search results for a valid query', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: sampleSearchResponse });

      const result = await serpApiClient.handleRequest('what is TypeScript', 'search');

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.text).toContain('Search results for:');
      expect(result.data!.text).toContain('TypeScript');
      expect(result.data!.raw).toBeDefined();
    });

    it('should return error when query is empty', async () => {
      const result = await serpApiClient.handleRequest('', 'search');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No search query');
    });

    it('should return error when query is only whitespace', async () => {
      const result = await serpApiClient.handleRequest('   ', 'search');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No search query');
    });

    it('should return error when API key is not configured', async () => {
      (config.getSerpApiKey as jest.Mock).mockReturnValueOnce('');

      const result = await serpApiClient.handleRequest('test', 'search');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('should handle API errors gracefully', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('Network error'));

      const result = await serpApiClient.handleRequest('test', 'search');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('should pass correct parameters including locale to SerpAPI', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: minimalSearchResponse });

      await serpApiClient.handleRequest('my query', 'search');

      expect(mockInstance.get).toHaveBeenCalledWith('/search', {
        params: {
          engine: 'google',
          q: 'my query',
          api_key: 'test-serpapi-key',
          num: 5,
          hl: 'en',
          gl: 'us',
        },
        signal: undefined,
      });
    });

    it('should omit hl/gl when set to empty string', async () => {
      (config.getSerpApiHl as jest.Mock).mockReturnValueOnce('');
      (config.getSerpApiGl as jest.Mock).mockReturnValueOnce('');
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: minimalSearchResponse });

      await serpApiClient.handleRequest('my query', 'search');

      const params = mockInstance.get.mock.calls[0][1].params;
      expect(params).not.toHaveProperty('hl');
      expect(params).not.toHaveProperty('gl');
    });

    it('should forward AbortSignal to axios', async () => {
      const controller = new AbortController();
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: minimalSearchResponse });

      await serpApiClient.handleRequest('test query', 'search', controller.signal);

      expect(mockInstance.get).toHaveBeenCalledWith('/search', expect.objectContaining({
        signal: controller.signal,
      }));
    });

    it('should call fetchAIOverview when page_token is present and merge results', async () => {
      const searchDataWithToken = {
        ...minimalSearchResponse,
        ai_overview: {
          text_blocks: [{ snippet: 'Inline overview' }],
          page_token: 'abc123',
        },
      };
      const fullOverview = {
        ai_overview: {
          text_blocks: [
            { type: 'paragraph', snippet: 'Full AI Overview paragraph 1.' },
            { type: 'paragraph', snippet: 'Full AI Overview paragraph 2.' },
          ],
          references: [{ title: 'Ref', link: 'https://ref.com' }],
        },
      };
      mockInstance.get
        .mockResolvedValueOnce({ status: 200, data: searchDataWithToken })
        .mockResolvedValueOnce({ status: 200, data: fullOverview });

      const result = await serpApiClient.handleRequest('test', 'search');

      expect(mockInstance.get).toHaveBeenCalledTimes(2);
      // Second call should be the AI overview follow-up
      expect(mockInstance.get).toHaveBeenNthCalledWith(2, '/search', expect.objectContaining({
        params: expect.objectContaining({ engine: 'google_ai_overview', page_token: 'abc123' }),
      }));
      expect(result.success).toBe(true);
      expect(result.data!.text).toContain('Full AI Overview paragraph 1.');
    });

    it('should fall back to inline AI overview when fetchAIOverview fails', async () => {
      const searchDataWithToken = {
        ...minimalSearchResponse,
        ai_overview: {
          text_blocks: [{ snippet: 'Inline overview fallback' }],
          page_token: 'expired_token',
        },
      };
      mockInstance.get
        .mockResolvedValueOnce({ status: 200, data: searchDataWithToken })
        .mockRejectedValueOnce(new Error('Token expired'));

      const result = await serpApiClient.handleRequest('test', 'search');

      expect(result.success).toBe(true);
      // Should still contain the inline overview since follow-up failed gracefully
      expect(result.data!.text).toContain('Inline overview fallback');
    });
  });

  // ── formatSearchText ──────────────────────────────────────────

  describe('formatSearchText', () => {
    it('should format full results with all sections', () => {
      const text = serpApiClient.formatSearchText(sampleSearchResponse as any, 'what is TypeScript');

      expect(text).toContain('🔎 **Search results for:**');
      expect(text).toContain('📋 **Direct Answer:**');
      expect(text).toContain('TypeScript is a strongly typed');
      expect(text).toContain('📖 **TypeScript**');
      expect(text).toContain('*(Programming language)*');
      expect(text).toContain('🤖 **AI Overview:**');
      expect(text).toContain('📄 **Top Results:**');
      expect(text).toContain('[TypeScript: JavaScript With Syntax For Types]');
    });

    it('should handle results with only organic results', () => {
      const text = serpApiClient.formatSearchText(minimalSearchResponse as any, 'obscure query');

      expect(text).toContain('🔎 **Search results for:**');
      expect(text).toContain('Some Result');
      expect(text).not.toContain('📋 **Direct Answer:**');
      expect(text).not.toContain('📖 **');
      expect(text).not.toContain('🤖 **AI Overview:**');
    });

    it('should handle empty results gracefully', () => {
      const text = serpApiClient.formatSearchText(emptySearchResponse as any, 'nothing');

      expect(text).toContain('🔎 **Search results for:** *nothing*');
      // No organic results, no answer box, no knowledge graph
      expect(text).not.toContain('📄 **Top Results:**');
      expect(text).not.toContain('📋 **Direct Answer:**');
    });

    it('should include answer box link when available', () => {
      const text = serpApiClient.formatSearchText(sampleSearchResponse as any, 'test');

      expect(text).toContain('[Source](https://typescriptlang.org)');
    });

    it('should include knowledge graph source when available', () => {
      const text = serpApiClient.formatSearchText(sampleSearchResponse as any, 'test');

      expect(text).toContain('[Source: Wikipedia](https://en.wikipedia.org/wiki/TypeScript)');
    });
  });

  // ── formatSearchContextForAI ──────────────────────────────────

  describe('formatSearchContextForAI', () => {
    it('should format full results as XML', () => {
      const xml = serpApiClient.formatSearchContextForAI(sampleSearchResponse as any, 'what is TypeScript');

      expect(xml).toContain('<query>what is TypeScript</query>');
      expect(xml).toContain('<answer_box>');
      expect(xml).toContain('</answer_box>');
      expect(xml).toContain('<knowledge_graph>');
      expect(xml).toContain('</knowledge_graph>');
      expect(xml).toContain('<ai_overview>');
      expect(xml).toContain('</ai_overview>');
      expect(xml).toContain('<organic_results>');
      expect(xml).toContain('</organic_results>');
    });

    it('should escape XML special characters', () => {
      const response = {
        ...minimalSearchResponse,
        answer_box: {
          title: 'Test <&> "quotes"',
          answer: 'Answer with <html> & "entities"',
        },
      };

      const xml = serpApiClient.formatSearchContextForAI(response as any, 'test <query>');

      expect(xml).toContain('&lt;query&gt;');
      expect(xml).toContain('&lt;html&gt;');
      expect(xml).toContain('&amp;');
      expect(xml).toContain('&quot;');
    });

    it('should include organic results with position', () => {
      const xml = serpApiClient.formatSearchContextForAI(sampleSearchResponse as any, 'test');

      expect(xml).toContain('position="1"');
      expect(xml).toContain('<title>TypeScript: JavaScript With Syntax For Types</title>');
      expect(xml).toContain('<link>https://www.typescriptlang.org/</link>');
    });

    it('should include AI overview references', () => {
      const xml = serpApiClient.formatSearchContextForAI(sampleSearchResponse as any, 'test');

      expect(xml).toContain('<references>');
      expect(xml).toContain('title="TypeScript Docs"');
    });

    it('should handle minimal results without optional sections', () => {
      const xml = serpApiClient.formatSearchContextForAI(minimalSearchResponse as any, 'test');

      expect(xml).toContain('<query>test</query>');
      expect(xml).toContain('<organic_results>');
      expect(xml).not.toContain('<answer_box>');
      expect(xml).not.toContain('<knowledge_graph>');
      expect(xml).not.toContain('<ai_overview>');
    });
  });

  // ── formatAIOverviewOnly ───────────────────────────────────────

  describe('formatAIOverviewOnly', () => {
    it('should return only the AI Overview section with references', () => {
      const text = serpApiClient.formatAIOverviewOnly(sampleSearchResponse as any, 'what is TypeScript');

      expect(text).toContain('🔎 **Second opinion for:**');
      expect(text).toContain('🤖 **Google AI Overview:**');
      expect(text).toContain('TypeScript is a superset of JavaScript');
      expect(text).toContain('📚 **Sources:**');
      expect(text).toContain('[TypeScript Docs](https://typescriptlang.org/docs)');
      // Should NOT contain organic results or other sections
      expect(text).not.toContain('📋 **Direct Answer:**');
      expect(text).not.toContain('📖 **');
      expect(text).not.toContain('📄 **Top Results:**');
    });

    it('should return a helpful fallback when no AI Overview is available', () => {
      const text = serpApiClient.formatAIOverviewOnly(minimalSearchResponse as any, 'obscure query');

      expect(text).toContain('🔎 **Second opinion for:**');
      expect(text).toContain('⚠️ Google did not return an AI Overview');
      expect(text).toContain('search');
      expect(text).not.toContain('🤖 **Google AI Overview:**');
    });

    it('should handle empty AI overview text_blocks', () => {
      const data = {
        search_metadata: { status: 'Success' },
        ai_overview: { text_blocks: [] },
        organic_results: [{ position: 1, title: 'Test', link: 'https://example.com' }],
      };

      const text = serpApiClient.formatAIOverviewOnly(data as any, 'test');

      expect(text).toContain('⚠️ Google did not return an AI Overview');
    });

    it('should handle AI Overview without references', () => {
      const data = {
        search_metadata: { status: 'Success' },
        ai_overview: {
          text_blocks: [{ type: 'paragraph', snippet: 'Some overview text.' }],
        },
      };

      const text = serpApiClient.formatAIOverviewOnly(data as any, 'test');

      expect(text).toContain('🤖 **Google AI Overview:**');
      expect(text).toContain('Some overview text.');
      expect(text).not.toContain('📚 **Sources:**');
    });
  });

  // ── handleRequest with "second opinion" keyword ───────────────

  describe('handleRequest - second opinion keyword', () => {
    it('should use AI-Overview-only formatting for "second opinion" keyword', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: sampleSearchResponse });

      const result = await serpApiClient.handleRequest('what is TypeScript', 'second opinion');

      expect(result.success).toBe(true);
      expect(result.data!.text).toContain('🔎 **Second opinion for:**');
      expect(result.data!.text).toContain('🤖 **Google AI Overview:**');
      expect(result.data!.text).not.toContain('📄 **Top Results:**');
    });

    it('should return fallback message when no AI Overview for "second opinion"', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: minimalSearchResponse });

      const result = await serpApiClient.handleRequest('obscure topic', 'second opinion');

      expect(result.success).toBe(true);
      expect(result.data!.text).toContain('⚠️ Google did not return an AI Overview');
    });

    it('should use full formatting for "search" keyword', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: sampleSearchResponse });

      const result = await serpApiClient.handleRequest('what is TypeScript', 'search');

      expect(result.success).toBe(true);
      expect(result.data!.text).toContain('🔎 **Search results for:**');
      expect(result.data!.text).toContain('📄 **Top Results:**');
    });
  });

  // ── testConnection ────────────────────────────────────────────

  describe('testConnection', () => {
    it('should return healthy when API responds successfully', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: { search_metadata: { status: 'Success' } },
      });

      const result = await serpApiClient.testConnection();

      expect(result.healthy).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return unhealthy when API key is not configured', async () => {
      (config.getSerpApiKey as jest.Mock).mockReturnValueOnce('');

      const result = await serpApiClient.testConnection();

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('should return unhealthy on 401 error', async () => {
      const error: any = new Error('Unauthorized');
      error.isAxiosError = true;
      error.response = { status: 401 };
      mockInstance.get.mockRejectedValueOnce(error);
      (axios.isAxiosError as unknown as jest.Mock).mockReturnValueOnce(true);

      const result = await serpApiClient.testConnection();

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('Invalid API key');
    });

    it('should return unhealthy on 429 error', async () => {
      const error: any = new Error('Too many requests');
      error.isAxiosError = true;
      error.response = { status: 429 };
      mockInstance.get.mockRejectedValueOnce(error);
      (axios.isAxiosError as unknown as jest.Mock).mockReturnValueOnce(true);

      const result = await serpApiClient.testConnection();

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('Rate limit');
    });

    it('should return unhealthy on network error', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await serpApiClient.testConnection();

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('should use minimal params for test connection', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: { search_metadata: { status: 'Success' } },
      });

      await serpApiClient.testConnection();

      expect(mockInstance.get).toHaveBeenCalledWith('/search', {
        params: {
          engine: 'google',
          q: 'test',
          api_key: 'test-serpapi-key',
          num: 1,
        },
        timeout: 15000,
      });
    });
  });

  // ── isHealthy ─────────────────────────────────────────────────

  describe('isHealthy', () => {
    it('should return true when test connection is healthy', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: { search_metadata: { status: 'Success' } },
      });

      const healthy = await serpApiClient.isHealthy();
      expect(healthy).toBe(true);
    });

    it('should return false when test connection fails', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('fail'));

      const healthy = await serpApiClient.isHealthy();
      expect(healthy).toBe(false);
    });
  });

  // ── AI Overview extraction ────────────────────────────────────

  describe('AI Overview handling', () => {
    it('should extract snippets from nested text blocks', () => {
      const data = {
        search_metadata: { status: 'Success' },
        ai_overview: {
          text_blocks: [
            { type: 'paragraph', snippet: 'First paragraph.' },
            {
              type: 'list',
              list: [
                { snippet: 'List item 1' },
                { snippet: 'List item 2' },
              ],
            },
            { type: 'paragraph', snippet: 'Second paragraph.' },
          ],
        },
        organic_results: [],
      };

      const text = serpApiClient.formatSearchText(data as any, 'test');
      expect(text).toContain('🤖 **AI Overview:**');
      expect(text).toContain('First paragraph.');
      // Should be limited to maxSnippets (3 for Discord format)
    });

    it('should handle empty AI overview gracefully', () => {
      const data = {
        search_metadata: { status: 'Success' },
        ai_overview: { text_blocks: [] },
        organic_results: [{ position: 1, title: 'Test', link: 'https://example.com' }],
      };

      const text = serpApiClient.formatSearchText(data as any, 'test');
      expect(text).not.toContain('🤖 **AI Overview:**');
    });
  });

  // ── refresh ───────────────────────────────────────────────────

  describe('refresh', () => {
    it('should rebuild the axios instance', () => {
      serpApiClient.refresh();
      // refresh creates a new client via axios.create, which should be called
      expect(axios.create).toHaveBeenCalled();
    });
  });
});
