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
    getSerpApiLocation: jest.fn(() => ''),
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

const recipeSearchResponse = {
  search_metadata: { status: 'Success' },
  search_parameters: { q: 'best way to prepare a chuck roast' },
  recipes_results: [
    {
      title: 'Oven Braised Chuck Roast',
      link: 'https://example.com/chuck-roast',
      source: 'Hungry Paprikas',
      rating: 4.9,
      reviews: 138,
      total_time: '4 hr 40 min',
      ingredients: ['Chuck roast', 'apple cider vinegar', 'garlic'],
    },
    {
      title: 'Best Pot Roast',
      link: 'https://example.com/pot-roast',
      source: 'The Kitchn',
      total_time: '4 hr 30 min',
      ingredients: ['Beef chuck roast', 'red wine', 'beef broth'],
    },
  ],
  related_questions: [
    {
      question: 'How long should a chuck roast cook?',
      snippet: 'About 3-4 hours at 325°F.',
      link: 'https://example.com/faq',
    },
    {
      question: 'Should you sear a chuck roast first?',
      snippet: 'Yes, searing locks in flavor.',
    },
  ],
  organic_results: [
    { position: 1, title: 'Chuck Roast Guide', link: 'https://example.com/guide', snippet: 'A complete guide.' },
  ],
};

const responseWithUnhandledBlocks = {
  search_metadata: { status: 'Success' },
  search_parameters: { q: 'test' },
  organic_results: [
    { position: 1, title: 'Test', link: 'https://example.com' },
  ],
  top_stories: [
    { title: 'Breaking News', link: 'https://example.com/news' },
  ],
  local_results: {
    places: [{ title: 'Local Place' }],
  },
};

