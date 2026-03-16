import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { config } from './config';
import { logger } from './logger';

export interface FileOutput {
  filePath: string;
  fileName: string;
  url: string;
  size: number;
}

class FileHandler {
  private outputsDir = path.join(__dirname, '../../outputs');

  constructor() {
    if (!fs.existsSync(this.outputsDir)) {
      fs.mkdirSync(this.outputsDir, { recursive: true });
    }
  }

  private getDatePath(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return `${year}/${month}/${day}T${hours}-${minutes}-${seconds}`;
  }

  private sanitizeFileName(fileName: string): string {
    return fileName.replace(/[^a-z0-9._-]/gi, '_').toLowerCase();
  }

  private normalizeDescription(description: string): string {
    const words = description
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3);

    while (words.length < 3) {
      words.push('item');
    }

    return words.join('_');
  }

  saveFile(
    requester: string,
    description: string,
    fileBuffer: Buffer,
    extension: string,
    apiSource: string = 'unknown'
  ): FileOutput {
    const datePath = this.getDatePath();
    const dirPath = path.join(this.outputsDir, datePath);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    // Format: {timestamp}_{api}_{requester}_{description}-{counter}.{ext}
    const safeRequester = this.sanitizeFileName(requester);
    const safeDescription = this.sanitizeFileName(
      this.normalizeDescription(description)
    );
    const safeApi = this.sanitizeFileName(apiSource);
    const timestamp = Date.now();
    const baseName = `${timestamp}_${safeApi}_${safeRequester}_${safeDescription}`;

    // Collision counter: increment until the filename is unique
    let counter = 1;
    let fileName = `${baseName}-${counter}.${extension}`;
    let filePath = path.join(dirPath, fileName);
    while (fs.existsSync(filePath)) {
      counter++;
      fileName = `${baseName}-${counter}.${extension}`;
      filePath = path.join(dirPath, fileName);
    }

    // Verify resolved path stays within outputs directory
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.outputsDir))) {
      throw new Error('Path traversal detected — refusing to write outside outputs directory');
    }

    fs.writeFileSync(filePath, fileBuffer);

    const size = fileBuffer.length;
    const relativeFilePath = path.relative(
      this.outputsDir,
      filePath
    );
    const url = `${config.getOutputBaseUrl()}/${relativeFilePath.replace(/\\/g, '/')}`;

    return {
      filePath,
      fileName,
      url,
      size,
    };
  }

  async saveFromUrl(
    requester: string,
    description: string,
    fileUrl: string,
    extension: string,
    apiSource: string = 'unknown'
  ): Promise<FileOutput | null> {
    try {
      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      return this.saveFile(requester, description, response.data, extension, apiSource);
    } catch (error) {
      logger.logError('system', `Failed to download file from URL: ${error}`);
      return null;
    }
  }

  /**
   * Decode a `data:<mime>;base64,<payload>` URI and persist the binary content.
   * Returns the same {@link FileOutput} shape as {@link saveFile}.
   * Falls back to the given `defaultExtension` when the MIME type cannot be parsed.
   */
  saveFromDataUrl(
    requester: string,
    description: string,
    dataUrl: string,
    defaultExtension: string,
    apiSource: string = 'unknown'
  ): FileOutput | null {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) {
      logger.logError('system', 'saveFromDataUrl: invalid data-URL format');
      return null;
    }

    const mime = match[1];           // e.g. "image/png"
    const base64 = match[2];
    const buffer = Buffer.from(base64, 'base64');

    // Derive extension from MIME — e.g. "image/jpeg" → "jpg", "video/mp4" → "mp4"
    const mimeExt = mime.split('/')[1]?.replace('jpeg', 'jpg');
    const extension = mimeExt || defaultExtension;

    return this.saveFile(requester, description, buffer, extension, apiSource);
  }

  /**
   * Delete media output directories older than `retentionDays` days.
   * Walks the `outputs/YYYY/MM/DDThh-mm-ss/` directory tree, skipping `logs/`.
   * Empty month/year directories are removed after processing.
   *
   * @param retentionDays Number of days to retain.  0 = grooming disabled.
   */
  groomMedia(retentionDays: number): { deleted: string[]; skipped: number; errors: number } {
    if (retentionDays === 0) {
      return { deleted: [], skipped: 0, errors: 0 };
    }

    const cutoffDate = new Date(Date.now() - retentionDays * 86_400_000);
    const deleted: string[] = [];
    let skipped = 0;
    let errors = 0;

    let topEntries: string[];
    try {
      topEntries = fs.readdirSync(this.outputsDir);
    } catch {
      return { deleted: [], skipped: 0, errors: 0 };
    }

    const yearRegex = /^\d{4}$/;
    const monthRegex = /^\d{2}$/;
    const leafRegex = /^(\d{2})T(\d{2})-(\d{2})-(\d{2})$/;

    for (const yearName of topEntries) {
      if (yearName === 'logs' || !yearRegex.test(yearName)) continue;
      const yearPath = path.join(this.outputsDir, yearName);
      if (!fs.statSync(yearPath).isDirectory()) continue;

      let months: string[];
      try { months = fs.readdirSync(yearPath); } catch { continue; }

      for (const monthName of months) {
        if (!monthRegex.test(monthName)) continue;
        const monthPath = path.join(yearPath, monthName);
        if (!fs.statSync(monthPath).isDirectory()) continue;

        let leaves: string[];
        try { leaves = fs.readdirSync(monthPath); } catch { continue; }

        for (const leafName of leaves) {
          const m = leafRegex.exec(leafName);
          if (!m) continue;
          const leafPath = path.join(monthPath, leafName);
          if (!fs.statSync(leafPath).isDirectory()) continue;

          // Reconstruct date: YYYY-MM-DDThh:mm:ss
          const day = m[1];
          const hh = m[2];
          const mm = m[3];
          const ss = m[4];
          const dateStr = `${yearName}-${monthName}-${day}T${hh}:${mm}:${ss}`;
          const folderDate = new Date(dateStr);
          if (isNaN(folderDate.getTime())) {
            skipped++;
            continue;
          }

          if (folderDate < cutoffDate) {
            try {
              fs.rmSync(leafPath, { recursive: true, force: true });
              deleted.push(`${yearName}/${monthName}/${leafName}`);
            } catch {
              errors++;
            }
          } else {
            skipped++;
          }
        }

        // Remove empty month dir
        try {
          const remaining = fs.readdirSync(monthPath);
          if (remaining.length === 0) fs.rmdirSync(monthPath);
        } catch { /* ignore */ }
      }

      // Remove empty year dir
      try {
        const remaining = fs.readdirSync(yearPath);
        if (remaining.length === 0) fs.rmdirSync(yearPath);
      } catch { /* ignore */ }
    }

    if (deleted.length > 0) {
      logger.log('success', 'system', `MEDIA-GROOMING: Deleted ${deleted.length} folder(s), skipped ${skipped}, errors ${errors}`);
    }

    return { deleted, skipped, errors };
  }

  shouldAttachFile(fileSize: number): boolean {
    return fileSize <= config.getFileSizeThreshold();
  }

  readFile(filePath: string): Buffer | null {
    try {
      return fs.readFileSync(filePath);
    } catch (error) {
      logger.logError('system', `Failed to read file: ${error}`);
      return null;
    }
  }
}

export const fileHandler = new FileHandler();
