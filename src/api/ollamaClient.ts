import axios, { AxiosInstance } from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { ChatMessage } from '../types';
import type { OllamaTool } from '../utils/toolsSchema';

/** Maximum tool calls to process per turn (enforced when returning from /api/chat). */
export const MAX_TOOL_CALLS = 3;

/** One tool call from Ollama message.tool_calls. */
export interface OllamaToolCall {
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

function normalizeToolCall(tc: unknown): OllamaToolCall | null {
  if (!tc || typeof tc !== 'object') return null;
  const t = tc as Record<string, unknown>;
  const fn = t.function;
  if (!fn || typeof fn !== 'object') return null;
  const f = fn as Record<string, unknown>;
  const name = f.name;
  if (typeof name !== 'string' || !name.trim()) return null;
  let args: Record<string, unknown> | string = f.arguments as Record<string, unknown> | string;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args) as Record<string, unknown>;
    } catch {
      args = {};
    }
  }
  if (typeof args !== 'object' || args === null) args = {};
  return {
    type: 'function',
    function: { name: name.trim(), arguments: args },
  };
}

export interface OllamaResponse {
  success: boolean;
  data?: {
    text: string;
    /** Present when the model returned tool_calls (trimmed to MAX_TOOL_CALLS). */
    tool_calls?: OllamaToolCall[];
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

  /** Cached model names with expiry to avoid per-request /api/tags calls */
  private modelCache: { names: Set<string>; expiry: number } = { names: new Set(), expiry: 0 };
  private static MODEL_CACHE_TTL_MS = 60_000; // 1 minute

  /** Cached vision capability per model name */
  private visionCache: Map<string, { capable: boolean; expiry: number }> = new Map();
  private static VISION_CACHE_TTL_MS = 60_000; // 1 minute

  /** Default HTTP timeout (ms) for all Ollama requests, including
   *  pre-flight checks that lack a per-request AbortSignal. */
  private static HTTP_TIMEOUT_MS = 60_000;

  constructor() {
    this.client = axios.create({
      baseURL: config.getOllamaEndpoint(),
      timeout: OllamaClient.HTTP_TIMEOUT_MS,
    });
  }

  /**
   * Rebuild the axios instance with the current endpoint from config.
   * Called after config.reload() on config save.
   */
  refresh(): void {
    this.client = axios.create({
      baseURL: config.getOllamaEndpoint(),
      timeout: OllamaClient.HTTP_TIMEOUT_MS,
    });
    // Invalidate model cache when endpoint changes
    this.modelCache = { names: new Set(), expiry: 0 };
    this.visionCache.clear();
  }

  /**
   * List all models available on the Ollama instance.
   * Calls GET /api/tags and parses the response.
   */
  async listModels(signal?: AbortSignal): Promise<OllamaModelInfo[]> {
    try {
      const response = await this.client.get('/api/tags', signal ? { signal } : undefined);
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
   * Uses a short-lived cache to avoid hitting /api/tags on every request.
   */
  async validateModel(model: string, signal?: AbortSignal): Promise<boolean> {
    const now = Date.now();
    if (now < this.modelCache.expiry && this.modelCache.names.size > 0) {
      return this.modelCache.names.has(model);
    }
    const models = await this.listModels(signal);
    this.modelCache = {
      names: new Set(models.map(m => m.name)),
      expiry: now + OllamaClient.MODEL_CACHE_TTL_MS,
    };
    return this.modelCache.names.has(model);
  }

  /**
   * Check if a model supports vision (image) inputs.
   * Calls POST /api/show and inspects model metadata for vision/clip indicators.
   * Results are cached with the same TTL as the model list cache.
   */
  async isVisionCapable(model: string, signal?: AbortSignal): Promise<boolean> {
    const now = Date.now();
    const cached = this.visionCache.get(model);
    if (cached && now < cached.expiry) {
      return cached.capable;
    }

    try {
      const response = await this.client.post('/api/show', { name: model }, signal ? { signal } : undefined);
      if (response.status === 200 && response.data) {
        const data = response.data;
        // Check model_info keys for vision/projector indicators
        const modelInfo = data.model_info;
        if (modelInfo && typeof modelInfo === 'object') {
          const keys = Object.keys(modelInfo);
          const hasVisionKey = keys.some(k =>
            k.includes('vision') || k.includes('projector') || k.includes('mmproj')
          );
          if (hasVisionKey) {
            this.visionCache.set(model, { capable: true, expiry: now + OllamaClient.VISION_CACHE_TTL_MS });
            return true;
          }
        }
        // Check details.families for 'clip' (used by llava and similar models)
        const families = data.details?.families;
        if (Array.isArray(families) && families.some((f: string) => f === 'clip')) {
          this.visionCache.set(model, { capable: true, expiry: now + OllamaClient.VISION_CACHE_TTL_MS });
          return true;
        }
      }
    } catch {
      // If we can't determine capability, assume not vision-capable
    }

    this.visionCache.set(model, { capable: false, expiry: now + OllamaClient.VISION_CACHE_TTL_MS });
    return false;
  }

  async generate(
    prompt: string,
    requester: string,
    model?: string,
    conversationHistory?: ChatMessage[],
    signal?: AbortSignal,
    options?: { includeSystemPrompt?: boolean; tools?: OllamaTool[]; contextSize?: number },
    images?: string[],
  ): Promise<OllamaResponse> {
    let selectedModel = model || config.getOllamaModel();

    if (!selectedModel) {
      const errorMsg = 'No Ollama model configured. Please select a model in the configurator.';
      logger.logError(requester, errorMsg);
      return { success: false, error: errorMsg };
    }

    try {
      // Detect whether any images exist — either on the trigger message or
      // carried on conversation history entries (reply-chain image collection).
      const hasDirectImages = images && images.length > 0;
      const hasHistoryImages = conversationHistory?.some(m => m.images && m.images.length > 0) ?? false;
      const hasAnyImages = hasDirectImages || hasHistoryImages;

      // When images are present, verify the selected model supports vision.
      // If not, auto-switch to the configured vision model.
      if (hasAnyImages) {
        const isVision = await this.isVisionCapable(selectedModel, signal);
        if (!isVision) {
          const visionModel = config.getOllamaVisionModel();
          if (!visionModel || visionModel === selectedModel) {
            const errorMsg = `Model "${selectedModel}" does not support images and no vision model is configured (OLLAMA_VISION_MODEL).`;
            logger.logError(requester, errorMsg);
            return { success: false, error: errorMsg };
          }
          logger.log('success', requester,
            `VISION: Model "${selectedModel}" lacks vision capability — switching to "${visionModel}"`);
          selectedModel = visionModel;
        }
      }

      // Validate that the model exists before sending
      const modelExists = await this.validateModel(selectedModel, signal);
      if (!modelExists) {
        const errorMsg = `Ollama model "${selectedModel}" is not available. Please check the configurator.`;
        logger.logError(requester, errorMsg);
        return { success: false, error: errorMsg };
      }

      logger.logRequest(
        requester,
        `Ollama ${selectedModel}: ${prompt.substring(0, 100)}...`
      );

      // Build messages array for /api/chat
      const messages: ChatMessage[] = [];

      // Add global persona/system prompt unless caller opts out.
      // Internal tool calls (context evaluator, keyword classifier) set
      // includeSystemPrompt: false so only their own system prompt is used.
      if (options?.includeSystemPrompt !== false) {
        const systemPrompt = config.getOllamaSystemPrompt();
        if (systemPrompt) {
          messages.push({ role: 'system', content: systemPrompt });
        }
      }

      // Add conversation history from reply chain (if any)
      if (conversationHistory && conversationHistory.length > 0) {
        messages.push(...conversationHistory);
      }

      // Add current user message (with optional images for vision models)
      const userMessage: ChatMessage = { role: 'user', content: prompt };
      if (images && images.length > 0) {
        userMessage.images = images;
      }
      messages.push(userMessage);

      const requestBody: Record<string, unknown> = {
        model: selectedModel,
        messages,
        stream: false,
      };
      if (options?.tools && options.tools.length > 0) {
        requestBody.tools = options.tools;
      }
      if (options?.contextSize) {
        requestBody.options = {
          num_ctx: options.contextSize,
        };
      }

      // DEBUG: log full Ollama request messages
      logger.logDebugLazy(requester, () => `OLLAMA-REQUEST: model=${selectedModel}, messages=${JSON.stringify(messages, null, 2)}`);

      const response = await this.client.post('/api/chat', requestBody, signal ? { signal } : undefined);

      if (response.status === 200 && response.data?.message) {
        const msg = response.data.message as { content?: string; tool_calls?: unknown[] };
        const responseText = msg.content ?? '';
        const rawToolCalls = msg.tool_calls;

        logger.logReply(
          requester,
          `Ollama response received for prompt: ${prompt.substring(0, 50)}...`
        );

        // DEBUG: log full Ollama response text
        logger.logDebug(requester, `OLLAMA-RESPONSE: ${responseText}`);

        let tool_calls: OllamaToolCall[] | undefined;
        if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
          tool_calls = rawToolCalls
            .slice(0, MAX_TOOL_CALLS)
            .map((tc: unknown) => normalizeToolCall(tc))
            .filter((tc): tc is OllamaToolCall => tc !== null);
        }

        return {
          success: true,
          data: {
            text: responseText,
            ...(tool_calls && tool_calls.length > 0 ? { tool_calls } : {}),
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
   * Unlike listModels(), this method intentionally does NOT swallow network
   * errors so that a connection failure is reported as healthy: false.
   */
  async testConnection(): Promise<OllamaHealthResult> {
    try {
      const response = await this.client.get('/api/tags');
      if (response.status === 200 && Array.isArray(response.data?.models)) {
        const models: OllamaModelInfo[] = response.data.models.map((m: Record<string, unknown>) => ({
          name: String(m.name ?? ''),
          size: Number(m.size ?? 0),
          parameterSize: String((m.details as Record<string, unknown>)?.parameter_size ?? ''),
          family: String((m.details as Record<string, unknown>)?.family ?? ''),
          quantization: String((m.details as Record<string, unknown>)?.quantization_level ?? ''),
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
      const response = await this.client.get('/api/tags');
      return response.status === 200;
    } catch {
      return false;
    }
  }
}

export const ollamaClient = new OllamaClient();
