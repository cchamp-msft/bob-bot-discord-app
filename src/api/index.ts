import { comfyuiClient, ComfyUIResponse } from './comfyuiClient';
import { ollamaClient, OllamaResponse, OllamaHealthResult } from './ollamaClient';
import { config } from '../utils/config';

export type { ComfyUIResponse, OllamaResponse, OllamaHealthResult };

class ApiManager {
  async executeRequest(
    api: 'comfyui' | 'ollama',
    requester: string,
    data: string,
    _timeout: number,
    model?: string
  ): Promise<ComfyUIResponse | OllamaResponse> {
    if (api === 'comfyui') {
      return await comfyuiClient.generateImage(data, requester);
    } else {
      return await ollamaClient.generate(data, requester, model || config.getOllamaModel());
    }
  }

  async checkApiHealth(api: 'comfyui' | 'ollama'): Promise<boolean> {
    if (api === 'comfyui') {
      return await comfyuiClient.isHealthy();
    } else {
      return await ollamaClient.isHealthy();
    }
  }

  /**
   * Rebuild API client axios instances with current config endpoints.
   * Call after config.reload() on config save — not on other reload paths.
   */
  refreshClients(): void {
    ollamaClient.refresh();
    comfyuiClient.refresh();
  }

  /**
   * Test Ollama connection and return health status with available models.
   */
  async testOllamaConnection() {
    return await ollamaClient.testConnection();
  }

  /**
   * Validate a ComfyUI workflow JSON string.
   */
  validateWorkflow(workflowJson: string) {
    return comfyuiClient.validateWorkflow(workflowJson);
  }
}

export const apiManager = new ApiManager();
