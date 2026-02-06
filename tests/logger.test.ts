/**
 * Logger tests — exercises log formatting, file creation, and
 * convenience methods without any Discord dependencies.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We need to construct a Logger instance pointing to a temp dir.
// The exported singleton uses a hardcoded path, so we import the
// module and override the private logsDir before testing.

import { logger } from '../src/utils/logger';

describe('Logger', () => {
  let tempDir: string;
  let originalLogsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
    originalLogsDir = (logger as any).logsDir;
    (logger as any).logsDir = tempDir;
  });

  afterEach(() => {
    (logger as any).logsDir = originalLogsDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function readLatestLog(): string {
    const files = fs.readdirSync(tempDir).filter((f) => f.endsWith('.log'));
    expect(files.length).toBeGreaterThan(0);
    return fs.readFileSync(path.join(tempDir, files[0]), 'utf-8');
  }

  describe('log', () => {
    it('should write a formatted log line to a date-named file', () => {
      logger.log('success', 'testuser', 'hello world');

      const content = readLatestLog();
      expect(content).toMatch(/\[.*\] \[success\] \[testuser\] hello world/);
    });

    it('should use ISO timestamp format', () => {
      logger.log('error', 'user1', 'test message');

      const content = readLatestLog();
      // ISO 8601: YYYY-MM-DDTHH:MM:SS.sssZ
      expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should create log file named YYYY-MM-DD.log', () => {
      logger.log('success', 'user', 'data');

      const files = fs.readdirSync(tempDir);
      const logFile = files.find((f) => f.endsWith('.log'));
      expect(logFile).toMatch(/^\d{4}-\d{2}-\d{2}\.log$/);
    });

    it('should append multiple log entries to the same file', () => {
      logger.log('success', 'user1', 'first');
      logger.log('error', 'user2', 'second');
      logger.log('busy', 'user3', 'third');

      const content = readLatestLog();
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(3);
    });
  });

  describe('convenience methods', () => {
    it('logRequest should prefix with REQUEST:', () => {
      logger.logRequest('alice', 'generate a cat');

      const content = readLatestLog();
      expect(content).toContain('[success]');
      expect(content).toContain('[alice]');
      expect(content).toContain('REQUEST: generate a cat');
    });

    it('logReply should prefix with REPLY:', () => {
      logger.logReply('bob', 'image sent');

      const content = readLatestLog();
      expect(content).toContain('[success]');
      expect(content).toContain('REPLY: image sent');
    });

    it('logError should use error status and prefix with ERROR:', () => {
      logger.logError('system', 'something broke');

      const content = readLatestLog();
      expect(content).toContain('[error]');
      expect(content).toContain('ERROR: something broke');
    });

    it('logBusy should use busy status and prefix with API_BUSY:', () => {
      logger.logBusy('carol', 'comfyui');

      const content = readLatestLog();
      expect(content).toContain('[busy]');
      expect(content).toContain('API_BUSY: comfyui');
    });

    it('logTimeout should use timeout status and prefix with TIMEOUT:', () => {
      logger.logTimeout('dave', 'generate');

      const content = readLatestLog();
      expect(content).toContain('[timeout]');
      expect(content).toContain('TIMEOUT: generate');
    });
  });
});
