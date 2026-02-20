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
import { runWithThreadId } from '../src/utils/threadContext';

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

    it('should include a thread tag when called inside a thread context', () => {
      runWithThreadId('a1b2', () => {
        logger.log('success', 'testuser', 'threaded log');
      });

      const content = readLatestLog();
      expect(content).toContain('[testuser] [a1b2]');
      expect(content).toContain('threaded log');
    });

    it('should omit thread tag when called outside a thread context', () => {
      logger.log('success', 'testuser', 'no thread');

      const content = readLatestLog();
      // Should NOT have a thread tag bracket pair after requester
      expect(content).toMatch(/\[testuser\] no thread/);
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

    it('should not infinite-loop when file exceeds MAX_BYTES with few long lines', () => {
      // Write a log file with very few, extremely long lines so that the
      // last 512 KB chunk contains fewer than `count` lines and chunkSize
      // caps at MAX_BYTES. Before the fix this caused an infinite loop.
      const logFile = (logger as unknown as { getLogFilePath: () => string }).getLogFilePath();
      const longLine = 'X'.repeat(600_000); // 600 KB — single line > MAX_BYTES
      const fs = require('fs');
      fs.mkdirSync(require('path').dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, longLine + '\nshort\n', 'utf-8');

      // This call must terminate quickly. If the bug is present it would loop forever.
      const start = Date.now();
      const lines = logger.getRecentLines(200);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(5000); // should finish in well under 5s
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[lines.length - 1]).toBe('short');
    });
  });

  describe('logReply with content', () => {
    it('should log truncated reply content by default (no DEBUG)', () => {
      const longContent = 'a'.repeat(300);
      logger.logReply('alice', 'Ollama response sent: 300 characters', longContent);

      const content = readLatestLog();
      const lines = content.trim().split('\n');
      // First line: normal REPLY log, second line: truncated content
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('REPLY: Ollama response sent: 300 characters');
      expect(lines[1]).toContain('REPLY [content]: ' + 'a'.repeat(200) + '...');
    });

    it('should log short reply content without truncation', () => {
      logger.logReply('bob', 'Ollama response sent: 50 characters', 'short reply');

      const content = readLatestLog();
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('REPLY [content]: short reply');
      expect(lines[1]).not.toContain('...');
    });

    it('should not log content line when replyContent is omitted', () => {
      logger.logReply('carol', 'ComfyUI response sent: 2 images');

      const content = readLatestLog();
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('REPLY: ComfyUI response sent: 2 images');
    });

    it('should log full reply content when DEBUG_LOGGING is enabled', () => {
      process.env.DEBUG_LOGGING = 'true';
      try {
        const longContent = 'b'.repeat(500);
        logger.logReply('dave', 'response info', longContent);

        const content = readLatestLog();
        expect(content).toContain('REPLY [full]: ' + 'b'.repeat(500));
        expect(content).not.toContain('REPLY [content]:');
      } finally {
        delete process.env.DEBUG_LOGGING;
      }
    });
  });

  describe('logDebug', () => {
    it('should not write when DEBUG_LOGGING is not set', () => {
      delete process.env.DEBUG_LOGGING;
      logger.logDebug('alice', 'secret debug info');

      const logFile = (logger as any).getLogFilePath();
      const exists = fs.existsSync(logFile);
      // No file should be created since nothing was logged
      expect(exists).toBe(false);
    });

    it('should write debug log when DEBUG_LOGGING is true', () => {
      process.env.DEBUG_LOGGING = 'true';
      try {
        logger.logDebug('alice', 'debug info here');

        const content = readLatestLog();
        expect(content).toContain('[debug]');
        expect(content).toContain('DEBUG: debug info here');
      } finally {
        delete process.env.DEBUG_LOGGING;
      }
    });
  });

  describe('logIncoming with DEBUG', () => {
    it('should log full content when DEBUG enabled and content is long', () => {
      process.env.DEBUG_LOGGING = 'true';
      try {
        const longMsg = 'x'.repeat(200);
        logger.logIncoming('user1', '12345', 'DM', null, longMsg);

        const content = readLatestLog();
        const lines = content.trim().split('\n');
        // Normal truncated line + debug full line
        expect(lines.length).toBeGreaterThanOrEqual(2);
        expect(lines[0]).toContain('x'.repeat(100) + '...');
        expect(lines[1]).toContain('INCOMING [full]:');
        expect(lines[1]).toContain('x'.repeat(200));
      } finally {
        delete process.env.DEBUG_LOGGING;
      }
    });

    it('should not log debug line for short content even with DEBUG enabled', () => {
      process.env.DEBUG_LOGGING = 'true';
      try {
        logger.logIncoming('user1', '12345', 'DM', null, 'short msg');

        const content = readLatestLog();
        const lines = content.trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('"short msg"');
      } finally {
        delete process.env.DEBUG_LOGGING;
      }
    });
  });

  describe('debug log level mapping', () => {
    it('should map debug status to debug level', () => {
      process.env.DEBUG_LOGGING = 'true';
      try {
        logger.log('debug', 'user', 'test debug');

        const content = readLatestLog();
        expect(content).toContain('[debug] [debug]');
      } finally {
        delete process.env.DEBUG_LOGGING;
      }
    });
  });

  describe('logDebugLazy', () => {
    it('should not call builder when DEBUG_LOGGING is off', () => {
      delete process.env.DEBUG_LOGGING;
      const builder = jest.fn(() => 'expensive string');
      logger.logDebugLazy('alice', builder);

      expect(builder).not.toHaveBeenCalled();
      const logFile = (logger as any).getLogFilePath();
      expect(fs.existsSync(logFile)).toBe(false);
    });

    it('should call builder and log when DEBUG_LOGGING is true', () => {
      process.env.DEBUG_LOGGING = 'true';
      try {
        const builder = jest.fn(() => 'lazy debug data');
        logger.logDebugLazy('bob', builder);

        expect(builder).toHaveBeenCalledTimes(1);
        const content = readLatestLog();
        expect(content).toContain('[debug]');
        expect(content).toContain('DEBUG: lazy debug data');
      } finally {
        delete process.env.DEBUG_LOGGING;
      }
    });
  });

  describe('logReply with empty-string content', () => {
    it('should log content line for empty-string replyContent', () => {
      logger.logReply('eve', 'Response sent: 0 characters', '');

      const content = readLatestLog();
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('REPLY: Response sent: 0 characters');
      expect(lines[1]).toContain('REPLY [content]:');
    });
  });

  describe('isDebugEnabled', () => {
    it('should return false when DEBUG_LOGGING is not set', () => {
      delete process.env.DEBUG_LOGGING;
      expect(logger.isDebugEnabled()).toBe(false);
    });

    it('should return true when DEBUG_LOGGING is true', () => {
      process.env.DEBUG_LOGGING = 'true';
      try {
        expect(logger.isDebugEnabled()).toBe(true);
      } finally {
        delete process.env.DEBUG_LOGGING;
      }
    });
  });

  describe('getAllLines', () => {
    it('should return empty array when no log file exists', () => {
      const lines = logger.getAllLines();
      expect(lines).toEqual([]);
    });

    it('should return all lines from the log file', () => {
      for (let i = 0; i < 5; i++) {
        logger.log('success', 'user', `line ${i}`);
      }
      const lines = logger.getAllLines();
      expect(lines).toHaveLength(5);
      expect(lines[0]).toContain('line 0');
      expect(lines[4]).toContain('line 4');
    });
  });

  describe('rotateLog', () => {
    it('should return null when no log file exists', () => {
      const result = logger.rotateLog();
      expect(result).toBeNull();
    });

    it('should return null when log file is empty', () => {
      // Create an empty log file
      const logFile = (logger as any).getLogFilePath();
      fs.writeFileSync(logFile, '', 'utf-8');

      const result = logger.rotateLog();
      expect(result).toBeNull();
    });

    it('should archive current log and clear active file', () => {
      logger.log('success', 'user', 'before rotate');

      const result = logger.rotateLog();
      expect(result).not.toBeNull();
      expect(result!.archivedName).toMatch(/^\d{4}-\d{2}-\d{2}_0\.log$/);
      expect(result!.activeFile).toMatch(/^\d{4}-\d{2}-\d{2}\.log$/);

      // Archive should contain the original content
      const archivedContent = fs.readFileSync(result!.archivedPath, 'utf-8');
      expect(archivedContent).toContain('before rotate');

      // Active log should only contain the rotation log entry
      const activeFile = (logger as any).getLogFilePath();
      const activeContent = fs.readFileSync(activeFile, 'utf-8');
      expect(activeContent).toContain('LOG-ROTATE');
      expect(activeContent).not.toContain('before rotate');
    });

    it('should increment index for multiple rotations', () => {
      logger.log('success', 'user', 'first content');
      const result1 = logger.rotateLog();
      expect(result1!.archivedName).toMatch(/_0\.log$/);

      logger.log('success', 'user', 'second content');
      const result2 = logger.rotateLog();
      expect(result2!.archivedName).toMatch(/_1\.log$/);

      logger.log('success', 'user', 'third content');
      const result3 = logger.rotateLog();
      expect(result3!.archivedName).toMatch(/_2\.log$/);
    });

    it('should allow new writes after rotation', () => {
      logger.log('success', 'user', 'before');
      logger.rotateLog();
      logger.log('success', 'user', 'after rotate');

      const lines = logger.getRecentLines();
      expect(lines.some(l => l.includes('after rotate'))).toBe(true);
      expect(lines.some(l => l.includes('before'))).toBe(false);
    });
  });

  // ── Secret redaction (CodeQL js/clear-text-logging) ──────

  describe('redactSecrets', () => {
    it('should redact JSON-style api_key values', () => {
      const input = '{"api_key":"sk-secret-123","query":"hello"}';
      const result = (logger.constructor as any).redactSecrets(input);
      expect(result).not.toContain('sk-secret-123');
      expect(result).toContain('"api_key":"***"');
    });

    it('should redact query-string style api_key=VALUE', () => {
      const input = 'REQUEST: api_key=mySecretKey123&q=test';
      const result = (logger.constructor as any).redactSecrets(input);
      expect(result).not.toContain('mySecretKey123');
      expect(result).toContain('api_key=***');
    });

    it('should redact token values in JSON format', () => {
      const input = '{"token":"abc123","data":"safe"}';
      const result = (logger.constructor as any).redactSecrets(input);
      expect(result).not.toContain('abc123');
      expect(result).toContain('"token":"***"');
    });

    it('should redact password values', () => {
      const input = '{"password":"hunter2"}';
      const result = (logger.constructor as any).redactSecrets(input);
      expect(result).not.toContain('hunter2');
      expect(result).toContain('"password":"***"');
    });

    it('should leave non-sensitive data unchanged', () => {
      const input = 'Normal log message with no secrets';
      const result = (logger.constructor as any).redactSecrets(input);
      expect(result).toBe(input);
    });

    it('should redact multiple occurrences in one line', () => {
      const input = 'api_key=secret1&token=secret2';
      const result = (logger.constructor as any).redactSecrets(input);
      expect(result).not.toContain('secret1');
      expect(result).not.toContain('secret2');
    });
  });

  describe('log method applies redaction to sinks', () => {
    it('should redact api_key in console output', () => {
      logger.log('success', 'test', 'Params: api_key=realSecret123&q=hello');
      const loggedLine = consoleSpy.mock.calls[0][0];
      expect(loggedLine).not.toContain('realSecret123');
      expect(loggedLine).toContain('api_key=***');
    });

    it('should redact api_key in file output', () => {
      logger.log('success', 'test', 'Params: api_key=realSecret123&q=hello');
      const content = readLatestLog();
      expect(content).not.toContain('realSecret123');
      expect(content).toContain('api_key=***');
    });

    it('should redact in error-level output', () => {
      logger.log('error', 'test', '{"api_key":"thekey","msg":"fail"}');
      const loggedLine = consoleErrorSpy.mock.calls[0][0];
      expect(loggedLine).not.toContain('thekey');
    });

    it('should redact in warn-level output', () => {
      logger.log('warn', 'test', '{"token":"tok123"}');
      const loggedLine = consoleWarnSpy.mock.calls[0][0];
      expect(loggedLine).not.toContain('tok123');
    });
  });
});
