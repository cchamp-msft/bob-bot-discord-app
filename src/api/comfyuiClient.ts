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
  /** When the workflow was in UI format and auto-converted, this holds the API-format JSON string. */
  convertedWorkflow?: string;
  /** True if the workflow was auto-converted from UI format to API format. */
  wasConverted?: boolean;
}

/**
 * Detect whether a parsed workflow object is in ComfyUI's UI export format
 * (has top-level nodes array and links array) rather than the API format
 * (flat object keyed by node IDs with class_type).
 */
export function isUIFormat(workflow: Record<string, unknown>): boolean {
  return Array.isArray(workflow.nodes) && Array.isArray(workflow.links);
}

/**
 * Convert a ComfyUI UI-format workflow to the API format expected by /api/prompt.
 *
 * UI format has: { nodes: [ { id, type, widgets_values, inputs, ... } ], links: [...] }
 * API format has: { "<id>": { class_type: "...", inputs: { ... } } }
 *
 * The conversion maps each node's `type` → `class_type`, maps widget values
 * to named inputs using known node type definitions, and resolves link
 * connections between nodes.
 */
export function convertUIToAPIFormat(
  workflow: Record<string, unknown>
): Record<string, unknown> {
  const nodes = workflow.nodes as Array<Record<string, unknown>>;
  const links = workflow.links as Array<unknown[]>;

  // Build a link lookup: linkId → { sourceNodeId, sourceSlotIndex }
  const linkMap = new Map<number, { sourceNodeId: number; sourceSlotIndex: number }>();
  for (const link of links) {
    // link format: [linkId, sourceNodeId, sourceSlotIndex, targetNodeId, targetSlotIndex, type]
    if (Array.isArray(link) && link.length >= 5) {
      linkMap.set(Number(link[0]), {
        sourceNodeId: Number(link[1]),
        sourceSlotIndex: Number(link[2]),
      });
    }
  }

  const apiWorkflow: Record<string, unknown> = {};

  for (const node of nodes) {
    const nodeId = String(node.id);
    const classType = node.type as string;

    if (!classType) continue;

    // Start with an empty inputs object
    const inputs: Record<string, unknown> = {};

    // Map widgets_values to named inputs using known node type widget definitions
    const widgetValues = node.widgets_values as unknown[] | undefined;
    if (Array.isArray(widgetValues) && widgetValues.length > 0) {
      const widgetNames = WIDGET_NAME_MAP[classType];
      if (widgetNames) {
        // Map positional widget values to their named inputs
        for (let i = 0; i < Math.min(widgetValues.length, widgetNames.length); i++) {
          inputs[widgetNames[i]] = widgetValues[i];
        }
      } else {
        // Unknown node type — store widget values as-is to preserve %prompt%
        // Use generic names: widget_value_0, widget_value_1, ...
        for (let i = 0; i < widgetValues.length; i++) {
          inputs[`widget_value_${i}`] = widgetValues[i];
        }
      }
    }

    // Populate from explicit input connections (these override widget values)
    const nodeInputs = node.inputs as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(nodeInputs)) {
      for (const input of nodeInputs) {
        const inputName = input.name as string;
        const linkId = input.link as number | null;
        if (inputName && linkId != null) {
          const linkInfo = linkMap.get(linkId);
          if (linkInfo) {
            // API format references: [sourceNodeId, sourceSlotIndex]
            inputs[inputName] = [String(linkInfo.sourceNodeId), linkInfo.sourceSlotIndex];
          }
        }
      }
    }

    const nodeEntry: Record<string, unknown> = {
      class_type: classType,
      inputs,
    };

    // Store meta if present (helps with debugging)
    if (node.title) {
      nodeEntry._meta = { title: node.title };
    }

    apiWorkflow[nodeId] = nodeEntry;
  }

  return apiWorkflow;
}

/**
 * Known widget-name mappings for common ComfyUI node types.
 * Maps class_type → ordered list of widget input names.
 * This allows positional widgets_values to be mapped to named inputs.
 */
