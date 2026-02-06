import { logger } from './logger';

export interface QueuedRequest {
  id: string;
  api: 'comfyui' | 'ollama';
  requester: string;
  keyword: string;
  data: string;
  timeout: number;
  executor: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  startTime: number;
}

class RequestQueue {
  private comfyuiActive: boolean = false;
  private ollamaActive: boolean = false;
  private requestIdCounter: number = 0;

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
  async execute(
    api: 'comfyui' | 'ollama',
    requester: string,
    keyword: string,
    timeout: number,
    executor: () => Promise<any>
  ): Promise<any> {
    if (!this.isApiAvailable(api)) {
      logger.logBusy(requester, api);
      throw new Error(`API_BUSY:${api}`);
    }

    this.setActive(api, true);
    const requestId = String(++this.requestIdCounter);

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
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
      this.setActive(api, false);
    }
  }
}

export const requestQueue = new RequestQueue();
