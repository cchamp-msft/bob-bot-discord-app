import axios, { AxiosInstance } from 'axios';
import * as dns from 'dns/promises';
import * as net from 'net';
import { load as cheerioLoad } from 'cheerio';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { serpApiClient } from './serpApiClient';
import { WebFetchResponse, WebFetchHealthResult } from '../types';

// ── Constants ─────────────────────────────────────────────────────

/** Content-types that are treated as text and extracted via cheerio. */
const TEXT_CONTENT_TYPES = new Set([
  'text/html',
  'text/plain',
  'application/json',
  'application/xhtml+xml',
  'application/xml',
  'text/xml',
]);

/** Content-types that are treated as images and base64-encoded. */
const IMAGE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Markers that indicate a captcha / bot challenge page. */
const CAPTCHA_MARKERS = [
  'recaptcha',
  'g-recaptcha',
  'cf-challenge',
  'cloudflare',
  'challenge-platform',
  'verify you are human',
  'please verify you are a human',
  'just a moment',
  'checking your browser',
  'hcaptcha',
];

/** CIDR-like checks for private/internal IPv4 ranges. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  // 127.0.0.0/8
  if (parts[0] === 127) return true;
  // 10.0.0.0/8
  if (parts[0] === 10) return true;
  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 169.254.0.0/16 (link-local)
  if (parts[0] === 169 && parts[1] === 254) return true;
  // 0.0.0.0
  if (parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0) return true;
  return false;
}

/** Check if an IPv6 address is private/internal. */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
  if (lower.startsWith('fe80')) return true; // fe80::/10
  return false;
}

// ── WebFetch Client ───────────────────────────────────────────────

class WebFetchClient {
  private client: AxiosInstance;

  constructor() {
    this.client = this.buildClient();
  }

