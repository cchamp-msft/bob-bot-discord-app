import axios, { AxiosInstance } from 'axios';
import { randomUUID } from 'crypto';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { ComfyUIWebSocketManager } from './comfyuiWebSocket';

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

/**
 * Node class_types that produce output (images/video).
 * Used by hasOutputNode() to pre-flight-validate workflows before submission.
 */
const OUTPUT_NODE_TYPES = new Set([
  'SaveImage',
  'PreviewImage',
  'SaveAnimatedWEBP',
  'SaveAnimatedPNG',
]);

/**
 * Check whether a parsed API-format workflow contains at least one output node.
 * Returns true if any node's class_type is in OUTPUT_NODE_TYPES.
 */
export function hasOutputNode(workflow: Record<string, unknown>): boolean {
  for (const node of Object.values(workflow)) {
    const classType = (node as Record<string, unknown>)?.class_type;
    if (typeof classType === 'string' && OUTPUT_NODE_TYPES.has(classType)) {
      return true;
    }
  }
  return false;
}

/**
 * Parameters for the default workflow builder.
 */
export interface DefaultWorkflowParams {
  /** Checkpoint model file path (relative to ComfyUI models dir) */
  ckpt_name: string;
  /** Latent image width (must be divisible by 8) */
  width: number;
  /** Latent image height (must be divisible by 8) */
  height: number;
  /** Number of sampling steps */
  steps: number;
  /** CFG scale */
  cfg: number;
  /** Sampler name (e.g. euler, dpmpp_2m) */
  sampler_name: string;
  /** Scheduler (e.g. normal, karras) */
  scheduler: string;
  /** Denoise strength (0–1) */
  denoise: number;
  /**
   * Seed for the KSampler node.
   * -1 means random: resolved to a random integer in [0, 2147483647]
   * before sending to ComfyUI. Any other value is used as-is.
   */
  seed: number;
}

/**
 * Resolve a seed value for ComfyUI.
 * -1 means random: generate a random integer in [0, 2147483647].
 * Any other value is passed through unchanged.
 */
export function resolveSeed(seed: number): number {
  if (seed === -1) {
    return Math.floor(Math.random() * 2147483648); // 0–2147483647
  }
  return seed;
}

/**
 * Walk all KSampler nodes in a parsed workflow and resolve their seed values.
 * Seeds of -1 are replaced with a fresh random integer; other values are kept.
 * This must run per-request so that random seeds differ between generations.
 */
export function resolveWorkflowSeeds(workflow: Record<string, unknown>): void {
  for (const nodeId of Object.keys(workflow)) {
    const node = workflow[nodeId] as Record<string, unknown>;
    if (node.class_type === 'KSampler') {
      const inputs = node.inputs as Record<string, unknown>;
      if (typeof inputs.seed === 'number') {
        inputs.seed = resolveSeed(inputs.seed);
      }
    }
  }
}

/**
 * Build a default text-to-image workflow in ComfyUI API format.
 *
 * Node layout:
 *   1: CheckpointLoaderSimple (provides MODEL, CLIP, VAE)
 *   2: CLIPTextEncode (positive prompt — uses %prompt%)
 *   3: CLIPTextEncode (negative prompt — empty)
 *   4: EmptyLatentImage
 *   5: KSampler
 *   6: VAEDecode
 *   7: SaveImage
 */
