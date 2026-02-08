import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { readEnvVar } from './dotenvCodec';
import type { PublicConfig } from '../types';

dotenv.config();

/**
 * Keys whose .env values may contain backslash escapes that dotenv
 * doesn't decode.  After every dotenv.config() call we re-read
 * these from the raw file and replace process.env with the decoded
 * value so the rest of the app sees human-readable text.
 */
const ESCAPED_ENV_KEYS = ['OLLAMA_SYSTEM_PROMPT', 'ERROR_MESSAGE'];

function normalizeEscapedEnvVars(): void {
  const envPath = path.join(__dirname, '../../.env');
  for (const key of ESCAPED_ENV_KEYS) {
    const decoded = readEnvVar(envPath, key);
    if (decoded !== undefined) {
      process.env[key] = decoded;
    }
  }
}

normalizeEscapedEnvVars();

export interface KeywordConfig {
  keyword: string;
  api: 'comfyui' | 'ollama' | 'accuweather';
  timeout: number;
  description: string;
  /** Target API to route to after AI classification identifies this keyword. */
  routeApi?: 'comfyui' | 'ollama' | 'accuweather' | 'external';
  /** Specific Ollama model to use when routeApi is 'ollama'. */
  routeModel?: string;
  /** When true, pass the routed API result back through Ollama for conversational refinement. */
  finalOllamaPass?: boolean;
  /** AccuWeather data mode: which data to fetch. Only used when api is 'accuweather'. */
  accuweatherMode?: 'current' | 'forecast' | 'full';
}

export interface ConfigData {
  keywords: KeywordConfig[];
}

class Config {
  private keywords: KeywordConfig[] = [];

  constructor() {
    this.loadKeywords();
  }

