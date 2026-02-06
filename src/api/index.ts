import { comfyuiClient } from './comfyuiClient';
import { ollamaClient } from './ollamaClient';

class ApiManager {
  async executeRequest(
    api: 'comfyui' | 'ollama',
    requester: string,
    data: string,
    timeout: number
  ): Promise<any> {
    if (api === 'comfyui') {
      return await comfyuiClient.generateImage(data, requester, timeout);
    } else {
      return await ollamaClient.generate(data, requester);
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