export function buildDefaultWorkflow(params: DefaultWorkflowParams): Record<string, unknown> {
  return {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: {
        ckpt_name: params.ckpt_name,
      },
      _meta: { title: 'Load Checkpoint' },
    },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: '%prompt%',
        clip: ['1', 1], // CheckpointLoaderSimple output slot 1 = CLIP
      },
      _meta: { title: 'Positive Prompt' },
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: '',
        clip: ['1', 1], // CheckpointLoaderSimple output slot 1 = CLIP
      },
      _meta: { title: 'Negative Prompt' },
    },
    '4': {
      class_type: 'EmptyLatentImage',
      inputs: {
        width: params.width,
        height: params.height,
        batch_size: 1,
      },
      _meta: { title: 'Empty Latent Image' },
    },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: params.seed,
        steps: params.steps,
        cfg: params.cfg,
        sampler_name: params.sampler_name,
        scheduler: params.scheduler,
        denoise: params.denoise,
        model: ['1', 0],    // CheckpointLoaderSimple output slot 0 = MODEL
        positive: ['2', 0], // Positive CLIPTextEncode output slot 0
        negative: ['3', 0], // Negative CLIPTextEncode output slot 0
        latent_image: ['4', 0], // EmptyLatentImage output slot 0
      },
      _meta: { title: 'KSampler' },
    },
    '6': {
      class_type: 'VAEDecode',
      inputs: {
        samples: ['5', 0], // KSampler output slot 0 = LATENT
        vae: ['1', 2],     // CheckpointLoaderSimple output slot 2 = VAE
      },
      _meta: { title: 'VAE Decode' },
    },
    '7': {
      class_type: 'SaveImage',
      inputs: {
        filename_prefix: 'BobBot',
        images: ['6', 0], // VAEDecode output slot 0 = IMAGE
      },
      _meta: { title: 'Save Image' },
    },
  };
}

/**
 * Applies sampler override settings to all KSampler nodes in a parsed API-format
 * workflow object. Only nodes with class_type === 'KSampler' are patched.
 * Returns the number of KSampler nodes that were overridden.
 */
function applySamplerOverrides(
  workflow: Record<string, unknown>,
  overrides: {
    steps: number;
    cfg: number;
    sampler_name: string;
    scheduler: string;
    denoise: number;
    seed: number;
  }
): number {
  let count = 0;
  for (const nodeId of Object.keys(workflow)) {
    const node = workflow[nodeId] as Record<string, unknown>;
    if (node.class_type === 'KSampler') {
      const inputs = node.inputs as Record<string, unknown>;
      inputs.steps = overrides.steps;
      inputs.cfg = overrides.cfg;
      inputs.sampler_name = overrides.sampler_name;
      inputs.scheduler = overrides.scheduler;
      inputs.denoise = overrides.denoise;
      inputs.seed = overrides.seed;
      count++;
    }
  }
  return count;
}

