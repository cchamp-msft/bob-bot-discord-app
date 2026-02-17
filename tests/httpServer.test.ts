/**
 * HttpServer tests — verifies bind-host defaults, admin auth middleware,
 * localhostOnly guard, security headers, and trust proxy setting.
 *
 * Uses supertest-style request simulation against the Express app
 * without actually opening a network port.
 */

// ── Mocks (must be declared before any source import) ────────────

jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
    logBusy: jest.fn(),
    logTimeout: jest.fn(),
    logDebug: jest.fn(),
    logDebugLazy: jest.fn(),
    logWarn: jest.fn(),
    getRecentLines: jest.fn(() => []),
  },
}));

jest.mock('../src/utils/configWriter', () => ({
  configWriter: {
    updateEnv: jest.fn(),
    updateKeywords: jest.fn(),
    saveWorkflow: jest.fn(),
    deleteWorkflow: jest.fn(),
  },
}));

jest.mock('../src/utils/fileHandler', () => ({
  fileHandler: { saveFromUrl: jest.fn() },
}));

jest.mock('../src/api', () => ({
  apiManager: {
    testOllamaConnection: jest.fn(),
    testAccuWeatherConnection: jest.fn(),
    checkNflHealth: jest.fn(),
    checkMemeHealth: jest.fn(),
    testSerpApiConnection: jest.fn(),
    checkApiHealth: jest.fn(),
    refreshClients: jest.fn(),
  },
}));

jest.mock('../src/api/comfyuiClient', () => ({
  comfyuiClient: {
    getSamplers: jest.fn(),
    getSchedulers: jest.fn(),
    getCheckpoints: jest.fn(),
    getExportWorkflow: jest.fn(),
    generateImage: jest.fn(),
  },
}));

jest.mock('../src/bot/discordManager', () => ({
  discordManager: {
    getStatus: jest.fn(() => ({ connected: false })),
    start: jest.fn(),
    stop: jest.fn(),
    testToken: jest.fn(),
    destroy: jest.fn(),
  },
}));

// Dynamic mock for config so we can control ADMIN_TOKEN per test
const mockConfig = {
  getHttpPort: () => 3000,
  getHttpHost: () => (process.env.HTTP_HOST || '').trim() || '127.0.0.1',
  getOutputsPort: () => 3003,
  getOutputsHost: () => '0.0.0.0',
  getOutputBaseUrl: () => 'http://localhost:3003',
  getAdminToken: jest.fn(() => ''),
  getPublicConfig: jest.fn(() => ({ http: { port: 3000, httpHost: '127.0.0.1', outputsPort: 3003, outputsHost: '0.0.0.0' } })),
  getApiEndpoint: jest.fn(() => 'http://localhost'),
  reload: jest.fn(() => ({ reloaded: [], requiresRestart: [] })),
};
jest.mock('../src/utils/config', () => ({ config: mockConfig }));

import http from 'http';
import { httpServer } from '../src/utils/httpServer';
import type { Express } from 'express';

// ── Helpers ──────────────────────────────────────────────────────

let testServer: http.Server | null = null;

/**
 * Start the Express app on an ephemeral port and return a base URL
 * that the tests can use with fetch().
 */
function startTestServer(app: Express): Promise<string> {
  return new Promise((resolve) => {
    testServer = app.listen(0, '127.0.0.1', () => {
      const addr = testServer!.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

async function stopTestServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!testServer) { resolve(); return; }
    testServer.close(() => { testServer = null; resolve(); });
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe('httpServer', () => {
  const originalEnv = process.env;
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await startTestServer(httpServer.getApp());
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockConfig.getAdminToken.mockReturnValue('');
  });

  afterAll(async () => {
    process.env = originalEnv;
    await stopTestServer();
    try { await httpServer.stop(); } catch { /* ignore */ }
  });

  // ── Bind host tests ──────────────────────────────────────────

  it('defaults to binding 127.0.0.1 when HTTP_HOST is not set', () => {
    delete process.env.HTTP_HOST;

    const app: any = httpServer.getApp();
    const listenMock = jest.fn((_port: number, _host: string, cb?: () => void) => {
      if (typeof cb === 'function') cb();
      return { close: (closeCb: (err?: unknown) => void) => closeCb() };
    });

    app.listen = listenMock;
    httpServer.start();

    expect(listenMock).toHaveBeenCalled();
    expect(listenMock.mock.calls[0][1]).toBe('127.0.0.1');
  });

  it('binds to HTTP_HOST when provided', () => {
    process.env.HTTP_HOST = '0.0.0.0';

    const app: any = httpServer.getApp();
    const listenMock = jest.fn((_port: number, _host: string, cb?: () => void) => {
      if (typeof cb === 'function') cb();
      return { close: (closeCb: (err?: unknown) => void) => closeCb() };
    });

    app.listen = listenMock;
    httpServer.start();

    expect(listenMock).toHaveBeenCalled();
    expect(listenMock.mock.calls[0][1]).toBe('0.0.0.0');
  });

  // ── Trust proxy ──────────────────────────────────────────────

  it('has trust proxy explicitly disabled', () => {
    const app = httpServer.getApp();
    expect(app.get('trust proxy')).toBe(false);
  });

  // ── Security headers ─────────────────────────────────────────

  it('sets X-Content-Type-Options on responses', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('does not expose X-Powered-By header', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  // ── localhostOnly guard (from localhost — should pass) ───────

  it('allows localhost requests to admin routes', async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    // Request comes from 127.0.0.1 since that's where we bound
    expect(res.status).toBe(200);
  });

  // ── Admin token auth ─────────────────────────────────────────

  it('requires Bearer token when ADMIN_TOKEN is configured', async () => {
    mockConfig.getAdminToken.mockReturnValue('s3cret-tok3n');

    // No token header
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Unauthorized');
  });

  it('rejects wrong Bearer token', async () => {
    mockConfig.getAdminToken.mockReturnValue('s3cret-tok3n');

    const res = await fetch(`${baseUrl}/api/config`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts correct Bearer token when ADMIN_TOKEN is configured', async () => {
    mockConfig.getAdminToken.mockReturnValue('s3cret-tok3n');

    const res = await fetch(`${baseUrl}/api/config`, {
      headers: { Authorization: 'Bearer s3cret-tok3n' },
    });
    expect(res.status).toBe(200);
  });

  it('skips auth check when ADMIN_TOKEN is not configured', async () => {
    mockConfig.getAdminToken.mockReturnValue('');

    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
  });

  // ── Health endpoint (no auth) ────────────────────────────────

  it('/health responds without authentication', async () => {
    mockConfig.getAdminToken.mockReturnValue('s3cret-tok3n');

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
  });

  // ── 404 handler ──────────────────────────────────────────────

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
