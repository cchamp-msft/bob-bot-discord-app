/**
 * OutputsServer tests — verifies the dedicated outputs file server
 * starts on the configured port/host, shuts down cleanly, serves
 * static files, blocks /logs, returns health, and sets security headers.
 */

// Mock logger so tests don't write to real log files
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
  },
}));

// Mock config to return predictable values
jest.mock('../src/utils/config', () => ({
  config: {
    getOutputsPort: () => 3003,
    getOutputsHost: () => '0.0.0.0',
    getOutputsTrustProxy: () => false,
    getOutputBaseUrl: () => 'http://localhost:3003',
    // Use a tight rate limit so tests can trigger 429 without hundreds of requests
    getOutputsRateLimitWindowMs: () => 60000,
    getOutputsRateLimitMax: () => 5,
  },
}));

jest.mock('../src/utils/activityEvents', () => {
  const events: any[] = [];
  return {
    activityEvents: {
      emit: jest.fn((type: string, narrative: string, metadata = {}, imageUrls: string[] = []) => {
        const ev = { id: events.length + 1, timestamp: new Date().toISOString(), type, narrative, metadata, imageUrls };
        events.push(ev);
        return ev;
      }),
      emitMessageReceived: jest.fn(),
      emitRoutingDecision: jest.fn(),
      emitBotReply: jest.fn(),
      emitBotImageReply: jest.fn(),
      emitError: jest.fn(),
      emitWarning: jest.fn(),
      getRecent: jest.fn((count = 50, since?: string) => {
        let filtered = events;
        if (since) filtered = events.filter((e: any) => e.timestamp > since);
        return filtered.slice(-count);
      }),
      clear: jest.fn(() => { events.length = 0; }),
      get size() { return events.length; },
    },
    __testEvents: events,
  };
});

// Mock activityKeyManager — always valid for tests unless overridden
jest.mock('../src/utils/activityKeyManager', () => ({
  activityKeyManager: {
    isValid: jest.fn((key: string) => key === 'test-valid-key'),
    issueKey: jest.fn(() => 'test-valid-key'),
    isExpired: jest.fn(() => false),
    remainingSeconds: jest.fn(() => 300),
    revoke: jest.fn(),
    createSession: jest.fn(() => 'test-session-token'),
    isSessionValid: jest.fn((token: string) => token === 'test-session-token'),
    isSessionExpired: jest.fn(() => false),
    sessionRemainingSeconds: jest.fn(() => 86400),
    revokeSession: jest.fn(),
  },
}));

import http from 'http';
import { outputsServer } from '../src/utils/outputsServer';
import { activityEvents } from '../src/utils/activityEvents';
import { activityKeyManager } from '../src/utils/activityKeyManager';
import type { Express } from 'express';

// ── Helpers ──────────────────────────────────────────────────────

let testServer: http.Server | null = null;

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