/** Delay helper for polling loops. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class ComfyUIClient {
  private client: AxiosInstance;

  /** Cached default workflow JSON, invalidated on refresh() */
  private cachedDefaultWorkflow: string | null = null;

  /** Maximum time (ms) to wait for a ComfyUI prompt to complete. */
  private static EXECUTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  /** Interval (ms) between history polls (for fallback polling). */
  private static POLL_INTERVAL_MS = 3_000; // 3 seconds

  /** Cached object_info response with TTL */
  private objectInfoCache: { data: Record<string, unknown>; expiry: number } | null = null;
  private static OBJECT_INFO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /** WebSocket manager for real-time execution tracking */
  private wsManager: ComfyUIWebSocketManager;

  /** Unique client ID for WebSocket identification */
  private clientId: string;

  constructor() {
    this.clientId = randomUUID();
    this.client = axios.create({
      baseURL: config.getComfyUIEndpoint(),
    });
    this.wsManager = new ComfyUIWebSocketManager(
      config.getComfyUIEndpoint(),
      this.clientId
    );
  }

  /**
   * Rebuild the axios instance with the current endpoint from config.
   * Called after config.reload() on config save.
   */
  refresh(): void {
    const newEndpoint = config.getComfyUIEndpoint();
    this.client = axios.create({
      baseURL: newEndpoint,
    });
    this.wsManager.updateBaseUrl(newEndpoint);
    this.cachedDefaultWorkflow = null;
    this.objectInfoCache = null;
  }

  // ── Discovery methods ──────────────────────────────────────────

  /**
   * Fetch the full /object_info response from ComfyUI.
   * Cached for 5 minutes to reduce API calls.
   */
  private async getObjectInfo(): Promise<Record<string, unknown>> {
    if (this.objectInfoCache && Date.now() < this.objectInfoCache.expiry) {
      return this.objectInfoCache.data;
    }
    try {
      const response = await this.client.get('/object_info/KSampler');
      if (response.status === 200 && response.data) {
        this.objectInfoCache = {
          data: response.data as Record<string, unknown>,
          expiry: Date.now() + ComfyUIClient.OBJECT_INFO_CACHE_TTL_MS,
        };
        return this.objectInfoCache.data;
      }
    } catch {
      // ComfyUI unreachable — return empty
    }
    return {};
  }

  /**
   * Get available sampler names from ComfyUI.
   * Queries /object_info/KSampler and extracts the sampler_name options.
   * Tolerates both `{ KSampler: { input: … } }` and direct `{ input: … }` shapes.
   */
  async getSamplers(): Promise<string[]> {
    try {
      const info = await this.getObjectInfo();
      const ksampler = (info.KSampler ?? info) as Record<string, unknown> | undefined;
      if (!ksampler) return [];
      const input = ksampler.input as Record<string, Record<string, unknown>> | undefined;
      const required = input?.required;
      const samplerEntry = required?.sampler_name as unknown[] | undefined;
      if (Array.isArray(samplerEntry)) {
        // Handle [["euler",…]] (nested) or ["euler",…] (flat)
        const list = Array.isArray(samplerEntry[0]) ? samplerEntry[0] : samplerEntry;
        return list.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      // Fall through
    }
    return [];
  }

  /**
   * Get available scheduler names from ComfyUI.
   * Queries /object_info/KSampler and extracts the scheduler options.
   * Tolerates both `{ KSampler: { input: … } }` and direct `{ input: … }` shapes.
   */
  async getSchedulers(): Promise<string[]> {
    try {
      const info = await this.getObjectInfo();
      const ksampler = (info.KSampler ?? info) as Record<string, unknown> | undefined;
      if (!ksampler) return [];
      const input = ksampler.input as Record<string, Record<string, unknown>> | undefined;
      const required = input?.required;
      const schedulerEntry = required?.scheduler as unknown[] | undefined;
      if (Array.isArray(schedulerEntry)) {
        // Handle [["normal",…]] (nested) or ["normal",…] (flat)
        const list = Array.isArray(schedulerEntry[0]) ? schedulerEntry[0] : schedulerEntry;
        return list.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      // Fall through
    }
    return [];
  }

  /**
   * Get available checkpoint model files from ComfyUI.
   * Queries GET /models/checkpoints.
   */
  async getCheckpoints(): Promise<string[]> {
    try {
      const response = await this.client.get('/models/checkpoints');
      if (response.status === 200 && Array.isArray(response.data)) {
        return response.data as string[];
      }
    } catch {
      // ComfyUI unreachable
    }
    return [];
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

  /**
   * Validate default workflow KSampler parameters against ComfyUI's
   * advertised options.  Falls back to safe defaults when the configured
   * sampler or scheduler is not supported by the connected instance.
   *
   * Returns the (possibly corrected) params and logs warnings for any
   * value that was overridden.
   */
  async validateDefaultWorkflowParams(
    params: DefaultWorkflowParams
  ): Promise<DefaultWorkflowParams> {
    const corrected = { ...params };

    // Clamp numeric inputs
    corrected.denoise = Math.max(0, Math.min(corrected.denoise, 1));
    corrected.steps = Math.max(1, Math.round(corrected.steps));
    corrected.width = Math.max(8, Math.round(corrected.width / 8) * 8);
    corrected.height = Math.max(8, Math.round(corrected.height / 8) * 8);
    corrected.cfg = Math.max(0.1, corrected.cfg);

    // Query ComfyUI for supported samplers & schedulers
    const [samplers, schedulers] = await Promise.all([
      this.getSamplers(),
      this.getSchedulers(),
    ]);

    if (samplers.length > 0 && !samplers.includes(corrected.sampler_name)) {
      const fallback = samplers.includes('euler') ? 'euler' : samplers[0];
      logger.logWarn(
        'comfyui',
        `Configured sampler "${corrected.sampler_name}" is not supported by this ComfyUI instance (available: ${samplers.join(', ')}). Falling back to "${fallback}".`
      );
      corrected.sampler_name = fallback;
    }

    if (schedulers.length > 0 && !schedulers.includes(corrected.scheduler)) {
      const fallback = schedulers.includes('normal') ? 'normal' : schedulers[0];
      logger.logWarn(
        'comfyui',
        `Configured scheduler "${corrected.scheduler}" is not supported by this ComfyUI instance (available: ${schedulers.join(', ')}). Falling back to "${fallback}".`
      );
      corrected.scheduler = fallback;
    }

    return corrected;
  }

  /**
   * Build and cache the default workflow JSON string from config parameters.
   * Returns null if no default model is configured.
   * Validates sampler/scheduler against ComfyUI when possible.
   */
  async getDefaultWorkflowJson(): Promise<string | null> {
    if (this.cachedDefaultWorkflow) return this.cachedDefaultWorkflow;

    const model = config.getComfyUIDefaultModel();
    if (!model) return null;

    const rawParams: DefaultWorkflowParams = {
      ckpt_name: model,
      width: config.getComfyUIDefaultWidth(),
      height: config.getComfyUIDefaultHeight(),
      steps: config.getComfyUIDefaultSteps(),
      cfg: config.getComfyUIDefaultCfg(),
      sampler_name: config.getComfyUIDefaultSampler(),
      scheduler: config.getComfyUIDefaultScheduler(),
      denoise: config.getComfyUIDefaultDenoise(),
      seed: config.getComfyUIDefaultSeed(),
    };

    const validatedParams = await this.validateDefaultWorkflowParams(rawParams);

    logger.log(
      'success',
      'comfyui',
      `Default workflow KSampler inputs: sampler=${validatedParams.sampler_name}, scheduler=${validatedParams.scheduler}, steps=${validatedParams.steps}, cfg=${validatedParams.cfg}, denoise=${validatedParams.denoise}`
    );

    const workflow = buildDefaultWorkflow(validatedParams);

    this.cachedDefaultWorkflow = JSON.stringify(workflow);
    return this.cachedDefaultWorkflow;
  }

  /**
   * Get the currently active workflow for export (custom or default).
   * Returns the workflow object, its source, and default params if applicable.
   * Returns null when no workflow is configured.
   */
  async getExportWorkflow(): Promise<{
    workflow: Record<string, unknown>;
    source: 'custom' | 'default';
    params?: DefaultWorkflowParams;
  } | null> {
    const customJson = config.getComfyUIWorkflow();
    if (customJson) {
      const validation = this.validateWorkflow(customJson);
      if (!validation.valid) return null;
      const effectiveJson = validation.convertedWorkflow ?? customJson;
      return { workflow: JSON.parse(effectiveJson), source: 'custom' };
    }

    const model = config.getComfyUIDefaultModel();
    if (!model) return null;

    const params: DefaultWorkflowParams = {
      ckpt_name: model,
      width: config.getComfyUIDefaultWidth(),
      height: config.getComfyUIDefaultHeight(),
      steps: config.getComfyUIDefaultSteps(),
      cfg: config.getComfyUIDefaultCfg(),
      sampler_name: config.getComfyUIDefaultSampler(),
      scheduler: config.getComfyUIDefaultScheduler(),
      denoise: config.getComfyUIDefaultDenoise(),
      seed: config.getComfyUIDefaultSeed(),
    };

    const workflow = buildDefaultWorkflow(params);
    return { workflow, source: 'default', params };
  }

  async generateImage(
    prompt: string,
    requester: string,
    signal?: AbortSignal,
    timeoutSeconds?: number
  ): Promise<ComfyUIResponse> {
    try {
      // Priority: custom uploaded workflow > default generated workflow
      let workflowJson = config.getComfyUIWorkflow();
      let usingDefault = false;

      if (!workflowJson) {
        workflowJson = (await this.getDefaultWorkflowJson()) ?? '';
        usingDefault = true;
      }

      if (!workflowJson) {
        const errorMsg = 'No ComfyUI workflow configured. Upload a workflow JSON or configure default workflow settings in the configurator.';
        logger.logError(requester, errorMsg);
        return { success: false, error: errorMsg };
      }

      let effectiveWorkflow: string;

      if (usingDefault) {
        // Default workflow is already in API format with %prompt% — skip validation
        effectiveWorkflow = workflowJson;
        logger.log('success', requester, 'Using default generated workflow');
      } else {
        // Validate custom workflow before use (also auto-converts UI format if needed)
        const validation = this.validateWorkflow(workflowJson);
        if (!validation.valid) {
          const errorMsg = `ComfyUI workflow validation failed: ${validation.error}`;
          logger.logError(requester, errorMsg);
          return { success: false, error: errorMsg };
        }

        // Use converted workflow if auto-conversion happened
        effectiveWorkflow = validation.convertedWorkflow ?? workflowJson;
      }

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

      // Resolve seed per-request: replace -1 with a fresh random value on every KSampler node
      resolveWorkflowSeeds(workflowData as Record<string, unknown>);

      // Apply sampler overrides to custom workflow KSampler nodes
      if (!usingDefault) {
        const patchedCount = applySamplerOverrides(workflowData as Record<string, unknown>, {
          steps:        config.getComfyUIDefaultSteps(),
          cfg:          config.getComfyUIDefaultCfg(),
          sampler_name: config.getComfyUIDefaultSampler(),
          scheduler:    config.getComfyUIDefaultScheduler(),
          denoise:      config.getComfyUIDefaultDenoise(),
          seed:         config.getComfyUIDefaultSeed(),
        });
        if (patchedCount > 0) {
          logger.log(
            'success',
            requester,
            `Applied sampler overrides to ${patchedCount} KSampler node(s): ` +
            `sampler=${config.getComfyUIDefaultSampler()}, scheduler=${config.getComfyUIDefaultScheduler()}, ` +
            `steps=${config.getComfyUIDefaultSteps()}, cfg=${config.getComfyUIDefaultCfg()}, denoise=${config.getComfyUIDefaultDenoise()}, seed=${config.getComfyUIDefaultSeed()}`
          );
        }
      }

      // Pre-flight: reject workflows with no output nodes before submitting
      if (!hasOutputNode(workflowData)) {
        const errorMsg = 'Workflow has no output node (e.g. SaveImage, PreviewImage). ComfyUI requires at least one output node to produce results.';
        logger.logError(requester, errorMsg);
        return { success: false, error: errorMsg };
      }

      // Log node summary for debugging workflow issues
      const nodeIds = Object.keys(workflowData);
      const nodeSummary = nodeIds.map(id => {
        const node = workflowData[id] as Record<string, unknown>;
        return `${id}:${node.class_type ?? 'unknown'}`;
      }).join(', ');
      logger.log('success', requester, `ComfyUI workflow nodes: [${nodeSummary}]`);

      // DEBUG: log full ComfyUI workflow submission
      logger.logDebugLazy(requester, () => `COMFYUI-REQUEST: prompt=[${prompt}], workflow=${JSON.stringify(workflowData, null, 2)}`);

      // Ensure WebSocket is connected before submitting prompt
      // This provides a proper client context to prevent tqdm stderr issues
      let wsConnected = false;
      try {
        await this.wsManager.connectWithRetry();
        wsConnected = true;
      } catch (wsError) {
        const wsErrorMsg = wsError instanceof Error ? wsError.message : String(wsError);
        logger.logError(requester, `WebSocket connection failed, will fall back to polling: ${wsErrorMsg}`);
      }

      // Step 1: Submit the prompt — response contains { prompt_id }
      // Use our WebSocket clientId to associate execution with our connection
      let submitResponse;
      try {
        submitResponse = await this.client.post(
          '/api/prompt',
          {
            prompt: workflowData,
            client_id: this.clientId,
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
        // Check top-level error field first (prompt_no_outputs, prompt_outputs_failed_validation, etc.)
        const topError = submitResponse.data?.error;
        if (topError) {
          const errorType = topError.type ?? 'unknown';
          const errorMessage = topError.message ?? JSON.stringify(topError);
          const errorMsg = `ComfyUI prompt validation failed [${errorType}]: ${errorMessage}`;
          logger.logError(requester, errorMsg);
          return { success: false, error: errorMsg };
        }

        // Check node-level errors
        const nodeErrors = submitResponse.data?.node_errors;
        if (nodeErrors && Object.keys(nodeErrors).length > 0) {
          const errorMsg = `ComfyUI workflow errors: ${JSON.stringify(nodeErrors)}`;
          logger.logError(requester, errorMsg);
          return { success: false, error: errorMsg };
        }

        // Generic fallback — log full response for diagnostics
        logger.logError(requester, `ComfyUI unexpected prompt response: ${JSON.stringify(submitResponse.data)}`);
        return { success: false, error: 'Failed to submit prompt to ComfyUI' };
      }

      const promptId: string = submitResponse.data.prompt_id;
      logger.logReply(requester, `ComfyUI prompt submitted: ${promptId}`);

      // Step 2: Wait for execution via WebSocket (real-time updates)
      // Falls back to HTTP polling if WebSocket is unavailable or fails
      const executionTimeoutMs = timeoutSeconds
        ? timeoutSeconds * 1000
        : ComfyUIClient.EXECUTION_TIMEOUT_MS;

      let historyData: Record<string, unknown> | null = null;

      if (wsConnected) {
        let lastLoggedPercent = -1;
        const executionResult = await this.wsManager.waitForExecution({
          promptId,
          timeoutMs: executionTimeoutMs,
          signal,
          onProgress: (value, max, nodeId) => {
            // Throttle progress logging: only log at 0%, every 25%, and 100%
            const percent = max > 0 ? Math.floor((value / max) * 100) : 0;
            const bucket = Math.floor(percent / 25) * 25;
            if (bucket !== lastLoggedPercent || value === max) {
              lastLoggedPercent = bucket;
              logger.log('success', requester, `ComfyUI progress: ${value}/${max} [${percent}%] (node ${nodeId})`);
            }
          },
          onExecuting: (nodeId) => {
            if (nodeId) {
              logger.log('success', requester, `ComfyUI executing node: ${nodeId}`);
            }
          },
        });

        if (executionResult.success && executionResult.completed) {
          // WebSocket confirmed completion — fetch history
          historyData = await this.fetchHistory(promptId, signal);
          if (!historyData) {
            // History may not be available yet (race between WS completion and /history);
            // fall back to polling with the remaining budget.
            const remainingMs = Math.max(0, executionTimeoutMs - (executionResult.elapsedMs ?? 0));
            if (remainingMs > 0) {
              logger.log('success', requester, `History not yet available after WS completion, polling (${Math.round(remainingMs / 1000)}s remaining)`);
              historyData = await this.pollForCompletion(promptId, signal, remainingMs);
            }
          }
        } else if (executionResult.completed && executionResult.error) {
          // ComfyUI reported an execution error (e.g. missing model) — terminal, no fallback
          logger.logError(requester, executionResult.error);
          return { success: false, error: executionResult.error };
        } else if (executionResult.error === 'Execution aborted') {
          // User/system abort — terminal, no fallback
          logger.logError(requester, 'ComfyUI generation aborted');
          return { success: false, error: 'ComfyUI generation aborted' };
        } else {
          // WS transport failure or WS timeout — fall back to polling with remaining time
          const remainingMs = Math.max(0, executionTimeoutMs - (executionResult.elapsedMs ?? 0));
          if (remainingMs <= 0) {
            const errorMsg = 'ComfyUI generation timed out waiting for results';
            logger.logError(requester, errorMsg);
            return { success: false, error: errorMsg };
          }
          logger.logError(requester, `WebSocket wait failed (${executionResult.error}), falling back to polling (${Math.round(remainingMs / 1000)}s remaining)`);
          historyData = await this.pollForCompletion(promptId, signal, remainingMs);
        }
      } else {
        // No WebSocket available — use polling
        logger.log('success', requester, 'Using HTTP polling for ComfyUI execution tracking');
        historyData = await this.pollForCompletion(promptId, signal, executionTimeoutMs);
      }

      // Step 3: Process history results
      if (!historyData) {
        const errorMsg = signal?.aborted
          ? 'ComfyUI generation aborted'
          : 'ComfyUI generation timed out waiting for results';
        logger.logError(requester, errorMsg);
        return { success: false, error: errorMsg };
      }

      // Log history structure for debugging
      const historyStatus = historyData.status as Record<string, unknown> | undefined;
      const historyOutputs = historyData.outputs as Record<string, unknown> | undefined;
      logger.log(
        'success',
        requester,
        `ComfyUI history for ${promptId}: status=${historyStatus?.status_str ?? 'n/a'}, ` +
        `output_nodes=[${historyOutputs ? Object.keys(historyOutputs).join(', ') : 'none'}]`
      );

      // Check for execution errors in the history entry
      const executionError = this.extractExecutionError(historyData);
      if (executionError) {
        logger.logError(requester, `ComfyUI execution failed: ${executionError}`);
        return { success: false, error: executionError };
      }

      // Step 4: Extract image URLs from output nodes
      const images = this.extractImageUrls(historyData);

      if (images.length === 0) {
        const outputs = historyData.outputs as Record<string, unknown> | undefined;
        const outputKeys = outputs ? Object.keys(outputs) : [];
        logger.logError(
          requester,
          `ComfyUI workflow produced no images. Output nodes: [${outputKeys.join(', ')}]. ` +
          'Check ComfyUI server logs for execution errors — the workflow may reference missing models or custom nodes.'
        );
        return {
          success: false,
          error: 'ComfyUI workflow produced no images. Check ComfyUI server logs for execution errors.',
        };
      }

      logger.logReply(
        requester,
        `ComfyUI generation completed for prompt: ${prompt.substring(0, 50)}... (${images.length} image(s))`
      );

      // DEBUG: log full image URLs
      logger.logDebugLazy(requester, () => `COMFYUI-RESPONSE: ${images.length} image(s): ${JSON.stringify(images)}`);

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
   * Fetch the history entry for a specific prompt.
   * Returns the history entry or null if not found.
   */
  async fetchHistory(promptId: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.client.get(
        `/history/${promptId}`,
        signal ? { signal } : undefined
      );
      if (response.status === 200 && response.data?.[promptId]) {
        return response.data[promptId] as Record<string, unknown>;
      }
    } catch {
      // History not available
    }
    return null;
  }

  /**
   * Poll GET /history/{promptId} until the prompt appears in the response,
   * indicating the workflow has finished executing.
   * Returns the history entry for the prompt, or null on timeout/abort.
   * Used as a fallback when WebSocket connection is unavailable.
   *
   * @param timeoutMs — Maximum time to poll. Defaults to EXECUTION_TIMEOUT_MS.
   */
  async pollForCompletion(
    promptId: string,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + (timeoutMs ?? ComfyUIClient.EXECUTION_TIMEOUT_MS);

    while (Date.now() < deadline) {
      if (signal?.aborted) return null;

      try {
        const response = await this.client.get(
          `/history/${promptId}`,
          signal ? { signal } : undefined
        );
        if (response.status === 200 && response.data?.[promptId]) {
          const entry = response.data[promptId] as Record<string, unknown>;

          // ComfyUI sets status.completed = true when done (success or failure)
          const status = entry.status as Record<string, unknown> | undefined;
          if (status?.completed === false) {
            // Still executing — keep polling
            await delay(ComfyUIClient.POLL_INTERVAL_MS);
            continue;
          }

          return entry;
        }
      } catch {
        // History not ready yet — continue polling
      }

      await delay(ComfyUIClient.POLL_INTERVAL_MS);
    }

    return null;
  }

  /**
   * Extract an error message from a ComfyUI history entry, if the execution failed.
   * ComfyUI stores execution status in `status.status_str` and error details in
   * `status.messages` when a workflow encounters a runtime error.
   * Returns null if no error is detected.
   */
  extractExecutionError(historyData: Record<string, unknown>): string | null {
    const status = historyData.status as Record<string, unknown> | undefined;
    if (!status) return null;

    const statusStr = status.status_str as string | undefined;

    // "error" status indicates a runtime failure
    if (statusStr === 'error') {
      const messages = status.messages as Array<[string, Record<string, unknown>]> | undefined;
      if (Array.isArray(messages)) {
        // Look for execution_error message tuples: ["execution_error", { ... }]
        for (const msg of messages) {
          if (Array.isArray(msg) && msg[0] === 'execution_error' && msg[1]) {
            const detail = msg[1];
            const exception = detail.exception_message || detail.exception_type || '';
            const nodeType = detail.node_type ? ` (node: ${detail.node_type})` : '';
            const nodeId = detail.node_id ? ` [node ${detail.node_id}]` : '';
            return `ComfyUI execution error${nodeId}${nodeType}: ${exception}`;
          }
        }
      }
      return 'ComfyUI execution failed (status: error). Check ComfyUI server logs for details.';
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

  /**
   * Close the ComfyUI client and disconnect WebSocket.
   * Call during graceful shutdown.
   */
  close(): void {
    this.wsManager.disconnect();
  }
}

export const comfyuiClient = new ComfyUIClient();
