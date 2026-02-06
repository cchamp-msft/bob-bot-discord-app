import * as fs from 'fs';
import * as path from 'path';

interface LogEntry {
  timestamp: string;
  status: 'success' | 'error' | 'busy' | 'timeout';
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

  log(
    status: 'success' | 'error' | 'busy' | 'timeout',
    requester: string,
    data: string
  ): void {
    const entry: LogEntry = {
      timestamp: this.formatTimestamp(),
      status,
      requester,
      data,
    };

    const logLine = `[${entry.timestamp}] [${entry.status}] [${entry.requester}] ${entry.data}\n`;

    const logFile = this.getLogFilePath();
    try {
      fs.appendFileSync(logFile, logLine, 'utf-8');
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  logRequest(requester: string, messageContent: string): void {
    this.log('success', requester, `REQUEST: ${messageContent}`);
  }

  logReply(requester: string, messageContent: string): void {
    this.log('success', requester, `REPLY: ${messageContent}`);
  }

  logError(requester: string, error: string): void {
    this.log('error', requester, `ERROR: ${error}`);
  }

  logBusy(requester: string, api: string): void {
    this.log('busy', requester, `API_BUSY: ${api}`);
  }

  logTimeout(requester: string, keyword: string): void {
    this.log('timeout', requester, `TIMEOUT: ${keyword}`);
  }
}

export const logger = new Logger();
