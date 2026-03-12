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

/** Hostnames that always resolve locally and must be blocked. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

/** TLD suffixes that resolve to link-local/internal infrastructure. */
const BLOCKED_TLD_SUFFIXES = ['.local', '.internal', '.localdomain', '.localhost'];

/** Check whether a hostname should be blocked before DNS resolution. */
function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) return true;
  return BLOCKED_TLD_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Comprehensive reserved/private IPv4 check.
 * Covers RFC 1918, loopback, link-local, CGNAT, documentation, benchmarking,
 * multicast, and broadcast ranges.
 */
function isReservedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 0) return true;                              // 0.0.0.0/8   (this network)
  if (a === 10) return true;                             // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true;     // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true;                            // 127.0.0.0/8
  if (a === 169 && b === 254) return true;               // 169.254.0.0/16 (link-local)
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true;               // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true;  // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && parts[2] === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && parts[2] === 113) return true;  // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true;                             // 224.0.0.0+ (multicast & reserved)
  return false;
}

/**
 * Comprehensive reserved/private IPv6 check.
 * Covers loopback, ULA, link-local, IPv4-mapped private, and unspecified.
 */
function isReservedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;  // fc00::/7 ULA
  if (lower.startsWith('fe80')) return true;                          // fe80::/10 link-local
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.substring('::ffff:'.length);
    if (net.isIPv4(mapped) && isReservedIPv4(mapped)) return true;
  }
  return false;
}

// ── WebFetch Client ───────────────────────────────────────────────

class WebFetchClient {
  private client: AxiosInstance;

  constructor() {
    this.client = this.buildClient();
  }

