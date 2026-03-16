import { logger } from './logger';
import { fileHandler } from './fileHandler';

/** Delay before the first grooming run (10 seconds — let servers boot). */
const STARTUP_DELAY_MS = 10_000;

/** Interval between grooming runs (24 hours). */
const INTERVAL_MS = 24 * 60 * 60 * 1000;

class RetentionScheduler {
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Execute both log and media grooming passes.
   * Reads retention values directly from env to avoid circular dep with config
   * (consistent with logger.ts rotateLog pattern).
   */
  runAll(): { logGrooming: { deleted: string[]; skipped: number; disabled: boolean }; mediaGrooming: { deleted: string[]; skipped: number; errors: number; disabled: boolean } } {
    logger.log('success', 'system', 'RETENTION: Running scheduled grooming');

    // Log grooming
    const logRetention = parseInt(process.env.LOG_RETENTION_DAYS || '7', 10);
    const logDisabled = logRetention === 0 || isNaN(logRetention);
    const logResult = logDisabled
      ? { deleted: [] as string[], skipped: 0 }
      : logger.groomLogs(logRetention);

    // Media grooming
    const mediaRetention = parseInt(process.env.MEDIA_RETENTION_DAYS || '30', 10);
    const mediaDisabled = mediaRetention === 0 || isNaN(mediaRetention);
    const mediaResult = mediaDisabled
      ? { deleted: [] as string[], skipped: 0, errors: 0 }
      : fileHandler.groomMedia(mediaRetention);

    return {
      logGrooming: { ...logResult, disabled: logDisabled },
      mediaGrooming: { ...mediaResult, disabled: mediaDisabled },
    };
  }

  /** Start the scheduler: initial run after 10s, then every 24h. */
  start(): void {
    this.startupTimer = setTimeout(() => {
      this.runAll();
      this.intervalTimer = setInterval(() => this.runAll(), INTERVAL_MS);
    }, STARTUP_DELAY_MS);
  }

  /** Clear all timers. */
  destroy(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }
}

export const retentionScheduler = new RetentionScheduler();
