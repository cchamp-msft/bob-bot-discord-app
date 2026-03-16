/**
 * mediaPersistence tests — exercises persistMedia with HTTP URLs,
 * data-URIs, and raw buffers.
 *
 * Uses mocked fileHandler so no real I/O occurs.
 */

jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
    logWarn: jest.fn(),
    logDebug: jest.fn(),
    logDebugLazy: jest.fn(),
  },
}));

jest.mock('../src/utils/config', () => ({
  config: {
    getOutputBaseUrl: () => 'http://localhost:3003',
    getFileSizeThreshold: () => 10485760,
  },
}));

const mockSaveFile = jest.fn();
const mockSaveFromUrl = jest.fn();
const mockSaveFromDataUrl = jest.fn();

jest.mock('../src/utils/fileHandler', () => ({
  fileHandler: {
    saveFile: mockSaveFile,
    saveFromUrl: mockSaveFromUrl,
    saveFromDataUrl: mockSaveFromDataUrl,
    shouldAttachFile: jest.fn(() => true),
    readFile: jest.fn(() => Buffer.from('test')),
  },
}));

import { persistMedia, MediaSource } from '../src/utils/mediaPersistence';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('persistMedia', () => {
  const defaultOutput = {
    filePath: '/outputs/2026/03/03T12-00-00/user-test_item_item.png',
    fileName: 'user-test_item_item.png',
    url: 'http://localhost:3003/2026/03/03T12-00-00/user-test_item_item.png',
    size: 1024,
  };

  describe('HTTP URL sources', () => {
    it('should save from HTTP URL via fileHandler.saveFromUrl', async () => {
      mockSaveFromUrl.mockResolvedValue(defaultOutput);

      const sources: MediaSource[] = [
        { source: 'https://cdn.x.ai/img/abc.png', defaultExtension: 'png', mediaType: 'image' },
      ];

      const results = await persistMedia('user', 'test prompt', sources);

      expect(results).toHaveLength(1);
      expect(results[0].mediaType).toBe('image');
      expect(results[0].source).toBe('https://cdn.x.ai/img/abc.png');
      expect(results[0].filePath).toBe(defaultOutput.filePath);
      expect(mockSaveFromUrl).toHaveBeenCalledWith('user', 'test prompt', 'https://cdn.x.ai/img/abc.png', 'png', 'unknown');
    });

    it('should extract extension from URL path', async () => {
      mockSaveFromUrl.mockResolvedValue(defaultOutput);

      const sources: MediaSource[] = [
        { source: 'https://cdn.x.ai/vid/abc.mp4', defaultExtension: 'webm', mediaType: 'video' },
      ];

      await persistMedia('user', 'video prompt', sources);

      expect(mockSaveFromUrl).toHaveBeenCalledWith('user', 'video prompt', 'https://cdn.x.ai/vid/abc.mp4', 'mp4', 'unknown');
    });

    it('should extract extension from ComfyUI-style filename param', async () => {
      mockSaveFromUrl.mockResolvedValue(defaultOutput);

      const sources: MediaSource[] = [
        { source: 'http://comfy:8188/view?filename=output.webp&type=output', defaultExtension: 'png', mediaType: 'image' },
      ];

      await persistMedia('user', 'comfy prompt', sources);

      expect(mockSaveFromUrl).toHaveBeenCalledWith('user', 'comfy prompt', sources[0].source, 'webp', 'unknown');
    });

    it('should use defaultExtension when URL has no parseable extension', async () => {
      mockSaveFromUrl.mockResolvedValue(defaultOutput);

      const sources: MediaSource[] = [
        { source: 'https://cdn.x.ai/img/abc', defaultExtension: 'png', mediaType: 'image' },
      ];

      await persistMedia('user', 'test', sources);

      expect(mockSaveFromUrl).toHaveBeenCalledWith('user', 'test', 'https://cdn.x.ai/img/abc', 'png', 'unknown');
    });

    it('should skip failed downloads and continue', async () => {
      mockSaveFromUrl
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(defaultOutput);

      const sources: MediaSource[] = [
        { source: 'https://cdn.x.ai/img/fail.png', defaultExtension: 'png', mediaType: 'image' },
        { source: 'https://cdn.x.ai/img/ok.png', defaultExtension: 'png', mediaType: 'image' },
      ];

      const results = await persistMedia('user', 'test', sources);

      expect(results).toHaveLength(1);
      expect(results[0].source).toBe('https://cdn.x.ai/img/ok.png');
    });
  });

  describe('data-URI sources', () => {
    it('should save from data-URI via fileHandler.saveFromDataUrl', async () => {
      mockSaveFromDataUrl.mockReturnValue(defaultOutput);

      const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
      const sources: MediaSource[] = [
        { source: dataUrl, defaultExtension: 'png', mediaType: 'image' },
      ];

      const results = await persistMedia('user', 'b64 prompt', sources);

      expect(results).toHaveLength(1);
      expect(results[0].mediaType).toBe('image');
      expect(mockSaveFromDataUrl).toHaveBeenCalledWith('user', 'b64 prompt', dataUrl, 'png', 'unknown');
    });

    it('should handle failed data-URI save', async () => {
      mockSaveFromDataUrl.mockReturnValue(null);

      const sources: MediaSource[] = [
        { source: 'data:image/png;base64,bad', defaultExtension: 'png', mediaType: 'image' },
      ];

      const results = await persistMedia('user', 'bad data', sources);

      expect(results).toHaveLength(0);
    });
  });

  describe('buffer sources', () => {
    it('should save raw buffer via fileHandler.saveFile', async () => {
      mockSaveFile.mockReturnValue(defaultOutput);

      const buf = Buffer.from('fake video data');
      const sources: MediaSource[] = [
        { source: 'buffer', buffer: buf, defaultExtension: 'mp4', mediaType: 'video' },
      ];

      const results = await persistMedia('user', 'buffer prompt', sources);

      expect(results).toHaveLength(1);
      expect(results[0].source).toBe('buffer');
      expect(results[0].mediaType).toBe('video');
      expect(mockSaveFile).toHaveBeenCalledWith('user', 'buffer prompt', buf, 'mp4', 'unknown');
    });

    it('should skip buffer source without buffer data', async () => {
      const sources: MediaSource[] = [
        { source: 'buffer', defaultExtension: 'mp4', mediaType: 'video' },
      ];

      const results = await persistMedia('user', 'no buf', sources);

      expect(results).toHaveLength(0);
      expect(mockSaveFile).not.toHaveBeenCalled();
    });
  });

  describe('mixed sources', () => {
    it('should process multiple heterogeneous sources', async () => {
      const urlOutput = { ...defaultOutput, fileName: 'url.png' };
      const dataOutput = { ...defaultOutput, fileName: 'data.png' };
      const bufOutput = { ...defaultOutput, fileName: 'buf.mp4' };

      mockSaveFromUrl.mockResolvedValue(urlOutput);
      mockSaveFromDataUrl.mockReturnValue(dataOutput);
      mockSaveFile.mockReturnValue(bufOutput);

      const sources: MediaSource[] = [
        { source: 'https://cdn.x.ai/img.png', defaultExtension: 'png', mediaType: 'image' },
        { source: 'data:image/jpeg;base64,/9j/4A==', defaultExtension: 'jpg', mediaType: 'image' },
        { source: 'buffer', buffer: Buffer.from('vid'), defaultExtension: 'mp4', mediaType: 'video' },
      ];

      const results = await persistMedia('user', 'mixed', sources);

      expect(results).toHaveLength(3);
      expect(mockSaveFromUrl).toHaveBeenCalledTimes(1);
      expect(mockSaveFromDataUrl).toHaveBeenCalledTimes(1);
      expect(mockSaveFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('should catch exceptions and continue processing', async () => {
      mockSaveFromUrl
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(defaultOutput);

      const sources: MediaSource[] = [
        { source: 'https://cdn.x.ai/img/fail.png', defaultExtension: 'png', mediaType: 'image' },
        { source: 'https://cdn.x.ai/img/ok.png', defaultExtension: 'png', mediaType: 'image' },
      ];

      const results = await persistMedia('user', 'error test', sources);

      expect(results).toHaveLength(1);
      expect(results[0].source).toBe('https://cdn.x.ai/img/ok.png');
    });

    it('should log error for unrecognised source type', async () => {
      const { logger } = require('../src/utils/logger');

      const sources: MediaSource[] = [
        { source: 'ftp://unsupported', defaultExtension: 'png', mediaType: 'image' },
      ];

      const results = await persistMedia('user', 'bad source', sources);

      expect(results).toHaveLength(0);
      expect(logger.logError).toHaveBeenCalledWith(
        'system',
        expect.stringContaining('unrecognised source type'),
      );
    });
  });
});
