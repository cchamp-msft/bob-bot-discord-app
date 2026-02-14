/**
 * OutputsServer tests — verifies the dedicated outputs file server
 * starts on the configured port/host, and shuts down cleanly.
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

import { outputsServer } from '../src/utils/outputsServer';

describe('OutputsServer', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(async () => {
    process.env = originalEnv;
    try {
      await outputsServer.stop();
    } catch {
      // ignore
    }
  });

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
});
