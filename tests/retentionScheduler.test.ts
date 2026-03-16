/**
 * RetentionScheduler tests — exercises start/destroy lifecycle
 * and runAll() behaviour with various env configurations.
 */

// Mock logger
jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logError: jest.fn(),
    groomLogs: jest.fn(() => ({ deleted: [], skipped: 0 })),
  },
}));

// Mock fileHandler
jest.mock('../src/utils/fileHandler', () => ({
  fileHandler: {
    groomMedia: jest.fn(() => ({ deleted: [], skipped: 0, errors: 0 })),
  },
}));

import { retentionScheduler } from '../src/utils/retentionScheduler';
import { logger } from '../src/utils/logger';
import { fileHandler } from '../src/utils/fileHandler';

const originalEnv = { ...process.env };

afterEach(() => {
  retentionScheduler.destroy();
  jest.clearAllMocks();
  // Restore env
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe('RetentionScheduler', () => {
  describe('start() and destroy()', () => {
    it('should set timers on start and clear them on destroy', () => {
      jest.useFakeTimers();
      retentionScheduler.start();

      // Timers should be set (startupTimer)
      expect((retentionScheduler as any).startupTimer).not.toBeNull();

      retentionScheduler.destroy();
      expect((retentionScheduler as any).startupTimer).toBeNull();
      expect((retentionScheduler as any).intervalTimer).toBeNull();

      jest.useRealTimers();
    });

    it('should run initial grooming after startup delay', () => {
      jest.useFakeTimers();
      retentionScheduler.start();

      // Before delay: nothing called
      expect(logger.groomLogs).not.toHaveBeenCalled();
      expect(fileHandler.groomMedia).not.toHaveBeenCalled();

      // Advance past the 10s startup delay
      jest.advanceTimersByTime(10_000);

      expect(logger.groomLogs).toHaveBeenCalled();
      expect(fileHandler.groomMedia).toHaveBeenCalled();

      retentionScheduler.destroy();
      jest.useRealTimers();
    });

    it('should set interval timer after first run', () => {
      jest.useFakeTimers();
      retentionScheduler.start();

      jest.advanceTimersByTime(10_000);
      expect((retentionScheduler as any).intervalTimer).not.toBeNull();

      retentionScheduler.destroy();
      jest.useRealTimers();
    });
  });

  describe('runAll()', () => {
    it('should call groomLogs with LOG_RETENTION_DAYS default (7)', () => {
      delete process.env.LOG_RETENTION_DAYS;
      retentionScheduler.runAll();
      expect(logger.groomLogs).toHaveBeenCalledWith(7);
    });

    it('should call groomMedia with MEDIA_RETENTION_DAYS default (30)', () => {
      delete process.env.MEDIA_RETENTION_DAYS;
      retentionScheduler.runAll();
      expect(fileHandler.groomMedia).toHaveBeenCalledWith(30);
    });

    it('should parse custom retention values from env', () => {
      process.env.LOG_RETENTION_DAYS = '14';
      process.env.MEDIA_RETENTION_DAYS = '60';
      retentionScheduler.runAll();
      expect(logger.groomLogs).toHaveBeenCalledWith(14);
      expect(fileHandler.groomMedia).toHaveBeenCalledWith(60);
    });

    it('should skip log grooming when LOG_RETENTION_DAYS=0', () => {
      process.env.LOG_RETENTION_DAYS = '0';
      const result = retentionScheduler.runAll();
      expect(logger.groomLogs).not.toHaveBeenCalled();
      expect(result.logGrooming.disabled).toBe(true);
    });

    it('should skip media grooming when MEDIA_RETENTION_DAYS=0', () => {
      process.env.MEDIA_RETENTION_DAYS = '0';
      const result = retentionScheduler.runAll();
      expect(fileHandler.groomMedia).not.toHaveBeenCalled();
      expect(result.mediaGrooming.disabled).toBe(true);
    });

    it('should return combined results', () => {
      (logger.groomLogs as jest.Mock).mockReturnValueOnce({ deleted: ['old.log'], skipped: 2 });
      (fileHandler.groomMedia as jest.Mock).mockReturnValueOnce({ deleted: ['2024/01/01T00-00-00'], skipped: 5, errors: 0 });

      const result = retentionScheduler.runAll();

      expect(result.logGrooming.deleted).toEqual(['old.log']);
      expect(result.logGrooming.skipped).toBe(2);
      expect(result.logGrooming.disabled).toBe(false);
      expect(result.mediaGrooming.deleted).toEqual(['2024/01/01T00-00-00']);
      expect(result.mediaGrooming.skipped).toBe(5);
      expect(result.mediaGrooming.disabled).toBe(false);
    });
  });
});
