/**
 * WebFetchClient tests — exercises URL validation, content processing,
 * safety layers, captcha detection, HTML extraction, image handling,
 * and SerpAPI fallback.
 */

const mockInstance = {
  get: jest.fn(),
  defaults: { baseURL: '' },
};

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => mockInstance),
    get: jest.fn(),
    isAxiosError: jest.fn((err: any) => err?.isAxiosError === true),
  },
}));

jest.mock('../src/utils/config', () => ({
  config: {
    getWebFetchEnabled: jest.fn(() => true),
    getWebFetchTimeout: jest.fn(() => 15000),
    getWebFetchMaxTextSize: jest.fn(() => 5242880),
    getWebFetchMaxImageSize: jest.fn(() => 10485760),
    getWebFetchMaxContentChars: jest.fn(() => 8000),
    getWebFetchMaxRedirects: jest.fn(() => 3),
    getWebFetchRobotsTxtMode: jest.fn(() => 'disabled'),
    getWebFetchUserAgent: jest.fn(() => 'BobBot/1.0'),
    getSerpApiKey: jest.fn(() => 'test-key'),
    getSerpApiEndpoint: jest.fn(() => 'https://serpapi.com'),
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
    logTimeout: jest.fn(),
    logIgnored: jest.fn(),
  },
}));

jest.mock('dns/promises', () => ({
  resolve: jest.fn().mockResolvedValue(['93.184.216.34']),
  resolve6: jest.fn().mockResolvedValue([]),
}));

// Mock serpApiClient for fallback tests
const mockSerpApiHandleRequest = jest.fn();
jest.mock('../src/api/serpApiClient', () => ({
  serpApiClient: {
    handleRequest: mockSerpApiHandleRequest,
    refresh: jest.fn(),
  },
}));

import axios from 'axios';
import { webFetchClient } from '../src/api/webFetchClient';
import { config } from '../src/utils/config';
import * as dns from 'dns/promises';

// ── Helpers ───────────────────────────────────────────────────────

function htmlPage(body: string, title = 'Test Page'): Buffer {
  return Buffer.from(`<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`);
}

function mockSuccessResponse(buffer: Buffer, contentType = 'text/html') {
  mockInstance.get.mockResolvedValueOnce({
    status: 200,
    headers: { 'content-type': contentType },
    data: buffer,
  });
}

// ── Tests ─────────────────────────────────────────────────────────