  private loadKeywords(): void {
    const keywordsPath = path.join(__dirname, '../../config/keywords.json');
    try {
      const data = fs.readFileSync(keywordsPath, 'utf-8');
      const config: ConfigData = JSON.parse(data);

      if (!Array.isArray(config.keywords)) {
        throw new Error('keywords.json: "keywords" must be an array');
      }

      for (const entry of config.keywords) {
        if (!entry.keyword || typeof entry.keyword !== 'string') {
          throw new Error(`keywords.json: invalid keyword entry — missing "keyword" string`);
        }
        if (entry.api !== 'comfyui' && entry.api !== 'ollama' && entry.api !== 'accuweather') {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid api "${entry.api}" — must be "comfyui", "ollama", or "accuweather"`);
        }
        if (typeof entry.timeout !== 'number' || entry.timeout <= 0) {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid timeout — must be a positive number`);
        }
        if (entry.routeApi !== undefined && entry.routeApi !== 'comfyui' && entry.routeApi !== 'ollama' && entry.routeApi !== 'accuweather' && entry.routeApi !== 'external') {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid routeApi "${entry.routeApi}" — must be "comfyui", "ollama", "accuweather", or "external"`);
        }
        if (entry.routeModel !== undefined && typeof entry.routeModel !== 'string') {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid routeModel — must be a string`);
        }
        if (entry.finalOllamaPass !== undefined && typeof entry.finalOllamaPass !== 'boolean') {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid finalOllamaPass — must be a boolean`);
        }
        if (entry.accuweatherMode !== undefined && entry.accuweatherMode !== 'current' && entry.accuweatherMode !== 'forecast' && entry.accuweatherMode !== 'full') {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid accuweatherMode "${entry.accuweatherMode}" — must be "current", "forecast", or "full"`);
        }
      }

      this.keywords = config.keywords;
      logger.log('success', 'config', `Loaded ${this.keywords.length} keywords from config`);
    } catch (error) {
      logger.logError('config', `Failed to load keywords.json: ${error}`);
      this.keywords = [];
    }
  }

  getKeywords(): KeywordConfig[] {
    return this.keywords;
  }

  getKeywordConfig(keyword: string): KeywordConfig | undefined {
    return this.keywords.find(
      (k) => k.keyword.toLowerCase() === keyword.toLowerCase()
    );
  }

  getDiscordToken(): string {
    return process.env.DISCORD_TOKEN || '';
  }

  getClientId(): string {
    return process.env.DISCORD_CLIENT_ID || '';
  }

  getComfyUIEndpoint(): string {
    return process.env.COMFYUI_ENDPOINT || 'http://localhost:8190';
  }

  getOllamaEndpoint(): string {
    return process.env.OLLAMA_ENDPOINT || 'http://localhost:11434';
  }

  getAccuWeatherEndpoint(): string {
    return process.env.ACCUWEATHER_ENDPOINT || 'https://dataservice.accuweather.com';
  }

  getAccuWeatherApiKey(): string {
    return process.env.ACCUWEATHER_API_KEY || '';
  }

  getAccuWeatherDefaultLocation(): string {
    return process.env.ACCUWEATHER_DEFAULT_LOCATION || '';
  }

  getHttpPort(): number {
    return this.parseIntEnv('HTTP_PORT', 3000);
  }

  getOutputBaseUrl(): string {
    return process.env.OUTPUT_BASE_URL || 'http://localhost:3000';
  }

  getFileSizeThreshold(): number {
    return this.parseIntEnv('FILE_SIZE_THRESHOLD', 10485760);
  }

  getDefaultTimeout(): number {
    return this.parseIntEnv('DEFAULT_TIMEOUT', 300);
  }

  getOllamaModel(): string {
    return process.env.OLLAMA_MODEL || '';
  }

  /**
   * System prompt sent with every Ollama request to set the bot's personality.
   * Defaults to a friendly, tone-matching Discord bot persona.
   */
  getOllamaSystemPrompt(): string {
    // Distinguish "not set" (undefined) from "explicitly cleared" (empty string)
    const val = process.env.OLLAMA_SYSTEM_PROMPT;
    if (val === undefined) {
      return 'You are a helpful Discord bot assistant. Be friendly and helpful by default, but match the user\'s tone when appropriate—if someone is being snarky or playful, feel free to respond in kind. Always prioritize being useful and respectful.';
    }
    return val;
  }

  getErrorMessage(): string {
    return process.env.ERROR_MESSAGE || "I'm experiencing technical difficulties. Please try again later.";
  }

  getErrorRateLimitMinutes(): number {
    return this.parseIntEnv('ERROR_RATE_LIMIT_MINUTES', 60);
  }

  /**
   * Whether reply chain context collection is enabled.
   * When true, the bot traverses Discord reply chains to build
   * conversation history for Ollama chat requests.
   */
  getReplyChainEnabled(): boolean {
    return process.env.REPLY_CHAIN_ENABLED !== 'false';
  }

  /**
   * Maximum number of messages to traverse in a reply chain.
   * Deeper chains are truncated at this limit. Default: 10.
   */
  getReplyChainMaxDepth(): number {
    const raw = this.parseIntEnv('REPLY_CHAIN_MAX_DEPTH', 10);
    return Math.max(1, Math.min(raw, 50));
  }

  /**
   * Maximum total characters of reply chain content sent to Ollama.
   * Once the accumulated context exceeds this limit, older messages are
   * dropped from the front. Default: 16000 (~4k tokens).
   */
  getReplyChainMaxTokens(): number {
    const raw = this.parseIntEnv('REPLY_CHAIN_MAX_TOKENS', 16000);
    return Math.max(1000, Math.min(raw, 128000));
  }

  /**
   * Whether to include the embed block (with internal View link) in image
   * generation responses.  Default: false — only the image attachment is sent.
   */
  getImageResponseIncludeEmbed(): boolean {
    return process.env.IMAGE_RESPONSE_INCLUDE_EMBED === 'true';
  }

  /**
   * Maximum number of file attachments per Discord message.
   * Clamped to 1–10 (Discord's hard limit is 10).
   */
  getMaxAttachments(): number {
    const raw = this.parseIntEnv('MAX_ATTACHMENTS', 10);
    return Math.max(1, Math.min(raw, 10));
  }

  // ── Default ComfyUI workflow parameters ───────────────────────

  /** Checkpoint model path for the default workflow. Empty = no default workflow. */
  getComfyUIDefaultModel(): string {
    return process.env.COMFYUI_DEFAULT_MODEL || '';
  }

  /** Latent image width for the default workflow. Default: 512 */
  getComfyUIDefaultWidth(): number {
    return this.parseIntEnv('COMFYUI_DEFAULT_WIDTH', 512);
  }

  /** Latent image height for the default workflow. Default: 512 */
  getComfyUIDefaultHeight(): number {
    return this.parseIntEnv('COMFYUI_DEFAULT_HEIGHT', 512);
  }

  /** Sampling steps for the default workflow. Default: 20 */
  getComfyUIDefaultSteps(): number {
    return this.parseIntEnv('COMFYUI_DEFAULT_STEPS', 20);
  }

  /** CFG scale for the default workflow. Default: 7.0 */
  getComfyUIDefaultCfg(): number {
    return this.parseFloatEnv('COMFYUI_DEFAULT_CFG', 7.0);
  }

  /** Sampler name for the default workflow. Default: euler */
  getComfyUIDefaultSampler(): string {
    return process.env.COMFYUI_DEFAULT_SAMPLER || 'euler';
  }

  /** Scheduler for the default workflow. Default: normal */
  getComfyUIDefaultScheduler(): string {
    return process.env.COMFYUI_DEFAULT_SCHEDULER || 'normal';
  }

  /** Denoise strength for the default workflow. Default: 1.0 */
  getComfyUIDefaultDenoise(): number {
    return this.parseFloatEnv('COMFYUI_DEFAULT_DENOISE', 1.0);
  }

  /**
   * Load the ComfyUI workflow JSON from .config/comfyui-workflow.json.
   * Returns the raw JSON string, or empty string if not found.
   */
  getComfyUIWorkflow(): string {
    const workflowPath = path.join(__dirname, '../../.config/comfyui-workflow.json');
    try {
      if (fs.existsSync(workflowPath)) {
        return fs.readFileSync(workflowPath, 'utf-8');
      }
    } catch (error) {
      logger.logError('config', `Failed to load ComfyUI workflow: ${error}`);
    }
    return '';
  }

  /**
   * Check whether a ComfyUI workflow file exists.
   */
  hasComfyUIWorkflow(): boolean {
    const workflowPath = path.join(__dirname, '../../.config/comfyui-workflow.json');
    return fs.existsSync(workflowPath);
  }

  private parseIntEnv(name: string, defaultValue: number): number {
    const raw = process.env[name];
    if (!raw) return defaultValue;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed)) {
      logger.logWarn('config', `Environment variable ${name} is not a valid number: "${raw}" — using default ${defaultValue}`);
      return defaultValue;
    }
    return parsed;
  }

  private parseFloatEnv(name: string, defaultValue: number): number {
    const raw = process.env[name];
    if (!raw) return defaultValue;
    const parsed = parseFloat(raw);
    if (isNaN(parsed)) {
      logger.logWarn('config', `Environment variable ${name} is not a valid number: "${raw}" — using default ${defaultValue}`);
      return defaultValue;
    }
    return parsed;
  }

  getApiEndpoint(api: 'comfyui' | 'ollama' | 'accuweather'): string {
    if (api === 'comfyui') return this.getComfyUIEndpoint();
    if (api === 'accuweather') return this.getAccuWeatherEndpoint();
    return this.getOllamaEndpoint();
  }

  /**
   * Reload hot-reloadable config from .env and keywords.json.
   * API endpoints and keywords reload in-place.
   * Discord token, client ID, and HTTP port require restart.
   */
  reload(): { reloaded: string[]; requiresRestart: string[] } {
    const requiresRestart: string[] = [];
    const reloaded: string[] = [];

    // Capture current values BEFORE reloading .env
    const prevToken = process.env.DISCORD_TOKEN || '';
    const prevClientId = process.env.DISCORD_CLIENT_ID || '';
    const prevPort = this.port;
    const prevComfyUI = this.getComfyUIEndpoint();
    const prevOllama = this.getOllamaEndpoint();
    const prevAccuWeather = this.getAccuWeatherEndpoint();
    const prevAccuWeatherKey = this.getAccuWeatherApiKey();
    const prevAccuWeatherLocation = this.getAccuWeatherDefaultLocation();
    const prevBaseUrl = this.getOutputBaseUrl();
    const prevThreshold = this.getFileSizeThreshold();
    const prevTimeout = this.getDefaultTimeout();
    const prevOllamaModel = this.getOllamaModel();
    const prevSystemPrompt = this.getOllamaSystemPrompt();
    const prevErrorMsg = this.getErrorMessage();
    const prevErrorRate = this.getErrorRateLimitMinutes();
    const prevMaxAttach = this.getMaxAttachments();
    const prevReplyChainEnabled = this.getReplyChainEnabled();
    const prevReplyChainMaxDepth = this.getReplyChainMaxDepth();
    const prevReplyChainMaxTokens = this.getReplyChainMaxTokens();
    const prevImageResponseIncludeEmbed = this.getImageResponseIncludeEmbed();
    const prevDefaultModel = this.getComfyUIDefaultModel();
    const prevDefaultWidth = this.getComfyUIDefaultWidth();
    const prevDefaultHeight = this.getComfyUIDefaultHeight();
    const prevDefaultSteps = this.getComfyUIDefaultSteps();
    const prevDefaultCfg = this.getComfyUIDefaultCfg();
    const prevDefaultSampler = this.getComfyUIDefaultSampler();
    const prevDefaultScheduler = this.getComfyUIDefaultScheduler();
    const prevDefaultDenoise = this.getComfyUIDefaultDenoise();

    // Re-parse .env into process.env
    const envPath = path.join(__dirname, '../../.env');
    const envResult = dotenv.config({ path: envPath, override: true });
    if (envResult.error) {
      logger.logError('config', `Failed to reload .env: ${envResult.error}`);
    }

    // Decode backslash escapes that dotenv leaves as-is
    normalizeEscapedEnvVars();

    // Detect restart-required changes (only HTTP port)
    const newPort = this.parseIntEnv('HTTP_PORT', 3000);
    if (newPort !== prevPort) requiresRestart.push('HTTP_PORT');

    // Track Discord changes (manageable via start/stop, not restart)
    const newToken = process.env.DISCORD_TOKEN || '';
    const newClientId = process.env.DISCORD_CLIENT_ID || '';
    if (newToken !== prevToken) reloaded.push('DISCORD_TOKEN');
    if (newClientId !== prevClientId) reloaded.push('DISCORD_CLIENT_ID');

    // Track hot-reloaded changes
    if (this.getComfyUIEndpoint() !== prevComfyUI) reloaded.push('COMFYUI_ENDPOINT');
    if (this.getOllamaEndpoint() !== prevOllama) reloaded.push('OLLAMA_ENDPOINT');
    if (this.getAccuWeatherEndpoint() !== prevAccuWeather) reloaded.push('ACCUWEATHER_ENDPOINT');
    if (this.getAccuWeatherApiKey() !== prevAccuWeatherKey) reloaded.push('ACCUWEATHER_API_KEY');
    if (this.getAccuWeatherDefaultLocation() !== prevAccuWeatherLocation) reloaded.push('ACCUWEATHER_DEFAULT_LOCATION');
    if (this.getOutputBaseUrl() !== prevBaseUrl) reloaded.push('OUTPUT_BASE_URL');
    if (this.getFileSizeThreshold() !== prevThreshold) reloaded.push('FILE_SIZE_THRESHOLD');
    if (this.getDefaultTimeout() !== prevTimeout) reloaded.push('DEFAULT_TIMEOUT');
    if (this.getOllamaModel() !== prevOllamaModel) reloaded.push('OLLAMA_MODEL');
    if (this.getOllamaSystemPrompt() !== prevSystemPrompt) reloaded.push('OLLAMA_SYSTEM_PROMPT');
    if (this.getErrorMessage() !== prevErrorMsg) reloaded.push('ERROR_MESSAGE');
    if (this.getErrorRateLimitMinutes() !== prevErrorRate) reloaded.push('ERROR_RATE_LIMIT_MINUTES');
    if (this.getMaxAttachments() !== prevMaxAttach) reloaded.push('MAX_ATTACHMENTS');
    if (this.getReplyChainEnabled() !== prevReplyChainEnabled) reloaded.push('REPLY_CHAIN_ENABLED');
    if (this.getReplyChainMaxDepth() !== prevReplyChainMaxDepth) reloaded.push('REPLY_CHAIN_MAX_DEPTH');
    if (this.getReplyChainMaxTokens() !== prevReplyChainMaxTokens) reloaded.push('REPLY_CHAIN_MAX_TOKENS');
    if (this.getImageResponseIncludeEmbed() !== prevImageResponseIncludeEmbed) reloaded.push('IMAGE_RESPONSE_INCLUDE_EMBED');
    if (this.getComfyUIDefaultModel() !== prevDefaultModel) reloaded.push('COMFYUI_DEFAULT_MODEL');
    if (this.getComfyUIDefaultWidth() !== prevDefaultWidth) reloaded.push('COMFYUI_DEFAULT_WIDTH');
    if (this.getComfyUIDefaultHeight() !== prevDefaultHeight) reloaded.push('COMFYUI_DEFAULT_HEIGHT');
    if (this.getComfyUIDefaultSteps() !== prevDefaultSteps) reloaded.push('COMFYUI_DEFAULT_STEPS');
    if (this.getComfyUIDefaultCfg() !== prevDefaultCfg) reloaded.push('COMFYUI_DEFAULT_CFG');
    if (this.getComfyUIDefaultSampler() !== prevDefaultSampler) reloaded.push('COMFYUI_DEFAULT_SAMPLER');
    if (this.getComfyUIDefaultScheduler() !== prevDefaultScheduler) reloaded.push('COMFYUI_DEFAULT_SCHEDULER');
    if (this.getComfyUIDefaultDenoise() !== prevDefaultDenoise) reloaded.push('COMFYUI_DEFAULT_DENOISE');

    // Reload keywords
    this.loadKeywords();
    reloaded.push('keywords');

    return { reloaded, requiresRestart };
  }

  /** Port captured at construction time — changes require restart */
  private port = this.parseIntEnv('HTTP_PORT', 3000);

  /**
   * Get a safe view of config for the configurator UI.
   * Never exposes Discord token or API keys.
   */
  getPublicConfig(): PublicConfig {
    return {
      discord: {
        clientId: process.env.DISCORD_CLIENT_ID || '',
        tokenConfigured: !!process.env.DISCORD_TOKEN,
      },
      apis: {
        comfyui: this.getComfyUIEndpoint(),
        ollama: this.getOllamaEndpoint(),
        ollamaModel: this.getOllamaModel(),
        ollamaSystemPrompt: this.getOllamaSystemPrompt(),
        comfyuiWorkflowConfigured: this.hasComfyUIWorkflow(),
        accuweather: this.getAccuWeatherEndpoint(),
        accuweatherDefaultLocation: this.getAccuWeatherDefaultLocation(),
        accuweatherApiKeyConfigured: !!this.getAccuWeatherApiKey(),
      },
      defaultWorkflow: {
        model: this.getComfyUIDefaultModel(),
        width: this.getComfyUIDefaultWidth(),
        height: this.getComfyUIDefaultHeight(),
        steps: this.getComfyUIDefaultSteps(),
        cfg: this.getComfyUIDefaultCfg(),
        sampler: this.getComfyUIDefaultSampler(),
        scheduler: this.getComfyUIDefaultScheduler(),
        denoise: this.getComfyUIDefaultDenoise(),
      },
      errorHandling: {
        errorMessage: this.getErrorMessage(),
        errorRateLimitMinutes: this.getErrorRateLimitMinutes(),
      },
      http: {
        port: this.getHttpPort(),
        outputBaseUrl: this.getOutputBaseUrl(),
      },
      limits: {
        fileSizeThreshold: this.getFileSizeThreshold(),
        defaultTimeout: this.getDefaultTimeout(),
        maxAttachments: this.getMaxAttachments(),
      },
      keywords: this.getKeywords(),
      replyChain: {
        enabled: this.getReplyChainEnabled(),
        maxDepth: this.getReplyChainMaxDepth(),
        maxTokens: this.getReplyChainMaxTokens(),
      },
      imageResponse: {
        includeEmbed: this.getImageResponseIncludeEmbed(),
      },
    };
  }
}

export const config = new Config();
