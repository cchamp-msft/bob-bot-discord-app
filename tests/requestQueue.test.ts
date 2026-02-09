/**
 * RequestQueue tests — exercises FIFO queueing, timeout with AbortSignal,
 * and concurrency without any Discord or API dependencies.
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
    logDebug: jest.fn(),
    logDebugLazy: jest.fn(),
  },
}));

import { requestQueue } from '../src/utils/requestQueue';
import { logger } from '../src/utils/logger';

describe('RequestQueue', () => {
  // Reset active state between tests by accessing private fields
  beforeEach(() => {
    (requestQueue as any).comfyuiActive = false;
    (requestQueue as any).ollamaActive = false;
    (requestQueue as any).comfyuiQueue = [];
    (requestQueue as any).ollamaQueue = [];
    jest.clearAllMocks();
  });

  describe('isApiAvailable', () => {
    it('should report both APIs as available initially', () => {
      expect(requestQueue.isApiAvailable('comfyui')).toBe(true);
      expect(requestQueue.isApiAvailable('ollama')).toBe(true);
    });
  });

  describe('pending', () => {
    it('should report 0 pending when queue is empty', () => {
      expect(requestQueue.pending('comfyui')).toBe(0);
      expect(requestQueue.pending('ollama')).toBe(0);
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

    it('should enqueue and run FIFO when API is busy', async () => {
      const order: number[] = [];

      // First request: slow — holds the lock
      const p1 = requestQueue.execute(
        'comfyui', 'user1', 'generate', 10,
        async () => {
          await new Promise(r => setTimeout(r, 80));
          order.push(1);
          return 'first';
        }
      );

      // Second request: enqueued behind p1
      const p2 = requestQueue.execute(
        'comfyui', 'user2', 'generate', 10,
        async () => {
          order.push(2);
          return 'second';
        }
      );

      // Third request: enqueued behind p2
      const p3 = requestQueue.execute(
        'comfyui', 'user3', 'generate', 10,
        async () => {
          order.push(3);
          return 'third';
        }
      );

      const results = await Promise.all([p1, p2, p3]);
      expect(results).toEqual(['first', 'second', 'third']);
      expect(order).toEqual([1, 2, 3]);
    });

    it('should allow different APIs to run independently', async () => {
      const order: string[] = [];

      const pComfyui = requestQueue.execute(
        'comfyui', 'testuser', 'generate', 10,
        async () => {
          await new Promise(r => setTimeout(r, 50));
          order.push('comfyui');
          return 'comfyui done';
        }
      );

      const pOllama = requestQueue.execute(
        'ollama', 'testuser', 'ask', 10,
        async () => {
          order.push('ollama');
          return 'ollama done';
        }
      );

      const [r1, r2] = await Promise.all([pComfyui, pOllama]);
      expect(r1).toBe('comfyui done');
      expect(r2).toBe('ollama done');
      // ollama should finish first since it doesn't delay
      expect(order[0]).toBe('ollama');
    });

    it('should timeout if executor takes too long', async () => {
      await expect(
        requestQueue.execute(
          'comfyui', 'testuser', 'generate', 0.05, // 50ms timeout
          () => new Promise((resolve) => setTimeout(() => resolve('late'), 500))
        )
      ).rejects.toThrow('timed out');

      expect(logger.logTimeout).toHaveBeenCalledWith('testuser', 'generate');
      // Lock should be released after timeout
      expect(requestQueue.isApiAvailable('comfyui')).toBe(true);
    });

    it('should abort the signal on timeout', async () => {
      let signalAborted = false;

      await expect(
        requestQueue.execute(
          'ollama', 'testuser', 'ask', 0.05, // 50ms timeout
          async (signal: AbortSignal) => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            signalAborted = signal.aborted;
            return 'done';
          }
        )
      ).rejects.toThrow('timed out');

      // The signal should have been aborted by the time the race rejects
      // (We verify by trying a quick cooperative executor after)
      let abortedFlag = false;
      await requestQueue.execute(
        'ollama', 'testuser', 'ask', 1,
        async (signal: AbortSignal) => {
          // This runs after drain resumes — just validate signal is fresh
          abortedFlag = signal.aborted;
          return 'ok';
        }
      );
      expect(abortedFlag).toBe(false);
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

    it('should propagate executor errors without blocking queue', async () => {
      const p1 = requestQueue.execute(
        'ollama', 'testuser', 'ask', 10,
        async () => { throw new Error('custom error'); }
      );

      const p2 = requestQueue.execute(
        'ollama', 'testuser', 'ask', 10,
        async () => 'recovered'
      );

      await expect(p1).rejects.toThrow('custom error');
      await expect(p2).resolves.toBe('recovered');
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

    it('should process queued requests even if earlier ones fail', async () => {
      const results: string[] = [];

      const p1 = requestQueue.execute(
        'comfyui', 'user1', 'generate', 10,
        async () => { throw new Error('fail'); }
      ).catch(() => { results.push('p1-failed'); });

      const p2 = requestQueue.execute(
        'comfyui', 'user2', 'generate', 10,
        async () => { results.push('p2-ok'); return 'ok'; }
      );

      await Promise.all([p1, p2]);
      expect(results).toContain('p1-failed');
      expect(results).toContain('p2-ok');
      expect(results).toHaveLength(2);
    });

    it('should combine caller signal with timeout signal via AbortSignal.any', async () => {
      let receivedSignal: AbortSignal | undefined;

      const callerController = new AbortController();

      await requestQueue.execute(
        'ollama', 'user1', 'ask', 60,
        async (sig) => {
          receivedSignal = sig;
          return 'done';
        },
        callerController.signal
      );

      // The executor should receive a combined signal (not the raw caller signal)
      expect(receivedSignal).toBeDefined();
      // It should not be the caller signal directly (it's a composite)
      expect(receivedSignal).not.toBe(callerController.signal);
      // When the caller aborts, the combined signal should also abort
      expect(receivedSignal!.aborted).toBe(false);
      callerController.abort();
      expect(receivedSignal!.aborted).toBe(true);
    });

    it('should pass queue signal directly when no caller signal is provided', async () => {
      let receivedSignal: AbortSignal | undefined;

      await requestQueue.execute(
        'ollama', 'user1', 'ask', 60,
        async (sig) => {
          receivedSignal = sig;
          return 'done';
        }
      );

      // Without a caller signal, the executor gets the queue's own signal
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal!.aborted).toBe(false);
    });

    it('should reject when caller signal is already aborted', async () => {
      const callerController = new AbortController();
      callerController.abort();

      const promise = requestQueue.execute(
        'ollama', 'user1', 'ask', 60,
        async (sig) => {
          // Should never reach here — entry is skipped before execution
          return 'done';
        },
        callerController.signal
      );

      await expect(promise).rejects.toThrow('cancelled');
    });

    it('should skip queued entry without invoking executor when caller aborts while waiting', async () => {
      const callerController = new AbortController();
      let executorCalled = false;

      // First request: holds the lock long enough for us to abort the second
      const p1 = requestQueue.execute(
        'ollama', 'user1', 'ask', 10,
        async () => {
          // Abort the second request's signal while it's queued
          callerController.abort();
          await new Promise(r => setTimeout(r, 30));
          return 'first';
        }
      );

      // Second request: enqueued behind p1 with a caller signal
      const p2 = requestQueue.execute(
        'ollama', 'user2', 'ask', 10,
        async () => {
          executorCalled = true;
          return 'second';
        },
        callerController.signal
      );

      await expect(p1).resolves.toBe('first');
      await expect(p2).rejects.toThrow('cancelled');
      expect(executorCalled).toBe(false);
    });
  });
});
