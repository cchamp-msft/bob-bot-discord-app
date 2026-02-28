import axios, { AxiosInstance } from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { ChatMessage } from '../types';
import type { OllamaTool } from '../utils/toolsSchema';
import type { OllamaToolCall } from './ollamaClient';

export interface XaiModelInfo {
  id: string;
  owned_by?: string;
}

export interface XaiHealthResult {
  healthy: boolean;
  models: XaiModelInfo[];
  error?: string;
}

export interface XaiResponse {
  success: boolean;
  data?: {
    text: string;
    tool_calls?: OllamaToolCall[];
  };
  error?: string;
}

export interface XaiImageResponse {
  success: boolean;
  data?: {
    images: string[];
  };
  error?: string;
}

/**
 * Map OllamaTool schema to OpenAI function-calling format used by xAI.
 * xAI uses the same OpenAI-compatible schema.
 */
function mapToolsToOpenAI(tools: OllamaTool[]): unknown[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

class XaiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = this.createClient();
  }

  private createClient(): AxiosInstance {
    return axios.create({
      baseURL: config.getXaiEndpoint(),
      timeout: config.getXaiTimeout(),
      headers: {
        'Content-Type': 'application/json',
        ...(config.getXaiApiKey() ? { Authorization: `Bearer ${config.getXaiApiKey()}` } : {}),
      },
    });
  }

  refresh(): void {
    this.client = this.createClient();
  }

  async listModels(signal?: AbortSignal): Promise<XaiModelInfo[]> {
    try {
      const response = await this.client.get('/models', signal ? { signal } : undefined);
      if (response.status === 200 && Array.isArray(response.data?.data)) {
        return response.data.data.map((m: Record<string, unknown>) => ({
          id: String(m.id ?? ''),
          owned_by: m.owned_by ? String(m.owned_by) : undefined,
        }));
      }
      return [];
    } catch {
      return [];
    }
  }

  async testConnection(): Promise<XaiHealthResult> {
    try {
      const response = await this.client.get('/models');
      if (response.status === 200 && Array.isArray(response.data?.data)) {
        const models: XaiModelInfo[] = response.data.data.map((m: Record<string, unknown>) => ({
          id: String(m.id ?? ''),
          owned_by: m.owned_by ? String(m.owned_by) : undefined,
        }));
        return { healthy: true, models };
      }
      return { healthy: true, models: [] };
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
      const response = await this.client.get('/models');
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async generate(
    prompt: string,
    requester: string,
    model?: string,
    conversationHistory?: ChatMessage[],
    signal?: AbortSignal,
    options?: {
      includeSystemPrompt?: boolean;
      tools?: OllamaTool[];
      timeout?: number;
    },
  ): Promise<XaiResponse> {
    const selectedModel = model || config.getXaiModel();

    if (!selectedModel) {
      const errorMsg = 'No xAI model configured. Please select a model in the configurator.';
      logger.logError(requester, errorMsg);
      return { success: false, error: errorMsg };
    }

    try {
      const messages: Array<{ role: string; content: string }> = [];

      if (options?.includeSystemPrompt !== false) {
        const systemPrompt = config.getOllamaSystemPrompt();
        if (systemPrompt) {
          let fullSystemPrompt = systemPrompt;
          if (config.getXaiEncourageBuiltinTools()) {
            fullSystemPrompt += '\n\nPlease provide a thorough response. If needed, use your available tools (e.g., web_search, x_keyword_search, code_execution) to gather updated info, verify facts, or perform computations before finalizing your answer.';
          }
          messages.push({ role: 'system', content: fullSystemPrompt });
        }
      }

      if (conversationHistory && conversationHistory.length > 0) {
        for (const msg of conversationHistory) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }

      messages.push({ role: 'user', content: prompt });

      const requestBody: Record<string, unknown> = {
        model: selectedModel,
        messages,
        stream: false,
      };

      if (options?.tools && options.tools.length > 0) {
        requestBody.tools = mapToolsToOpenAI(options.tools);
      }

      logger.logRequest(
        requester,
        `xAI ${selectedModel}: ${prompt.substring(0, 100)}...`
      );

      logger.logDebugLazy(requester, () =>
        `XAI-REQUEST: model=${selectedModel}, messages=${JSON.stringify(messages, null, 2)}`
      );

      const reqConfig: Record<string, unknown> = {};
      if (signal) reqConfig.signal = signal;
      if (options?.timeout) reqConfig.timeout = options.timeout;

      const response = await this.client.post(
        '/chat/completions',
        requestBody,
        Object.keys(reqConfig).length > 0 ? reqConfig : undefined,
      );

      if (response.status === 200 && response.data?.choices?.length > 0) {
        const choice = response.data.choices[0];
        const responseText = choice.message?.content ?? '';
        const rawToolCalls = choice.message?.tool_calls;

        logger.logReply(
          requester,
          `xAI response received for prompt: ${prompt.substring(0, 50)}...`
        );

        logger.logDebug(requester, `XAI-RESPONSE: ${responseText}`);

        let tool_calls: OllamaToolCall[] | undefined;
        if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
          const parsed: OllamaToolCall[] = [];
          for (const tc of rawToolCalls.slice(0, 3)) {
            const fn = (tc as Record<string, unknown>).function as Record<string, unknown> | undefined;
            if (!fn || typeof fn.name !== 'string') continue;
            let args: Record<string, unknown> | string = {};
            if (typeof fn.arguments === 'string') {
              try { args = JSON.parse(fn.arguments) as Record<string, unknown>; } catch { args = {}; }
            } else if (typeof fn.arguments === 'object' && fn.arguments !== null) {
              args = fn.arguments as Record<string, unknown>;
            }
            parsed.push({
              type: 'function',
              function: { name: fn.name.trim(), arguments: args },
            });
          }
          if (parsed.length > 0) tool_calls = parsed;
        }

        return {
          success: true,
          data: {
            text: responseText,
            ...(tool_calls && tool_calls.length > 0 ? { tool_calls } : {}),
          },
        };
      }

      return { success: false, error: 'Failed to generate response from xAI' };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.logError(requester, `xAI error: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Generate an image using xAI's image generation API.
   * Returns base64-encoded image data URLs.
   */
  async generateImage(
    prompt: string,
    requester: string,
    signal?: AbortSignal,
  ): Promise<XaiImageResponse> {
    const model = 'grok-2-image';

    try {
      logger.logRequest(requester, `xAI image generation: ${prompt.substring(0, 80)}...`);

      const requestBody = {
        model,
        messages: [{ role: 'user', content: prompt }],
      };

      const reqConfig: Record<string, unknown> = {};
      if (signal) reqConfig.signal = signal;

      const response = await this.client.post('/chat/completions', requestBody,
        Object.keys(reqConfig).length > 0 ? reqConfig : undefined);

      if (response.status === 200 && response.data?.choices?.length > 0) {
        const choice = response.data.choices[0];
        const content = choice.message?.content;
        const images: string[] = [];

        if (typeof content === 'string' && content.startsWith('data:image')) {
          images.push(content);
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part?.type === 'image_url' && part?.image_url?.url) {
              images.push(part.image_url.url);
            }
          }
        }

        if (images.length > 0) {
          logger.logReply(requester, `xAI image generated: ${images.length} image(s)`);
          return { success: true, data: { images } };
        }

        return { success: false, error: 'No images returned from xAI' };
      }

      return { success: false, error: 'Failed to generate image from xAI' };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.logError(requester, `xAI image error: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }
}

export const xaiClient = new XaiClient();