describe('OutputsServer', () => {
  const originalEnv = process.env;
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await startTestServer(outputsServer.getApp());
  });

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(async () => {
    process.env = originalEnv;
    await stopTestServer();
    try { await outputsServer.stop(); } catch { /* ignore */ }
  });

  // ── Start / stop / lifecycle ─────────────────────────────────

  it('starts on configured port and host', () => {
    const app: any = outputsServer.getApp();
    const listenMock = jest.fn((_port: number, _host: string, cb?: () => void) => {
      if (typeof cb === 'function') cb();
      return {
        close: (closeCb: (err?: unknown) => void) => closeCb(),
      };
    });

    app.listen = listenMock;

    outputsServer.start();

    expect(listenMock).toHaveBeenCalled();
    expect(listenMock.mock.calls[0][0]).toBe(3003);
    expect(listenMock.mock.calls[0][1]).toBe('0.0.0.0');
  });

  it('stop resolves when no server is running', async () => {
    (outputsServer as any).server = null;
    await expect(outputsServer.stop()).resolves.toBeUndefined();
  });

  it('stop closes the server gracefully', async () => {
    const closeMock = jest.fn((cb: (err?: unknown) => void) => cb());
    (outputsServer as any).server = { close: closeMock };

    await outputsServer.stop();

    expect(closeMock).toHaveBeenCalled();
    expect((outputsServer as any).server).toBeNull();
  });

  it('stop rejects when server close errors', async () => {
    const testError = new Error('close failed');
    const closeMock = jest.fn((cb: (err?: unknown) => void) => cb(testError));
    (outputsServer as any).server = { close: closeMock };

    await expect(outputsServer.stop()).rejects.toThrow('close failed');
  });

  it('exposes the express app via getApp()', () => {
    const app = outputsServer.getApp();
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe('function');
  });

  // ── Trust proxy ──────────────────────────────────────────────

  it('defaults trust proxy to disabled', () => {
    const app = outputsServer.getApp();
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

  // ── /health endpoint ─────────────────────────────────────────

  it('/health returns ok status', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });

  // ── /logs blocking ───────────────────────────────────────────

  it('/logs returns 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/logs`);
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Forbidden');
  });

  it('/logs/anything returns 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/logs/2026/02/test.log`);
    expect(res.status).toBe(403);
  });

  // ── 404 handler ──────────────────────────────────────────────

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${baseUrl}/nonexistent-file.png`);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Not found');
  });

  // ── /activity page ──────────────────────────────────────────

  it('/activity serves the activity page HTML', async () => {
    const res = await fetch(`${baseUrl}/activity`);
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/html');
  });

  // ── /api/activity endpoint ─────────────────────────────────

  it('/api/activity returns JSON with events and serverTime', async () => {
    const res = await fetch(`${baseUrl}/api/activity?key=test-valid-key`);
    expect(res.status).toBe(200);
    const body = await res.json() as { events: any[]; serverTime: string };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.serverTime).toBeDefined();
    expect(new Date(body.serverTime).toISOString()).toBe(body.serverTime);
  });

  it('/api/activity respects since query parameter', async () => {
    // getRecent is mocked — just verify it's called with the right args
    const mockGetRecent = activityEvents.getRecent as jest.MockedFunction<typeof activityEvents.getRecent>;
    mockGetRecent.mockClear();

    const since = '2026-01-01T00:00:00.000Z';
    await fetch(`${baseUrl}/api/activity?key=test-valid-key&since=${encodeURIComponent(since)}`);

    expect(mockGetRecent).toHaveBeenCalledWith(50, since);
  });

  it('/api/activity respects count query parameter (capped at 100)', async () => {
    const mockGetRecent = activityEvents.getRecent as jest.MockedFunction<typeof activityEvents.getRecent>;
    mockGetRecent.mockClear();

    await fetch(`${baseUrl}/api/activity?key=test-valid-key&count=10`);
    expect(mockGetRecent).toHaveBeenCalledWith(10, undefined);
  });

  it('/api/activity caps count at 100', async () => {
    const mockGetRecent = activityEvents.getRecent as jest.MockedFunction<typeof activityEvents.getRecent>;
    mockGetRecent.mockClear();

    await fetch(`${baseUrl}/api/activity?key=test-valid-key&count=999`);
    expect(mockGetRecent).toHaveBeenCalledWith(100, undefined);
  });

  it('/api/activity ignores invalid count parameter', async () => {
    const mockGetRecent = activityEvents.getRecent as jest.MockedFunction<typeof activityEvents.getRecent>;
    mockGetRecent.mockClear();

    await fetch(`${baseUrl}/api/activity?key=test-valid-key&count=abc`);
    expect(mockGetRecent).toHaveBeenCalledWith(50, undefined);
  });

  it('/api/activity has security headers', async () => {
    const res = await fetch(`${baseUrl}/api/activity?key=test-valid-key`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  // ── /api/activity key guard ──────────────────────────────

  it('/api/activity returns 401 when no key is provided', async () => {
    const res = await fetch(`${baseUrl}/api/activity`);
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Unauthorized');
  });

  it('/api/activity returns 401 for an invalid key', async () => {
    const res = await fetch(`${baseUrl}/api/activity?key=bad-key-value`);
    expect(res.status).toBe(401);
  });

  it('/api/activity accepts key via x-activity-key header', async () => {
    const res = await fetch(`${baseUrl}/api/activity`, {
      headers: { 'x-activity-key': 'test-valid-key' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { events: any[]; serverTime: string };
    expect(Array.isArray(body.events)).toBe(true);
  });

  // ── /api/privacy-policy endpoint ───────────────────────────

  it('/api/privacy-policy returns the privacy policy as plain text', async () => {
    const res = await fetch(`${baseUrl}/api/privacy-policy`);
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('Privacy Policy');
  });

  it('/api/privacy-policy has security headers', async () => {
    const res = await fetch(`${baseUrl}/api/privacy-policy`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  // ── Activity page privacy dialog ──────────────────────────

  it('/activity page does not display the privacy dialog by default', async () => {
    const res = await fetch(`${baseUrl}/activity`);
    const html = await res.text();

    // The dialog CSS must NOT unconditionally set display:flex
    // — it should be gated behind the [open] attribute.
    expect(html).toContain('dialog.policy-dialog[open]');
    expect(html).not.toMatch(/dialog\.policy-dialog\s*\{[^}]*display:\s*flex/);
  });

  it('/activity page loads privacy policy only on click (lazy)', async () => {
    const res = await fetch(`${baseUrl}/activity`);
    const html = await res.text();

    // The script must contain a click-gated fetch, not an eager fetch
    expect(html).toContain("privacyLink.addEventListener('click'");
    expect(html).toContain("fetch('/api/privacy-policy')");
    // showModal must only appear inside named functions, not at top-level init
    expect(html).toContain('loadAndShowPolicy');
  });

  // ── /api/activity session-based auth ──────────────────────

  it('/api/activity creates a session on successful key auth', async () => {
    const mockCreateSession = activityKeyManager.createSession as jest.MockedFunction<typeof activityKeyManager.createSession>;
    mockCreateSession.mockClear();

    const res = await fetch(`${baseUrl}/api/activity?key=test-valid-key`);
    expect(res.status).toBe(200);
    const body = await res.json() as { events: any[]; serverTime: string; sessionToken?: string };
    expect(body.sessionToken).toBe('test-session-token');
    expect(mockCreateSession).toHaveBeenCalled();
  });

  it('/api/activity accepts session token via query param', async () => {
    const res = await fetch(`${baseUrl}/api/activity?session=test-session-token`);
    expect(res.status).toBe(200);
    const body = await res.json() as { events: any[]; serverTime: string; sessionToken?: string };
    expect(Array.isArray(body.events)).toBe(true);
    // No new sessionToken when already using a session
    expect(body.sessionToken).toBeUndefined();
  });

  it('/api/activity accepts session token via x-activity-session header', async () => {
    const res = await fetch(`${baseUrl}/api/activity`, {
      headers: { 'x-activity-session': 'test-session-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { events: any[]; serverTime: string };
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('/api/activity returns 401 for an invalid session token', async () => {
    const res = await fetch(`${baseUrl}/api/activity?session=bad-session-token`);
    expect(res.status).toBe(401);
  });

  it('/api/activity prefers session token over key when both provided', async () => {
    const mockIsValid = activityKeyManager.isValid as jest.MockedFunction<typeof activityKeyManager.isValid>;
    const mockCreateSession = activityKeyManager.createSession as jest.MockedFunction<typeof activityKeyManager.createSession>;
    mockIsValid.mockClear();
    mockCreateSession.mockClear();

    const res = await fetch(`${baseUrl}/api/activity?session=test-session-token&key=test-valid-key`);
    expect(res.status).toBe(200);
    // isValid should NOT be called because session check came first
    expect(mockIsValid).not.toHaveBeenCalled();
    // No new session created since we already had a valid one
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('/api/activity falls back to key when session is invalid', async () => {
    const mockIsSessionValid = activityKeyManager.isSessionValid as jest.MockedFunction<typeof activityKeyManager.isSessionValid>;
    const mockCreateSession = activityKeyManager.createSession as jest.MockedFunction<typeof activityKeyManager.createSession>;
    mockIsSessionValid.mockReturnValueOnce(false); // session invalid this time
    mockCreateSession.mockClear();

    const res = await fetch(`${baseUrl}/api/activity?session=expired-session&key=test-valid-key`);
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionToken?: string };
    // Should have created a new session from the valid key
    expect(mockCreateSession).toHaveBeenCalled();
    expect(body.sessionToken).toBe('test-session-token');
  });

  // ── Rate limiting ──────────────────────────────────────────────
  // The config mock sets max=5, windowMs=60000.
  // /activity and /api/privacy-policy share the same limiter instance,
  // so we test them together.  The previous tests already consumed some
  // of the budget, so we use a dedicated describe with its own server.

  describe('rate limiting', () => {
    let rlBaseUrl: string;
    let rlServer: http.Server | null = null;

    // Spin up a *fresh* outputs-server instance so the rate limiter starts
    // with a clean counter.  We cannot easily reset the limiter on the
    // shared instance because it's captured at module level.
    beforeAll(async () => {
      // Re-require to get a fresh OutputsServer with a clean rate limiter.
      // Because jest.mock is hoisted, the mocks are still active.
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { outputsServer: freshServer } = require('../src/utils/outputsServer');
        rlBaseUrl = '';
        rlServer = freshServer.getApp().listen(0, '127.0.0.1', () => {
          const addr = (rlServer as any).address() as { port: number };
          rlBaseUrl = `http://127.0.0.1:${addr.port}`;
        });
      });
      // Wait for the server to start listening
      await new Promise<void>((resolve) => {
        const check = () => {
          if (rlBaseUrl) return resolve();
          setTimeout(check, 10);
        };
        check();
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        if (!rlServer) return resolve();
        rlServer.close(() => { rlServer = null; resolve(); });
      });
    });

    it('/activity returns 429 after exceeding the rate limit', async () => {
      // Send max (5) requests — all should succeed
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${rlBaseUrl}/activity`);
        expect(res.status).toBe(200);
      }
      // 6th request should be rate-limited
      const res = await fetch(`${rlBaseUrl}/activity`);
      expect(res.status).toBe(429);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('Too Many Requests');
    });

    it('/api/privacy-policy shares the same rate-limit bucket', async () => {
      // After the previous test the bucket is already exhausted
      const res = await fetch(`${rlBaseUrl}/api/privacy-policy`);
      expect(res.status).toBe(429);
    });

    it('non-rate-limited routes still respond normally under pressure', async () => {
      // /health is NOT rate-limited
      const res = await fetch(`${rlBaseUrl}/health`);
      expect(res.status).toBe(200);
    });
  });
});
