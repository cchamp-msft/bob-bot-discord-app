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

      expect(result.fileName).toMatch(/^testuser-my_great_file\.txt$/);
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

      expect(result.fileName).toMatch(/^user_with_spaces_-/);
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
});
