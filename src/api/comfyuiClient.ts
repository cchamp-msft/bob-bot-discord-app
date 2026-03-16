import axios, { AxiosError, AxiosInstance } from 'axios';
import { randomUUID } from 'crypto';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { persistMedia, PersistedMedia } from '../utils/mediaPersistence';
import { ComfyUIWebSocketManager } from './comfyuiWebSocket';

export interface ComfyUIResponse {
  success: boolean;
  data?: {
    text?: string;
    images?: string[];
    videos?: string[];
    /** Pre-persisted output descriptors (avoids re-downloading). */
    savedOutputs?: PersistedMedia[];
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
  /** Non-blocking warnings (e.g. missing %negative% placeholder, broken node references). */
  warnings?: string[];
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
  CLIPLoader: ['clip_name', 'type'],
  UNETLoader: ['unet_name', 'weight_dtype'],
  DualCLIPLoader: ['clip_name1', 'clip_name2', 'type'],

  // Latent
  EmptyLatentImage: ['width', 'height', 'batch_size'],

  // Output — images
  SaveImage: ['filename_prefix'],
  PreviewImage: [],

  // Output — video
  SaveVideo: ['filename_prefix'],
  PreviewVideo: ['filename_prefix'],

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
  'SaveVideo',
  'PreviewVideo',
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
   * -1 means random: resolved to a random integer in [0, Number.MAX_SAFE_INTEGER]
   * before sending to ComfyUI. Any other value is used as-is.
   */
  seed: number;
  /** Separate VAE model path. When set, a VAELoader node is added. */
  vae_name?: string;
  /** Separate CLIP model path. When set, a CLIPLoader node is added. */
  clip_name?: string;
  /** Second CLIP model path for DualCLIPLoader. When set along with clip_name, uses DualCLIPLoader. */
  clip_name2?: string;
  /** CLIP loader type (e.g. 'stable_diffusion', 'sdxl', 'flux'). Defaults to 'stable_diffusion'. */
  clip_type?: string;
  /** Diffuser/UNET model path. When set, a UNETLoader replaces CheckpointLoaderSimple as model source. */
  diffuser_name?: string;
}

/**
 * Resolve a seed value for ComfyUI.
 * -1 means random: generate a random integer in [0, Number.MAX_SAFE_INTEGER].
 * Any other value is passed through unchanged.
 */
export function resolveSeed(seed: number): number {
  if (seed === -1) {
    return Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER + 1)); // 0–9007199254740991
  }
  return seed;
}

/**
 * Walk all sampler/noise nodes in a parsed workflow and resolve their seed values.
 * Seeds of -1 are replaced with a fresh random integer; other values are kept.
 * This must run per-request so that random seeds differ between generations.
 * Handles KSampler (seed), KSamplerAdvanced (noise_seed), and RandomNoise (noise_seed).
 */
export function resolveWorkflowSeeds(workflow: Record<string, unknown>): void {
  for (const nodeId of Object.keys(workflow)) {
    const node = workflow[nodeId] as Record<string, unknown>;
    const inputs = node.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;

    if (node.class_type === 'KSampler' && typeof inputs.seed === 'number') {
      inputs.seed = resolveSeed(inputs.seed);
    }
    if ((node.class_type === 'KSamplerAdvanced' || node.class_type === 'RandomNoise')
        && typeof inputs.noise_seed === 'number') {
      inputs.noise_seed = resolveSeed(inputs.noise_seed);
    }
  }
}

/**
 * Parse the `--seed: <number>` convention from a content string.
 * Returns the content without the seed marker, and the parsed seed (or null).
 * Must be called before parseNegativePrompt since --seed: is appended last.
 */
export function parseSeed(content: string): { content: string; seed: number | null } {
  const marker = '\n--seed:';
  const idx = content.indexOf(marker);
  if (idx === -1) return { content, seed: null };
  const seedStr = content.substring(idx + marker.length).trim();
  const remaining = content.substring(0, idx);
  const parsed = parseInt(seedStr, 10);
  return { content: remaining, seed: isNaN(parsed) ? null : parsed };
}

