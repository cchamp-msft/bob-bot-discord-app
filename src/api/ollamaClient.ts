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

export interface OllamaModelInfo {
  name: string;
  size: number;
  parameterSize: string;
  family: string;
  quantization: string;
}

export interface OllamaHealthResult {
  healthy: boolean;
  models: OllamaModelInfo[];
  error?: string;
}

class OllamaClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.getOllamaEndpoint(),
    });
  }

  /**
   * Rebuild the axios instance with the current endpoint from config.
   * Called after config.reload() on config save.
   */
  refresh(): void {
    this.client = axios.create({
      baseURL: config.getOllamaEndpoint(),
    });
  }

  /**
   * List all models available on the Ollama instance.
   * Calls GET /api/tags and parses the response.
   */
  async listModels(): Promise<OllamaModelInfo[]> {
    try {
      const response = await this.client.get('/api/tags');
      if (response.status === 200 && Array.isArray(response.data?.models)) {
        return response.data.models.map((m: Record<string, unknown>) => ({
          name: String(m.name ?? ''),
          size: Number(m.size ?? 0),
          parameterSize: String((m.details as Record<string, unknown>)?.parameter_size ?? ''),
          family: String((m.details as Record<string, unknown>)?.family ?? ''),
          quantization: String((m.details as Record<string, unknown>)?.quantization_level ?? ''),
        }));
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Check whether a specific model name exists on the Ollama instance.
   */
  async validateModel(model: string): Promise<boolean> {
    const models = await this.listModels();
    return models.some((m) => m.name === model);
  }

  async generate(
    prompt: string,
    requester: string,
    model?: string
  ): Promise<OllamaResponse> {
    const selectedModel = model || config.getOllamaModel();

    if (!selectedModel) {
      const errorMsg = 'No Ollama model configured. Please select a model in the configurator.';
      logger.logError(requester, errorMsg);
      return { success: false, error: errorMsg };
    }

    try {
      // Validate that the model exists before sending
      const modelExists = await this.validateModel(selectedModel);
      if (!modelExists) {
        const errorMsg = `Ollama model "${selectedModel}" is not available. Please check the configurator.`;
        logger.logError(requester, errorMsg);
        return { success: false, error: errorMsg };
      }

      logger.logRequest(
        requester,
        `Ollama ${selectedModel}: ${prompt.substring(0, 100)}...`
      );

      const systemPrompt = config.getOllamaSystemPrompt();
      const requestBody: Record<string, unknown> = {
        model: selectedModel,
        prompt: prompt,
        stream: false,
      };
      if (systemPrompt) {
        requestBody.system = systemPrompt;
      }

      const response = await this.client.post('/api/generate', requestBody);

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

  /**
   * Test connection to Ollama and return health status with available models.
   */
  async testConnection(): Promise<OllamaHealthResult> {
    try {
      const models = await this.listModels();
      return {
        healthy: true,
        models,
      };
    } catch (error) {
      return {
        healthy: false,
        models: [],
        error: error instanceof Error ? error.message : String(error),
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
