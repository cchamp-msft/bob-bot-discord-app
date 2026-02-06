/**
 * RequestQueue tests — exercises locking, timeout, and concurrency
 * without any Discord or API dependencies.
 */

// Mock the logger so it doesn't write to disk during tests
jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
    logBusy: jest.fn(),
    logTimeout: jest.fn(),
  },
}));

import { requestQueue } from '../src/utils/requestQueue';
import { logger } from '../src/utils/logger';

describe('RequestQueue', () => {
  // Reset active state between tests by executing a no-op to clear locks
  beforeEach(() => {
    // Access private fields to reset state
    (requestQueue as any).comfyuiActive = false;
    (requestQueue as any).ollamaActive = false;
  });

  describe('isApiAvailable', () => {
    it('should report both APIs as available initially', () => {
      expect(requestQueue.isApiAvailable('comfyui')).toBe(true);
      expect(requestQueue.isApiAvailable('ollama')).toBe(true);
    });
  });

  describe('execute', () => {
    it('should execute and return the result of the executor', async () => {
      const result = await requestQueue.execute(
        'comfyui', 'testuser', 'generate', 10,
        async () => ({ success: true, data: 'hello' })
      );

      expect(result).toEqual({ success: true, data: 'hello' });
    });

    it('should mark API as unavailable during execution', async () => {
      let duringExecution = true;

      await requestQueue.execute(
        'comfyui', 'testuser', 'generate', 10,
        async () => {
          duringExecution = requestQueue.isApiAvailable('comfyui');
          return 'done';
        }
      );

      expect(duringExecution).toBe(false);
    });

    it('should release API lock after successful execution', async () => {
      await requestQueue.execute(
        'comfyui', 'testuser', 'generate', 10,
        async () => 'done'
      );

      expect(requestQueue.isApiAvailable('comfyui')).toBe(true);
    });

    it('should release API lock after failed execution', async () => {
      try {
        await requestQueue.execute(
          'ollama', 'testuser', 'ask', 10,
          async () => { throw new Error('boom'); }
        );
      } catch {
        // expected
      }

      expect(requestQueue.isApiAvailable('ollama')).toBe(true);
    });

    it('should throw API_BUSY when API is already locked', async () => {
      // Lock comfyui manually
      (requestQueue as any).comfyuiActive = true;

      await expect(
        requestQueue.execute(
          'comfyui', 'testuser', 'generate', 10,
          async () => 'should not run'
        )
      ).rejects.toThrow('API_BUSY:comfyui');

      expect(logger.logBusy).toHaveBeenCalledWith('testuser', 'comfyui');
    });

    it('should allow different APIs to run independently', async () => {
      // Lock comfyui
      (requestQueue as any).comfyuiActive = true;

      // ollama should still be available
      const result = await requestQueue.execute(
        'ollama', 'testuser', 'ask', 10,
        async () => 'ollama works'
      );

      expect(result).toBe('ollama works');
    });

    it('should timeout if executor takes too long', async () => {
      await expect(
        requestQueue.execute(
          'comfyui', 'testuser', 'generate', 0.05, // 50ms timeout
          () => new Promise((resolve) => setTimeout(() => resolve('late'), 200))
        )
      ).rejects.toThrow('timed out');

      expect(logger.logTimeout).toHaveBeenCalledWith('testuser', 'generate');
      // Lock should be released after timeout
      expect(requestQueue.isApiAvailable('comfyui')).toBe(true);
    });

    it('should not timeout if executor completes in time', async () => {
      const result = await requestQueue.execute(
        'ollama', 'testuser', 'ask', 1,
        async () => {
          await new Promise((r) => setTimeout(r, 10));
          return 'fast enough';
        }
      );

      expect(result).toBe('fast enough');
    });

    it('should propagate executor errors', async () => {
      await expect(
        requestQueue.execute(
          'ollama', 'testuser', 'ask', 10,
          async () => { throw new Error('custom error'); }
        )
      ).rejects.toThrow('custom error');
    });

    it('should preserve generic type through execution', async () => {
      interface MyResult { value: number; label: string }

      const result = await requestQueue.execute<MyResult>(
        'comfyui', 'testuser', 'generate', 10,
        async () => ({ value: 42, label: 'answer' })
      );

      expect(result.value).toBe(42);
      expect(result.label).toBe('answer');
    });
  });
});
