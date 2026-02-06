import axios, { AxiosInstance } from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

export interface OllamaResponse {
  success: boolean;
  data?: {
    text: string;
  };
  error?: string;
}

class OllamaClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.getOllamaEndpoint(),
      timeout: 30000,
    });
  }

  async generate(
    prompt: string,
    requester: string,
    model: string = 'llama2'
  ): Promise<OllamaResponse> {
    try {
      logger.logRequest(
        requester,
        `Ollama ${model}: ${prompt.substring(0, 100)}...`
      );

      const response = await this.client.post('/api/generate', {
        model: model,
        prompt: prompt,
        stream: false,
      });

      if (response.status === 200 && response.data.response) {
        logger.logReply(
          requester,
          `Ollama response received for prompt: ${prompt.substring(0, 50)}...`
        );

        return {
          success: true,
          data: {
            text: response.data.response,
          },
        };
      }

      return {
        success: false,
        error: 'Failed to generate response',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.logError(requester, `Ollama error: ${errorMsg}`);

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.client.get('/api/tags');
      return response.status === 200;
    } catch {
      return false;
    }
  }
}

export const ollamaClient = new OllamaClient();
