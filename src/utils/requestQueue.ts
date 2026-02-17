import { logger } from './logger';
import { generateThreadId, getThreadId, runWithThreadId } from './threadContext';

interface QueueEntry<T = unknown> {
  api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi' | 'meme';
  requester: string;
  keyword: string;
  timeout: number;
  executor: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  /** Optional external signal from the caller for cooperative cancellation. */
  callerSignal?: AbortSignal;
  /** Captured parent thread context at enqueue time (if any). */
  parentThreadId?: string;
}

class RequestQueue {
  private comfyuiActive: boolean = false;
  private ollamaActive: boolean = false;
  private accuweatherActive: boolean = false;
  private nflActive: boolean = false;
  private serpapiActive: boolean = false;
  private memeActive: boolean = false;
  private comfyuiQueue: QueueEntry[] = [];
  private ollamaQueue: QueueEntry[] = [];
  private accuweatherQueue: QueueEntry[] = [];
  private nflQueue: QueueEntry[] = [];
  private serpapiQueue: QueueEntry[] = [];
  private memeQueue: QueueEntry[] = [];

  isApiAvailable(api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi' | 'meme'): boolean {
    if (api === 'comfyui') return !this.comfyuiActive;
    if (api === 'accuweather') return !this.accuweatherActive;
    if (api === 'nfl') return !this.nflActive;
    if (api === 'serpapi') return !this.serpapiActive;
    if (api === 'meme') return !this.memeActive;
    return !this.ollamaActive;
  }

  /** Number of pending (waiting) entries for an API. */
  pending(api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi' | 'meme'): number {
    if (api === 'comfyui') return this.comfyuiQueue.length;
    if (api === 'accuweather') return this.accuweatherQueue.length;
    if (api === 'nfl') return this.nflQueue.length;
    if (api === 'serpapi') return this.serpapiQueue.length;
    if (api === 'meme') return this.memeQueue.length;
    return this.ollamaQueue.length;
  }

  private setActive(api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi' | 'meme', active: boolean): void {
    if (api === 'comfyui') {
      this.comfyuiActive = active;
    } else if (api === 'accuweather') {
      this.accuweatherActive = active;
    } else if (api === 'nfl') {
      this.nflActive = active;
    } else if (api === 'serpapi') {
      this.serpapiActive = active;
    } else if (api === 'meme') {
      this.memeActive = active;
    } else {
      this.ollamaActive = active;
    }
  }

  private getQueue(api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi' | 'meme'): QueueEntry[] {
    if (api === 'comfyui') return this.comfyuiQueue;
    if (api === 'accuweather') return this.accuweatherQueue;
    if (api === 'nfl') return this.nflQueue;
    if (api === 'serpapi') return this.serpapiQueue;
    if (api === 'meme') return this.memeQueue;
    return this.ollamaQueue;
  }

  /**
   * Enqueue a request for the given API.
   * Requests are executed serially (FIFO) per API — the promise resolves
   * when this particular request completes (or rejects on timeout / error).
   *
   * The executor receives an AbortSignal that is aborted on timeout so
   * cooperative callers can stop work early.
   */
  execute<T>(
    api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi' | 'meme',
    requester: string,
    keyword: string,
    timeout: number,
    executor: ((signal: AbortSignal) => Promise<T>) | (() => Promise<T>),
    callerSignal?: AbortSignal
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const parentThreadId = getThreadId();
      const entry: QueueEntry<T> = {
        api,
        requester,
        keyword,
        timeout,
        executor: executor as (signal: AbortSignal) => Promise<T>,
        resolve,
        reject,
        callerSignal,
        parentThreadId,
      };

      this.getQueue(api).push(entry as unknown as QueueEntry);

      // If the API is idle, start draining immediately
      if (this.isApiAvailable(api)) {
        this.drain(api);
      }
    });
  }

  /**
   * Drain the queue for a given API — runs entries one at a time.
   */
  private async drain(api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi' | 'meme'): Promise<void> {
    const queue = this.getQueue(api);

    while (queue.length > 0) {
      const entry = queue.shift()!;

      // Skip entries whose caller has already cancelled — no point executing
      if (entry.callerSignal?.aborted) {
        entry.reject(new Error('Request was cancelled before execution'));
        continue;
      }

      this.setActive(api, true);

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const threadIdPart = generateThreadId();
      const threadId = entry.parentThreadId
        ? `${entry.parentThreadId}:${threadIdPart}`
        : threadIdPart;

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`Request timed out after ${entry.timeout}s`));
          }, entry.timeout * 1000);
        });

        // Combine the queue's timeout signal with any caller-provided signal
        const effectiveSignal = entry.callerSignal
          ? AbortSignal.any([controller.signal, entry.callerSignal])
          : controller.signal;

        const result = await runWithThreadId(threadId, () =>
          Promise.race([
            entry.executor(effectiveSignal),
            timeoutPromise,
          ])
        );
        entry.resolve(result);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('timed out')
        ) {
          logger.logTimeout(entry.requester, entry.keyword);
        }
        entry.reject(error);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        this.setActive(api, false);
      }
    }
  }
}

export const requestQueue = new RequestQueue();