  private buildClient(): AxiosInstance {
    const maxBody = Math.max(config.getWebFetchMaxTextSize(), config.getWebFetchMaxImageSize());
    return axios.create({
      timeout: config.getWebFetchTimeout(),
      maxRedirects: 0,
      headers: {
        'User-Agent': config.getWebFetchUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/png,*/*;q=0.8',
      },
      responseType: 'arraybuffer',
      maxContentLength: maxBody,
      maxBodyLength: maxBody,
      validateStatus: () => true,
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
      }
      if (robotsResult.note) {
        robotsTxtNote = robotsResult.note;
      }
    }

    logger.log('success', 'system', `WEBFETCH: Fetching "${url}" (tool: ${toolName})`);

    try {
      const maxRedirects = config.getWebFetchMaxRedirects();
      let currentUrl = url;

      // Follow redirects manually so each hop is validated for SSRF
      let response = await this.client.get(currentUrl, { signal });
      let redirectCount = 0;

      while (this.isRedirect(response.status) && redirectCount < maxRedirects) {
        const location = response.headers['location'];
        if (!location) break;

        const nextUrl = new URL(location, currentUrl).toString();

        const hopValidation = this.validateUrl(nextUrl);
        if (hopValidation) {
          return { success: false, error: `Redirect to unsafe URL blocked: ${hopValidation}` };
        }
        try {
          await this.checkDns(nextUrl);
        } catch (dnsErr) {
          const dnsMsg = dnsErr instanceof Error ? dnsErr.message : String(dnsErr);
          return { success: false, error: `Redirect blocked by DNS policy: ${dnsMsg}` };
        }

        redirectCount++;
        currentUrl = nextUrl;
        response = await this.client.get(currentUrl, { signal });
      }

      if (this.isRedirect(response.status)) {
        return { success: false, error: `Too many redirects (max ${maxRedirects})` };
      }

      // Layer 3: Response validation (content-type)
      const rawContentType = response.headers['content-type'] || '';
      const contentType = rawContentType.split(';')[0].trim().toLowerCase();

      if (response.status === 403 || response.status === 401 || response.status === 429) {
        logger.logWarn('webfetch', `HTTP ${response.status} from ${currentUrl} — falling back to search`);
        return this.fallbackToSearch(url, `HTTP ${response.status} — access denied or rate limited`, signal);
      }

      if (response.status >= 400 || response.status >= 500) {
        return { success: false, error: `HTTP ${response.status} from ${currentUrl}` };
      }

      const buffer = Buffer.from(response.data);

      if (IMAGE_CONTENT_TYPES.has(contentType)) {
        return this.processImage(buffer, url, contentType);
      }

      if (TEXT_CONTENT_TYPES.has(contentType)) {
        return this.processText(buffer, url, contentType, robotsTxtNote, signal);
      }

      return { success: false, error: `Unsupported content type: ${contentType}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      if (
        msg.includes('timeout') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('ECONNRESET') ||
        msg.includes('aborted') ||
        msg.includes('maxContentLength') ||
        msg.includes('maxBodyLength')
      ) {
        logger.logWarn('webfetch', `Fetch failed for ${url}: ${msg} — falling back to search`);
        return this.fallbackToSearch(url, msg, signal);
      }

      logger.logError('webfetch', `Fetch failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  // ── Layer 1: URL validation ─────────────────────────────────────

  /** Validate URL format, protocol, and hostname. Returns error string or null if valid. */
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

    const hostname = parsed.hostname;
    const bareHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;

    if (isBlockedHostname(bareHostname)) {
      return `Blocked hostname "${bareHostname}" (SSRF blocked)`;
    }

    if (net.isIPv4(bareHostname) && isReservedIPv4(bareHostname)) {
      return 'URL points to a private/internal IP address (SSRF blocked)';
    }
    if (net.isIPv6(bareHostname) && isReservedIPv6(bareHostname)) {
      return 'URL points to a private/internal IP address (SSRF blocked)';
    }

    return null;
  }

  /**
   * DNS pre-resolution to block SSRF via hostname -> private IP.
   * Resolves both A and AAAA records independently.
   * Fails closed: if DNS cannot resolve the hostname at all, the request is blocked.
   */
  private async checkDns(url: string): Promise<void> {
    const parsed = new URL(url);
    const rawHostname = parsed.hostname;
    const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname;

    if (net.isIPv4(hostname) || net.isIPv6(hostname)) return;

    const [v4Result, v6Result] = await Promise.allSettled([
      dns.resolve(hostname),
      dns.resolve6(hostname),
    ]);

    const v4Addrs = v4Result.status === 'fulfilled' ? v4Result.value : [];
    const v6Addrs = v6Result.status === 'fulfilled' ? v6Result.value : [];

    if (v4Addrs.length === 0 && v6Addrs.length === 0) {
      throw new Error(`DNS resolution failed for "${hostname}" — request blocked (fail-closed)`);
    }

    for (const addr of v4Addrs) {
      if (isReservedIPv4(addr)) {
        throw new Error(`URL hostname "${hostname}" resolves to private IP ${addr} (SSRF blocked)`);
      }
    }
    for (const addr of v6Addrs) {
      if (isReservedIPv6(addr)) {
        throw new Error(`URL hostname "${hostname}" resolves to private IPv6 ${addr} (SSRF blocked)`);
      }
    }
  }

  private isRedirect(status: number): boolean {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
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

  private async processText(buffer: Buffer, url: string, contentType: string, robotsTxtNote?: string, signal?: AbortSignal): Promise<WebFetchResponse> {
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
      return this.fallbackToSearch(url, `Captcha detected: ${captchaResult}`, signal);
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
      return this.fallbackToSearch(url, 'Page returned no extractable text content', signal);
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

  private async fallbackToSearch(url: string, reason: string, signal?: AbortSignal): Promise<WebFetchResponse> {
    logger.log('success', 'system', `WEBFETCH: Falling back to SerpAPI search for ${url} (reason: ${reason})`);

    if (signal?.aborted) {
      return { success: false, error: `Request cancelled before fallback search for ${url}` };
    }

    const query = this.buildFallbackQuery(url);
    try {
      const searchResult = await serpApiClient.handleRequest(query, 'web_search', signal);
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
