import * as fs from 'fs';
import * as path from 'path';

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

    const logLine = `[${entry.timestamp}] [${entry.level}] [${entry.status}] [${entry.requester}] ${entry.data}`;

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
          chunkSize = Math.min(chunkSize * 2, MAX_BYTES, stat.size);
          if (chunkSize >= stat.size) {
            // Read the whole file — final attempt
            const fullBuf = Buffer.alloc(stat.size);
            fs.readSync(fd, fullBuf, 0, stat.size, 0);
            lines = fullBuf.toString('utf-8').split('\n').filter(Boolean);
            break;
          }
        }

        return lines.slice(-count);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  }
}

export const logger = new Logger();