const WIDGET_NAME_MAP: Record<string, string[]> = {
  // Text encoders
  CLIPTextEncode: ['text'],
  CLIPTextEncodeSDXL: ['text_g', 'text_l', 'width', 'height', 'crop_w', 'crop_h', 'target_width', 'target_height'],

  // Samplers
  KSampler: ['seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  KSamplerAdvanced: ['add_noise', 'noise_seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'],

  // Loaders
  CheckpointLoaderSimple: ['ckpt_name'],
  LoRALoader: ['lora_name', 'strength_model', 'strength_clip'],
  VAELoader: ['vae_name'],

  // Latent
  EmptyLatentImage: ['width', 'height', 'batch_size'],

  // Output
  SaveImage: ['filename_prefix'],
  PreviewImage: [],

  // CLIP
  CLIPSetLastLayer: ['stop_at_clip_layer'],

  // Conditioning
  ConditioningCombine: [],
  ConditioningSetArea: ['width', 'height', 'x', 'y', 'strength'],
};

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
   * If the workflow is in ComfyUI's UI export format, it is auto-converted to API format.
   */
  validateWorkflow(workflowJson: string): WorkflowValidationResult {
    // Validate JSON structure
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(workflowJson);
    } catch (e) {
      return {
        valid: false,
        error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Detect UI format and auto-convert
    let finalJson = workflowJson;
    let wasConverted = false;

    if (isUIFormat(parsed)) {
      try {
        const converted = convertUIToAPIFormat(parsed);
        finalJson = JSON.stringify(converted, null, 2);
        wasConverted = true;
        logger.log('success', 'comfyui', 'Detected UI-format workflow — auto-converted to API format');
      } catch (e) {
        return {
          valid: false,
          error: `Workflow appears to be in ComfyUI UI format but conversion failed: ${e instanceof Error ? e.message : String(e)}. Please export using "Save (API Format)" in ComfyUI.`,
        };
      }
    }

    // Validate %prompt% placeholder presence (case-sensitive)
    if (!finalJson.includes('%prompt%')) {
      const hint = wasConverted
        ? ' Note: the workflow was auto-converted from UI format — the %prompt% placeholder may not have survived conversion. Please ensure %prompt% is set as a widget value in your ComfyUI workflow before exporting.'
        : '';
      return {
        valid: false,
        error: `Workflow must contain at least one %prompt% placeholder (case-sensitive).${hint}`,
      };
    }

    return {
      valid: true,
      ...(wasConverted ? { convertedWorkflow: finalJson, wasConverted: true } : {}),
    };
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

      // Validate workflow before use (also auto-converts UI format if needed)
      const validation = this.validateWorkflow(workflowJson);
      if (!validation.valid) {
        const errorMsg = `ComfyUI workflow validation failed: ${validation.error}`;
        logger.logError(requester, errorMsg);
        return { success: false, error: errorMsg };
      }

      // Use converted workflow if auto-conversion happened
      const effectiveWorkflow = validation.convertedWorkflow ?? workflowJson;

      logger.logRequest(
        requester,
        `ComfyUI generate: ${prompt.substring(0, 100)}...`
      );

      // JSON-escape the prompt so quotes/backslashes don't break the workflow JSON
      const escapedPrompt = JSON.stringify(prompt).slice(1, -1);

      // Replace all occurrences of %prompt% with the escaped prompt (case-sensitive)
      const substitutedWorkflow = effectiveWorkflow.split('%prompt%').join(escapedPrompt);

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
          let errorMsg = `ComfyUI prompt rejected (HTTP ${axiosErr.response.status}): ${detail}`;
          if (axiosErr.response.status === 500) {
            errorMsg += '. This may indicate the workflow format is incompatible — try re-exporting with "Save (API Format)" in ComfyUI. Check ComfyUI server logs for details.';
          }
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
