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

interface SerpApiAIOverviewTextBlock {
  type?: string;
  snippet?: string;
  title?: string;
  list?: SerpApiAIOverviewListItem[];
  text_blocks?: SerpApiAIOverviewTextBlock[];
  reference_indexes?: number[];
}

interface SerpApiAIOverviewListItem {
  snippet?: string;
  title?: string;
  text_blocks?: SerpApiAIOverviewTextBlock[];
  reference_indexes?: number[];
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
  answer_box?: SerpApiAnswerBox;
  knowledge_graph?: SerpApiKnowledgeGraph;
  ai_overview?: SerpApiAIOverview;
  organic_results?: SerpApiOrganicResult[];
}

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
   * Handle a search request dispatched by the API router.
   * Performs a Google Search via SerpAPI and returns formatted results.
   */
  async handleRequest(content: string, keyword: string, signal?: AbortSignal): Promise<SerpApiResponse> {
    const query = content.trim();
    if (!query) {
      return { success: false, error: 'No search query provided' };
    }

    const apiKey = config.getSerpApiKey();
    if (!apiKey) {
      return { success: false, error: 'SerpAPI key is not configured' };
    }

    try {
      logger.log('success', 'system', `SERPAPI: Searching "${query}" (keyword: ${keyword})`);
      const data = await this.googleSearch(query, apiKey, signal);

      // If the initial search includes a page_token for AI Overview,
      // attempt the follow-up call and merge the full overview data.
      if (data.ai_overview?.page_token) {
        const fullOverview = await this.fetchAIOverview(data.ai_overview.page_token, apiKey, signal);
        if (fullOverview) {
          data.ai_overview = fullOverview;
        }
      }

      // "second opinion" keyword returns only the AI Overview section.
      const isAIOverviewOnly = keyword === 'second opinion';
      const text = isAIOverviewOnly
        ? this.formatAIOverviewOnly(data, query)
        : this.formatSearchText(data, query);
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
  private async googleSearch(query: string, apiKey: string, signal?: AbortSignal): Promise<SerpApiSearchResponse> {
    const params: Record<string, string | number> = {
      engine: 'google',
      q: query,
      api_key: apiKey,
      num: 5,
    };

    // Inject locale params to improve AI Overview availability.
    // AI Overview is mainly returned for hl=en with limited gl values.
    const hl = config.getSerpApiHl();
    const gl = config.getSerpApiGl();
    if (hl) params.hl = hl;
    if (gl) params.gl = gl;

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
      const response = await this.client.get('/search', {
        params: {
          engine: 'google_ai_overview',
          page_token: pageToken,
          api_key: apiKey,
        },
        timeout: 15_000, // Shorter timeout — token expires quickly
        signal,
      });

      return response.data?.ai_overview ?? null;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.logWarn('serpapi', `AI Overview fetch failed (non-fatal): ${msg}`);
      return null;
    }
  }

  // ── Formatting: AI Overview only (second opinion) ──────────────

  /**
   * Format only the AI Overview section for "second opinion" responses.
   * Returns a user-friendly message when no AI Overview is available.
   */
  formatAIOverviewOnly(data: SerpApiSearchResponse, query: string): string {
    const parts: string[] = [];

    parts.push(`🔎 **Second opinion for:** *${query}*\n`);

    if (data.ai_overview?.text_blocks?.length) {
      const snippets = this.extractAIOverviewSnippets(data.ai_overview.text_blocks, 10);
      if (snippets.length > 0) {
        parts.push(`🤖 **Google AI Overview:**`);
        for (const s of snippets) {
          parts.push(`> ${s}`);
        }

        // Include references if available
        if (data.ai_overview.references?.length) {
          parts.push('');
          parts.push(`📚 **Sources:**`);
          for (const ref of data.ai_overview.references.slice(0, 5)) {
            const title = ref.title || 'Link';
            const link = ref.link || '';
            if (link) {
              parts.push(`- [${title}](${link})`);
            }
          }
        }
      }
    }

    // If we only have the header line, no AI Overview was found
    if (parts.length <= 1) {
      if (data.ai_overview?.error) {
        parts.push(`⚠️ Google AI Overview returned an error: ${data.ai_overview.error}`);
      } else {
        parts.push(`⚠️ Google did not return an AI Overview for this query.`);
      }
      parts.push(`This can happen when the topic is too niche, ambiguous, or not well-suited for an AI-generated summary.`);
      parts.push(`AI Overview availability is locale-dependent — ensure **SERPAPI_HL** and **SERPAPI_GL** are set (e.g. \`en\`/\`us\`).`);
      parts.push(`💡 *Tip: Try rephrasing your query or using the **search** keyword for full results.*`);
    }

    return parts.join('\n').trim();
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
   * Limits output to maxSnippets to keep context manageable.
   */
  private extractAIOverviewSnippets(
    blocks: SerpApiAIOverviewTextBlock[],
    maxSnippets: number
  ): string[] {
    const snippets: string[] = [];

    const walk = (items: SerpApiAIOverviewTextBlock[]): void => {
      for (const block of items) {
        if (snippets.length >= maxSnippets) return;

        if (block.snippet) {
          snippets.push(block.snippet);
        }

        // Recurse into lists
        if (block.list) {
          for (const item of block.list) {
            if (snippets.length >= maxSnippets) return;
            if (item.snippet) snippets.push(item.snippet);
            if (item.text_blocks) walk(item.text_blocks);
          }
        }

        // Recurse into nested text_blocks
        if (block.text_blocks) {
          walk(block.text_blocks);
        }
      }
    };

    walk(blocks);
    return snippets;
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

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

export const serpApiClient = new SerpApiClient();