/**
 * Parse the `--negative: <text>` convention from a content string.
 * Returns the positive prompt (without the negative marker) and the negative text.
 * If no `--negative:` is found, the entire string is positive and negative is empty.
 */
export function parseNegativePrompt(content: string): { positive: string; negative: string } {
  const marker = '\n--negative:';
  const idx = content.indexOf(marker);
  if (idx === -1) {
    return { positive: content, negative: '' };
  }
  const positive = content.substring(0, idx).trim();
  const negative = content.substring(idx + marker.length).trim();
  return { positive, negative };
}

/**
 * Combine config default negative prompt with model-provided negative.
 * Default is prepended, comma-separated. Either or both may be empty.
 */
export function resolveNegativePrompt(defaultNeg: string, modelNeg: string): string {
  const parts = [defaultNeg.trim(), modelNeg.trim()].filter(Boolean);
  return parts.join(', ');
}

/**
 * Walk all node inputs in a parsed API-format workflow and check that
 * every `[nodeId, slot]` array reference points to an existing node.
 * Returns an array of warning strings for broken references.
 */
export function validateNodeReferences(workflow: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const nodeIds = new Set(Object.keys(workflow));

  for (const [nodeId, nodeValue] of Object.entries(workflow)) {
    const node = nodeValue as Record<string, unknown>;
    const inputs = node.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;

    for (const [inputName, inputValue] of Object.entries(inputs)) {
      if (Array.isArray(inputValue) && inputValue.length === 2 && typeof inputValue[0] === 'string' && typeof inputValue[1] === 'number') {
        const refNodeId = inputValue[0];
        if (!nodeIds.has(refNodeId)) {
          warnings.push(`Node ${nodeId} input "${inputName}" references non-existent node ${refNodeId}`);
        }
      }
    }
  }

  return warnings;
}

/**
 * Build a default text-to-image workflow in ComfyUI API format.
 *
 * Adaptive: the node graph varies based on whether separate VAE, CLIP,
 * or diffuser/UNET models are configured.
 *
 * Mode detection:
 *   - Checkpoint only (default): CheckpointLoaderSimple provides MODEL, CLIP, VAE
 *   - + VAE: adds VAELoader, overrides VAE source
 *   - + CLIP: adds CLIPLoader, overrides CLIP source
 *   - Diffuser (requires VAE): UNETLoader for MODEL, CheckpointLoaderSimple
 *     or CLIPLoader for CLIP, VAELoader for VAE
 */
