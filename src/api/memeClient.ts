import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { MemeTemplate, MemeResponse, MemeHealthResult } from '../types';

// ── Template cache types ─────────────────────────────────────────

interface TemplateCacheFile {
  /** ISO-8601 timestamp of when this cache was successfully downloaded. */
  downloadedAt: string;
  /** The full list of meme templates from the API. */
  templates: MemeTemplate[];
}

// ── Constants ────────────────────────────────────────────────────

/** How often to refresh templates (7 days in ms). */
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Path to the on-disk template cache. */
const CACHE_PATH = path.join(__dirname, '../../.config/meme-templates.json');

// ── Meme Client ──────────────────────────────────────────────────

class MemeClient {
  private client: AxiosInstance;
  private templates: MemeTemplate[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  private normalizeKeyword(keyword: string): string {
    const trimmed = keyword.trim().toLowerCase();
    return trimmed.startsWith('!') ? trimmed.slice(1) : trimmed;
  }

  private isTemplateListKeyword(keyword: string): boolean {
    const normalized = this.normalizeKeyword(keyword);
    return normalized === 'meme_templates' || normalized === 'meme_template';
  }

  private isMemeDebugEnabled(): boolean {
    return config.getMemeLoggingDebug();
  }

  constructor() {
    this.client = this.buildClient();
  }

  private buildClient(): AxiosInstance {
    return axios.create({
      baseURL: config.getMemeEndpoint(),
      timeout: 30_000,
    });
  }

  /**
   * Rebuild the axios instance with current config (called after config reload).
   */
  refresh(): void {
    this.client = this.buildClient();
  }

  // ── Template cache lifecycle ────────────────────────────────────

  /**
   * Initialise templates from disk or remote and start the recurring
   * refresh timer. Call once at application startup when MEME_ENABLED
   * is true.
   */
  async initialise(): Promise<void> {
    // Load from disk first (fast path)
    const diskCache = this.loadCacheFromDisk();

    if (diskCache) {
      this.templates = diskCache.templates;
      const age = Date.now() - new Date(diskCache.downloadedAt).getTime();
      logger.log('success', 'meme',
        `Loaded ${this.templates.length} meme templates from cache (age: ${Math.round(age / 3_600_000)}h)`);

      if (age >= REFRESH_INTERVAL_MS) {
        // Cache is stale — refresh in background
        logger.log('success', 'meme', 'Template cache is stale — refreshing from API');
        this.fetchAndCacheTemplates().catch((e) =>
          logger.logError('meme', `Background template refresh failed: ${e}`)
        );
      }
    } else {
      // No disk cache — must fetch before we can serve requests
      logger.log('success', 'meme', 'No template cache found — fetching from API');
      await this.fetchAndCacheTemplates();
    }

    // Start recurring refresh timer
    this.refreshTimer = setInterval(() => {
      logger.log('success', 'meme', 'Periodic template refresh triggered');
      this.fetchAndCacheTemplates().catch((e) =>
        logger.logError('meme', `Periodic template refresh failed: ${e}`)
      );
    }, REFRESH_INTERVAL_MS);
  }

  /**
   * Stop the recurring refresh timer. Call on application shutdown.
   */
  destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Fetch the full template list from the remote API and persist
   * to disk. Only replaces the local cache on a successful download.
   */
  async fetchAndCacheTemplates(): Promise<void> {
    const response = await this.client.get<MemeTemplate[]>('/templates');
    const templates = response.data;

    if (!Array.isArray(templates) || templates.length === 0) {
      throw new Error('Template response was empty or invalid');
    }

    this.templates = templates;

    const cacheData: TemplateCacheFile = {
      downloadedAt: new Date().toISOString(),
      templates,
    };

    // Ensure .config directory exists
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(CACHE_PATH, JSON.stringify(cacheData, null, 2), 'utf-8');
    logger.log('success', 'meme',
      `Cached ${templates.length} meme templates to disk`);
  }

  /**
   * Load the on-disk template cache, returning null when absent or
   * unparseable without throwing.
   */
  private loadCacheFromDisk(): TemplateCacheFile | null {
    try {
      if (!fs.existsSync(CACHE_PATH)) return null;
      const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
      const data: TemplateCacheFile = JSON.parse(raw);
      if (!Array.isArray(data.templates) || !data.downloadedAt) return null;
      return data;
    } catch {
      return null;
    }
  }

  // ── Template lookup ─────────────────────────────────────────────

  /**
   * Find a template by exact id or case-insensitive name substring.
   */
  findTemplate(query: string): MemeTemplate | undefined {
    const lower = query.toLowerCase().trim();
    // Exact id match first
    const byId = this.templates.find(t => t.id.toLowerCase() === lower);
    if (byId) return byId;
    // Exact name match
    const byName = this.templates.find(t => t.name.toLowerCase() === lower);
    if (byName) return byName;
    // Substring name match
    return this.templates.find(t => t.name.toLowerCase().includes(lower));
  }

  /**
   * Get the total number of cached templates.
   */
  get templateCount(): number {
    return this.templates.length;
  }

  /**
   * Return the template list formatted for LLM inference prompts.
   * Each line: `id: Human-Readable Name (N lines)`
   *
   * Returns an empty string when templates have not been loaded yet.
   */
  getTemplateListForInference(): string {
    if (this.templates.length === 0) return '';
    return this.templates
      .map(t => `${t.id}: ${t.name} (${t.lines} lines)`)
      .join('\n');
  }

  /**
   * Return a comma-separated string of all template ids.
   * Intended for the /meme_templates slash command and !meme_templates keyword.
   */
  getTemplateIds(): string {
    if (this.templates.length === 0) return '';
    return this.templates.map(t => t.id).join(', ');
  }

  // ── Meme generation ─────────────────────────────────────────────

  /**
   * Build the rendered meme image URL for the given template + text lines.
   * Special characters in text are URL-encoded per the memegen.link spec.
   */
  buildMemeUrl(templateId: string, textLines: string[]): string {
    const base = config.getMemeEndpoint();
    const encoded = textLines.map(line =>
      encodeURIComponent(line.replace(/ /g, '_').replace(/\?/g, '~q').replace(/%/g, '~p').replace(/#/g, '~h').replace(/\//g, '~s'))
    );
    // Pad empty slots with _ (blank) to respect the template's line count
    const slugs = encoded.length > 0 ? encoded.join('/') : '_';
    return `${base}/images/${templateId}/${slugs}.png`;
  }

  // ── Main request handler ────────────────────────────────────────

  /**
   * Handle a meme generation request.
   *
   * The input `content` is expected to contain a template identifier
   * and the meme text lines, inferred by the model. Formats accepted:
   *   - "drake | text top | text bottom"
   *   - "templateId top text / bottom text"
   *
   * If no template can be matched the request fails with a helpful error.
   */
  async handleRequest(content: string, _keyword: string, signal?: AbortSignal): Promise<MemeResponse> {
    if (!config.getMemeEnabled()) {
      return { success: false, error: 'Meme API is disabled (MEME_ENABLED=false)' };
    }

    if (this.isTemplateListKeyword(_keyword)) {
      const ids = this.getTemplateIds();
      return {
        success: true,
        data: {
          text: ids || 'No meme templates found',
        },
      };
    }

    if (this.templates.length === 0) {
      return { success: false, error: 'Meme templates have not been loaded yet. Please try again shortly.' };
    }

    try {
      if (this.isMemeDebugEnabled()) {
        logger.log('success', 'meme', `MEME-INFERENCE: Raw routed content: "${content}"`);
      }

      const parsed = this.parseInput(content);
      if (!parsed) {
        logger.logWarn('meme',
          `MEME-INFERENCE: Template lookup failed for input: "${content.substring(0, 200)}". ` +
          `Available templates (${this.templates.length}): ${this.templates.slice(0, 10).map(t => t.id).join(', ')}…`);
        return {
          success: false,
          error: `Could not identify a meme template from your prompt. Available templates include: ${this.templates.slice(0, 10).map(t => t.name).join(', ')}… (${this.templates.length} total)`,
        };
      }

      const { template, lines } = parsed;
      logger.log('success', 'meme',
        `MEME-INFERENCE: Matched template "${template.id}" (${template.name}) with ${lines.length} text line(s)`);
      if (this.isMemeDebugEnabled()) {
        logger.log('success', 'meme',
          `MEME-INFERENCE: Final parsed payload: template="${template.id}", lines=${JSON.stringify(lines)}`);
      }
      const imageUrl = this.buildMemeUrl(template.id, lines);

      // Validate the URL is reachable (HEAD request) with abort support
      await this.client.head(imageUrl, { signal });

      logger.log('success', 'meme',
        `MEME-INFERENCE: Generated meme URL: ${imageUrl}`);
      return {
        success: true,
        data: {
          text: `**${template.name}** meme`,
          imageUrl,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (signal?.aborted) {
        return { success: false, error: 'Request was cancelled' };
      }
      return { success: false, error: `Meme generation failed: ${msg}` };
    }
  }

  /**
   * Parse freeform input into a template + text lines.
   *
   * Supported separators: `|`, `/`, or newline.
   * The first segment is treated as a template query; subsequent segments
   * become the meme text lines.
   */
  parseInput(content: string): { template: MemeTemplate; lines: string[] } | null {
    // Try pipe-separated first, then slash-separated, then treat first phrase as template
    let parts: string[];
    if (content.includes('|')) {
      parts = content.split('|').map(s => s.trim()).filter(Boolean);
    } else if (content.includes('/')) {
      parts = content.split('/').map(s => s.trim()).filter(Boolean);
    } else if (content.includes('\n')) {
      parts = content.split('\n').map(s => s.trim()).filter(Boolean);
    } else {
      // Single string — try to split on first comma or just use whole thing
      parts = content.split(',').map(s => s.trim()).filter(Boolean);
    }

    if (parts.length === 0) return null;

    if (this.isMemeDebugEnabled()) {
      logger.log('success', 'meme', `MEME-INFERENCE: Parsed input segments: ${JSON.stringify(parts)}`);
    }

    const templateQuery = parts[0];
    const template = this.findTemplate(templateQuery);
    if (!template) {
      if (this.isMemeDebugEnabled()) {
        logger.log('success', 'meme', `MEME-INFERENCE: No template match for query "${templateQuery}"`);
      }
      return null;
    }

    const lines = parts.slice(1);

    // If no lines provided, use empty lines matching the template's expected line count
    if (lines.length === 0) {
      return { template, lines: Array(template.lines).fill('') };
    }

    return { template, lines };
  }

  // ── Health check ────────────────────────────────────────────────

  /**
   * Test connectivity to the memegen.link API.
   */
  async testConnection(): Promise<MemeHealthResult> {
    if (!config.getMemeEnabled()) {
      return { healthy: false, error: 'Meme API is disabled (MEME_ENABLED=false)' };
    }

    try {
      const response = await this.client.get<MemeTemplate[]>('/templates', { timeout: 10_000 });
      const count = Array.isArray(response.data) ? response.data.length : 0;
      return { healthy: true, templateCount: count };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { healthy: false, error: msg };
    }
  }
}

export const memeClient = new MemeClient();
