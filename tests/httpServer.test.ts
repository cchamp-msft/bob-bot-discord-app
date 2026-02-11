import { httpServer } from '../src/utils/httpServer';

describe('httpServer', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(async () => {
    process.env = originalEnv;
    try {
      await httpServer.stop();
    } catch {
      // ignore
    }
  });

  it('defaults to binding 127.0.0.1 when HTTP_HOST is not set', () => {
    delete process.env.HTTP_HOST;

    const app: any = httpServer.getApp();
    const listenMock = jest.fn((_port: number, _host: string, cb?: () => void) => {
      if (typeof cb === 'function') cb();
      return {
        close: (closeCb: (err?: unknown) => void) => closeCb(),
      };
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
      return {
        close: (closeCb: (err?: unknown) => void) => closeCb(),
      };
    });

    app.listen = listenMock;

    httpServer.start();

    expect(listenMock).toHaveBeenCalled();
    expect(listenMock.mock.calls[0][1]).toBe('0.0.0.0');
  });
});
