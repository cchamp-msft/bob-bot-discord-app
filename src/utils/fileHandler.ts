import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { config } from './config';
import { logger } from './logger';

interface FileOutput {
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
    extension: string
  ): FileOutput {
    const datePath = this.getDatePath();
    const dirPath = path.join(this.outputsDir, datePath);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    // Format: requester-three_word_description.ext
    const safeRequester = this.sanitizeFileName(requester);
    const safeDescription = this.sanitizeFileName(
      this.normalizeDescription(description)
    );
    const fileName = `${safeRequester}-${safeDescription}.${extension}`;
    const filePath = path.join(dirPath, fileName);

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
    extension: string
  ): Promise<FileOutput | null> {
    try {
      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      return this.saveFile(requester, description, response.data, extension);
    } catch (error) {
      logger.logError('system', `Failed to download file from URL: ${error}`);
      return null;
    }
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
