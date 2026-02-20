import * as fs from 'fs';
import * as path from 'path';
import { getThreadId } from './threadContext';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export type LogStatus = 'success' | 'error' | 'warn' | 'busy' | 'timeout' | 'debug';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  status: LogStatus;
  requester: string;
  data: string;
}

class Logger {
  private logsDir = path.join(__dirname, '../../outputs/logs');

  /**
   * Patterns that match sensitive values in log output.
   * Each regex targets a key=value or key:"value" style, replacing the value
   * portion with '***' while keeping the key visible for diagnostics.
   *
   * Addresses CodeQL js/clear-text-logging by ensuring API keys and tokens
   * are never emitted to console or file sinks.
   */
  private static readonly REDACT_PATTERNS: { pattern: RegExp; replacement: string }[] = [
    // JSON-style: "api_key":"VALUE" or "apiKey":"VALUE"
    { pattern: /("(?:api_key|apiKey|api[-_]?secret|token|secret|password|authorization|bearer)":\s*")([^"]+)(")/gi, replacement: '$1***$3' },
    // Query-string / param style: api_key=VALUE (up to & or whitespace)
    { pattern: /((?:api_key|apiKey|api[-_]?secret|token|secret|password|authorization)=)([^\s&"]+)/gi, replacement: '$1***' },
  ];

  /**
   * Redact sensitive values from a log line before it reaches any sink.
   */
  static redactSecrets(line: string): string {
    let result = line;
    for (const { pattern, replacement } of Logger.REDACT_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  constructor() {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  private getLogFilePath(): string {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(this.logsDir, `${dateStr}.log`);
  }

  private formatTimestamp(): string {
    const now = new Date();
    return now.toISOString(); // ISO format with timestamp
  }

  private statusToLevel(status: LogStatus): LogLevel {
    switch (status) {
      case 'success': return 'info';
      case 'error': return 'error';
      case 'warn': return 'warn';
      case 'busy': return 'warn';
      case 'timeout': return 'warn';
      case 'debug': return 'debug';
    }
  }

  log(
    status: LogStatus,
    requester: string,
    data: string
  ): void {
    const level = this.statusToLevel(status);
    const entry: LogEntry = {
      timestamp: this.formatTimestamp(),
      level,
      status,
      requester,
      data,
    };

    const threadId = getThreadId();
    const threadTag = threadId ? ` [${threadId}]` : '';
    const rawLine = `[${entry.timestamp}] [${entry.level}] [${entry.status}] [${entry.requester}]${threadTag} ${entry.data}`;

    // Redact secrets before any sink (console or file). Addresses CodeQL
    // js/clear-text-logging alerts #8/#9/#10.
    const logLine = Logger.redactSecrets(rawLine);

    // Write to console (same line as file)
    switch (level) {
      case 'error':
        console.error(logLine);
        break;
      case 'warn':
        console.warn(logLine);
        break;
      default:
        console.log(logLine);
    }

    // Write to file
    const logFile = this.getLogFilePath();
    try {
      fs.appendFileSync(logFile, logLine + '\n', 'utf-8');
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  logRequest(requester: string, messageContent: string): void {
    this.log('success', requester, `REQUEST: ${messageContent}`);
  }

  /**
   * Check whether debug logging is enabled.
   * Reads process.env directly to avoid circular dependency with config.
   */
  isDebugEnabled(): boolean {
    return process.env.DEBUG_LOGGING === 'true';
  }

  logIncoming(
    username: string,
    userId: string,
    channelType: string,
    guildName: string | null,
    content: string
  ): void {
    const location = guildName ? `Guild: ${guildName}` : 'DM';
    const preview = content.length > 100 ? content.substring(0, 100) + '...' : content;
    this.log('success', username, `INCOMING: (${userId}) (${location}) [${channelType}] "${preview}"`);

    // DEBUG: log full message content when enabled and truncated
    if (this.isDebugEnabled() && content.length > 100) {
      this.logDebug(username, `INCOMING [full]: "${content}"`);
    }
  }

  logIgnored(username: string, reason: string): void {
    this.log('success', username, `IGNORED: ${reason}`);
  }

  logDefault(username: string, content: string): void {
    const preview = content.length > 80 ? content.substring(0, 80) + '...' : content;
    this.log('success', username, `USING_DEFAULT: No keyword found, defaulting to Ollama for: "${preview}"`);
  }

  logReply(requester: string, messageContent: string, replyContent?: string): void {
    this.log('success', requester, `REPLY: ${messageContent}`);

    // Log reply content: truncated by default, full when DEBUG enabled
    if (replyContent !== undefined) {
      if (this.isDebugEnabled()) {
        this.logDebug(requester, `REPLY [full]: ${replyContent}`);
      } else {
        const truncated = replyContent.length > 200
          ? replyContent.substring(0, 200) + '...'
          : replyContent;
        this.log('success', requester, `REPLY [content]: ${truncated}`);
      }
    }
  }

  /**
   * Log a debug-level message. Only written when DEBUG_LOGGING is enabled.
   */
  logDebug(requester: string, data: string): void {
    if (!this.isDebugEnabled()) return;
    this.log('debug', requester, `DEBUG: ${data}`);
  }

  /**
   * Log a debug-level message using a lazy builder function.
   * The builder is only called when DEBUG_LOGGING is enabled,
   * avoiding expensive operations (e.g. JSON.stringify) when debug is off.
   */
  logDebugLazy(requester: string, build: () => string): void {
    if (!this.isDebugEnabled()) return;
    this.log('debug', requester, `DEBUG: ${build()}`);
  }

  logError(requester: string, error: string): void {
    this.log('error', requester, `ERROR: ${error}`);
  }

  logWarn(requester: string, warning: string): void {
    this.log('warn', requester, `WARN: ${warning}`);
  }

  logBusy(requester: string, api: string): void {
    this.log('busy', requester, `API_BUSY: ${api}`);
  }

  logTimeout(requester: string, keyword: string): void {
    this.log('timeout', requester, `TIMEOUT: ${keyword}`);
  }

  /**
   * Read the last N lines from today's log file.
   * Used by the configurator status console to tail the log.
   */
  getRecentLines(count: number = 200): string[] {
    const logFile = this.getLogFilePath();
    try {
      if (!fs.existsSync(logFile)) return [];
      const stat = fs.statSync(logFile);
      if (stat.size === 0) return [];

      // Tail-read strategy: start with a chunk from the end and expand if
      // we haven't found enough lines, up to a hard cap of 512 KB.
      const MAX_BYTES = 512 * 1024;
      const fd = fs.openSync(logFile, 'r');
      try {
        let chunkSize = Math.min(count * 256, MAX_BYTES, stat.size);
        let lines: string[] = [];

        while (true) {
          const start = Math.max(0, stat.size - chunkSize);
          const buf = Buffer.alloc(chunkSize);
          fs.readSync(fd, buf, 0, chunkSize, start);
          const text = buf.toString('utf-8');
          lines = text.split('\n').filter(Boolean);

          // Enough lines, or we've already read from the start of the file
          if (lines.length >= count || start === 0) break;

          // Double the chunk and retry
          const prevChunkSize = chunkSize;
          chunkSize = Math.min(chunkSize * 2, MAX_BYTES, stat.size);
          if (chunkSize >= stat.size) {
            // Read the whole file — final attempt
            const fullBuf = Buffer.alloc(stat.size);
            fs.readSync(fd, fullBuf, 0, stat.size, 0);
            lines = fullBuf.toString('utf-8').split('\n').filter(Boolean);
            break;
          }

          // Guard: if chunkSize cannot grow (capped at MAX_BYTES while
          // file is larger), stop to avoid an infinite loop.
          if (chunkSize <= prevChunkSize) break;
        }

        return lines.slice(-count);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  }

  /**
   * Read ALL lines from today's log file.
   * Used by the configurator expanded log viewer.
   */
  getAllLines(): string[] {
    const logFile = this.getLogFilePath();
    try {
      if (!fs.existsSync(logFile)) return [];
      const content = fs.readFileSync(logFile, 'utf-8');
      return content.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Rotate the current active log file.
   *
   * Copies the current log content into an archive file named
   * `YYYY-MM-DD_N.log` (next available index) in the same directory,
   * then truncates the active log file so new writes start fresh.
   *
   * The active log filename remains stable (`YYYY-MM-DD.log`).
   *
   * Returns metadata about the rotation, or null if there is nothing
   * to rotate (e.g. no log file exists yet).
   */
  rotateLog(): { archivedPath: string; archivedName: string; activeFile: string } | null {
    const logFile = this.getLogFilePath();

    if (!fs.existsSync(logFile)) return null;
    const stat = fs.statSync(logFile);
    if (stat.size === 0) return null;

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD

    // Find next available index for the archive
    let index = 0;
    let archivedPath: string;
    do {
      archivedPath = path.join(this.logsDir, `${dateStr}_${index}.log`);
      index++;
    } while (fs.existsSync(archivedPath));

    // Copy current log to archive, then truncate active file
    fs.copyFileSync(logFile, archivedPath);
    fs.writeFileSync(logFile, '', 'utf-8');

    const archivedName = path.basename(archivedPath);
    this.log('success', 'system', `LOG-ROTATE: Archived to ${archivedName} and cleared active log`);

    return {
      archivedPath,
      archivedName,
      activeFile: path.basename(logFile),
    };
  }
}

export const logger = new Logger();
