import { comfyuiClient, ComfyUIResponse } from './comfyuiClient';
import { ollamaClient, OllamaResponse } from './ollamaClient';

export type { ComfyUIResponse, OllamaResponse };

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
      return await ollamaClient.generate(data, requester, model || 'llama2');
    }
  }

  async checkApiHealth(api: 'comfyui' | 'ollama'): Promise<boolean> {
    if (api === 'comfyui') {
      return await comfyuiClient.isHealthy();
    } else {
      return await ollamaClient.isHealthy();
    }
  }
}

export const apiManager = new ApiManager();
