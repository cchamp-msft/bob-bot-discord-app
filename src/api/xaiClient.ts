import axios, { AxiosInstance } from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { persistMedia, PersistedMedia } from '../utils/mediaPersistence';
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
    /** Persisted output descriptors (populated when save succeeds). */
    savedOutputs?: PersistedMedia[];
  };
  error?: string;
}

export interface XaiVideoResponse {
  success: boolean;
  data?: {
    url: string;
    duration?: number;
    /** Persisted output descriptors (populated when save succeeds). */
    savedOutputs?: PersistedMedia[];
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

      logger.logXaiDebugLazy(requester, () =>
        `XAI-REQUEST: model=${selectedModel}, messages=${JSON.stringify(messages, null, 2)}`
      );

      if (options?.tools && options.tools.length > 0) {
        logger.logXaiDebugLazy(requester, () =>
          `XAI-TOOLS: ${JSON.stringify(requestBody.tools, null, 2)}`
        );
      }

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

        logger.logXaiDebug(requester, `XAI-RESPONSE: ${responseText}`);

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

          logger.logXaiDebugLazy(requester, () =>
            `XAI-TOOL-CALLS: ${JSON.stringify(tool_calls, null, 2)}`
          );
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
   * Generate an image using xAI's dedicated image generation endpoint.
   * Uses POST /images/generations with the grok-imagine-image model.
   * Returns image URLs (temporary — download or process promptly).
   */
  async generateImage(
    prompt: string,
    requester: string,
    signal?: AbortSignal,
  ): Promise<XaiImageResponse> {
    const model = config.getXaiImageModel();

    try {
      logger.logRequest(requester, `xAI image generation: ${prompt.substring(0, 80)}...`);

      const requestBody: Record<string, unknown> = {
        model,
        prompt,
        response_format: 'url',
      };

      logger.logXaiDebugLazy(requester, () =>
        `XAI-IMAGE-REQUEST: model=${model}, prompt=${prompt}`
      );

      const reqConfig: Record<string, unknown> = {};
      if (signal) reqConfig.signal = signal;

      const response = await this.client.post('/images/generations', requestBody,
        Object.keys(reqConfig).length > 0 ? reqConfig : undefined);

      if (response.status === 200 && Array.isArray(response.data?.data)) {
        const images: string[] = [];
        for (const item of response.data.data) {
          if (item?.url) {
            images.push(item.url);
          } else if (item?.b64_json) {
            images.push(`data:image/png;base64,${item.b64_json}`);
          }
        }

        if (images.length > 0) {
          logger.logReply(requester, `xAI image generated: ${images.length} image(s)`);
          logger.logXaiDebug(requester, `XAI-IMAGE-RESPONSE: ${images.length} image(s) received`);

          // Persist generated images to outputs/
          const savedOutputs = await persistMedia(
            requester,
            prompt,
            images.map(src => ({
              source: src,
              defaultExtension: 'png',
              mediaType: 'image' as const,
            })),
            'xai',
          );
          if (savedOutputs.length > 0) {
            logger.logDebug(requester, `xAI images persisted: ${savedOutputs.length} file(s)`);
          }

          return { success: true, data: { images, savedOutputs } };
        }

        logger.logXaiDebug(requester, `XAI-IMAGE-RESPONSE: No images found in response data`);
        return { success: false, error: 'No images returned from xAI' };
      }

      return { success: false, error: `xAI image generation failed with status ${response.status}` };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.logError(requester, `xAI image error: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Generate a video using xAI's video generation endpoint.
   * Submits POST /videos/generations, then polls GET /videos/:requestId
   * until status is 'done', 'expired', or timeout is reached.
   */
  async generateVideo(
    prompt: string,
    requester: string,
    signal?: AbortSignal,
  ): Promise<XaiVideoResponse> {
    const model = config.getXaiVideoModel();
    const pollIntervalMs = 5_000;
    const maxPollMs = 10 * 60 * 1000;

    try {
      logger.logRequest(requester, `xAI video generation: ${prompt.substring(0, 80)}...`);

      const requestBody: Record<string, unknown> = {
        model,
        prompt,
      };

      logger.logXaiDebugLazy(requester, () =>
        `XAI-VIDEO-REQUEST: model=${model}, prompt=${prompt}`
      );

      const reqConfig: Record<string, unknown> = {};
      if (signal) reqConfig.signal = signal;

      const startResponse = await this.client.post('/videos/generations', requestBody,
        Object.keys(reqConfig).length > 0 ? reqConfig : undefined);

      const requestId = startResponse.data?.request_id;
      if (!requestId) {
        return { success: false, error: 'xAI video generation did not return a request_id' };
      }

      logger.logXaiDebug(requester, `XAI-VIDEO-POLL: started, request_id=${requestId}`);

      const startTime = Date.now();
      while (Date.now() - startTime < maxPollMs) {
        if (signal?.aborted) {
          return { success: false, error: 'xAI video generation aborted' };
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        const pollResponse = await this.client.get(`/videos/${requestId}`,
          signal ? { signal } : undefined);
        const status = pollResponse.data?.status;

        logger.logXaiDebug(requester, `XAI-VIDEO-POLL: status=${status}`);

        if (status === 'done') {
          const video = pollResponse.data?.video;
          if (video?.url) {
            logger.logReply(requester, `xAI video generated: ${video.duration ?? '?'}s`);

            // Persist generated video to outputs/
            const savedOutputs = await persistMedia(
              requester,
              prompt,
              [{ source: video.url, defaultExtension: 'mp4', mediaType: 'video' as const }],
              'xai',
            );
            if (savedOutputs.length > 0) {
              logger.logDebug(requester, `xAI video persisted: ${savedOutputs.length} file(s)`);
            }

            return {
              success: true,
              data: { url: video.url, duration: video.duration, savedOutputs },
            };
          }
          return { success: false, error: 'xAI video completed but returned no URL' };
        }

        if (status === 'expired') {
          return { success: false, error: 'xAI video generation request expired' };
        }
      }

      return { success: false, error: `xAI video generation timed out after ${maxPollMs / 1000}s` };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.logError(requester, `xAI video error: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }
}

export const xaiClient = new XaiClient();