export function buildDefaultWorkflow(params: DefaultWorkflowParams): Record<string, unknown> {
  const useDiffuser = !!params.diffuser_name;
  const useSeparateVae = !!params.vae_name;
  const useSeparateClip = !!params.clip_name;
  const useDualClip = useSeparateClip && !!params.clip_name2;
  const clipType = params.clip_type || 'stable_diffusion';

  const workflow: Record<string, unknown> = {};
  let nextId = 1;
  const id = () => String(nextId++);

  // Track source nodes as [nodeId, slotIndex] tuples
  let modelSource: [string, number];
  let clipSource: [string, number];
  let vaeSource: [string, number];

  // ── Model loader(s) ───────────────────────────────────────

  if (useDiffuser) {
    // UNETLoader for MODEL
    const unetId = id();
    workflow[unetId] = {
      class_type: 'UNETLoader',
      inputs: { unet_name: params.diffuser_name, weight_dtype: 'default' },
      _meta: { title: 'Load Diffusion Model' },
    };
    modelSource = [unetId, 0];

    // Diffuser mode requires separate VAE
    const vaeId = id();
    workflow[vaeId] = {
      class_type: 'VAELoader',
      inputs: { vae_name: params.vae_name },
      _meta: { title: 'Load VAE' },
    };
    vaeSource = [vaeId, 0];

    if (useDualClip) {
      // DualCLIPLoader for CLIP
      const clipId = id();
      workflow[clipId] = {
        class_type: 'DualCLIPLoader',
        inputs: { clip_name1: params.clip_name, clip_name2: params.clip_name2, type: clipType },
        _meta: { title: 'Load Dual CLIP' },
      };
      clipSource = [clipId, 0];
    } else if (useSeparateClip) {
      // CLIPLoader for CLIP
      const clipId = id();
      workflow[clipId] = {
        class_type: 'CLIPLoader',
        inputs: { clip_name: params.clip_name, type: clipType },
        _meta: { title: 'Load CLIP' },
      };
      clipSource = [clipId, 0];
    } else {
      // Fall back to checkpoint for CLIP
      const ckptId = id();
      workflow[ckptId] = {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: params.ckpt_name },
        _meta: { title: 'Load Checkpoint (CLIP)' },
      };
      clipSource = [ckptId, 1];
    }
  } else {
    // Standard checkpoint mode
    const ckptId = id();
    workflow[ckptId] = {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: params.ckpt_name },
      _meta: { title: 'Load Checkpoint' },
    };
    modelSource = [ckptId, 0];
    clipSource = [ckptId, 1];
    vaeSource = [ckptId, 2];

    if (useSeparateVae) {
      const vaeId = id();
      workflow[vaeId] = {
        class_type: 'VAELoader',
        inputs: { vae_name: params.vae_name },
        _meta: { title: 'Load VAE' },
      };
      vaeSource = [vaeId, 0];
    }

    if (useDualClip) {
      const clipId = id();
      workflow[clipId] = {
        class_type: 'DualCLIPLoader',
        inputs: { clip_name1: params.clip_name, clip_name2: params.clip_name2, type: clipType },
        _meta: { title: 'Load Dual CLIP' },
      };
      clipSource = [clipId, 0];
    } else if (useSeparateClip) {
      const clipId = id();
      workflow[clipId] = {
        class_type: 'CLIPLoader',
        inputs: { clip_name: params.clip_name, type: clipType },
        _meta: { title: 'Load CLIP' },
      };
      clipSource = [clipId, 0];
    }
  }

  // ── Common tail nodes ─────────────────────────────────────

  const posPromptId = id();
  workflow[posPromptId] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: '%prompt%', clip: clipSource },
    _meta: { title: 'Positive Prompt' },
  };

  const negPromptId = id();
  workflow[negPromptId] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: '%negative%', clip: clipSource },
    _meta: { title: 'Negative Prompt' },
  };

  const latentId = id();
  workflow[latentId] = {
    class_type: 'EmptyLatentImage',
    inputs: { width: params.width, height: params.height, batch_size: 1 },
    _meta: { title: 'Empty Latent Image' },
  };

  const samplerId = id();
  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      seed: params.seed,
      steps: params.steps,
      cfg: params.cfg,
      sampler_name: params.sampler_name,
      scheduler: params.scheduler,
      denoise: params.denoise,
      model: modelSource,
      positive: [posPromptId, 0],
      negative: [negPromptId, 0],
      latent_image: [latentId, 0],
    },
    _meta: { title: 'KSampler' },
  };

  const decodeId = id();
  workflow[decodeId] = {
    class_type: 'VAEDecode',
    inputs: { samples: [samplerId, 0], vae: vaeSource },
    _meta: { title: 'VAE Decode' },
  };

  const saveId = id();
  workflow[saveId] = {
    class_type: 'SaveImage',
    inputs: { filename_prefix: 'BobBot', images: [decodeId, 0] },
    _meta: { title: 'Save Image' },
  };

  return workflow;
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

/** Options for extended ComfyUI generation (multi-workflow, image input). */
export interface ComfyUIGenerateOptions {
  /** Tool name — selects per-tool workflow from .config/comfyui-workflows/{toolName}.json. */
  toolName?: string;
  /** Base64-encoded image payloads for img2img/img2vid workflows. */
  images?: string[];
}

