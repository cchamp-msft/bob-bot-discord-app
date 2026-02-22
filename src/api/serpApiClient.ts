import axios, { AxiosInstance } from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { SerpApiResponse, SerpApiHealthResult } from '../types';

// ── Internal types for SerpAPI JSON responses ────────────────────

interface SerpApiOrganicResult {
  position: number;
  title: string;
  link: string;
  snippet?: string;
}

interface SerpApiAnswerBox {
  type?: string;
  title?: string;
  answer?: string;
  snippet?: string;
  snippet_highlighted_words?: string[];
  link?: string;
}

interface SerpApiKnowledgeGraph {
  title?: string;
  type?: string;
  description?: string;
  source?: { name?: string; link?: string };
}

interface SerpApiAIOverviewTableCell {
  snippet?: string;
}

interface SerpApiAIOverviewComparison {
  feature?: string;
  values?: string[];
}

interface SerpApiAIOverviewTextBlock {
  type?: string;
  snippet?: string;
  title?: string;
  list?: SerpApiAIOverviewListItem[];
  text_blocks?: SerpApiAIOverviewTextBlock[];
  reference_indexes?: number[];
  /** Table flag — indicates the block contains tabular data (undocumented SerpAPI shape). */
  table?: unknown[][] | boolean;
  /** Detailed table rows, first row is the header (undocumented SerpAPI shape). */
  detailed?: SerpApiAIOverviewTableCell[][];
  /** Comparison items within expandable sections (undocumented SerpAPI shape). */
  comparison?: SerpApiAIOverviewComparison[];
}

interface SerpApiAIOverviewListItem {
  snippet?: string;
  title?: string;
  text_blocks?: SerpApiAIOverviewTextBlock[];
  reference_indexes?: number[];
  /** Nested lists within list items (undocumented SerpAPI shape). */
  list?: SerpApiAIOverviewListItem[];
}

interface SerpApiAIOverviewReference {
  title?: string;
  link?: string;
  snippet?: string;
  source?: string;
  index?: number;
}

interface SerpApiAIOverview {
  text_blocks?: SerpApiAIOverviewTextBlock[];
  references?: SerpApiAIOverviewReference[];
  /** Token to fetch full AI Overview via the google_ai_overview engine. Expires within 1 minute. */
  page_token?: string;
  /** Error message returned by SerpAPI when the AI Overview could not be generated. */
  error?: string;
  /** Debug link to the SerpAPI result page (useful for diagnosing overview failures). */
  serpapi_link?: string;
}

interface SerpApiSearchResponse {
  search_metadata?: { status?: string };
  search_parameters?: { q?: string };
  search_information?: Record<string, unknown>;
  answer_box?: SerpApiAnswerBox;
  knowledge_graph?: SerpApiKnowledgeGraph;
  ai_overview?: SerpApiAIOverview;
  organic_results?: SerpApiOrganicResult[];
  /** Index signature — generic blocks are accessed dynamically. */
  [key: string]: unknown;
}

/**
 * Keys to silently skip when generically formatting response blocks.
 * These are either metadata (not user-useful) or presentational noise.
 * Everything NOT in this set AND not handled by a dedicated formatter
 * will be rendered generically.
 */
const SKIP_RESPONSE_KEYS = new Set([
  'search_metadata',
  'search_parameters',
  'search_information',
  'pagination',
  'serpapi_pagination',
  'related_searches',
  'immersive_products',
  'refine_search_filters',
  'refine_this_search',
]);

// ── SerpAPI Client ────────────────────────────────────────────────

class SerpApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = this.buildClient();
  }

  private buildClient(): AxiosInstance {
    return axios.create({
      baseURL: config.getSerpApiEndpoint(),
      timeout: 30_000,
    });
  }

  /**
   * Rebuild the axios instance with current config (called after config reload).
   */
  refresh(): void {
    this.client = this.buildClient();
  }

  // ── Main request handler ────────────────────────────────────────

  /**
   * Handle a web_search request dispatched by the API router.
   * Performs a Google Search via SerpAPI and returns formatted results.
   */
  async handleRequest(content: string, toolName: string, signal?: AbortSignal): Promise<SerpApiResponse> {
    const query = content.trim();
    if (!query) {
      return { success: false, error: 'No search query provided' };
    }

    const apiKey = config.getSerpApiKey();
    if (!apiKey) {
      return { success: false, error: 'SerpAPI key is not configured' };
    }

    try {
      logger.log('success', 'system', `SERPAPI: Searching "${query}" (tool: ${toolName})`);
      const data = await this.googleSearch(query, apiKey, signal);

      // Log response shape for debugging AIO availability issues
      logger.logDebugLazy('serpapi', () => {
        const aio = data.ai_overview;
        const aioStatus = aio
          ? (aio.page_token ? 'page_token' : aio.error ? `error: ${aio.error}` : aio.text_blocks?.length ? `inline(${aio.text_blocks.length} blocks)` : 'empty')
          : 'absent';
        return `RESPONSE: status=${data.search_metadata?.status}, ai_overview=${aioStatus}, organics=${data.organic_results?.length ?? 0}`;
      });

      // Log full raw response body for deep diagnostics (secrets redacted at logger sink)
      logger.logDebugLazy('serpapi', () => {
        // Deep-clone and strip known secret-bearing fields before serialization
        const safe = { ...data, search_parameters: undefined };
        return `RAW RESPONSE BODY:\n${JSON.stringify(safe, null, 2)}`;
      });

      // If the initial search includes a page_token for AI Overview,
      // attempt the follow-up call and merge the full overview data.
      if (data.ai_overview?.page_token) {
        logger.logDebug('serpapi', `AI Overview requires follow-up (page_token present)`);
        const fullOverview = await this.fetchAIOverview(data.ai_overview.page_token, apiKey, signal);
        if (fullOverview) {
          data.ai_overview = fullOverview;
        }
      }

      const text = this.formatSearchText(data, query);
      return {
        success: true,
        data: { text, raw: data },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.logError('serpapi', `Search failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  // ── Google Search ─────────────────────────────────────────────

  /**
   * Execute a Google Search via SerpAPI.
   * Returns the parsed JSON response.
   */
  private async googleSearch(query: string, apiKey: string, signal?: AbortSignal, num = 5): Promise<SerpApiSearchResponse> {
    const params: Record<string, string | number> = {
      engine: 'google',
      q: query,
      api_key: apiKey,
      num,
    };

    // Inject locale params to improve AI Overview availability.
    // AI Overview is mainly returned for hl=en with limited gl values.
    // NOTE: `location` is supported by the Google Search API but NOT by
    // the Google AI Overview API. We include it here on the initial search
    // to help Google determine locale context for AIO eligibility.
    const hl = config.getSerpApiHl();
    const gl = config.getSerpApiGl();
    const location = config.getSerpApiLocation();
    if (hl) params.hl = hl;
    if (gl) params.gl = gl;
    if (location) params.location = location;

    // Log outbound request shape (redacted: api_key replaced)
    logger.logDebugLazy('serpapi', () => {
      const safeParams = { ...params, api_key: '***' };
      return `REQUEST: ${JSON.stringify(safeParams)}`;
    });

    const response = await this.client.get('/search', {
      params,
      signal,
    });

    return response.data as SerpApiSearchResponse;
  }

  /**
   * Fetch the full AI Overview via a dedicated request using the page_token.
   * The token expires within 1 minute of the original search, so this
   * should be called immediately after the search returns a page_token.
   *
   * Returns the AI Overview data, or null if the request fails or times out.
   */
  private async fetchAIOverview(pageToken: string, apiKey: string, signal?: AbortSignal): Promise<SerpApiAIOverview | null> {
    try {
      // The google_ai_overview engine only accepts page_token + api_key.
      // It does NOT support hl, gl, or location — those are inherited from
      // the original Google Search that produced the page_token.
      const params = {
        engine: 'google_ai_overview' as const,
        page_token: pageToken,
        api_key: apiKey,
      };

      logger.logDebugLazy('serpapi', () => {
        return `AIO-FOLLOWUP REQUEST: engine=${params.engine}, page_token=${pageToken.substring(0, 24)}...`;
      });

      const response = await this.client.get('/search', {
        params,
        timeout: 15_000, // Shorter timeout — token expires quickly
        signal,
      });

      const overview: SerpApiAIOverview | undefined = response.data?.ai_overview;

      logger.logDebugLazy('serpapi', () => {
        if (!overview) return 'AIO-FOLLOWUP RESPONSE: ai_overview absent';
        if (overview.error) return `AIO-FOLLOWUP RESPONSE: error=${overview.error}`;
        return `AIO-FOLLOWUP RESPONSE: text_blocks=${overview.text_blocks?.length ?? 0}, refs=${overview.references?.length ?? 0}`;
      });

      return overview ?? null;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.logWarn('serpapi', `AI Overview fetch failed (non-fatal): ${msg}`);
      return null;
    }
  }

  // ── Formatting: Discord-friendly text ─────────────────────────

  /**
   * Format search results as Discord-friendly Markdown.
   */
  formatSearchText(data: SerpApiSearchResponse, query: string): string {
    const parts: string[] = [];

    parts.push(`🔎 **Search results for:** *${query}*\n`);

    // Answer Box (direct answer)
    if (data.answer_box) {
      const ab = data.answer_box;
      const answer = ab.answer || ab.snippet || '';
      if (answer) {
        parts.push(`📋 **Direct Answer:**`);
        if (ab.title) parts.push(`> **${ab.title}**`);
        parts.push(`> ${answer}`);
        if (ab.link) parts.push(`> [Source](${ab.link})`);
        parts.push('');
      }
    }

    // Knowledge Graph
    if (data.knowledge_graph?.description) {
      const kg = data.knowledge_graph;
      parts.push(`📖 **${kg.title || 'Knowledge Graph'}**${kg.type ? ` *(${kg.type})*` : ''}`);
      parts.push(`> ${kg.description}`);
      if (kg.source?.link) parts.push(`> [Source: ${kg.source.name || 'Link'}](${kg.source.link})`);
      parts.push('');
    }

    // AI Overview (inline from search — summarized)
    if (data.ai_overview?.text_blocks?.length) {
      const snippets = this.extractAIOverviewSnippets(data.ai_overview.text_blocks, 3);
      if (snippets.length > 0) {
        parts.push(`🤖 **AI Overview:**`);
        for (const s of snippets) {
          parts.push(`> ${s}`);
        }
        parts.push('');
      }
    }

    // Generic iteration: render blocks not already handled above
    const extras = this.getExtraBlocks(data, ['answer_box', 'knowledge_graph', 'ai_overview', 'organic_results']);
    for (const key of extras) {
      const block = this.formatStructuredBlock(key, data[key]);
      if (block.length > 0) {
        parts.push(...block);
        parts.push('');
      }
    }

    // Organic Results (top 5)
    const organics = data.organic_results?.slice(0, 5) ?? [];
    if (organics.length > 0) {
      parts.push(`📄 **Top Results:**`);
      for (const result of organics) {
        const snippet = result.snippet ? ` — ${result.snippet}` : '';
        parts.push(`${result.position}. [${result.title}](${result.link})${snippet}`);
      }
    }

    return parts.join('\n').trim() || `No results found for "${query}".`;
  }

  // ── Formatting: AI context (XML) ──────────────────────────────

  /**
   * Format search results as XML-tagged context for Ollama final pass.
   */
  formatSearchContextForAI(data: SerpApiSearchResponse, query: string): string {
    const parts: string[] = [];

    parts.push(`<query>${this.escapeXml(query)}</query>`);

    // Answer Box
    if (data.answer_box) {
      const ab = data.answer_box;
      const answer = ab.answer || ab.snippet || '';
      if (answer) {
        parts.push(`<answer_box>`);
        if (ab.title) parts.push(`  <title>${this.escapeXml(ab.title)}</title>`);
        parts.push(`  <answer>${this.escapeXml(answer)}</answer>`);
        if (ab.link) parts.push(`  <source>${this.escapeXml(ab.link)}</source>`);
        parts.push(`</answer_box>`);
      }
    }

    // Knowledge Graph
    if (data.knowledge_graph?.description) {
      const kg = data.knowledge_graph;
      parts.push(`<knowledge_graph>`);
      if (kg.title) parts.push(`  <title>${this.escapeXml(kg.title)}</title>`);
      if (kg.type) parts.push(`  <type>${this.escapeXml(kg.type)}</type>`);
      parts.push(`  <description>${this.escapeXml(kg.description!)}</description>`);
      if (kg.source?.link) parts.push(`  <source>${this.escapeXml(kg.source.link)}</source>`);
      parts.push(`</knowledge_graph>`);
    }

    // AI Overview
    if (data.ai_overview?.text_blocks?.length) {
      parts.push(`<ai_overview>`);
      const snippets = this.extractAIOverviewSnippets(data.ai_overview.text_blocks, 5);
      for (const s of snippets) {
        parts.push(`  <snippet>${this.escapeXml(s)}</snippet>`);
      }
      if (data.ai_overview.references?.length) {
        parts.push(`  <references>`);
        for (const ref of data.ai_overview.references.slice(0, 5)) {
          parts.push(`    <ref title="${this.escapeXml(ref.title || '')}" link="${this.escapeXml(ref.link || '')}" />`);
        }
        parts.push(`  </references>`);
      }
      parts.push(`</ai_overview>`);
    }

    // Generic iteration: render any remaining blocks as XML
    const extras = this.getExtraBlocks(data, ['answer_box', 'knowledge_graph', 'ai_overview', 'organic_results']);
    for (const key of extras) {
      parts.push(...this.formatStructuredBlockXml(key, data[key]));
    }

    // Organic Results
    const organics = data.organic_results?.slice(0, 5) ?? [];
    if (organics.length > 0) {
      parts.push(`<organic_results>`);
      for (const r of organics) {
        parts.push(`  <result position="${r.position}">`);
        parts.push(`    <title>${this.escapeXml(r.title)}</title>`);
        parts.push(`    <link>${this.escapeXml(r.link)}</link>`);
        if (r.snippet) parts.push(`    <snippet>${this.escapeXml(r.snippet)}</snippet>`);
        parts.push(`  </result>`);
      }
      parts.push(`</organic_results>`);
    }

    return parts.join('\n');
  }

  // ── AI Overview helpers ───────────────────────────────────────

  /**
   * Recursively extract snippet text from AI Overview text_blocks.
   * Handles all known block types: paragraph, heading, list, expandable,
   * table, and comparison. Limits output to maxSnippets.
   */
  private extractAIOverviewSnippets(
    blocks: SerpApiAIOverviewTextBlock[],
    maxSnippets: number
  ): string[] {
    const snippets: string[] = [];

    const push = (text: string): boolean => {
      if (snippets.length >= maxSnippets) return false;
      snippets.push(text);
      return true;
    };

    const walk = (items: SerpApiAIOverviewTextBlock[]): void => {
      for (const block of items) {
        if (snippets.length >= maxSnippets) return;

        // Direct snippet (paragraph, heading, etc.)
        if (block.snippet) {
          push(block.snippet);
        }

        // Recurse into lists
        if (block.list) {
          for (const item of block.list) {
            if (snippets.length >= maxSnippets) return;
            if (item.snippet) push(item.snippet);
            // Nested lists within list items
            if (item.list) {
              for (const nested of item.list) {
                if (snippets.length >= maxSnippets) return;
                if (nested.snippet) push(nested.snippet);
              }
            }
            if (item.text_blocks) walk(item.text_blocks);
          }
        }

        // Table blocks — extract from the 'detailed' array or 'formatted'
        if (block.table && block.detailed) {
          for (const row of block.detailed.slice(1)) { // skip header row
            if (snippets.length >= maxSnippets) return;
            const cells = row.map((c: SerpApiAIOverviewTableCell) => c.snippet || '').filter(Boolean);
            if (cells.length) push(cells.join(' — '));
          }
        } else if (block.table && Array.isArray(block.table)) {
          // Fallback: raw table rows
          for (const row of (block.table as unknown[][]).slice(1)) {
            if (snippets.length >= maxSnippets) return;
            if (Array.isArray(row)) push(row.join(' — '));
          }
        }

        // Comparison blocks within expandable sections
        if (block.comparison) {
          for (const comp of block.comparison) {
            if (snippets.length >= maxSnippets) return;
            const vals = comp.values?.join(' vs ') || '';
            if (comp.feature && vals) push(`${comp.feature}: ${vals}`);
          }
        }

        // Recurse into nested text_blocks (expandable sections, etc.)
        if (block.text_blocks) {
          walk(block.text_blocks);
        }
      }
    };

    walk(blocks);
    return snippets;
  }

  // ── Embedded AI Overview discovery ────────────────────────────

  /**
   * Render a single AI Overview section (top-level or embedded) into parts.
   * Optionally includes a subtitle heading for embedded overviews.
   */
  private renderAIOverviewSection(
    parts: string[],
    overview: SerpApiAIOverview,
    subtitle: string | undefined,
    maxSnippets: number
  ): void {
    if (!overview.text_blocks?.length) return;

    const snippets = this.extractAIOverviewSnippets(overview.text_blocks, maxSnippets);
    if (snippets.length === 0) return;

    // Add section heading
    if (subtitle) {
      parts.push(`🤖 **AI Overview** — *${subtitle}*`);
    } else {
      parts.push(`🤖 **Google AI Overview:**`);
    }

    for (const s of snippets) {
      parts.push(`> ${s}`);
    }

    parts.push('');
  }

  /**
   * Recursively search the entire response object for embedded `ai_overview`
   * keys. Google sometimes nests AI Overview data inside other blocks
   * (e.g. knowledge_graph.types.<topic>.ai_overview).
   *
   * Skips the top-level `data.ai_overview` (already handled separately).
   * Returns an array of { subtitle, aiOverview } for each embedded occurrence,
   * where subtitle is the parent object's `subtitle` field (the topic question).
   */
  findEmbeddedAIOverviews(
    data: SerpApiSearchResponse
  ): Array<{ subtitle: string | undefined; aiOverview: SerpApiAIOverview }> {
    const results: Array<{ subtitle: string | undefined; aiOverview: SerpApiAIOverview }> = [];
    const seen = new Set<string>();
    const MAX_DEPTH = 10;

    const walk = (obj: unknown, depth: number, isTopLevel: boolean): void => {
      if (depth > MAX_DEPTH || obj === null || obj === undefined || typeof obj !== 'object') {
        return;
      }

      const record = obj as Record<string, unknown>;

      for (const key of Object.keys(record)) {
        const value = record[key];

        // Skip top-level ai_overview — it's handled separately
        if (isTopLevel && key === 'ai_overview') continue;

        if (key === 'ai_overview' && value && typeof value === 'object') {
          const overview = value as SerpApiAIOverview;
          if (overview.text_blocks?.length) {
            // Deduplicate by first snippet — Google sometimes nests the same
            // AI Overview at multiple paths (e.g. types + layering).
            const fingerprint = overview.text_blocks[0]?.snippet ?? '';
            if (!seen.has(fingerprint)) {
              seen.add(fingerprint);
              // Grab the sibling 'subtitle' from the parent object as context
              const subtitle = typeof record.subtitle === 'string' ? record.subtitle : undefined;
              results.push({ subtitle, aiOverview: overview });
            }
          }
        } else if (typeof value === 'object' && value !== null) {
          walk(value, depth + 1, false);
        }
      }
    };

    walk(data, 0, true);
    return results;
  }

  // ── Health / connectivity ───────────────────────────────────────

  /**
   * Test SerpAPI connectivity by performing a minimal search.
   */
  async testConnection(): Promise<SerpApiHealthResult> {
    const apiKey = config.getSerpApiKey();
    if (!apiKey) {
      return { healthy: false, error: 'SerpAPI key is not configured' };
    }

    try {
      const response = await this.client.get('/search', {
        params: {
          engine: 'google',
          q: 'test',
          api_key: apiKey,
          num: 1,
        },
        timeout: 15_000,
      });

      if (response.status === 200 && response.data?.search_metadata?.status === 'Success') {
        return { healthy: true };
      }

      return { healthy: false, error: 'Unexpected response from SerpAPI' };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        return { healthy: false, error: 'Invalid API key — authentication failed (HTTP 401)' };
      }
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        return { healthy: false, error: 'Rate limit exceeded — too many requests (HTTP 429)' };
      }
      return { healthy: false, error: errorMsg };
    }
  }

  /**
   * Simple boolean health check.
   */
  async isHealthy(): Promise<boolean> {
    const result = await this.testConnection();
    return result.healthy;
  }

  // ── Utility ─────────────────────────────────────────────────────

  /**
   * Return top-level response keys that should be generically formatted.
   * Filters out SKIP_RESPONSE_KEYS (metadata/noise) plus any additional
   * keys the caller already handles with dedicated formatters.
   */
  private getExtraBlocks(data: SerpApiSearchResponse, additionalSkips: string[] = []): string[] {
    const skip = new Set([...SKIP_RESPONSE_KEYS, ...additionalSkips]);
    return Object.keys(data).filter(
      (key) => !skip.has(key) && data[key] != null
    );
  }

  /**
   * Convert a snake_case key to a human-readable label.
   * e.g. "recipes_results" → "Recipes Results"
   */
  private humanizeKey(key: string): string {
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Generically format an arbitrary structured block for Discord Markdown.
   * Handles arrays of objects (extracts title/link/snippet), plain objects,
   * and primitive values. Limits arrays to 3 items.
   */
  private formatStructuredBlock(key: string, value: unknown): string[] {
    const parts: string[] = [];
    const label = this.humanizeKey(key);

    if (Array.isArray(value)) {
      parts.push(`📦 **${label}:**`);
      for (const item of value.slice(0, 3)) {
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>;
          const title = String(obj.title || obj.name || obj.question || '');
          const link = String(obj.link || obj.url || '');
          const snippet = String(obj.snippet || obj.description || obj.answer || '');

          if (title && link) {
            parts.push(`- [${title}](${link})${snippet ? ` — ${snippet}` : ''}`);
          } else if (title) {
            parts.push(`- **${title}**${snippet ? ` — ${snippet}` : ''}`);
          } else if (snippet) {
            parts.push(`- ${snippet}`);
          } else {
            const vals = Object.values(obj).filter((v) => typeof v === 'string').slice(0, 2);
            if (vals.length) parts.push(`- ${vals.join(' — ')}`);
          }
        } else {
          parts.push(`- ${String(item)}`);
        }
      }
      if (value.length > 3) {
        parts.push(`  *(${value.length - 3} more…)*`);
      }
    } else if (typeof value === 'object' && value !== null) {
      parts.push(`📦 **${label}:**`);
      const obj = value as Record<string, unknown>;
      if (obj.title || obj.description) {
        if (obj.title) parts.push(`> **${obj.title}**`);
        if (obj.description) parts.push(`> ${obj.description}`);
      } else {
        const entries = Object.entries(obj)
          .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
          .slice(0, 5);
        for (const [k, v] of entries) {
          parts.push(`> *${this.humanizeKey(k)}:* ${v}`);
        }
      }
    }

    return parts;
  }

  /**
   * Generically format an arbitrary structured block as XML for AI context.
   * Extracts scalar fields from objects/arrays; limits arrays to 3 items.
   */
  private formatStructuredBlockXml(key: string, value: unknown): string[] {
    const parts: string[] = [];
    parts.push(`<${key}>`);

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 3)) {
        if (typeof item === 'object' && item !== null) {
          parts.push(`  <item>`);
          for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
            if (typeof v === 'string' || typeof v === 'number') {
              parts.push(`    <${k}>${this.escapeXml(String(v))}</${k}>`);
            }
          }
          parts.push(`  </item>`);
        } else {
          parts.push(`  <item>${this.escapeXml(String(item))}</item>`);
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number') {
          parts.push(`  <${k}>${this.escapeXml(String(v))}</${k}>`);
        }
      }
    } else {
      parts.push(`  ${this.escapeXml(String(value))}`);
    }

    parts.push(`</${key}>`);
    return parts;
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

export const serpApiClient = new SerpApiClient();
