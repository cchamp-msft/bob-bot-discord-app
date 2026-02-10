import { comfyuiClient, ComfyUIResponse } from './comfyuiClient';
import { ollamaClient, OllamaResponse, OllamaHealthResult } from './ollamaClient';
import { accuweatherClient } from './accuweatherClient';
import { nflClient } from './nflClient';
import { config } from '../utils/config';
import { ChatMessage, AccuWeatherResponse, AccuWeatherHealthResult, NFLResponse, NFLHealthResult } from '../types';

export type { ComfyUIResponse, OllamaResponse, OllamaHealthResult, AccuWeatherResponse, AccuWeatherHealthResult, NFLResponse, NFLHealthResult };

/** Options forwarded to ollamaClient.generate() when api === 'ollama'. */
export interface OllamaRequestOptions {
  /** When false, skip the global persona system prompt (caller supplies its own). */
  includeSystemPrompt?: boolean;
}

class ApiManager {
  async executeRequest(
    api: 'comfyui' | 'ollama' | 'accuweather' | 'external',
    requester: string,
    data: string,
    _timeout: number,
    model?: string,
    conversationHistory?: ChatMessage[],
    signal?: AbortSignal,
    accuweatherMode?: 'current' | 'forecast' | 'full',
    ollamaOptions?: OllamaRequestOptions
  ): Promise<ComfyUIResponse | OllamaResponse | AccuWeatherResponse> {
    if (api === 'comfyui') {
      return await comfyuiClient.generateImage(data, requester, signal, _timeout);
    } else if (api === 'accuweather') {
      return await accuweatherClient.getWeather(data, requester, accuweatherMode || 'full');
    } else if (api === 'external') {
      // Stub for future external API integrations
      throw new Error('External API routing is not yet implemented');
    } else {
      return await ollamaClient.generate(data, requester, model || config.getOllamaModel(), conversationHistory, signal, ollamaOptions);
    }
  }

  async checkApiHealth(api: 'comfyui' | 'ollama' | 'accuweather'): Promise<boolean> {
    if (api === 'comfyui') {
      return await comfyuiClient.isHealthy();
    } else if (api === 'accuweather') {
      return await accuweatherClient.isHealthy();
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
    accuweatherClient.refresh();
    nflClient.refresh();
  }

  async checkNflHealth(): Promise<NFLHealthResult> {
    return await nflClient.testConnection();
  }

  /**
   * Test Ollama connection and return health status with available models.
   */
  async testOllamaConnection() {
    return await ollamaClient.testConnection();
  }

  /**
   * Test AccuWeather connection and return health status with location info.
   */
  async testAccuWeatherConnection() {
    return await accuweatherClient.testConnection();
  }

  /**
   * Validate a ComfyUI workflow JSON string.
   */
  validateWorkflow(workflowJson: string) {
    return comfyuiClient.validateWorkflow(workflowJson);
  }
}

export const apiManager = new ApiManager();