class ComfyUIClient {
  private client: AxiosInstance;

  /** Cached default workflow JSON, invalidated on refresh() */
  private cachedDefaultWorkflow: string | null = null;

  /** Maximum time (ms) to wait for a ComfyUI prompt to complete. */
  private static EXECUTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  /** Interval (ms) between history polls (for fallback polling). */
  private static POLL_INTERVAL_MS = 3_000; // 3 seconds

  /** Max consecutive HTTP failures before assuming ComfyUI is down during polling. */
  private static MAX_CONSECUTIVE_POLL_FAILURES = 5;

  /** Per-node-type object_info cache with TTL */
  private nodeInfoCache = new Map<string, { data: Record<string, unknown>; expiry: number }>();
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
    this.nodeInfoCache.clear();
  }

  // ── Discovery methods ──────────────────────────────────────────

  /**
   * Fetch /object_info/{nodeType} from ComfyUI.
   * Per-node-type caching with 5-minute TTL.
   */
  private async getNodeInfo(nodeType: string): Promise<Record<string, unknown>> {
    const cached = this.nodeInfoCache.get(nodeType);
    if (cached && Date.now() < cached.expiry) {
      return cached.data;
    }
    try {
      const response = await this.client.get(`/object_info/${nodeType}`);
      if (response.status === 200 && response.data) {
        this.nodeInfoCache.set(nodeType, {
          data: response.data as Record<string, unknown>,
          expiry: Date.now() + ComfyUIClient.OBJECT_INFO_CACHE_TTL_MS,
        });
        return response.data as Record<string, unknown>;
      }
    } catch {
      // ComfyUI unreachable — return empty
    }
    return {};
  }

  /**
   * Extract the available options for a specific input from a node's object_info.
   * Navigates: info[nodeType].input.required[inputName][0] (array of strings).
   * Tolerates both `{ NodeType: { input: … } }` and direct `{ input: … }` shapes.
   */
  private async extractNodeInputOptions(nodeType: string, inputName: string): Promise<string[]> {
    try {
      const info = await this.getNodeInfo(nodeType);
      const node = (info[nodeType] ?? info) as Record<string, unknown> | undefined;
      if (!node) return [];
      const input = node.input as Record<string, Record<string, unknown>> | undefined;
      const required = input?.required;
      const entry = required?.[inputName] as unknown[] | undefined;
      if (Array.isArray(entry)) {
        // Handle [["euler",…]] (nested) or ["euler",…] (flat)
        const list = Array.isArray(entry[0]) ? entry[0] : entry;
        return list.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      // Fall through
    }
    return [];
  }

  /**
   * Get available sampler names from ComfyUI.
   * Queries /object_info/KSampler and extracts the sampler_name options.
   */
  async getSamplers(): Promise<string[]> {
    return this.extractNodeInputOptions('KSampler', 'sampler_name');
  }

  /**
   * Get available scheduler names from ComfyUI.
   * Queries /object_info/KSampler and extracts the scheduler options.
   */
  async getSchedulers(): Promise<string[]> {
    return this.extractNodeInputOptions('KSampler', 'scheduler');
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
   * Get available VAE model files from ComfyUI.
   * Queries GET /models/vae.
   */
  async getVaeModels(): Promise<string[]> {
    try {
      const response = await this.client.get('/models/vae');
      if (response.status === 200 && Array.isArray(response.data)) {
        return response.data as string[];
      }
    } catch {
      // ComfyUI unreachable
    }
    return [];
  }

  /**
   * Get available CLIP model files from ComfyUI.
   * Queries /object_info/CLIPLoader for the clip_name input options.
   */
  async getClipModels(): Promise<string[]> {
    return this.extractNodeInputOptions('CLIPLoader', 'clip_name');
  }

  /**
   * Get available diffuser/UNET model files from ComfyUI.
   * Queries /object_info/UNETLoader for the unet_name input options.
   */
  async getDiffuserModels(): Promise<string[]> {
    return this.extractNodeInputOptions('UNETLoader', 'unet_name');
  }

  /**
   * Get available CLIP type options for single CLIPLoader.
   * Queries /object_info/CLIPLoader for the type input options.
   */
  async getClipTypes(): Promise<string[]> {
    return this.extractNodeInputOptions('CLIPLoader', 'type');
  }

  /**
   * Get available CLIP type options for DualCLIPLoader.
   * Queries /object_info/DualCLIPLoader for the type input options.
   */
  async getDualClipTypes(): Promise<string[]> {
    return this.extractNodeInputOptions('DualCLIPLoader', 'type');
  }

  /**
   * Validate a workflow JSON string.
   * Checks that it is valid JSON and contains at least one occurrence of %prompt% (case-sensitive).
   * If the workflow is in ComfyUI's UI export format, it is auto-converted to API format.
   */
  validateWorkflow(workflowJson: string): WorkflowValidationResult {
    // Pre-substitute %seed% with a dummy value so unquoted numeric placeholders
    // (e.g. "noise_seed": %seed%) don't break JSON.parse.  The real seed is
    // substituted later in generateImage().
    const jsonForParsing = workflowJson.split('%seed%').join('0');

    // Validate JSON structure
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonForParsing);
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

    // Collect non-blocking warnings
    const warnings: string[] = [];

    // Warn if negative prompt is configured but %negative% is missing
    if (config.getComfyUIDefaultNegativePrompt() && !finalJson.includes('%negative%')) {
      const msg = 'Default negative prompt is configured but this workflow has no %negative% placeholder — the negative prompt will be ignored for this workflow.';
      warnings.push(msg);
      logger.logWarn('comfyui', msg);
    }

    // Validate node references
    const effectiveParsed = wasConverted ? JSON.parse(finalJson) : parsed;
    const refWarnings = validateNodeReferences(effectiveParsed as Record<string, unknown>);
    for (const w of refWarnings) {
      warnings.push(w);
      logger.logWarn('comfyui', `Workflow node reference warning: ${w}`);
    }

    return {
      valid: true,
      ...(wasConverted ? { convertedWorkflow: finalJson, wasConverted: true } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
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
      vae_name: config.getComfyUIDefaultVae() || undefined,
      clip_name: config.getComfyUIDefaultClip() || undefined,
      clip_name2: config.getComfyUIDefaultClip2() || undefined,
      clip_type: config.getComfyUIDefaultClipType() || undefined,
      diffuser_name: config.getComfyUIDefaultDiffuser() || undefined,
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
      vae_name: config.getComfyUIDefaultVae() || undefined,
      clip_name: config.getComfyUIDefaultClip() || undefined,
      clip_name2: config.getComfyUIDefaultClip2() || undefined,
      clip_type: config.getComfyUIDefaultClipType() || undefined,
      diffuser_name: config.getComfyUIDefaultDiffuser() || undefined,
    };

    const workflow = buildDefaultWorkflow(params);
    return { workflow, source: 'default', params };
  }

  /**
   * Upload an image to the ComfyUI server for use in img2img/img2vid workflows.
   * Uses the ComfyUI /upload/image endpoint with multipart/form-data.
   * Returns the uploaded filename and metadata needed for workflow substitution.
   */
  async uploadImage(imageBuffer: Buffer, filename?: string): Promise<{ name: string; subfolder: string; type: string }> {
    const uploadName = filename || `${randomUUID()}.png`;
    const blob = new Blob([new Uint8Array(imageBuffer)], { type: 'image/png' });
    const formData = new FormData();
    formData.append('image', blob, uploadName);
    formData.append('type', 'input');

    const response = await this.client.post('/upload/image', formData);

    const result = response.data as { name: string; subfolder: string; type: string };
    logger.log('success', 'comfyui', `Image uploaded: ${result.name} (subfolder: ${result.subfolder || '(root)'})`);
    return result;
  }

  async generateImage(
    prompt: string,
    requester: string,
    signal?: AbortSignal,
    timeoutSeconds?: number,
    options?: ComfyUIGenerateOptions
  ): Promise<ComfyUIResponse> {
    try {
      // Priority: custom uploaded workflow > default generated workflow
      let workflowJson = options?.toolName
        ? config.getComfyUIWorkflowForTool(options.toolName)
        : config.getComfyUIWorkflow();
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

      // Parse seed from content (must be first — it's appended last)
      const { content: contentWithoutSeed, seed: userSeed } = parseSeed(prompt);
      // Split positive/negative from the --negative: convention
      const { positive, negative: modelNegative } = parseNegativePrompt(contentWithoutSeed);
      const resolvedNegative = resolveNegativePrompt(
        config.getComfyUIDefaultNegativePrompt(),
        modelNegative
      );
      const resolvedSeed = userSeed !== null ? userSeed : config.getComfyUIDefaultSeed();

      // JSON-escape prompts so quotes/backslashes don't break the workflow JSON
      const escapedPrompt = JSON.stringify(positive).slice(1, -1);
      const escapedNegative = JSON.stringify(resolvedNegative).slice(1, -1);
      const seedStr = String(resolveSeed(resolvedSeed));

      // Replace all occurrences of %prompt%, %negative%, and %seed% (case-sensitive)
      const substitutedWorkflow = effectiveWorkflow
        .split('%prompt%').join(escapedPrompt)
        .split('%negative%').join(escapedNegative)
        .split('%seed%').join(seedStr);

      // ── Image upload and %image% substitution ──────────────────
      let finalWorkflow = substitutedWorkflow;
      if (options?.images?.length) {
        // Upload the first image to ComfyUI
        const imageBuffer = Buffer.from(options.images[0], 'base64');
        const uploaded = await this.uploadImage(imageBuffer);
        finalWorkflow = finalWorkflow.split('%image%').join(uploaded.name);
        logger.log('success', requester, `ComfyUI: uploaded input image as "${uploaded.name}" for %image% substitution`);
      } else if (substitutedWorkflow.includes('%image%')) {
        const errorMsg = 'Workflow contains %image% placeholder but no input image was provided. Attach an image to use this tool.';
        logger.logError(requester, errorMsg);
        return { success: false, error: errorMsg };
      }

      // Parse the substituted workflow to send as the prompt object
      const workflowData = JSON.parse(finalWorkflow);

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
          seed:         resolveSeed(config.getComfyUIDefaultSeed()),
        });
        if (patchedCount > 0) {
          const resolvedSeed = resolveSeed(config.getComfyUIDefaultSeed());
          logger.log(
            'success',
            requester,
            `Applied sampler overrides to ${patchedCount} KSampler node(s): ` +
            `sampler=${config.getComfyUIDefaultSampler()}, scheduler=${config.getComfyUIDefaultScheduler()}, ` +
            `steps=${config.getComfyUIDefaultSteps()}, cfg=${config.getComfyUIDefaultCfg()}, denoise=${config.getComfyUIDefaultDenoise()}, seed=${resolvedSeed}`
          );
        }
      }

      // Pre-flight: reject workflows with no output nodes before submitting
      if (!hasOutputNode(workflowData)) {
        const errorMsg = 'Workflow has no output node (e.g. SaveImage, PreviewImage, SaveVideo, PreviewVideo). ComfyUI requires at least one output node to produce results.';
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

      // Step 2: Wait for execution via WebSocket + polling in parallel.
      // WebSocket gives real-time progress; polling is the reliable fallback.
      // We race both so that if the WS silently fails to deliver messages,
      // polling picks up the completed result within seconds.
      const executionTimeoutMs = timeoutSeconds
        ? timeoutSeconds * 1000
        : ComfyUIClient.EXECUTION_TIMEOUT_MS;

      let historyData: Record<string, unknown> | null = null;

      // Controller to cancel the losing branch of the race
      const raceController = new AbortController();
      const raceSignal = signal
        ? AbortSignal.any([signal, raceController.signal])
        : raceController.signal;

      if (wsConnected) {
        // ── Parallel: WS wait + polling race ──
        let lastLoggedPercent = -1;
        const wsPromise = this.wsManager.waitForExecution({
          promptId,
          timeoutMs: executionTimeoutMs,
          signal: raceSignal,
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

        const pollPromise = this.pollForCompletion(promptId, raceSignal, executionTimeoutMs);

        // Wrap each branch into a common result shape for Promise.race
        type RaceResult =
          | { source: 'ws'; history: Record<string, unknown> | null; error?: string }
          | { source: 'poll'; history: Record<string, unknown> | null }
          | { source: 'ws-error'; error: string; terminal: boolean };

        const wsBranch: Promise<RaceResult> = wsPromise.then(async (executionResult) => {
          if (executionResult.completed && executionResult.error) {
            // Execution error (missing model, etc.) — terminal
            return { source: 'ws-error' as const, error: executionResult.error, terminal: true };
          }
          if (executionResult.error === 'Execution aborted') {
            return { source: 'ws-error' as const, error: 'ComfyUI generation aborted', terminal: true };
          }
          if (executionResult.success && executionResult.completed) {
            logger.log('success', requester, 'WebSocket detected completion, fetching history');
            const history = await this.fetchHistory(promptId, signal);
            return { source: 'ws' as const, history };
          }
          // WS transport failure or timeout — don't resolve the race,
          // let the poll branch win (it's already running).
          // But log it so we have diagnostics.
          logger.logError(requester, `WebSocket wait ended without completion: ${executionResult.error ?? 'unknown'}`);
          // Return a non-winning result; poll branch will win the race
          return new Promise<RaceResult>(() => {});
        });

        const pollBranch: Promise<RaceResult> = pollPromise.then((history) => {
          if (history) {
            logger.log('success', requester, 'Polling detected completion');
          }
          return { source: 'poll' as const, history };
        });

        const raceResult = await Promise.race([wsBranch, pollBranch]);
        // Cancel the losing branch
        raceController.abort();

        if (raceResult.source === 'ws-error') {
          logger.logError(requester, raceResult.error);
          return { success: false, error: raceResult.error };
        }

        historyData = raceResult.history;

        // If WS won but history wasn't ready yet, do a quick poll
        if (!historyData && raceResult.source === 'ws') {
          logger.log('success', requester, 'History not yet available after WS completion, brief poll');
          historyData = await this.pollForCompletion(promptId, signal, 15_000);
        }
      } else {
        // No WebSocket available — use polling only
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

      // Step 4: Extract output URLs from image/video output nodes
      const { images, videos } = this.extractOutputUrls(historyData);
      const totalOutputs = images.length + videos.length;

      if (totalOutputs === 0) {
        const outputs = historyData.outputs as Record<string, unknown> | undefined;
        const outputKeys = outputs ? Object.keys(outputs) : [];
        logger.logError(
          requester,
          `ComfyUI workflow produced no outputs. Output nodes: [${outputKeys.join(', ')}]. ` +
          'Check ComfyUI server logs for execution errors — the workflow may reference missing models or custom nodes.'
        );
        return {
          success: false,
          error: 'ComfyUI workflow produced no outputs. Check ComfyUI server logs for execution errors.',
        };
      }

      const parts: string[] = [];
      if (images.length > 0) parts.push(`${images.length} image(s)`);
      if (videos.length > 0) parts.push(`${videos.length} video(s)`);

      logger.logReply(
        requester,
        `ComfyUI generation completed for prompt: ${prompt.substring(0, 50)}... (${parts.join(', ')})`
      );

      // DEBUG: log full output URLs
      logger.logDebugLazy(requester, () => `COMFYUI-RESPONSE: ${parts.join(', ')}: ${JSON.stringify({ images, videos })}`);

      // Persist generated media to outputs/
      const mediaSources = [
        ...images.map(url => ({ source: url, defaultExtension: 'png', mediaType: 'image' as const })),
        ...videos.map(url => ({ source: url, defaultExtension: 'mp4', mediaType: 'video' as const })),
      ];
      const savedOutputs = await persistMedia(requester, prompt, mediaSources, 'comfyui');
      if (savedOutputs.length > 0) {
        logger.logDebug(requester, `ComfyUI outputs persisted: ${savedOutputs.length} file(s)`);
      }

      return {
        success: true,
        data: {
          images,
          ...(videos.length > 0 ? { videos } : {}),
          savedOutputs,
        },
      };
    } catch (error) {
      let errorMsg: string;
      if (error && typeof error === 'object' && 'isAxiosError' in error) {
        const axiosErr = error as AxiosError;
        const status = axiosErr.response?.status ?? 'no response';
        const body = axiosErr.response?.data ? JSON.stringify(axiosErr.response.data).slice(0, 200) : axiosErr.message;
        errorMsg = `ComfyUI request failed (HTTP ${status}): ${body}`;
      } else if (error instanceof Error) {
        errorMsg = error.cause ? `${error.message}: ${error.cause}` : error.message;
      } else {
        errorMsg = String(error);
      }
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
    let consecutiveFailures = 0;

    while (Date.now() < deadline) {
      if (signal?.aborted) return null;

      try {
        const response = await this.client.get(
          `/history/${promptId}`,
          signal ? { signal } : undefined
        );

        // Successful HTTP response — reset failure counter
        consecutiveFailures = 0;

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
        consecutiveFailures++;
        if (consecutiveFailures >= ComfyUIClient.MAX_CONSECUTIVE_POLL_FAILURES) {
          logger.logError(
            'comfyui',
            `ComfyUI unreachable after ${consecutiveFailures} consecutive poll failures — aborting`
          );
          return null;
        }
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

  /** File extensions treated as video regardless of which output key they appear under. */
  private static VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.avi', '.mov', '.mkv', '.gif', '.webp']);

  /**
   * Determine whether a filename should be classified as video based on its extension.
   */
  private static isVideoFilename(filename: string): boolean {
    const ext = filename.lastIndexOf('.') >= 0
      ? filename.slice(filename.lastIndexOf('.')).toLowerCase()
      : '';
    return ComfyUIClient.VIDEO_EXTENSIONS.has(ext);
  }

  /**
   * Walk the outputs object from a ComfyUI history entry and collect
   * downloadable file URLs via the /view endpoint.
   *
   * Rather than relying on which output key (`images`, `gifs`, `videos`) a
   * file appears under, classification is based on the actual file extension.
   * This handles custom nodes (e.g. VHS_VideoCombine) that place video files
   * under the `images` key.
   *
   * Every array-of-objects property on each output node is scanned, so new or
   * custom output keys are picked up automatically.
   */
  extractOutputUrls(historyData: Record<string, unknown>): { images: string[]; videos: string[] } {
    const images: string[] = [];
    const videos: string[] = [];
    const outputs = historyData.outputs as Record<string, Record<string, unknown>> | undefined;
    if (!outputs) return { images, videos };

    const baseURL = this.client.defaults.baseURL || '';

    for (const nodeOutput of Object.values(outputs)) {
      // Scan every key on this node's output for arrays of file-like objects
      for (const value of Object.values(nodeOutput)) {
        if (!Array.isArray(value)) continue;
        for (const item of value) {
          if (typeof item !== 'object' || item === null) continue;
          const file = item as Record<string, string>;
          if (!file.filename) continue;

          const params = new URLSearchParams({
            filename: file.filename,
            ...(file.subfolder ? { subfolder: file.subfolder } : {}),
            type: file.type || 'output',
          });
          const url = `${baseURL}/view?${params.toString()}`;

          if (ComfyUIClient.isVideoFilename(file.filename)) {
            videos.push(url);
          } else {
            images.push(url);
          }
        }
      }
    }

    return { images, videos };
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
