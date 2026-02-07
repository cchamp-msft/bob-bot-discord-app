import axios, { AxiosInstance } from 'axios';
import { config } from '../utils/config';
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

export interface WorkflowValidationResult {
  valid: boolean;
  error?: string;
}

/** Delay helper for polling loops. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class ComfyUIClient {
  private client: AxiosInstance;

  /** Maximum time (ms) to wait for a ComfyUI prompt to complete. */
  private static POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  /** Interval (ms) between history polls. */
  private static POLL_INTERVAL_MS = 3_000; // 3 seconds

  constructor() {
    this.client = axios.create({
      baseURL: config.getComfyUIEndpoint(),
    });
  }

  /**
   * Rebuild the axios instance with the current endpoint from config.
   * Called after config.reload() on config save.
   */
  refresh(): void {
    this.client = axios.create({
      baseURL: config.getComfyUIEndpoint(),
    });
  }

  /**
   * Validate a workflow JSON string.
   * Checks that it is valid JSON and contains at least one occurrence of %prompt% (case-sensitive).
   */
  validateWorkflow(workflowJson: string): WorkflowValidationResult {
    // Validate JSON structure
    try {
      JSON.parse(workflowJson);
    } catch (e) {
      return {
        valid: false,
        error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Validate %prompt% placeholder presence (case-sensitive)
    if (!workflowJson.includes('%prompt%')) {
      return {
        valid: false,
        error: 'Workflow must contain at least one %prompt% placeholder (case-sensitive).',
      };
    }

    return { valid: true };
  }

  async generateImage(
    prompt: string,
    requester: string,
    signal?: AbortSignal
  ): Promise<ComfyUIResponse> {
    try {
      const workflowJson = config.getComfyUIWorkflow();

      if (!workflowJson) {
        const errorMsg = 'No ComfyUI workflow configured. Please upload a workflow JSON in the configurator.';
        logger.logError(requester, errorMsg);
        return { success: false, error: errorMsg };
      }

      // Validate workflow before use
      const validation = this.validateWorkflow(workflowJson);
      if (!validation.valid) {
        const errorMsg = `ComfyUI workflow validation failed: ${validation.error}`;
        logger.logError(requester, errorMsg);
        return { success: false, error: errorMsg };
      }

      logger.logRequest(
        requester,
        `ComfyUI generate: ${prompt.substring(0, 100)}...`
      );

      // JSON-escape the prompt so quotes/backslashes don't break the workflow JSON
      const escapedPrompt = JSON.stringify(prompt).slice(1, -1);

      // Replace all occurrences of %prompt% with the escaped prompt (case-sensitive)
      const substitutedWorkflow = workflowJson.split('%prompt%').join(escapedPrompt);

      // Parse the substituted workflow to send as the prompt object
      const workflowData = JSON.parse(substitutedWorkflow);

      // Step 1: Submit the prompt — response contains { prompt_id }
      let submitResponse;
      try {
        submitResponse = await this.client.post(
          '/api/prompt',
          {
            prompt: workflowData,
            client_id: requester,
          },
          signal ? { signal } : undefined
        );
      } catch (submitError) {
        // Axios throws on non-2xx — extract the response body for diagnostics
        const axiosErr = submitError as { response?: { status?: number; data?: unknown } };
        if (axiosErr.response) {
          const detail = typeof axiosErr.response.data === 'object'
            ? JSON.stringify(axiosErr.response.data)
            : String(axiosErr.response.data ?? '');
          const errorMsg = `ComfyUI prompt rejected (HTTP ${axiosErr.response.status}): ${detail}`;
          logger.logError(requester, errorMsg);
          return { success: false, error: errorMsg };
        }
        throw submitError; // re-throw non-HTTP errors (network, abort, etc.)
      }

      if (submitResponse.status !== 200 || !submitResponse.data?.prompt_id) {
        const nodeErrors = submitResponse.data?.node_errors;
        if (nodeErrors && Object.keys(nodeErrors).length > 0) {
          const errorMsg = `ComfyUI workflow errors: ${JSON.stringify(nodeErrors)}`;
          logger.logError(requester, errorMsg);
          return { success: false, error: errorMsg };
        }
        return { success: false, error: 'Failed to submit prompt to ComfyUI' };
      }

      const promptId: string = submitResponse.data.prompt_id;
      logger.logReply(requester, `ComfyUI prompt submitted: ${promptId}`);

      // Step 2: Poll /history/{prompt_id} until the job completes
      const historyData = await this.pollForCompletion(promptId, signal);

      if (!historyData) {
        const errorMsg = 'ComfyUI generation timed out waiting for results';
        logger.logError(requester, errorMsg);
        return { success: false, error: errorMsg };
      }

      // Step 3: Extract image URLs from output nodes
      const images = this.extractImageUrls(historyData);

      logger.logReply(
        requester,
        `ComfyUI generation completed for prompt: ${prompt.substring(0, 50)}... (${images.length} image(s))`
      );

      return {
        success: true,
        data: { images },
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

  /**
   * Poll GET /history/{promptId} until the prompt appears in the response,
   * indicating the workflow has finished executing.
   * Returns the history entry for the prompt, or null on timeout/abort.
   */
  async pollForCompletion(
    promptId: string,
    signal?: AbortSignal
  ): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + ComfyUIClient.POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (signal?.aborted) return null;

      try {
        const response = await this.client.get(`/history/${promptId}`);
        if (response.status === 200 && response.data?.[promptId]) {
          return response.data[promptId] as Record<string, unknown>;
        }
      } catch {
        // History not ready yet — continue polling
      }

      await delay(ComfyUIClient.POLL_INTERVAL_MS);
    }

    return null;
  }

  /**
   * Walk the outputs object from a ComfyUI history entry and collect
   * downloadable image URLs via the /view endpoint.
   * Handles all output node types (SaveImage, PreviewImage, etc.).
   */
  extractImageUrls(historyData: Record<string, unknown>): string[] {
    const images: string[] = [];
    const outputs = historyData.outputs as Record<string, Record<string, unknown>> | undefined;
    if (!outputs) return images;

    const baseURL = this.client.defaults.baseURL || '';

    for (const nodeOutput of Object.values(outputs)) {
      const nodeImages = nodeOutput.images as Array<Record<string, string>> | undefined;
      if (!Array.isArray(nodeImages)) continue;

      for (const img of nodeImages) {
        if (!img.filename) continue;
        const params = new URLSearchParams({
          filename: img.filename,
          ...(img.subfolder ? { subfolder: img.subfolder } : {}),
          type: img.type || 'output',
        });
        images.push(`${baseURL}/view?${params.toString()}`);
      }
    }

    return images;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.client.get('/queue');
      return response.status === 200;
    } catch {
      return false;
    }
  }
}

export const comfyuiClient = new ComfyUIClient();
