import { logger } from './logger';

class RequestQueue {
  private comfyuiActive: boolean = false;
  private ollamaActive: boolean = false;

  isApiAvailable(api: 'comfyui' | 'ollama'): boolean {
    return api === 'comfyui' ? !this.comfyuiActive : !this.ollamaActive;
  }

  private setActive(api: 'comfyui' | 'ollama', active: boolean): void {
    if (api === 'comfyui') {
      this.comfyuiActive = active;
    } else {
      this.ollamaActive = active;
    }
  }

  /**
   * Execute a request through the queue.
   * If the API is busy, rejects immediately with an error.
   * Otherwise, marks the API as busy and runs the executor function
   * with the configured timeout.
   */
  async execute<T>(
    api: 'comfyui' | 'ollama',
    requester: string,
    keyword: string,
    timeout: number,
    executor: () => Promise<T>
  ): Promise<T> {
    if (!this.isApiAvailable(api)) {
      logger.logBusy(requester, api);
      throw new Error(`API_BUSY:${api}`);
    }

    this.setActive(api, true);
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Request timed out after ${timeout}s`));
        }, timeout * 1000);
      });

      const result = await Promise.race([executor(), timeoutPromise]);
      return result;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('timed out')
      ) {
        logger.logTimeout(requester, keyword);
      }
      throw error;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      this.setActive(api, false);
    }
  }
}

export const requestQueue = new RequestQueue();
