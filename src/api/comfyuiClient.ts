import axios, { AxiosInstance } from 'axios';
import { config } from '../utils/config';
import { fileHandler } from '../utils/fileHandler';
import { logger } from '../utils/logger';

export interface ComfyUIResponse {
  success: boolean;
  data?: {
    text?: string;
    images?: string[];
    videos?: string[];
  };
  error?: string;
}

class ComfyUIClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.getComfyUIEndpoint(),
      timeout: 30000,
    });
  }

  async generateImage(
    prompt: string,
    requester: string,
    timeout: number
  ): Promise<ComfyUIResponse> {
    try {
      logger.logRequest(
        requester,
        `ComfyUI generate: ${prompt.substring(0, 100)}...`
      );

      // This is a placeholder for ComfyUI API call
      // You'll need to implement the actual ComfyUI API protocol
      const response = await this.client.post('/api/prompt', {
        prompt: prompt,
        client_id: requester,
      });

      if (response.status === 200) {
        logger.logReply(
          requester,
          `ComfyUI generation completed for prompt: ${prompt.substring(0, 50)}...`
        );

        // Parse response data (this depends on your ComfyUI setup)
        return {
          success: true,
          data: {
            images: response.data.images || [],
          },
        };
      }

      return {
        success: false,
        error: 'Failed to generate image',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.logError(requester, `ComfyUI error: ${errorMsg}`);

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.client.get('/api/system/status');
      return response.status === 200;
    } catch {
      return false;
    }
  }
}

export const comfyuiClient = new ComfyUIClient();
