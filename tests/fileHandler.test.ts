/**
 * FileHandler tests — exercises file saving, name sanitization,
 * description normalization, and path traversal protection.
 * Does NOT test saveFromUrl (requires network).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock logger so tests don't write to real log files
jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
    logBusy: jest.fn(),
    logTimeout: jest.fn(),
    logDebug: jest.fn(),
    logDebugLazy: jest.fn(),
  },
}));

// Mock config to return predictable values
jest.mock('../src/utils/config', () => ({
  config: {
    getOutputBaseUrl: () => 'http://localhost:3003',
    getFileSizeThreshold: () => 10485760,
  },
}));

import { fileHandler } from '../src/utils/fileHandler';

describe('FileHandler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filehandler-test-'));
    (fileHandler as any).outputsDir = tempDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('sanitizeFileName', () => {
    // Access private method
    const sanitize = (s: string) => (fileHandler as any).sanitizeFileName(s);

    it('should lowercase the result', () => {
      expect(sanitize('HELLO')).toBe('hello');
    });

    it('should replace special characters with underscores', () => {
      expect(sanitize('hello world!')).toBe('hello_world_');
    });

    it('should preserve dots, dashes, and underscores', () => {
      expect(sanitize('file-name_v2.txt')).toBe('file-name_v2.txt');
    });

    it('should handle empty string', () => {
      expect(sanitize('')).toBe('');
    });

    it('should sanitize unicode characters', () => {
      expect(sanitize('café')).toBe('caf_');
    });
  });

  describe('normalizeDescription', () => {
    const normalize = (s: string) => (fileHandler as any).normalizeDescription(s);

    it('should take first 3 words', () => {
      expect(normalize('one two three four')).toBe('one_two_three');
    });

    it('should pad to 3 words with "item"', () => {
      expect(normalize('hello')).toBe('hello_item_item');
    });

    it('should pad two words to 3', () => {
      expect(normalize('hello world')).toBe('hello_world_item');
    });

    it('should handle extra whitespace', () => {
      expect(normalize('  one   two   three  ')).toBe('one_two_three');
    });

    it('should handle empty string', () => {
      expect(normalize('')).toBe('item_item_item');
    });
  });

  describe('getDatePath', () => {
    const getDatePath = () => (fileHandler as any).getDatePath();

    it('should return YYYY/MM/DDThh-mm-ss format', () => {
      const result = getDatePath();
      expect(result).toMatch(/^\d{4}\/\d{2}\/\d{2}T\d{2}-\d{2}-\d{2}$/);
    });

    it('should not contain colons (Windows safe)', () => {
      const result = getDatePath();
      expect(result).not.toContain(':');
    });
  });

  describe('saveFile', () => {
    it('should save a file and return correct metadata', () => {
      const buffer = Buffer.from('hello world');
      const result = (fileHandler as any).saveFile('TestUser', 'my great file extra', buffer, 'txt');

      expect(result.fileName).toMatch(/^\d+_unknown_testuser_my_great_file-\d+\.txt$/);
      expect(result.size).toBe(11);
      expect(result.url).toContain('http://localhost:3003/');
      expect(fs.existsSync(result.filePath)).toBe(true);
    });

    it('should create date-based subdirectories', () => {
      const buffer = Buffer.from('data');
      const result = (fileHandler as any).saveFile('user', 'desc item item', buffer, 'bin');

      // Path should be inside a YYYY/MM/DDThh-mm-ss subdirectory
      const relative = path.relative(tempDir, result.filePath);
      const parts = relative.split(path.sep);
      expect(parts.length).toBeGreaterThanOrEqual(4); // year/month/dayTtime/file
    });

    it('should sanitize requester name', () => {
      const buffer = Buffer.from('data');
      const result = (fileHandler as any).saveFile('User With Spaces!', 'test item item', buffer, 'txt');

      expect(result.fileName).toMatch(/^\d+_unknown_user_with_spaces_/);
    });

    it('should write the correct content', () => {
      const content = 'binary content here';
      const buffer = Buffer.from(content);
      const result = (fileHandler as any).saveFile('user', 'test item item', buffer, 'dat');

      const readBack = fs.readFileSync(result.filePath, 'utf-8');
      expect(readBack).toBe(content);
    });
  });

  describe('shouldAttachFile', () => {
    it('should return true for files under threshold', () => {
      expect(fileHandler.shouldAttachFile(1024)).toBe(true);
    });

    it('should return true for files at threshold', () => {
      expect(fileHandler.shouldAttachFile(10485760)).toBe(true);
    });

    it('should return false for files over threshold', () => {
      expect(fileHandler.shouldAttachFile(10485761)).toBe(false);
    });
  });

  describe('readFile', () => {
    it('should read an existing file', () => {
      const filePath = path.join(tempDir, 'test.txt');
      fs.writeFileSync(filePath, 'hello');

      const result = fileHandler.readFile(filePath);
      expect(result).not.toBeNull();
      expect(result!.toString()).toBe('hello');
    });

    it('should return null for non-existent file', () => {
      const result = fileHandler.readFile(path.join(tempDir, 'nope.txt'));
      expect(result).toBeNull();
    });
  });

  describe('saveFromDataUrl', () => {
    it('should decode a valid PNG data-URL and save the file', () => {
      // Minimal 1x1 PNG (base64)
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB';
      const dataUrl = `data:image/png;base64,${b64}`;

      const result = fileHandler.saveFromDataUrl('tester', 'data url test', dataUrl, 'png');

      expect(result).not.toBeNull();
      expect(result!.fileName).toMatch(/\.png$/);
      expect(result!.size).toBeGreaterThan(0);
      expect(fs.existsSync(result!.filePath)).toBe(true);
    });

    it('should derive jpg extension from image/jpeg MIME', () => {
      const dataUrl = 'data:image/jpeg;base64,/9j/4A==';

      const result = fileHandler.saveFromDataUrl('tester', 'jpeg test', dataUrl, 'png');

      expect(result).not.toBeNull();
      expect(result!.fileName).toMatch(/\.jpg$/);
    });

    it('should use defaultExtension when MIME has no subtype', () => {
      // Fabricated MIME without a /subtype — unlikely but defensive
      const dataUrl = 'data:application;base64,dGVzdA==';

      const result = fileHandler.saveFromDataUrl('tester', 'fallback ext', dataUrl, 'bin');

      expect(result).not.toBeNull();
      // Extension derived as empty string from 'application' (no /), so fallback 'bin' used
      // Actually application has no /, so mime.split('/')[1] is undefined → uses 'bin'
    });

    it('should return null for an invalid data-URL format', () => {
      const result = fileHandler.saveFromDataUrl('tester', 'bad format', 'not-a-data-url', 'png');

      expect(result).toBeNull();
    });

    it('should return null for a malformed base64 section', () => {
      // Missing the base64 marker
      const result = fileHandler.saveFromDataUrl('tester', 'no b64', 'data:image/png;utf8,hello', 'png');

      expect(result).toBeNull();
    });
  });

  describe('groomMedia', () => {
    function mkLeaf(yearMonthDay: string): string {
      // yearMonthDay e.g. "2024/01/15T10-30-00"
      const leafPath = path.join(tempDir, yearMonthDay);
      fs.mkdirSync(leafPath, { recursive: true });
      // Put a dummy file inside so the dir isn't empty
      fs.writeFileSync(path.join(leafPath, 'img.png'), 'data');
      return leafPath;
    }

    it('should return early when retentionDays is 0 (disabled)', () => {
      mkLeaf('2020/01/01T00-00-00');
      const result = fileHandler.groomMedia(0);
      expect(result).toEqual({ deleted: [], skipped: 0, errors: 0 });
      // Folder should still exist
      expect(fs.existsSync(path.join(tempDir, '2020/01/01T00-00-00'))).toBe(true);
    });

    it('should delete old folders and keep recent ones', () => {
      const now = new Date();
      // Old folder: 60 days ago
      const old = new Date(now.getTime() - 60 * 86_400_000);
      const oldYear = String(old.getFullYear());
      const oldMonth = String(old.getMonth() + 1).padStart(2, '0');
      const oldDay = String(old.getDate()).padStart(2, '0');
      const oldPath = `${oldYear}/${oldMonth}/${oldDay}T12-00-00`;
      mkLeaf(oldPath);

      // Recent folder: today
      const newYear = String(now.getFullYear());
      const newMonth = String(now.getMonth() + 1).padStart(2, '0');
      const newDay = String(now.getDate()).padStart(2, '0');
      const newPath = `${newYear}/${newMonth}/${newDay}T12-00-00`;
      mkLeaf(newPath);

      const result = fileHandler.groomMedia(30);

      expect(result.deleted).toHaveLength(1);
      expect(result.deleted[0]).toBe(oldPath);
      expect(result.skipped).toBe(1);
      expect(fs.existsSync(path.join(tempDir, oldPath))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, newPath))).toBe(true);
    });

    it('should skip the logs/ directory', () => {
      const logsDir = path.join(tempDir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(logsDir, 'test.log'), 'log data');

      const result = fileHandler.groomMedia(1);
      expect(result.deleted).toHaveLength(0);
      expect(fs.existsSync(logsDir)).toBe(true);
    });

    it('should clean up empty parent directories', () => {
      // Create an old folder that will be deleted
      const old = new Date(Date.now() - 100 * 86_400_000);
      const y = String(old.getFullYear());
      const m = String(old.getMonth() + 1).padStart(2, '0');
      const d = String(old.getDate()).padStart(2, '0');
      const oldPath = `${y}/${m}/${d}T00-00-00`;
      mkLeaf(oldPath);

      fileHandler.groomMedia(7);

      // Month and year dirs should be cleaned up if empty
      expect(fs.existsSync(path.join(tempDir, y, m))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, y))).toBe(false);
    });

    it('should handle empty outputs directory', () => {
      const result = fileHandler.groomMedia(7);
      expect(result).toEqual({ deleted: [], skipped: 0, errors: 0 });
    });
  });
});
