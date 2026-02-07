/**
 * Logger tests — exercises log formatting, file creation, console output,
 * and convenience methods without any Discord dependencies.
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
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
    originalLogsDir = (logger as any).logsDir;
    (logger as any).logsDir = tempDir;
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    (logger as any).logsDir = originalLogsDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  function readLatestLog(): string {
    const files = fs.readdirSync(tempDir).filter((f) => f.endsWith('.log'));
    expect(files.length).toBeGreaterThan(0);
    return fs.readFileSync(path.join(tempDir, files[0]), 'utf-8');
  }

  describe('log', () => {
    it('should write a formatted log line with level and status to a date-named file', () => {
      logger.log('success', 'testuser', 'hello world');

      const content = readLatestLog();
      expect(content).toMatch(/\[.*\] \[info\] \[success\] \[testuser\] hello world/);
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

    it('should write the same line to both console and file', () => {
      logger.log('success', 'testuser', 'hello world');

      const fileContent = readLatestLog().trim();
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy.mock.calls[0][0]).toBe(fileContent);
    });

    it('should use console.error for error-level logs', () => {
      logger.log('error', 'user', 'bad thing');

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy.mock.calls[0][0]).toContain('[error]');
    });

    it('should use console.warn for warn-level logs', () => {
      logger.log('busy', 'user', 'busy thing');

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy.mock.calls[0][0]).toContain('[warn]');
    });

    it('should map status to correct level', () => {
      logger.log('success', 'u', 'a');
      logger.log('error', 'u', 'b');
      logger.log('warn', 'u', 'c');
      logger.log('busy', 'u', 'd');
      logger.log('timeout', 'u', 'e');

      const content = readLatestLog();
      const lines = content.trim().split('\n');
      expect(lines[0]).toContain('[info] [success]');
      expect(lines[1]).toContain('[error] [error]');
      expect(lines[2]).toContain('[warn] [warn]');
      expect(lines[3]).toContain('[warn] [busy]');
      expect(lines[4]).toContain('[warn] [timeout]');
    });
  });

  describe('convenience methods', () => {
    it('logRequest should prefix with REQUEST:', () => {
      logger.logRequest('alice', 'generate a cat');

      const content = readLatestLog();
      expect(content).toContain('[info]');
      expect(content).toContain('[success]');
      expect(content).toContain('[alice]');
      expect(content).toContain('REQUEST: generate a cat');
    });

    it('logReply should prefix with REPLY:', () => {
      logger.logReply('bob', 'image sent');

      const content = readLatestLog();
      expect(content).toContain('[info]');
      expect(content).toContain('[success]');
      expect(content).toContain('REPLY: image sent');
    });

    it('logError should use error status and level, prefix with ERROR:', () => {
      logger.logError('system', 'something broke');

      const content = readLatestLog();
      expect(content).toContain('[error] [error]');
      expect(content).toContain('ERROR: something broke');
    });

    it('logWarn should use warn level and warn status, prefix with WARN:', () => {
      logger.logWarn('config', 'invalid value');

      const content = readLatestLog();
      expect(content).toContain('[warn] [warn]');
      expect(content).toContain('WARN: invalid value');
    });

    it('logBusy should use busy status and prefix with API_BUSY:', () => {
      logger.logBusy('carol', 'comfyui');

      const content = readLatestLog();
      expect(content).toContain('[warn]');
      expect(content).toContain('[busy]');
      expect(content).toContain('API_BUSY: comfyui');
    });

    it('logTimeout should use timeout status and prefix with TIMEOUT:', () => {
      logger.logTimeout('dave', 'generate');

      const content = readLatestLog();
      expect(content).toContain('[warn]');
      expect(content).toContain('[timeout]');
      expect(content).toContain('TIMEOUT: generate');
    });

    it('logIncoming should log message details with INCOMING prefix', () => {
      logger.logIncoming('alice', '12345', 'DM', null, 'hello bot');

      const content = readLatestLog();
      expect(content).toContain('[info]');
      expect(content).toContain('[success]');
      expect(content).toContain('[alice]');
      expect(content).toContain('INCOMING:');
      expect(content).toContain('(12345)');
      expect(content).toContain('DM');
      expect(content).toContain('"hello bot"');
    });

    it('logIncoming should show guild name when provided', () => {
      logger.logIncoming('bob', '67890', 'GuildText', 'My Server', 'test message');

      const content = readLatestLog();
      expect(content).toContain('Guild: My Server');
    });

    it('logIncoming should truncate long content to 100 chars', () => {
      const longContent = 'a'.repeat(150);
      logger.logIncoming('carol', '11111', 'DM', null, longContent);

      const content = readLatestLog();
      expect(content).toContain('a'.repeat(100) + '...');
    });

    it('logIgnored should prefix with IGNORED:', () => {
      logger.logIgnored('dave', 'Empty message after mention removal');

      const content = readLatestLog();
      expect(content).toContain('[info]');
      expect(content).toContain('[success]');
      expect(content).toContain('IGNORED: Empty message after mention removal');
    });

    it('logDefault should prefix with USING_DEFAULT:', () => {
      logger.logDefault('eve', 'what is the weather?');

      const content = readLatestLog();
      expect(content).toContain('[info]');
      expect(content).toContain('[success]');
      expect(content).toContain('USING_DEFAULT: No keyword found, defaulting to Ollama for: "what is the weather?"');
    });
  });

  describe('getRecentLines', () => {
    it('should return empty array when no log file exists', () => {
      const lines = logger.getRecentLines();
      expect(lines).toEqual([]);
    });

    it('should return all lines when fewer than count', () => {
      logger.log('success', 'user', 'line 1');
      logger.log('success', 'user', 'line 2');

      const lines = logger.getRecentLines(10);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('line 1');
      expect(lines[1]).toContain('line 2');
    });

    it('should return only the last N lines when more exist', () => {
      for (let i = 0; i < 10; i++) {
        logger.log('success', 'user', `line ${i}`);
      }

      const lines = logger.getRecentLines(3);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('line 7');
      expect(lines[1]).toContain('line 8');
      expect(lines[2]).toContain('line 9');
    });

    it('should default to 200 lines', () => {
      for (let i = 0; i < 5; i++) {
        logger.log('success', 'user', `line ${i}`);
      }

      const lines = logger.getRecentLines();
      expect(lines).toHaveLength(5);
    });
  });
});
