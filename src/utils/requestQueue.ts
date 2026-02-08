import { logger } from './logger';

interface QueueEntry<T = unknown> {
  api: 'comfyui' | 'ollama' | 'accuweather';
  requester: string;
  keyword: string;
  timeout: number;
  executor: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

class RequestQueue {
  private comfyuiActive: boolean = false;
  private ollamaActive: boolean = false;
  private accuweatherActive: boolean = false;
  private comfyuiQueue: QueueEntry[] = [];
  private ollamaQueue: QueueEntry[] = [];
  private accuweatherQueue: QueueEntry[] = [];

  isApiAvailable(api: 'comfyui' | 'ollama' | 'accuweather'): boolean {
    if (api === 'comfyui') return !this.comfyuiActive;
    if (api === 'accuweather') return !this.accuweatherActive;
    return !this.ollamaActive;
  }

  /** Number of pending (waiting) entries for an API. */
  pending(api: 'comfyui' | 'ollama' | 'accuweather'): number {
    if (api === 'comfyui') return this.comfyuiQueue.length;
    if (api === 'accuweather') return this.accuweatherQueue.length;
    return this.ollamaQueue.length;
  }

  private setActive(api: 'comfyui' | 'ollama' | 'accuweather', active: boolean): void {
    if (api === 'comfyui') {
      this.comfyuiActive = active;
    } else if (api === 'accuweather') {
      this.accuweatherActive = active;
    } else {
      this.ollamaActive = active;
    }
  }

  private getQueue(api: 'comfyui' | 'ollama' | 'accuweather'): QueueEntry[] {
    if (api === 'comfyui') return this.comfyuiQueue;
    if (api === 'accuweather') return this.accuweatherQueue;
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
    api: 'comfyui' | 'ollama' | 'accuweather',
    requester: string,
    keyword: string,
    timeout: number,
    executor: ((signal: AbortSignal) => Promise<T>) | (() => Promise<T>)
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        api,
        requester,
        keyword,
        timeout,
        executor: executor as (signal: AbortSignal) => Promise<T>,
        resolve,
        reject,
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
  private async drain(api: 'comfyui' | 'ollama' | 'accuweather'): Promise<void> {
    const queue = this.getQueue(api);

    while (queue.length > 0) {
      const entry = queue.shift()!;
      this.setActive(api, true);

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`Request timed out after ${entry.timeout}s`));
          }, entry.timeout * 1000);
        });

        const result = await Promise.race([
          entry.executor(controller.signal),
          timeoutPromise,
        ]);
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
