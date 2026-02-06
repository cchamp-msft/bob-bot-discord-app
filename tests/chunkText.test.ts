/**
 * chunkText tests — exercises the newline-aware text splitting utility.
 */

import { chunkText } from '../src/utils/chunkText';

describe('chunkText', () => {
  it('should return single chunk for short text', () => {
    const result = chunkText('hello world', 2000);
    expect(result).toEqual(['hello world']);
  });

  it('should return single chunk when text equals max length', () => {
    const text = 'a'.repeat(2000);
    const result = chunkText(text, 2000);
    expect(result).toEqual([text]);
  });

  it('should split on newline boundaries', () => {
    const line = 'a'.repeat(80);
    // Build text of ~24 lines × 81 chars each = ~1944 + one more line pushes past 2000
    const lines = Array.from({ length: 26 }, () => line);
    const text = lines.join('\n');      // 26*80 + 25 newlines = 2105

    const chunks = chunkText(text, 2000);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Every chunk except the last should end at a newline boundary
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].endsWith('\n')).toBe(true);
    }

    // Reassembled text should match original
    expect(chunks.join('')).toBe(text);
  });

  it('should split on space when no newline available', () => {
    const text = 'word '.repeat(500); // 2500 chars
    const chunks = chunkText(text, 2000);
    expect(chunks.length).toBe(2);
    expect(chunks.join('')).toBe(text);
  });

  it('should hard-split when no newline or space exists', () => {
    const text = 'x'.repeat(5000);
    const chunks = chunkText(text, 2000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].length).toBe(2000);
    expect(chunks[1].length).toBe(2000);
    expect(chunks[2].length).toBe(1000);
    expect(chunks.join('')).toBe(text);
  });

  it('should handle empty string', () => {
    expect(chunkText('', 2000)).toEqual(['']);
  });

  it('should use default max length of 2000', () => {
    const text = 'a'.repeat(3000);
    const chunks = chunkText(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(2000);
  });
});
