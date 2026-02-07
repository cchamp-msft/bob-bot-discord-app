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

class ComfyUIClient {
  private client: AxiosInstance;

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

      const response = await this.client.post(
        '/api/prompt',
        {
          prompt: workflowData,
          client_id: requester,
        },
        signal ? { signal } : undefined
      );

      if (response.status === 200) {
        logger.logReply(
          requester,
          `ComfyUI generation completed for prompt: ${prompt.substring(0, 50)}...`
        );

        return {
          success: true,
          data: {
            images: response.data.images || [],
          },
        };
      }

      return {
        success: false,
        error: 'Failed to generate image',
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
