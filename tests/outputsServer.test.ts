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
    getOutputBaseUrl: () => 'http://localhost:3003',
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

import http from 'http';
import { outputsServer } from '../src/utils/outputsServer';
import { activityEvents } from '../src/utils/activityEvents';
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

  it('has trust proxy explicitly disabled', () => {
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
    const res = await fetch(`${baseUrl}/api/activity`);
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
    await fetch(`${baseUrl}/api/activity?since=${encodeURIComponent(since)}`);

    expect(mockGetRecent).toHaveBeenCalledWith(50, since);
  });

  it('/api/activity respects count query parameter (capped at 100)', async () => {
    const mockGetRecent = activityEvents.getRecent as jest.MockedFunction<typeof activityEvents.getRecent>;
    mockGetRecent.mockClear();

    await fetch(`${baseUrl}/api/activity?count=10`);
    expect(mockGetRecent).toHaveBeenCalledWith(10, undefined);
  });

  it('/api/activity caps count at 100', async () => {
    const mockGetRecent = activityEvents.getRecent as jest.MockedFunction<typeof activityEvents.getRecent>;
    mockGetRecent.mockClear();

    await fetch(`${baseUrl}/api/activity?count=999`);
    expect(mockGetRecent).toHaveBeenCalledWith(100, undefined);
  });

  it('/api/activity ignores invalid count parameter', async () => {
    const mockGetRecent = activityEvents.getRecent as jest.MockedFunction<typeof activityEvents.getRecent>;
    mockGetRecent.mockClear();

    await fetch(`${baseUrl}/api/activity?count=abc`);
    expect(mockGetRecent).toHaveBeenCalledWith(50, undefined);
  });

  it('/api/activity has security headers', async () => {
    const res = await fetch(`${baseUrl}/api/activity`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});