  private buildClient(): AxiosInstance {
    return axios.create({
      timeout: config.getWebFetchTimeout(),
      maxRedirects: config.getWebFetchMaxRedirects(),
      headers: {
        'User-Agent': config.getWebFetchUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/png,*/*;q=0.8',
      },
      responseType: 'arraybuffer',
      // Don't throw on non-2xx so we can handle errors gracefully
      validateStatus: (status) => status < 500,
    });
  }

  refresh(): void {
    this.client = this.buildClient();
  }

  // ── Main request handler ────────────────────────────────────────

  async handleRequest(content: string, toolName: string, signal?: AbortSignal): Promise<WebFetchResponse> {
    const url = content.trim();

    if (!config.getWebFetchEnabled()) {
      return { success: false, error: 'Web fetch is disabled' };
    }

    // Layer 1: URL validation
    const urlValidation = this.validateUrl(url);
    if (urlValidation) {
      return { success: false, error: urlValidation };
    }

    // DNS pre-resolution for SSRF protection
    try {
      await this.checkDns(url);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg };
    }

    // Optional robots.txt check
    let robotsTxtNote: string | undefined;
    if (config.getWebFetchRobotsTxt()) {
      const robotsResult = await this.checkRobotsTxt(url);
      if (robotsResult.blocked) {
        logger.logWarn('webfetch', `robots.txt blocks ${url}: ${robotsResult.reason}`);
        robotsTxtNote = robotsResult.reason;
        // Fall back to search instead
        return this.fallbackToSearch(url, `Blocked by robots.txt: ${robotsResult.reason}`);
      }
      if (robotsResult.note) {
        robotsTxtNote = robotsResult.note;
      }
    }

    logger.log('success', 'system', `WEBFETCH: Fetching "${url}" (tool: ${toolName})`);

    try {
      const response = await this.client.get(url, { signal });

      // Layer 3: Response validation (content-type)
      const rawContentType = response.headers['content-type'] || '';
      const contentType = rawContentType.split(';')[0].trim().toLowerCase();

      // Check for HTTP errors that indicate blocking
      if (response.status === 403 || response.status === 401 || response.status === 429) {
        logger.logWarn('webfetch', `HTTP ${response.status} from ${url} — falling back to search`);
        return this.fallbackToSearch(url, `HTTP ${response.status} — access denied or rate limited`);
      }

      if (response.status >= 400) {
        return { success: false, error: `HTTP ${response.status} from ${url}` };
      }

      const buffer = Buffer.from(response.data);

      // Handle images
      if (IMAGE_CONTENT_TYPES.has(contentType)) {
        return this.processImage(buffer, url, contentType);
      }

      // Handle text content
      if (TEXT_CONTENT_TYPES.has(contentType)) {
        return this.processText(buffer, url, contentType, robotsTxtNote);
      }

      // Reject unsupported content types
      return { success: false, error: `Unsupported content type: ${contentType}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // Timeouts, network errors → fallback to search
      if (
        msg.includes('timeout') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('ECONNRESET') ||
        msg.includes('aborted')
      ) {
        logger.logWarn('webfetch', `Fetch failed for ${url}: ${msg} — falling back to search`);
        return this.fallbackToSearch(url, msg);
      }

      logger.logError('webfetch', `Fetch failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  // ── Layer 1: URL validation ─────────────────────────────────────

  /** Validate URL format and protocol. Returns error string or null if valid. */
  validateUrl(url: string): string | null {
    if (!url) return 'No URL provided';

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `Invalid URL: ${url}`;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `URL must use http:// or https:// protocol (got ${parsed.protocol})`;
    }

    // Block direct IP addresses in the URL that are private
    const hostname = parsed.hostname;
    if (net.isIPv4(hostname) && isPrivateIPv4(hostname)) {
      return 'URL points to a private/internal IP address (SSRF blocked)';
    }
    if (net.isIPv6(hostname) && isPrivateIPv6(hostname)) {
      return 'URL points to a private/internal IP address (SSRF blocked)';
    }

    return null;
  }

  /** DNS pre-resolution to block SSRF via hostname → private IP. */
  private async checkDns(url: string): Promise<void> {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Skip DNS check for direct IP addresses (already checked in validateUrl)
    if (net.isIPv4(hostname) || net.isIPv6(hostname)) return;

    try {
      const addresses = await dns.resolve(hostname);
      for (const addr of addresses) {
        if (isPrivateIPv4(addr)) {
          throw new Error(`URL hostname "${hostname}" resolves to private IP ${addr} (SSRF blocked)`);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('SSRF blocked')) throw error;
      // Also try resolve6
      try {
        const addresses6 = await dns.resolve6(hostname);
        for (const addr of addresses6) {
          if (isPrivateIPv6(addr)) {
            throw new Error(`URL hostname "${hostname}" resolves to private IPv6 ${addr} (SSRF blocked)`);
          }
        }
      } catch (err6) {
        if (err6 instanceof Error && err6.message.includes('SSRF blocked')) throw err6;
        // DNS resolution failure is not an SSRF issue — let the HTTP request handle it
      }
    }
  }

  // ── robots.txt checking ─────────────────────────────────────────

  private async checkRobotsTxt(url: string): Promise<{ blocked: boolean; reason?: string; note?: string }> {
    try {
      const parsed = new URL(url);
      const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;
      const response = await axios.get(robotsUrl, {
        timeout: 5000,
        responseType: 'text',
        headers: { 'User-Agent': config.getWebFetchUserAgent() },
        validateStatus: () => true,
      });

      if (response.status !== 200 || typeof response.data !== 'string') {
        return { blocked: false, note: 'robots.txt not found — proceeding' };
      }

      const robotsTxt = response.data as string;
      const path = parsed.pathname + parsed.search;
      const userAgent = config.getWebFetchUserAgent().split('/')[0].toLowerCase();

      // Simple robots.txt parser — checks User-agent: * and bot-specific sections
      const lines = robotsTxt.split('\n');
      let inRelevantSection = false;
      let hasDisallow = false;

      for (const rawLine of lines) {
        const line = rawLine.trim().toLowerCase();
        if (line.startsWith('user-agent:')) {
          const agent = line.substring('user-agent:'.length).trim();
          inRelevantSection = agent === '*' || agent === userAgent;
        } else if (inRelevantSection && line.startsWith('disallow:')) {
          const disallowed = line.substring('disallow:'.length).trim();
          if (disallowed && path.startsWith(disallowed)) {
            hasDisallow = true;
          }
        }
      }

      if (hasDisallow) {
        return { blocked: true, reason: `Path "${path}" is disallowed by robots.txt` };
      }

      return { blocked: false };
    } catch {
      // Fail open — if we can't check robots.txt, proceed
      return { blocked: false, note: 'robots.txt check failed — proceeding' };
    }
  }

  // ── Layer 3–4: Content processing ───────────────────────────────

  private async processText(buffer: Buffer, url: string, contentType: string, robotsTxtNote?: string): Promise<WebFetchResponse> {
    // Actual byte-size validation
    const maxTextSize = config.getWebFetchMaxTextSize();
    if (buffer.length > maxTextSize) {
      return { success: false, error: `Content too large: ${buffer.length} bytes (max ${maxTextSize})` };
    }

    const html = buffer.toString('utf-8');

    // Captcha detection
    const captchaResult = this.detectCaptcha(html);
    if (captchaResult) {
      logger.logWarn('webfetch', `Captcha detected on ${url}: ${captchaResult}`);
      return this.fallbackToSearch(url, `Captcha detected: ${captchaResult}`);
    }

    // Extract text content
    let text: string;
    let title: string | undefined;

    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
      const extracted = this.extractTextFromHtml(html);
      text = extracted.text;
      title = extracted.title;
    } else if (contentType === 'application/json') {
      try {
        const parsed = JSON.parse(html);
        text = JSON.stringify(parsed, null, 2);
      } catch {
        text = html;
      }
    } else {
      text = html;
    }

    // Truncate to max content chars
    const maxChars = config.getWebFetchMaxContentChars();
    if (text.length > maxChars) {
      text = text.substring(0, maxChars) + '\n\n[Content truncated — showing first ' + maxChars + ' characters]';
    }

    if (!text.trim()) {
      logger.logWarn('webfetch', `No extractable text from ${url} — falling back to search`);
      return this.fallbackToSearch(url, 'Page returned no extractable text content');
    }

    return {
      success: true,
      data: {
        text,
        url,
        contentType,
        title,
        robotsTxtNote,
      },
    };
  }

  private processImage(buffer: Buffer, url: string, contentType: string): WebFetchResponse {
    const maxImageSize = config.getWebFetchMaxImageSize();
    if (buffer.length > maxImageSize) {
      return { success: false, error: `Image too large: ${buffer.length} bytes (max ${maxImageSize})` };
    }

    // Validate magic bytes
    if (!this.validateImageMagicBytes(buffer, contentType)) {
      return { success: false, error: `Content does not match expected image format (${contentType})` };
    }

    const base64 = buffer.toString('base64');

    return {
      success: true,
      data: {
        text: `[Image fetched from ${url} (${contentType}, ${buffer.length} bytes)]`,
        url,
        contentType,
        imageBase64: base64,
      },
    };
  }

  // ── HTML text extraction ────────────────────────────────────────

  extractTextFromHtml(html: string): { text: string; title?: string } {
    const $ = cheerioLoad(html);

    // Strip dangerous/noisy elements
    $('script, style, iframe, object, embed, form, noscript, svg, nav, footer, header').remove();
    // Strip hidden elements
    $('[style*="display:none"], [style*="display: none"], [hidden]').remove();

    const title = $('title').first().text().trim() || undefined;

    // Try to find main content area
    let text = '';
    const mainSelectors = ['main', 'article', '[role="main"]', '.content', '.post-content', '.article-body', '.entry-content'];
    for (const selector of mainSelectors) {
      const el = $(selector).first();
      if (el.length > 0) {
        text = el.text();
        break;
      }
    }

    // Fall back to body
    if (!text.trim()) {
      text = $('body').text() || $.text();
    }

    // Clean up whitespace: collapse runs of whitespace to single spaces/newlines
    text = text
      .replace(/\t/g, ' ')
      .replace(/ +/g, ' ')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();

    return { text, title };
  }

  // ── Captcha detection ───────────────────────────────────────────

  private detectCaptcha(html: string): string | null {
    const lower = html.toLowerCase();
    for (const marker of CAPTCHA_MARKERS) {
      if (lower.includes(marker)) {
        return marker;
      }
    }
    return null;
  }

  // ── Image validation ────────────────────────────────────────────

  private validateImageMagicBytes(buffer: Buffer, contentType: string): boolean {
    if (buffer.length < 4) return false;
    switch (contentType) {
      case 'image/png':
        return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
      case 'image/jpeg':
        return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
      case 'image/gif':
        return buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46;
      case 'image/webp':
        return buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
          && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
      default:
        return true;
    }
  }

  // ── SerpAPI fallback ────────────────────────────────────────────

  private buildFallbackQuery(url: string): string {
    try {
      const parsed = new URL(url);
      // Use domain + path keywords as search query
      const pathParts = parsed.pathname
        .split('/')
        .filter(Boolean)
        .map((p) => p.replace(/[-_]/g, ' '))
        .filter((p) => p.length > 1 && !/^\d+$/.test(p));
      const domain = parsed.hostname.replace('www.', '');
      return [domain, ...pathParts.slice(0, 3)].join(' ');
    } catch {
      return url;
    }
  }

  private async fallbackToSearch(url: string, reason: string): Promise<WebFetchResponse> {
    logger.log('success', 'system', `WEBFETCH: Falling back to SerpAPI search for ${url} (reason: ${reason})`);

    const query = this.buildFallbackQuery(url);
    try {
      const searchResult = await serpApiClient.handleRequest(query, 'web_search');
      if (searchResult.success && searchResult.data?.text) {
        return {
          success: true,
          data: {
            text: searchResult.data.text,
            url,
            contentType: 'text/plain',
            fallbackUsed: true,
            fallbackReason: reason,
          },
        };
      }
    } catch (error) {
      logger.logWarn('webfetch', `SerpAPI fallback also failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      success: false,
      error: `Failed to fetch ${url}: ${reason}. Search fallback also failed.`,
    };
  }

  // ── Formatting for AI context ───────────────────────────────────

  formatContentForAI(response: WebFetchResponse): string {
    if (!response.data) return 'No content available.';

    const parts: string[] = [];
    parts.push(`<url>${this.escapeXml(response.data.url)}</url>`);
    if (response.data.title) {
      parts.push(`<title>${this.escapeXml(response.data.title)}</title>`);
    }
    parts.push(`<content_type>${this.escapeXml(response.data.contentType)}</content_type>`);
    if (response.data.fallbackUsed) {
      parts.push(`<fallback_used>true</fallback_used>`);
      if (response.data.fallbackReason) {
        parts.push(`<fallback_reason>${this.escapeXml(response.data.fallbackReason)}</fallback_reason>`);
      }
    }
    if (response.data.robotsTxtNote) {
      parts.push(`<robots_txt>${this.escapeXml(response.data.robotsTxtNote)}</robots_txt>`);
    }
    if (response.data.imageBase64) {
      parts.push(`<image_attached>true</image_attached>`);
    }
    parts.push(`<page_content>\n${this.escapeXml(response.data.text)}\n</page_content>`);

    return parts.join('\n');
  }

  // ── Health / connectivity ───────────────────────────────────────

  async testConnection(): Promise<WebFetchHealthResult> {
    if (!config.getWebFetchEnabled()) {
      return { healthy: false, error: 'Web fetch is disabled' };
    }

    try {
      const result = await this.handleRequest('https://example.com', 'health_check');
      return { healthy: result.success };
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

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

export const webFetchClient = new WebFetchClient();