/** Fixture with skip-list keys that should be silently ignored. */
const responseWithSkippedKeys = {
  search_metadata: { status: 'Success' },
  search_parameters: { q: 'test' },
  organic_results: [
    { position: 1, title: 'Test', link: 'https://example.com' },
  ],
  immersive_products: [{ title: 'Product A' }],
  refine_search_filters: [{ label: 'By date' }],
  refine_this_search: [{ query: 'test refined' }],
  related_searches: [{ query: 'related test' }],
  pagination: { next: 'page2' },
  serpapi_pagination: { next: 'page2' },
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

    it('should include location when SERPAPI_LOCATION is set', async () => {
      (config.getSerpApiLocation as jest.Mock).mockReturnValueOnce('Austin,Texas');
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
          location: 'Austin,Texas',
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

    it('should omit location when SERPAPI_LOCATION is empty', async () => {
      (config.getSerpApiLocation as jest.Mock).mockReturnValueOnce('');
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: minimalSearchResponse });

      await serpApiClient.handleRequest('my query', 'search');

      const params = mockInstance.get.mock.calls[0][1].params;
      expect(params).not.toHaveProperty('location');
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

    it('should format recipe results generically via formatStructuredBlock', () => {
      const text = serpApiClient.formatSearchText(recipeSearchResponse as any, 'chuck roast');

      // Recipes are now rendered via the generic block formatter
      expect(text).toContain('📦 **Recipes Results:**');
      expect(text).toContain('[Oven Braised Chuck Roast](https://example.com/chuck-roast)');
      expect(text).toContain('[Best Pot Roast](https://example.com/pot-roast)');
    });

    it('should render unknown blocks generically instead of only logging', () => {
      const text = serpApiClient.formatSearchText(responseWithUnhandledBlocks as any, 'test');

      // top_stories and local_results should be rendered (not "not yet parsed")
      expect(text).toContain('📦 **Top Stories:**');
      expect(text).toContain('Breaking News');
      expect(text).toContain('📦 **Local Results:**');
    });

    it('should silently skip metadata and noise keys', () => {
      const text = serpApiClient.formatSearchText(responseWithSkippedKeys as any, 'test');

      expect(text).not.toContain('Immersive Products');
      expect(text).not.toContain('Refine Search');
      expect(text).not.toContain('Refine This');
      expect(text).not.toContain('Related Searches');
      expect(text).not.toContain('Pagination');
      expect(text).not.toContain('Serpapi Pagination');
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

    it('should format recipe results as generic XML blocks', () => {
      const xml = serpApiClient.formatSearchContextForAI(recipeSearchResponse as any, 'chuck roast');

      expect(xml).toContain('<recipes_results>');
      expect(xml).toContain('</recipes_results>');
      expect(xml).toContain('<title>Oven Braised Chuck Roast</title>');
      expect(xml).toContain('<link>https://example.com/chuck-roast</link>');
    });

    it('should format related questions as generic XML blocks', () => {
      const xml = serpApiClient.formatSearchContextForAI(recipeSearchResponse as any, 'chuck roast');

      expect(xml).toContain('<related_questions>');
      expect(xml).toContain('</related_questions>');
      expect(xml).toContain('<question>How long should a chuck roast cook?</question>');
      expect(xml).toContain('<snippet>About 3-4 hours');
    });

    it('should render unknown blocks as generic XML tags', () => {
      const xml = serpApiClient.formatSearchContextForAI(responseWithUnhandledBlocks as any, 'test');

      // Should use the actual key name as the XML tag
      expect(xml).toContain('<top_stories>');
      expect(xml).toContain('</top_stories>');
      expect(xml).toContain('<title>Breaking News</title>');
      expect(xml).toContain('<local_results>');
      expect(xml).toContain('</local_results>');
      // Should NOT use the old unhandled_blocks wrapper
      expect(xml).not.toContain('<unhandled_blocks>');
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

    it('should surface ai_overview.error in fallback message', () => {
      const data = {
        search_metadata: { status: 'Success' },
        ai_overview: {
          error: 'Content policy restriction',
        },
      };

      const text = serpApiClient.formatAIOverviewOnly(data as any, 'restricted query');

      expect(text).toContain('⚠️ Google AI Overview returned an error: Content policy restriction');
      expect(text).toContain('SERPAPI_HL');
      expect(text).not.toContain('🤖 **Google AI Overview:**');
    });

    it('should show generic fallback with locale guidance when no overview and no error', () => {
      const text = serpApiClient.formatAIOverviewOnly(minimalSearchResponse as any, 'obscure');

      expect(text).toContain('⚠️ Google did not return an AI Overview');
      expect(text).toContain('SERPAPI_HL');
      expect(text).toContain('SERPAPI_GL');
      expect(text).toContain('search');
    });

    it('should NOT render generic blocks (recipes, questions) — AI overview only', () => {
      const text = serpApiClient.formatAIOverviewOnly(recipeSearchResponse as any, 'chuck roast');

      // No AI overview exists, so should show fallback — NOT recipe/question blocks
      expect(text).not.toContain('📦 **Recipes Results:**');
      expect(text).not.toContain('📦 **Related Questions:**');
      expect(text).toContain('⚠️ Google did not return an AI Overview');
    });

    it('should NOT render unknown blocks generically', () => {
      const text = serpApiClient.formatAIOverviewOnly(responseWithUnhandledBlocks as any, 'test');

      expect(text).not.toContain('📦 **Top Stories:**');
      expect(text).not.toContain('📦 **Local Results:**');
      expect(text).toContain('⚠️ Google did not return an AI Overview');
    });

    it('should exclude organic_results from second opinion output', () => {
      const text = serpApiClient.formatAIOverviewOnly(responseWithUnhandledBlocks as any, 'test');

      expect(text).not.toContain('📄 **Top Results:**');
      expect(text).not.toContain('Organic Results');
    });

    it('should find embedded AI overview in knowledge_graph', () => {
      const data = {
        search_metadata: { status: 'Success' },
        knowledge_graph: {
          types: {
            subtitle: 'What are the different types?',
            ai_overview: {
              text_blocks: [
                { type: 'paragraph', snippet: 'There are several types to consider.' },
                { type: 'list', list: [{ snippet: 'Type A' }, { snippet: 'Type B' }] },
              ],
              references: [
                { title: 'Source One', link: 'https://example.com/one' },
              ],
            },
          },
        },
      };

      const text = serpApiClient.formatAIOverviewOnly(data as any, 'types of things');

      expect(text).toContain('🔎 **Second opinion for:**');
      expect(text).toContain('🤖 **AI Overview** — *What are the different types?*');
      expect(text).toContain('There are several types to consider.');
      expect(text).toContain('Type A');
      expect(text).toContain('📚 **Sources:**');
      expect(text).toContain('[Source One](https://example.com/one)');
      expect(text).not.toContain('⚠️ Google did not return an AI Overview');
    });

    it('should find multiple embedded AI overviews across topics', () => {
      const data = {
        search_metadata: { status: 'Success' },
        knowledge_graph: {
          topic_a: {
            subtitle: 'Question about A?',
            ai_overview: {
              text_blocks: [{ type: 'paragraph', snippet: 'Answer about A.' }],
              references: [],
            },
          },
          topic_b: {
            subtitle: 'Question about B?',
            ai_overview: {
              text_blocks: [{ type: 'paragraph', snippet: 'Answer about B.' }],
              references: [{ title: 'B Source', link: 'https://example.com/b' }],
            },
          },
        },
      };

      const text = serpApiClient.formatAIOverviewOnly(data as any, 'multi topic');

      expect(text).toContain('🤖 **AI Overview** — *Question about A?*');
      expect(text).toContain('Answer about A.');
      expect(text).toContain('🤖 **AI Overview** — *Question about B?*');
      expect(text).toContain('Answer about B.');
      expect(text).not.toContain('⚠️ Google did not return an AI Overview');
    });

    it('should prefer top-level AI overview over embedded when both exist', () => {
      const data = {
        search_metadata: { status: 'Success' },
        ai_overview: {
          text_blocks: [{ type: 'paragraph', snippet: 'Top-level overview.' }],
          references: [],
        },
        knowledge_graph: {
          types: {
            subtitle: 'What are the types?',
            ai_overview: {
              text_blocks: [{ type: 'paragraph', snippet: 'Embedded overview.' }],
              references: [],
            },
          },
        },
      };

      const text = serpApiClient.formatAIOverviewOnly(data as any, 'test');

      expect(text).toContain('🤖 **Google AI Overview:**');
      expect(text).toContain('Top-level overview.');
      // Should NOT render embedded when top-level is present
      expect(text).not.toContain('Embedded overview.');
    });

    it('should show fallback when embedded ai_overview has empty text_blocks', () => {
      const data = {
        search_metadata: { status: 'Success' },
        knowledge_graph: {
          types: {
            subtitle: 'Some question?',
            ai_overview: {
              text_blocks: [],
              references: [],
            },
          },
        },
      };

      const text = serpApiClient.formatAIOverviewOnly(data as any, 'test');

      expect(text).toContain('⚠️ Google did not return an AI Overview');
    });
  });

  // ── formatContentSearch ───────────────────────────────────────

  describe('formatContentSearch', () => {
    it('should format content with answer box, knowledge graph, and organic results', () => {
      const text = serpApiClient.formatContentSearch(sampleSearchResponse as any, 'what is TypeScript');

      expect(text).toContain('🔍 **Content found for:**');
      expect(text).toContain('📋 **Direct Answer:**');
      expect(text).toContain('TypeScript is a strongly typed programming language');
      expect(text).toContain('📖 **TypeScript**');
      expect(text).toContain('📄 **Top Results:**');
      expect(text).toContain('[TypeScript: JavaScript With Syntax For Types]');
      // Should NOT contain AI Overview — that's second opinion's domain
      expect(text).not.toContain('🤖 **AI Overview:**');
      expect(text).not.toContain('🤖 **Google AI Overview:**');
    });

    it('should render generic blocks (recipes, related questions)', () => {
      const text = serpApiClient.formatContentSearch(recipeSearchResponse as any, 'chuck roast');

      expect(text).toContain('📦 **Recipes Results:**');
      expect(text).toContain('[Oven Braised Chuck Roast]');
      expect(text).toContain('📦 **Related Questions:**');
      expect(text).toContain('How long should a chuck roast cook?');
      expect(text).toContain('📄 **Top Results:**');
    });

    it('should render unknown blocks generically', () => {
      const text = serpApiClient.formatContentSearch(responseWithUnhandledBlocks as any, 'test');

      expect(text).toContain('📦 **Top Stories:**');
      expect(text).toContain('Breaking News');
      expect(text).toContain('📦 **Local Results:**');
      expect(text).toContain('📄 **Top Results:**');
    });

    it('should silently skip noise keys', () => {
      const text = serpApiClient.formatContentSearch(responseWithSkippedKeys as any, 'test');

      expect(text).not.toContain('Immersive Products');
      expect(text).not.toContain('Refine Search');
      expect(text).not.toContain('Pagination');
    });

    it('should return fallback when no content is found', () => {
      const text = serpApiClient.formatContentSearch(emptySearchResponse as any, 'nothing');

      expect(text).toContain('No content found for "nothing".');
    });

    it('should handle results with only organic results', () => {
      const text = serpApiClient.formatContentSearch(minimalSearchResponse as any, 'obscure query');

      expect(text).toContain('🔍 **Content found for:**');
      expect(text).toContain('📄 **Top Results:**');
      expect(text).toContain('[Some Result]');
    });
  });

  // ── findEmbeddedAIOverviews ────────────────────────────────────

  describe('findEmbeddedAIOverviews', () => {
    it('should find ai_overview nested in knowledge_graph', () => {
      const data = {
        knowledge_graph: {
          types: {
            subtitle: 'What are the types?',
            ai_overview: {
              text_blocks: [{ type: 'paragraph', snippet: 'Found it.' }],
              references: [],
            },
          },
        },
      };

      const results = serpApiClient.findEmbeddedAIOverviews(data as any);

      expect(results).toHaveLength(1);
      expect(results[0].subtitle).toBe('What are the types?');
      expect(results[0].aiOverview.text_blocks![0].snippet).toBe('Found it.');
    });

    it('should skip top-level ai_overview', () => {
      const data = {
        ai_overview: {
          text_blocks: [{ type: 'paragraph', snippet: 'Top level.' }],
        },
      };

      const results = serpApiClient.findEmbeddedAIOverviews(data as any);

      expect(results).toHaveLength(0);
    });

    it('should find multiple embedded overviews', () => {
      const data = {
        knowledge_graph: {
          topic_a: {
            subtitle: 'Question A?',
            ai_overview: {
              text_blocks: [{ type: 'paragraph', snippet: 'Answer A.' }],
            },
          },
          topic_b: {
            subtitle: 'Question B?',
            ai_overview: {
              text_blocks: [{ type: 'paragraph', snippet: 'Answer B.' }],
            },
          },
        },
      };

      const results = serpApiClient.findEmbeddedAIOverviews(data as any);

      expect(results).toHaveLength(2);
      expect(results.map(r => r.subtitle)).toEqual(['Question A?', 'Question B?']);
    });

    it('should return empty array when no embedded overviews exist', () => {
      const results = serpApiClient.findEmbeddedAIOverviews(minimalSearchResponse as any);

      expect(results).toHaveLength(0);
    });

    it('should skip embedded ai_overview with empty text_blocks', () => {
      const data = {
        knowledge_graph: {
          types: {
            subtitle: 'Empty?',
            ai_overview: {
              text_blocks: [],
            },
          },
        },
      };

      const results = serpApiClient.findEmbeddedAIOverviews(data as any);

      expect(results).toHaveLength(0);
    });

    it('should capture subtitle from parent object', () => {
      const data = {
        some_block: {
          nested: {
            subtitle: 'How does it work?',
            ai_overview: {
              text_blocks: [{ snippet: 'It works like this.' }],
            },
          },
        },
      };

      const results = serpApiClient.findEmbeddedAIOverviews(data as any);

      expect(results).toHaveLength(1);
      expect(results[0].subtitle).toBe('How does it work?');
    });

    it('should handle missing subtitle gracefully', () => {
      const data = {
        some_block: {
          nested: {
            ai_overview: {
              text_blocks: [{ snippet: 'No subtitle here.' }],
            },
          },
        },
      };

      const results = serpApiClient.findEmbeddedAIOverviews(data as any);

      expect(results).toHaveLength(1);
      expect(results[0].subtitle).toBeUndefined();
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

    it('should merge full AI Overview via page_token and format as AI-Overview-only for "second opinion"', async () => {
      const searchDataWithToken = {
        ...minimalSearchResponse,
        ai_overview: {
          text_blocks: [{ snippet: 'Inline overview' }],
          page_token: 'token_for_second_opinion',
        },
      };
      const fullOverview = {
        ai_overview: {
          text_blocks: [
            { type: 'paragraph', snippet: 'Full AI Overview from follow-up.' },
          ],
          references: [{ title: 'Source', link: 'https://source.example.com' }],
        },
      };
      mockInstance.get
        .mockResolvedValueOnce({ status: 200, data: searchDataWithToken })
        .mockResolvedValueOnce({ status: 200, data: fullOverview });

      const result = await serpApiClient.handleRequest('test topic', 'second opinion');

      expect(mockInstance.get).toHaveBeenCalledTimes(2);
      expect(mockInstance.get).toHaveBeenNthCalledWith(2, '/search', expect.objectContaining({
        params: expect.objectContaining({ engine: 'google_ai_overview', page_token: 'token_for_second_opinion' }),
      }));
      expect(result.success).toBe(true);
      expect(result.data!.text).toContain('🔎 **Second opinion for:**');
      expect(result.data!.text).toContain('Full AI Overview from follow-up.');
      expect(result.data!.text).toContain('📚 **Sources:**');
      expect(result.data!.text).toContain('[Source](https://source.example.com)');
      // Should NOT contain organic/answer-box content
      expect(result.data!.text).not.toContain('📄 **Top Results:**');
    });

    it('should show AI Overview error message when ai_overview.error is present', async () => {
      const errorOverviewResponse = {
        search_metadata: { status: 'Success' },
        search_parameters: { q: 'restricted topic' },
        ai_overview: {
          error: 'AI Overview is not available for this query.',
        },
        organic_results: [
          { position: 1, title: 'Result', link: 'https://example.com', snippet: 'A snippet.' },
        ],
      };
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: errorOverviewResponse });

      const result = await serpApiClient.handleRequest('restricted topic', 'second opinion');

      expect(result.success).toBe(true);
      expect(result.data!.text).toContain('⚠️ Google AI Overview returned an error');
      expect(result.data!.text).toContain('AI Overview is not available for this query.');
      expect(result.data!.text).toContain('SERPAPI_HL');
      expect(result.data!.text).toContain('SERPAPI_GL');
    });

    it('should include locale guidance in fallback when no AI Overview is available', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: minimalSearchResponse });

      const result = await serpApiClient.handleRequest('obscure topic', 'second opinion');

      expect(result.success).toBe(true);
      expect(result.data!.text).toContain('SERPAPI_HL');
      expect(result.data!.text).toContain('SERPAPI_GL');
    });

    it('should find embedded AI overview for "second opinion" when top-level is absent', async () => {
      const dataWithEmbedded = {
        search_metadata: { status: 'Success' },
        search_parameters: { q: 'best lasagna' },
        knowledge_graph: {
          types: {
            subtitle: 'What are the different types of lasagna?',
            ai_overview: {
              text_blocks: [
                { type: 'paragraph', snippet: 'Lasagna types vary significantly by region.' },
              ],
              references: [
                { title: 'Serious Eats', link: 'https://www.seriouseats.com/lasagna' },
              ],
            },
          },
        },
        organic_results: [
          { position: 1, title: 'Easy Lasagna', link: 'https://example.com/lasagna' },
        ],
      };
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: dataWithEmbedded });

      const result = await serpApiClient.handleRequest('best lasagna', 'second opinion');

      expect(result.success).toBe(true);
      expect(result.data!.text).toContain('🤖 **AI Overview** — *What are the different types of lasagna?*');
      expect(result.data!.text).toContain('Lasagna types vary significantly by region.');
      expect(result.data!.text).toContain('[Serious Eats](https://www.seriouseats.com/lasagna)');
      // Should NOT contain organic results or generic blocks
      expect(result.data!.text).not.toContain('📄 **Top Results:**');
      expect(result.data!.text).not.toContain('⚠️ Google did not return an AI Overview');
    });
  });

  // ── handleRequest with "find content" keyword ──────────────────

  describe('handleRequest - find content keyword', () => {
    it('should use content search formatting for "find content" keyword', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: sampleSearchResponse });

      const result = await serpApiClient.handleRequest('what is TypeScript', 'find content');

      expect(result.success).toBe(true);
      expect(result.data!.text).toContain('🔍 **Content found for:**');
      expect(result.data!.text).toContain('📋 **Direct Answer:**');
      expect(result.data!.text).toContain('📄 **Top Results:**');
      expect(result.data!.text).not.toContain('🤖 **AI Overview:**');
      expect(result.data!.text).not.toContain('🤖 **Google AI Overview:**');
    });

    it('should return content with recipes and organic results for "find content"', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: recipeSearchResponse });

      const result = await serpApiClient.handleRequest('chuck roast', 'find content');

      expect(result.success).toBe(true);
      expect(result.data!.text).toContain('🔍 **Content found for:**');
      expect(result.data!.text).toContain('📦 **Recipes Results:**');
      expect(result.data!.text).toContain('📄 **Top Results:**');
    });

    it('should return fallback for empty results with "find content"', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: emptySearchResponse });

      const result = await serpApiClient.handleRequest('nothing', 'find content');

      expect(result.success).toBe(true);
      expect(result.data!.text).toContain('No content found for "nothing".');
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

    it('should extract snippets from expandable sections', () => {
      const data = {
        search_metadata: { status: 'Success' },
        ai_overview: {
          text_blocks: [
            { type: 'paragraph', snippet: 'Top level summary.' },
            {
              type: 'expandable',
              title: 'Detailed section',
              text_blocks: [
                { type: 'paragraph', snippet: 'Expanded detail paragraph.' },
                {
                  type: 'list',
                  list: [
                    { snippet: 'Expanded list item 1' },
                    { snippet: 'Expanded list item 2' },
                  ],
                },
              ],
            },
          ],
        },
        organic_results: [],
      };

      const text = serpApiClient.formatAIOverviewOnly(data as any, 'test');
      expect(text).toContain('Top level summary.');
      expect(text).toContain('Expanded detail paragraph.');
      expect(text).toContain('Expanded list item 1');
    });

    it('should extract snippets from table blocks using detailed array', () => {
      const data = {
        search_metadata: { status: 'Success' },
        ai_overview: {
          text_blocks: [
            {
              type: 'table',
              table: [
                ['Feature', 'Description'],
                ['Speed', 'Very fast'],
                ['Size', 'Compact'],
              ],
              detailed: [
                [{ snippet: 'Feature' }, { snippet: 'Description' }],
                [{ snippet: 'Speed' }, { snippet: 'Very fast' }],
                [{ snippet: 'Size' }, { snippet: 'Compact' }],
              ],
            },
          ],
        },
        organic_results: [],
      };

      const text = serpApiClient.formatAIOverviewOnly(data as any, 'test');
      expect(text).toContain('Speed — Very fast');
      expect(text).toContain('Size — Compact');
      // Header row should be skipped
      expect(text).not.toContain('Feature — Description');
    });

    it('should extract snippets from raw table when detailed is absent', () => {
      const data = {
        search_metadata: { status: 'Success' },
        ai_overview: {
          text_blocks: [
            {
              type: 'table',
              table: [
                ['Header1', 'Header2'],
                ['CellA', 'CellB'],
              ],
            },
          ],
        },
        organic_results: [],
      };

      const text = serpApiClient.formatAIOverviewOnly(data as any, 'test');
      expect(text).toContain('CellA — CellB');
    });

    it('should extract snippets from comparison blocks', () => {
      const data = {
        search_metadata: { status: 'Success' },
        ai_overview: {
          text_blocks: [
            { type: 'paragraph', snippet: 'Comparing devices.' },
            {
              type: 'expandable',
              title: 'Camera',
              text_blocks: [
                {
                  type: 'comparison',
                  product_labels: ['Phone A', 'Phone B'],
                  comparison: [
                    { feature: 'Resolution', values: ['12 MP', '48 MP'] },
                    { feature: 'Zoom', values: ['2x', '5x'] },
                  ],
                },
              ],
            },
          ],
        },
        organic_results: [],
      };

      const text = serpApiClient.formatAIOverviewOnly(data as any, 'test');
      expect(text).toContain('Comparing devices.');
      expect(text).toContain('Resolution: 12 MP vs 48 MP');
      expect(text).toContain('Zoom: 2x vs 5x');
    });

    it('should extract snippets from nested lists within list items', () => {
      const data = {
        search_metadata: { status: 'Success' },
        ai_overview: {
          text_blocks: [
            {
              type: 'list',
              list: [
                {
                  snippet: 'Parent item',
                  list: [
                    { snippet: 'Nested child A' },
                    { snippet: 'Nested child B' },
                  ],
                },
              ],
            },
          ],
        },
        organic_results: [],
      };

      const text = serpApiClient.formatAIOverviewOnly(data as any, 'test');
      expect(text).toContain('Parent item');
      expect(text).toContain('Nested child A');
      expect(text).toContain('Nested child B');
    });

    it('should not extract content from heading-only blocks beyond snippet', () => {
      const data = {
        search_metadata: { status: 'Success' },
        ai_overview: {
          text_blocks: [
            { type: 'heading', snippet: 'Section title' },
            { type: 'paragraph', snippet: 'Body text.' },
          ],
        },
        organic_results: [],
      };

      const text = serpApiClient.formatAIOverviewOnly(data as any, 'test');
      expect(text).toContain('Section title');
      expect(text).toContain('Body text.');
    });
  });

  // ── Debug logging for SerpAPI ─────────────────────────────────

  describe('SerpAPI debug logging', () => {
    it('should log redacted request params via logDebugLazy', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: sampleSearchResponse });
      const { logger: mockLogger } = require('../src/utils/logger');

      await serpApiClient.handleRequest('test query', 'search');

      // logDebugLazy should have been called for request params
      expect(mockLogger.logDebugLazy).toHaveBeenCalled();
      // Verify the lazy builder produces the expected shape
      const calls = mockLogger.logDebugLazy.mock.calls;
      const requestCall = calls.find((c: any[]) => {
        if (typeof c[1] === 'function') {
          const output = c[1]();
          return output.includes('REQUEST:') && output.includes('***');
        }
        return false;
      });
      expect(requestCall).toBeDefined();
    });

    it('should log response shape with ai_overview status', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: sampleSearchResponse });
      const { logger: mockLogger } = require('../src/utils/logger');

      await serpApiClient.handleRequest('test query', 'search');

      const calls = mockLogger.logDebugLazy.mock.calls;
      const responseCall = calls.find((c: any[]) => {
        if (typeof c[1] === 'function') {
          const output = c[1]();
          return output.includes('RESPONSE:');
        }
        return false;
      });
      expect(responseCall).toBeDefined();
      // ai_overview with inline text_blocks should be reported
      const output = responseCall![1]();
      expect(output).toContain('inline(');
    });

    it('should log full raw response body via logDebugLazy', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: sampleSearchResponse });
      const { logger: mockLogger } = require('../src/utils/logger');

      await serpApiClient.handleRequest('test query', 'search');

      const calls = mockLogger.logDebugLazy.mock.calls;
      const rawCall = calls.find((c: any[]) => {
        if (typeof c[1] === 'function') {
          const output = c[1]();
          return output.includes('RAW RESPONSE BODY:');
        }
        return false;
      });
      expect(rawCall).toBeDefined();
      const output = rawCall![1]();
      // Should contain the full JSON-serialized response
      expect(output).toContain('organic_results');
      expect(output).toContain('search_metadata');
    });

    it('should log page_token follow-up request', async () => {
      const searchDataWithToken = {
        ...minimalSearchResponse,
        ai_overview: {
          text_blocks: [{ snippet: 'Inline' }],
          page_token: 'follow_up_token_123',
        },
      };
      const fullOverview = {
        ai_overview: {
          text_blocks: [{ type: 'paragraph', snippet: 'Full text.' }],
          references: [],
        },
      };
      mockInstance.get
        .mockResolvedValueOnce({ status: 200, data: searchDataWithToken })
        .mockResolvedValueOnce({ status: 200, data: fullOverview });
      const { logger: mockLogger } = require('../src/utils/logger');

      await serpApiClient.handleRequest('test', 'second opinion');

      // Should have follow-up debug log
      expect(mockLogger.logDebug).toHaveBeenCalledWith(
        'serpapi',
        expect.stringContaining('page_token present'),
      );
      // Should have AIO follow-up request log via logDebugLazy
      const calls = mockLogger.logDebugLazy.mock.calls;
      const followUpCall = calls.find((c: any[]) => {
        if (typeof c[1] === 'function') {
          const output = c[1]();
          return output.includes('AIO-FOLLOWUP');
        }
        return false;
      });
      expect(followUpCall).toBeDefined();
    });

    it('should log api_key as redacted *** in request output', async () => {
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: minimalSearchResponse });
      const { logger: mockLogger } = require('../src/utils/logger');

      await serpApiClient.handleRequest('test', 'search');

      const calls = mockLogger.logDebugLazy.mock.calls;
      const requestCall = calls.find((c: any[]) => {
        if (typeof c[1] === 'function') {
          const output = c[1]();
          return output.includes('REQUEST:');
        }
        return false;
      });
      expect(requestCall).toBeDefined();
      const output = requestCall![1]();
      expect(output).toContain('***');
      expect(output).not.toContain('test-serpapi-key');
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
