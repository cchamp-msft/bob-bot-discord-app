/**
 * ThreadContext tests — exercises thread ID generation, propagation
 * via AsyncLocalStorage, and isolation between concurrent scopes.
 */

import { generateThreadId, runWithThreadId, getThreadId } from '../src/utils/threadContext';

describe('ThreadContext', () => {
  describe('generateThreadId', () => {
    it('should return a 4-character hex string', () => {
      const id = generateThreadId();
      expect(id).toMatch(/^[0-9a-f]{4}$/);
    });

    it('should generate different IDs on successive calls', () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateThreadId()));
      // With 50 draws from 65536, collisions are possible but extremely unlikely.
      // Allow at most 2 duplicates.
      expect(ids.size).toBeGreaterThanOrEqual(48);
    });
  });

  describe('runWithThreadId / getThreadId', () => {
    it('should return undefined outside a thread scope', () => {
      expect(getThreadId()).toBeUndefined();
    });

    it('should return the thread ID inside a synchronous scope', () => {
      const result = runWithThreadId('ab12', () => getThreadId());
      expect(result).toBe('ab12');
    });

    it('should return the thread ID inside an async scope', async () => {
      const result = await runWithThreadId('cd34', async () => {
        // Simulate async work
        await new Promise((r) => setTimeout(r, 5));
        return getThreadId();
      });
      expect(result).toBe('cd34');
    });

    it('should isolate thread IDs between nested scopes', () => {
      runWithThreadId('aaaa', () => {
        expect(getThreadId()).toBe('aaaa');

        const inner = runWithThreadId('bbbb', () => getThreadId());
        expect(inner).toBe('bbbb');

        // Outer scope should be restored
        expect(getThreadId()).toBe('aaaa');
      });
    });

    it('should isolate concurrent async scopes', async () => {
      const results: string[] = [];

      await Promise.all([
        runWithThreadId('1111', async () => {
          await new Promise((r) => setTimeout(r, 10));
          results.push(getThreadId()!);
        }),
        runWithThreadId('2222', async () => {
          await new Promise((r) => setTimeout(r, 5));
          results.push(getThreadId()!);
        }),
      ]);

      expect(results).toContain('1111');
      expect(results).toContain('2222');
    });
  });
});