describe('WebFetchClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (dns.resolve as jest.Mock).mockResolvedValue(['93.184.216.34']);
    (dns.resolve6 as jest.Mock).mockResolvedValue([]);
    // Reset config mocks to defaults
    (config.getWebFetchEnabled as jest.Mock).mockReturnValue(true);
    (config.getWebFetchTimeout as jest.Mock).mockReturnValue(15000);
    (config.getWebFetchMaxTextSize as jest.Mock).mockReturnValue(5242880);
    (config.getWebFetchMaxImageSize as jest.Mock).mockReturnValue(10485760);
    (config.getWebFetchMaxContentChars as jest.Mock).mockReturnValue(8000);
    (config.getWebFetchMaxRedirects as jest.Mock).mockReturnValue(3);
    (config.getWebFetchRobotsTxtMode as jest.Mock).mockReturnValue('disabled');
    (config.getWebFetchUserAgent as jest.Mock).mockReturnValue('BobBot/1.0');
  });

  // ── URL validation ──────────────────────────────────────────────

  describe('URL validation', () => {
    it('should reject empty URL', () => {
      expect(webFetchClient.validateUrl('')).toBe('No URL provided');
    });

    it('should reject invalid URL', () => {
      expect(webFetchClient.validateUrl('not-a-url')).toContain('Invalid URL');
    });

    it('should reject ftp protocol', () => {
      expect(webFetchClient.validateUrl('ftp://example.com')).toContain('http:// or https://');
    });

    it('should reject file protocol', () => {
      expect(webFetchClient.validateUrl('file:///etc/passwd')).toContain('http:// or https://');
    });

    it('should reject javascript protocol', () => {
      const result = webFetchClient.validateUrl('javascript:alert(1)');
      expect(result).not.toBeNull();
      expect(result).toContain('http:// or https://');
    });

    it('should accept valid http URL', () => {
      expect(webFetchClient.validateUrl('http://example.com')).toBeNull();
    });

    it('should accept valid https URL', () => {
      expect(webFetchClient.validateUrl('https://example.com/page')).toBeNull();
    });

    it('should reject private IP 127.0.0.1', () => {
      const result = webFetchClient.validateUrl('http://127.0.0.1/admin');
      expect(result).toContain('SSRF blocked');
    });

    it('should reject private IP 10.x.x.x', () => {
      const result = webFetchClient.validateUrl('http://10.0.0.1/internal');
      expect(result).toContain('SSRF blocked');
    });

    it('should reject private IP 192.168.x.x', () => {
      const result = webFetchClient.validateUrl('http://192.168.1.1/router');
      expect(result).toContain('SSRF blocked');
    });

    it('should reject private IP 172.16.x.x', () => {
      const result = webFetchClient.validateUrl('http://172.16.0.1/');
      expect(result).toContain('SSRF blocked');
    });
  });

  // ── DNS SSRF protection ─────────────────────────────────────────

  describe('DNS SSRF protection', () => {
    it('should block hostnames resolving to private IPs', async () => {
      (dns.resolve as jest.Mock).mockResolvedValue(['127.0.0.1']);

      const result = await webFetchClient.handleRequest('https://evil.example.com', 'fetch_webpage');
      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF blocked');
    });

    it('should allow hostnames resolving to public IPs', async () => {
      (dns.resolve as jest.Mock).mockResolvedValue(['93.184.216.34']);
      mockSuccessResponse(htmlPage('<p>Hello world</p>'));

      const result = await webFetchClient.handleRequest('https://example.com', 'fetch_webpage');
      expect(result.success).toBe(true);
    });
  });

  // ── Content-type filtering ──────────────────────────────────────

  describe('Content-type filtering', () => {
    it('should accept text/html', async () => {
      mockSuccessResponse(htmlPage('<p>Content</p>'));
      const result = await webFetchClient.handleRequest('https://example.com', 'fetch_webpage');
      expect(result.success).toBe(true);
    });

    it('should accept application/json', async () => {
      const json = Buffer.from(JSON.stringify({ key: 'value' }));
      mockSuccessResponse(json, 'application/json');
      const result = await webFetchClient.handleRequest('https://api.example.com/data', 'fetch_webpage');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('key');
    });

    it('should accept text/plain', async () => {
      const text = Buffer.from('Plain text content');
      mockSuccessResponse(text, 'text/plain');
      const result = await webFetchClient.handleRequest('https://example.com/readme.txt', 'fetch_webpage');
      expect(result.success).toBe(true);
      expect(result.data?.text).toBe('Plain text content');
    });

    it('should reject unsupported content types', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        data: Buffer.from([0x00]),
      });

      const result = await webFetchClient.handleRequest('https://example.com/file.bin', 'fetch_webpage');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported content type');
    });
  });

  // ── Size limit enforcement ──────────────────────────────────────

  describe('Size limits', () => {
    it('should reject text content exceeding max size', async () => {
      (config.getWebFetchMaxTextSize as jest.Mock).mockReturnValue(100);
      const largeContent = Buffer.from('x'.repeat(200));
      mockSuccessResponse(largeContent, 'text/plain');

      const result = await webFetchClient.handleRequest('https://example.com', 'fetch_webpage');
      expect(result.success).toBe(false);
      expect(result.error).toContain('too large');
    });

    it('should reject images exceeding max size', async () => {
      (config.getWebFetchMaxImageSize as jest.Mock).mockReturnValue(100);
      // PNG magic bytes + padding
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, ...new Array(200).fill(0)]);
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'image/png' },
        data: pngHeader,
      });

      const result = await webFetchClient.handleRequest('https://example.com/big.png', 'fetch_webpage');
      expect(result.success).toBe(false);
      expect(result.error).toContain('too large');
    });
  });

  // ── HTML text extraction ────────────────────────────────────────

  describe('HTML text extraction', () => {
    it('should strip script and style tags', () => {
      const html = '<html><head><style>body{color:red}</style></head><body><script>alert("xss")</script><p>Clean text</p></body></html>';
      const result = webFetchClient.extractTextFromHtml(html);
      expect(result.text).toContain('Clean text');
      expect(result.text).not.toContain('alert');
      expect(result.text).not.toContain('color:red');
    });

    it('should extract title', () => {
      const html = '<html><head><title>My Page</title></head><body><p>Content</p></body></html>';
      const result = webFetchClient.extractTextFromHtml(html);
      expect(result.title).toBe('My Page');
    });

    it('should prefer main/article content', () => {
      const html = '<html><body><nav>Nav stuff</nav><main><p>Main content here</p></main><footer>Footer</footer></body></html>';
      const result = webFetchClient.extractTextFromHtml(html);
      expect(result.text).toContain('Main content here');
    });

    it('should strip iframe, object, embed, form elements', () => {
      const html = '<html><body><iframe src="evil.com"></iframe><object data="x"></object><embed src="y"><form action="/"><input></form><p>Safe content</p></body></html>';
      const result = webFetchClient.extractTextFromHtml(html);
      expect(result.text).toContain('Safe content');
      expect(result.text).not.toContain('evil.com');
    });
  });

  // ── Captcha detection ───────────────────────────────────────────

  describe('Captcha detection', () => {
    it('should detect reCAPTCHA pages and fall back', async () => {
      mockSerpApiHandleRequest.mockResolvedValue({
        success: true,
        data: { text: 'Fallback search result' },
      });

      const captchaHtml = htmlPage('<div class="g-recaptcha">Please verify</div>');
      mockSuccessResponse(captchaHtml);

      const result = await webFetchClient.handleRequest('https://blocked-site.com', 'fetch_webpage');
      expect(result.success).toBe(true);
      expect(result.data?.fallbackUsed).toBe(true);
      expect(result.data?.fallbackReason).toContain('Captcha');
    });

    it('should detect Cloudflare challenge pages', async () => {
      mockSerpApiHandleRequest.mockResolvedValue({
        success: true,
        data: { text: 'Search results' },
      });

      const cfHtml = htmlPage('<p>Checking your browser before accessing</p>');
      mockSuccessResponse(cfHtml);

      const result = await webFetchClient.handleRequest('https://cf-site.com', 'fetch_webpage');
      expect(result.success).toBe(true);
      expect(result.data?.fallbackUsed).toBe(true);
    });
  });

  // ── SerpAPI fallback ────────────────────────────────────────────

  describe('SerpAPI fallback', () => {
    it('should fall back on HTTP 403', async () => {
      mockSerpApiHandleRequest.mockResolvedValue({
        success: true,
        data: { text: 'Fallback content' },
      });

      mockInstance.get.mockResolvedValueOnce({
        status: 403,
        headers: { 'content-type': 'text/html' },
        data: Buffer.from('Forbidden'),
      });

      const result = await webFetchClient.handleRequest('https://blocked.com', 'fetch_webpage');
      expect(result.success).toBe(true);
      expect(result.data?.fallbackUsed).toBe(true);
      expect(result.data?.fallbackReason).toContain('403');
    });

    it('should fall back on timeout', async () => {
      mockSerpApiHandleRequest.mockResolvedValue({
        success: true,
        data: { text: 'Timeout fallback' },
      });

      mockInstance.get.mockRejectedValueOnce(new Error('timeout of 15000ms exceeded'));

      const result = await webFetchClient.handleRequest('https://slow-site.com', 'fetch_webpage');
      expect(result.success).toBe(true);
      expect(result.data?.fallbackUsed).toBe(true);
      expect(result.data?.fallbackReason).toContain('timeout');
    });

    it('should return error when both fetch and fallback fail', async () => {
      mockSerpApiHandleRequest.mockRejectedValue(new Error('SerpAPI also failed'));
      mockInstance.get.mockRejectedValueOnce(new Error('timeout'));

      const result = await webFetchClient.handleRequest('https://nowhere.com', 'fetch_webpage');
      expect(result.success).toBe(false);
      expect(result.error).toContain('failed');
    });
  });

  // ── Image processing ────────────────────────────────────────────

  describe('Image processing', () => {
    it('should convert valid PNG to base64', async () => {
      // Minimal PNG header
      const pngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      ]);
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'image/png' },
        data: pngBuffer,
      });

      const result = await webFetchClient.handleRequest('https://example.com/image.png', 'fetch_webpage');
      expect(result.success).toBe(true);
      expect(result.data?.imageBase64).toBeDefined();
      expect(result.data?.contentType).toBe('image/png');
    });

    it('should reject mismatched magic bytes', async () => {
      const fakeImage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'image/png' },
        data: fakeImage,
      });

      const result = await webFetchClient.handleRequest('https://example.com/fake.png', 'fetch_webpage');
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not match');
    });
  });

  // ── Disabled state ──────────────────────────────────────────────

  describe('Disabled state', () => {
    it('should return error when disabled', async () => {
      (config.getWebFetchEnabled as jest.Mock).mockReturnValue(false);

      const result = await webFetchClient.handleRequest('https://example.com', 'fetch_webpage');
      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
    });
  });

  // ── Content truncation ──────────────────────────────────────────

  describe('Content truncation', () => {
    it('should truncate text exceeding max content chars', async () => {
      (config.getWebFetchMaxContentChars as jest.Mock).mockReturnValue(50);
      const longContent = htmlPage('<p>' + 'A'.repeat(200) + '</p>');
      mockSuccessResponse(longContent);

      const result = await webFetchClient.handleRequest('https://example.com', 'fetch_webpage');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('[Content truncated');
      expect(result.data!.text!.length).toBeLessThan(200);
    });
  });

  // ── AI context formatting ───────────────────────────────────────

  describe('formatContentForAI', () => {
    it('should produce XML-formatted context', () => {
      const response = {
        success: true,
        data: {
          text: 'Page content here',
          url: 'https://example.com',
          contentType: 'text/html',
          title: 'Example',
        },
      };
      const xml = webFetchClient.formatContentForAI(response);
      expect(xml).toContain('<url>');
      expect(xml).toContain('<title>Example</title>');
      expect(xml).toContain('<page_content>');
      expect(xml).toContain('Page content here');
    });

    it('should indicate fallback usage', () => {
      const response = {
        success: true,
        data: {
          text: 'Search results',
          url: 'https://blocked.com',
          contentType: 'text/plain',
          fallbackUsed: true,
          fallbackReason: 'HTTP 403',
        },
      };
      const xml = webFetchClient.formatContentForAI(response);
      expect(xml).toContain('<fallback_used>true</fallback_used>');
      expect(xml).toContain('HTTP 403');
    });
  });

  // ── SSRF hardening (security regression) ────────────────────────

  describe('SSRF hardening', () => {
    it('should block localhost hostname', () => {
      const result = webFetchClient.validateUrl('http://localhost/admin');
      expect(result).toContain('SSRF blocked');
    });

    it('should block localhost.localdomain hostname', () => {
      const result = webFetchClient.validateUrl('http://localhost.localdomain/');
      expect(result).toContain('SSRF blocked');
    });

    it('should block .local TLD', () => {
      const result = webFetchClient.validateUrl('http://printer.local/status');
      expect(result).toContain('SSRF blocked');
    });

    it('should block .internal TLD', () => {
      const result = webFetchClient.validateUrl('http://service.internal/api');
      expect(result).toContain('SSRF blocked');
    });

    it('should block CGNAT range 100.64.x.x', () => {
      const result = webFetchClient.validateUrl('http://100.64.0.1/');
      expect(result).toContain('SSRF blocked');
    });

    it('should block 0.0.0.0', () => {
      const result = webFetchClient.validateUrl('http://0.0.0.0/');
      expect(result).toContain('SSRF blocked');
    });

    it('should block multicast range 224.x.x.x', () => {
      const result = webFetchClient.validateUrl('http://224.0.0.1/');
      expect(result).toContain('SSRF blocked');
    });

    it('should block broadcast 255.255.255.255', () => {
      const result = webFetchClient.validateUrl('http://255.255.255.255/');
      expect(result).toContain('SSRF blocked');
    });

    it('should block TEST-NET-1 192.0.2.x', () => {
      const result = webFetchClient.validateUrl('http://192.0.2.1/');
      expect(result).toContain('SSRF blocked');
    });

    it('should block benchmarking range 198.18.x.x', () => {
      const result = webFetchClient.validateUrl('http://198.18.0.1/');
      expect(result).toContain('SSRF blocked');
    });

    it('should block IPv6 loopback ::1', () => {
      const result = webFetchClient.validateUrl('http://[::1]/');
      expect(result).toContain('SSRF blocked');
    });
  });

  // ── DNS fail-closed behavior ────────────────────────────────────

  describe('DNS fail-closed', () => {
    it('should block when both A and AAAA resolution fail', async () => {
      (dns.resolve as jest.Mock).mockRejectedValue(new Error('ENOTFOUND'));
      (dns.resolve6 as jest.Mock).mockRejectedValue(new Error('ENOTFOUND'));

      const result = await webFetchClient.handleRequest('https://nonexistent.example.com', 'fetch_webpage');
      expect(result.success).toBe(false);
      expect(result.error).toContain('fail-closed');
    });
  });

  // ── Dual-stack AAAA validation ──────────────────────────────────

  describe('Dual-stack DNS SSRF protection', () => {
    it('should block when A records are public but AAAA resolves to private', async () => {
      (dns.resolve as jest.Mock).mockResolvedValue(['93.184.216.34']);
      (dns.resolve6 as jest.Mock).mockResolvedValue(['::1']);

      const result = await webFetchClient.handleRequest('https://dualstack.example.com', 'fetch_webpage');
      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF blocked');
    });

    it('should block when AAAA resolves to ULA fd00::', async () => {
      (dns.resolve as jest.Mock).mockResolvedValue(['93.184.216.34']);
      (dns.resolve6 as jest.Mock).mockResolvedValue(['fd00::1']);

      const result = await webFetchClient.handleRequest('https://ula.example.com', 'fetch_webpage');
      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF blocked');
    });

    it('should allow when both A and AAAA are public', async () => {
      (dns.resolve as jest.Mock).mockResolvedValue(['93.184.216.34']);
      (dns.resolve6 as jest.Mock).mockResolvedValue(['2606:2800:220:1:248:1893:25c8:1946']);
      mockSuccessResponse(htmlPage('<p>Content</p>'));

      const result = await webFetchClient.handleRequest('https://safe.example.com', 'fetch_webpage');
      expect(result.success).toBe(true);
    });
  });

  // ── Redirect SSRF validation ────────────────────────────────────

  describe('Redirect SSRF validation', () => {
    it('should block redirect to private IP', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 302,
        headers: { 'content-type': 'text/html', location: 'http://127.0.0.1/admin' },
        data: Buffer.from(''),
      });

      const result = await webFetchClient.handleRequest('https://redirect.example.com', 'fetch_webpage');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Redirect to unsafe URL blocked');
    });

    it('should block redirect to localhost hostname', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 301,
        headers: { 'content-type': 'text/html', location: 'http://localhost/secret' },
        data: Buffer.from(''),
      });

      const result = await webFetchClient.handleRequest('https://redirect2.example.com', 'fetch_webpage');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Redirect to unsafe URL blocked');
    });

    it('should block redirect whose DNS resolves to private IP', async () => {
      // First hop succeeds DNS check
      (dns.resolve as jest.Mock)
        .mockResolvedValueOnce(['93.184.216.34'])   // initial URL
        .mockResolvedValueOnce(['10.0.0.1']);        // redirect target

      mockInstance.get.mockResolvedValueOnce({
        status: 302,
        headers: { 'content-type': 'text/html', location: 'https://evil-redirect.example.com/' },
        data: Buffer.from(''),
      });

      const result = await webFetchClient.handleRequest('https://start.example.com', 'fetch_webpage');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Redirect blocked by DNS policy');
    });

    it('should follow safe redirects successfully', async () => {
      mockInstance.get
        .mockResolvedValueOnce({
          status: 302,
          headers: { 'content-type': 'text/html', location: 'https://final.example.com/page' },
          data: Buffer.from(''),
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: { 'content-type': 'text/html' },
          data: htmlPage('<p>Final page</p>'),
        });

      const result = await webFetchClient.handleRequest('https://redirect-ok.example.com', 'fetch_webpage');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('Final page');
    });

    it('should fail when redirect count exceeds max', async () => {
      (config.getWebFetchMaxRedirects as jest.Mock).mockReturnValue(2);

      mockInstance.get
        .mockResolvedValueOnce({
          status: 302,
          headers: { location: 'https://hop1.example.com/' },
          data: Buffer.from(''),
        })
        .mockResolvedValueOnce({
          status: 302,
          headers: { location: 'https://hop2.example.com/' },
          data: Buffer.from(''),
        })
        .mockResolvedValueOnce({
          status: 302,
          headers: { location: 'https://hop3.example.com/' },
          data: Buffer.from(''),
        });

      const result = await webFetchClient.handleRequest('https://loop.example.com', 'fetch_webpage');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Too many redirects');
    });
  });

  // ── Transport-level size limits ─────────────────────────────────

  describe('Transport-level size limits', () => {
    it('should fall back when axios throws maxContentLength error', async () => {
      mockSerpApiHandleRequest.mockResolvedValue({
        success: true,
        data: { text: 'Fallback for oversized' },
      });
      mockInstance.get.mockRejectedValueOnce(new Error('maxContentLength size of 5242880 exceeded'));

      const result = await webFetchClient.handleRequest('https://huge.example.com', 'fetch_webpage');
      expect(result.success).toBe(true);
      expect(result.data?.fallbackUsed).toBe(true);
    });
  });

  // ── robots.txt modes ────────────────────────────────────────────

  describe('robots.txt modes', () => {
    it('ignore: should proceed with fetch and attach note when robots.txt blocks', async () => {
      (config.getWebFetchRobotsTxtMode as jest.Mock).mockReturnValue('ignore');
      (axios.get as jest.Mock).mockResolvedValueOnce({
        status: 200,
        data: 'User-agent: *\nDisallow: /',
      });
      mockSuccessResponse(htmlPage('<p>Blocked but fetched</p>'));

      const result = await webFetchClient.handleRequest('https://example.com/page', 'fetch_webpage');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('Blocked but fetched');
      expect(result.data?.robotsTxtNote).toMatch(/disallow/i);
    });

    it('follow: should block fetch and fall back to search when robots.txt disallows', async () => {
      (config.getWebFetchRobotsTxtMode as jest.Mock).mockReturnValue('follow');
      (axios.get as jest.Mock).mockResolvedValueOnce({
        status: 200,
        data: 'User-agent: *\nDisallow: /secret',
      });
      mockSerpApiHandleRequest.mockResolvedValue({
        success: true,
        data: { text: 'Search fallback result' },
      });

      const result = await webFetchClient.handleRequest('https://example.com/secret/doc', 'fetch_webpage');
      expect(result.success).toBe(true);
      expect(result.data?.fallbackUsed).toBe(true);
      expect(result.data?.fallbackReason).toContain('robots.txt');
    });

    it('follow: should proceed normally when robots.txt allows the path', async () => {
      (config.getWebFetchRobotsTxtMode as jest.Mock).mockReturnValue('follow');
      (axios.get as jest.Mock).mockResolvedValueOnce({
        status: 200,
        data: 'User-agent: *\nDisallow: /admin',
      });
      mockSuccessResponse(htmlPage('<p>Allowed content</p>'));

      const result = await webFetchClient.handleRequest('https://example.com/public', 'fetch_webpage');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('Allowed content');
      expect(result.data?.fallbackUsed).toBeUndefined();
    });

    it('disabled: should skip robots.txt check entirely', async () => {
      (config.getWebFetchRobotsTxtMode as jest.Mock).mockReturnValue('disabled');
      mockSuccessResponse(htmlPage('<p>No robots check</p>'));

      const result = await webFetchClient.handleRequest('https://example.com/page', 'fetch_webpage');
      expect(result.success).toBe(true);
      expect(result.data?.text).toContain('No robots check');
      expect(result.data?.robotsTxtNote).toBeUndefined();
      expect(axios.get).not.toHaveBeenCalled();
    });
  });

  // ── buildFallbackQuery ─────────────────────────────────────────

  describe('buildFallbackQuery', () => {
    it('should extract domain and meaningful path segments', () => {
      const query = webFetchClient.buildFallbackQuery(
        'https://www.msn.com/en-us/news/insight/nand-prices-soar-amid-ai-boom/gm-GMB6AA7777'
      );
      expect(query).toContain('msn.com');
      expect(query).toContain('news');
      expect(query).toContain('insight');
      expect(query).toContain('nand prices soar amid ai boom');
      expect(query).not.toMatch(/\ben\b/);
      expect(query).not.toMatch(/\ben-us\b/);
      expect(query).not.toMatch(/GMB6AA/i);
    });

    it('should strip locale segments like en, us, en-us', () => {
      const query = webFetchClient.buildFallbackQuery(
        'https://example.com/en/us/articles/some-great-article'
      );
      expect(query).not.toMatch(/\ben\b/);
      expect(query).not.toMatch(/\bus\b/);
      expect(query).toContain('articles');
      expect(query).toContain('some great article');
    });

    it('should drop pure numeric path segments', () => {
      const query = webFetchClient.buildFallbackQuery(
        'https://news.example.com/2025/12/article-title'
      );
      expect(query).not.toMatch(/\b2025\b/);
      expect(query).not.toMatch(/\b12\b/);
      expect(query).toContain('article title');
    });

    it('should drop opaque IDs with mixed alpha-numeric content', () => {
      const query = webFetchClient.buildFallbackQuery(
        'https://example.com/posts/my-great-post/abc123def456'
      );
      expect(query).toContain('my great post');
      expect(query).not.toContain('abc123def456');
    });

    it('should include meaningful query parameters', () => {
      const query = webFetchClient.buildFallbackQuery(
        'https://example.com/search?q=typescript+best+practices&utm_source=google'
      );
      expect(query).toContain('typescript best practices');
      expect(query).not.toContain('google');
      expect(query).not.toContain('utm_source');
    });

    it('should handle URL with only a domain', () => {
      const query = webFetchClient.buildFallbackQuery('https://www.example.com');
      expect(query).toBe('example.com');
    });

    it('should return raw URL string for invalid URLs', () => {
      const query = webFetchClient.buildFallbackQuery('not-a-valid-url');
      expect(query).toBe('not-a-valid-url');
    });

    it('should cap query length to avoid excessively long searches', () => {
      const longPath = Array.from({ length: 20 }, (_, i) => `segment-number-${i}`).join('/');
      const query = webFetchClient.buildFallbackQuery(`https://example.com/${longPath}`);
      expect(query.length).toBeLessThanOrEqual(120);
    });

    it('should strip www. from domain', () => {
      const query = webFetchClient.buildFallbackQuery('https://www.reddit.com/r/programming');
      expect(query).toContain('reddit.com');
      expect(query).not.toContain('www.');
    });

    it('should skip tracking query parameters', () => {
      const query = webFetchClient.buildFallbackQuery(
        'https://example.com/page?fbclid=abc123&gclid=xyz789&topic=interesting-stuff'
      );
      expect(query).not.toContain('fbclid');
      expect(query).not.toContain('gclid');
      expect(query).toContain('interesting stuff');
    });
  });
});
