import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { readEnvVar } from './dotenvCodec';
import { parseToolsXml } from './toolsXmlParser';
import type { ToolParameter } from './toolsXmlParser';
import type { PublicConfig, LlmProvider } from '../types';

dotenv.config();

/**
 * Keys whose .env values may contain backslash escapes that dotenv
 * doesn't decode.  After every dotenv.config() call we re-read
 * these from the raw file and replace process.env with the decoded
 * value so the rest of the app sees human-readable text.
 */
const ESCAPED_ENV_KEYS = ['OLLAMA_SYSTEM_PROMPT', 'ERROR_MESSAGE', 'OLLAMA_FINAL_PASS_PROMPT', 'ABILITY_RETRY_PROMPT'];

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

/**
 * The prefix character required for direct tool invocation in messages.
 * Natural language messages (without this prefix) go through model inference.
 * Model-emitted directives also use this prefix.
 */
export const COMMAND_PREFIX = '!';

/** Structured guidance for how a tool's inputs are inferred and validated. All context is available by default. */
export interface AbilityInputs {
  /** How inputs are provided: 'implicit' (inferred from context), 'explicit' (user must provide), 'mixed' (some inferred, some required). */
  mode: 'implicit' | 'explicit' | 'mixed';
  /** Required input descriptions (e.g., "location", "query"). */
  required?: string[];
  /** Optional input descriptions. */
  optional?: string[];
  /** Comma-separated source names to infer inputs from (e.g. "user_message, conversation_history"). */
  inferFrom?: string[];
  /** Plain-language validation constraints (e.g., "date must be YYYY-MM-DD or YYYYMMDD"). */
  validation?: string;
  /** 1–2 short usage examples. */
  examples?: string[];
}

/** Canonical list of valid tool API identifiers. Single source of truth for parser, writer, and UI. */
export const VALID_TOOL_APIS = [
  'comfyui', 'ollama', 'accuweather', 'nfl', 'serpapi', 'meme', 'discord', 'xai', 'xai-image', 'xai-video', 'webfetch',
] as const;

export interface ToolConfig {
  name: string;
  api: typeof VALID_TOOL_APIS[number];
  timeout: number;
  description: string;
  /** Human-readable description of this tool's API ability, provided to Ollama as context so it can suggest using this API when relevant. */
  abilityText?: string;
  /** Model-facing: when to use this ability (e.g., "User wants an image generated"). */
  abilityWhen?: string;
  /** Model-facing: structured input inference/validation guidance. */
  abilityInputs?: AbilityInputs;
  /** When true, this tool can be invoked with no additional user content (e.g. 'nfl_scores' alone). */
  allowEmptyContent?: boolean;
  /** Whether this tool is currently enabled. Defaults to true when omitted. */
  enabled?: boolean;
  /** Optional per-tool retry override (global defaults exist). */
  retry?: {
    /** When set, overrides the global ABILITY_RETRY_ENABLED for this tool. */
    enabled?: boolean;
    /** When set, overrides global ABILITY_RETRY_MAX_RETRIES for this tool. */
    maxRetries?: number;
    /** Optional per-tool model override (defaults to global retry model, then default Ollama model). */
    model?: string;
    /** Optional per-tool prompt override (defaults to global retry prompt). */
    prompt?: string;
  };
  /** Whether this tool is a built-in that cannot be edited or deleted — only toggled on/off. */
  builtin?: boolean;
  /** OpenAI-style parameter definitions for the XML tools format.
   *  Stored for faithful round-trip when writing back to tools.xml. */
  parameters?: Record<string, ToolParameter>;
}

/** @deprecated Use ToolConfig instead. */
export type KeywordConfig = ToolConfig;

export interface ConfigData {
  tools: ToolConfig[];
}

class Config {
  private tools: ToolConfig[] = [];
  /**
   * Human-readable error message when tools failed to load.
   * `null` when tools loaded successfully; surfaced via `getPublicConfig()`
   * so the configurator can display a diagnostic banner.
   */
  private toolsLoadError: string | null = null;

  constructor() {
    this.loadTools();
  }

  private getToolsPath(): string {
    const envPath = process.env.TOOLS_CONFIG_PATH;
    if (envPath) {
      return path.resolve(path.join(__dirname, '../..'), envPath);
    }
    return path.join(__dirname, '../../config/tools.xml');
  }

  private getDefaultToolsPath(): string {
    return path.join(__dirname, '../../config/tools.default.xml');
  }

  /**
   * If the runtime tools.xml does not exist and TOOLS_CONFIG_PATH is
   * not set, copy from the tracked tools.default.xml template — mirroring
   * the .env.example → .env pattern so the runtime file can be gitignored.
   *
   * **Design note – corrupt files are intentionally not auto-replaced.**
   * `ensureToolsFile()` only handles the *missing-file* case. If the
   * runtime file exists but contains malformed XML, `loadTools()` will
   * catch the parse error, set `this.tools = []`, and populate
   * `this.toolsLoadError` with diagnostic details so the configurator
   * can surface the problem.  Auto-restoring from the default template
   * on corruption was considered but rejected to avoid silently
   * discarding user customisations.  A future enhancement could offer
   * an explicit "repair from defaults" action in the configurator UI.
   */
  private ensureToolsFile(): void {
    // Skip when user specified a custom path via env.
    if (process.env.TOOLS_CONFIG_PATH) return;

    const runtimePath = this.getToolsPath();
    if (fs.existsSync(runtimePath)) return;

    const defaultPath = this.getDefaultToolsPath();
    if (fs.existsSync(defaultPath)) {
      fs.copyFileSync(defaultPath, runtimePath);
      logger.log('success', 'config', `Created runtime ${path.basename(runtimePath)} from ${path.basename(defaultPath)}`);
    } else {
      logger.logWarn('config', `No tools config found — neither ${runtimePath} nor ${defaultPath} exist`);
    }
  }

  private loadTools(): void {
    this.ensureToolsFile();
    const toolsPath = this.getToolsPath();
    try {
      const data = fs.readFileSync(toolsPath, 'utf-8');
      const configData: ConfigData = { tools: parseToolsXml(data) };

      // Enforce: custom "help" tool is only allowed when the built-in help tool is disabled
      const helpTool = `${COMMAND_PREFIX}help`;
      const builtinHelp = configData.tools.find(k => k.builtin && k.name.toLowerCase() === helpTool);
      const builtinHelpEnabled = builtinHelp ? builtinHelp.enabled !== false : false;
      if (builtinHelpEnabled) {
        const customHelp = configData.tools.find(k => !k.builtin && k.name.toLowerCase() === helpTool);
        if (customHelp) {
          logger.logWarn('config', 'Ignoring custom "help" tool because the built-in help tool is enabled');
          configData.tools = configData.tools.filter(k => k !== customHelp);
        }
      }

      this.tools = configData.tools;
      this.toolsLoadError = null;
      logger.log('success', 'config', `Loaded ${this.tools.length} tools from config`);

      // Merge missing default tools into runtime so newly added defaults
      // self-heal even when tools.xml predates them.
      // Existing tools are intentionally NOT overwritten.
      this.mergeDefaultTools();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const debugFile = toolsPath + '.debug';
      const hasDebug = fs.existsSync(debugFile);
      this.toolsLoadError = `Failed to parse ${path.basename(toolsPath)}: ${errorMsg}`
        + (hasDebug ? ` — see ${path.basename(debugFile)} for diagnostics` : '');
      logger.logError('config', `Failed to load tools config (${toolsPath}): ${errorMsg}`);
      if (hasDebug) {
        logger.logWarn('config', `Debug artifact exists: ${debugFile}`);
      }
      this.tools = [];
    }
  }

  getTools(): ToolConfig[] {
    return this.tools;
  }

  /**
   * Return the tool array from tools.default.xml.
   * Used by the configurator to offer a "sync missing" action.
   */
  getDefaultTools(): ToolConfig[] {
    const defaultPath = this.getDefaultToolsPath();
    try {
      const data = fs.readFileSync(defaultPath, 'utf-8');
      return parseToolsXml(data);
    } catch {
      return [];
    }
  }

  /**
   * Self-heal runtime tools by adding defaults that are missing.
   *
   * Important: existing runtime tools are NOT overwritten. This allows
   * users to customize values in tools.xml without defaults replacing them
   * on reload.
   */
  private mergeDefaultTools(): void {
    const defaults = this.getDefaultTools();
    const existingByKey = new Map(
      this.tools.map(k => [k.name.toLowerCase(), k])
    );

    let added = 0;
    let corrected = 0;
    let keptExisting = 0;

    for (const def of defaults) {
      const key = def.name.toLowerCase();
      const existing = existingByKey.get(key);

      if (!existing) {
        // New tool from defaults — append
        this.tools.push({ ...def });
        existingByKey.set(key, def);
        added++;
        logger.log('success', 'config',
          `TOOLS SELF-HEAL: Added missing tool "${def.name}" from tools.default.xml`);
      } else {
        if (existing.api !== def.api) {
          logger.logWarn('config',
            `TOOLS SELF-HEAL: Tool "${def.name}" has api="${existing.api}" but default is "${def.api}" — correcting to default`);
          existing.api = def.api;
          corrected++;
        }
        keptExisting++;
      }
    }

    if (added > 0 || corrected > 0) {
      logger.log('success', 'config',
        `TOOLS SELF-HEAL: tools.xml merged with defaults — added: ${added}, corrected: ${corrected}, kept existing: ${keptExisting}, total runtime tools: ${this.tools.length}`);
    } else {
      logger.log('success', 'config',
        `TOOLS SELF-HEAL: No missing defaults found — kept existing tools unchanged (${keptExisting} matched)`);
    }
  }

  getToolConfig(toolName: string): ToolConfig | undefined {
    const normalized = toolName.toLowerCase();
    // Support lookup by tool name with or without the command prefix
    const withPrefix = normalized.startsWith(COMMAND_PREFIX) ? normalized : `${COMMAND_PREFIX}${normalized}`;
    const withoutPrefix = normalized.startsWith(COMMAND_PREFIX) ? normalized.slice(COMMAND_PREFIX.length) : normalized;
    return this.tools.find(
      (k) => {
        const kw = k.name.toLowerCase();
        return kw === withPrefix || kw === withoutPrefix || kw === normalized;
      }
    );
  }

  /**
   * Explicit override for the bot's display name used in prompt
   * participant blocks. When non-empty, takes precedence over the
   * Discord client's own display name.
   */
  getBotDisplayName(): string {
    return (process.env.BOT_DISPLAY_NAME || '').trim();
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

  /** Default weather output type: 'current', 'forecast', or 'full'. */
  getAccuWeatherDefaultWeatherType(): 'current' | 'forecast' | 'full' {
    const raw = (process.env.ACCUWEATHER_DEFAULT_WEATHER_TYPE || '').trim().toLowerCase();
    if (raw === 'current' || raw === 'forecast') return raw;
    return 'full';
  }

  // ── NFL / ESPN configuration ─────────────────────────────

  getNflEndpoint(): string {
    return process.env.NFL_BASE_URL || 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
  }

  getNflEnabled(): boolean {
    return process.env.NFL_ENABLED !== 'false';
  }

  // ── Meme (memegen.link) configuration ─────────────────

  getMemeEndpoint(): string {
    return process.env.MEME_BASE_URL || 'https://api.memegen.link';
  }

  getMemeEnabled(): boolean {
    return process.env.MEME_ENABLED !== 'false';
  }

  /**
   * Whether verbose meme inference logging is enabled.
   * When true, full meme inference prompts and parsing context are logged.
   */
  getMemeLoggingDebug(): boolean {
    return process.env.MEME_LOGGING_DEBUG === 'true';
  }

  // ── SerpAPI configuration ────────────────────────────────

  getSerpApiKey(): string {
    return process.env.SERPAPI_API_KEY || '';
  }

  getSerpApiEndpoint(): string {
    return process.env.SERPAPI_ENDPOINT || 'https://serpapi.com';
  }

  /**
   * Language code for SerpAPI Google Search requests.
   * AI Overview availability is mainly limited to English (`hl=en`).
   * Defaults to 'en' when unset; set to empty string to omit.
   */
  getSerpApiHl(): string {
    const val = process.env.SERPAPI_HL;
    return val === undefined ? 'en' : val;
  }

  /**
   * Country code for SerpAPI Google Search requests.
   * AI Overview availability varies by country.
   * Defaults to 'us' when unset; set to empty string to omit.
   */
  getSerpApiGl(): string {
    const val = process.env.SERPAPI_GL;
    return val === undefined ? 'us' : val;
  }

  /**
   * Optional location hint for SerpAPI Google Search requests.
   * Example: "United States" or "Austin,Texas".
   * Empty string means omitted.
   */
  getSerpApiLocation(): string {
    return process.env.SERPAPI_LOCATION || '';
  }

  // ── Web Fetch configuration ──────────────────────────────────

  getWebFetchEnabled(): boolean {
    return process.env.WEBFETCH_ENABLED !== 'false';
  }

  getWebFetchTimeout(): number {
    return parseInt(process.env.WEBFETCH_TIMEOUT || '15000', 10);
  }

  getWebFetchMaxTextSize(): number {
    return parseInt(process.env.WEBFETCH_MAX_TEXT_SIZE || '5242880', 10);
  }

  getWebFetchMaxImageSize(): number {
    return parseInt(process.env.WEBFETCH_MAX_IMAGE_SIZE || '10485760', 10);
  }

  getWebFetchMaxContentChars(): number {
    return parseInt(process.env.WEBFETCH_MAX_CONTENT_CHARS || '8000', 10);
  }

  getWebFetchMaxRedirects(): number {
    return parseInt(process.env.WEBFETCH_MAX_REDIRECTS || '3', 10);
  }

  /**
   * Returns the robots.txt handling mode:
   * - `"follow"` — check robots.txt; if disallowed, block fetch and fall back to search.
   * - `"ignore"` — check robots.txt; if disallowed, log a note but proceed with fetch.
   * - `"disabled"` — do not check robots.txt at all.
   *
   * Accepts the legacy `"true"` (mapped to `"ignore"`) and `"false"` (mapped to `"disabled"`).
   */
  getWebFetchRobotsTxtMode(): 'follow' | 'ignore' | 'disabled' {
    const raw = (process.env.WEBFETCH_ROBOTS_TXT || 'disabled').toLowerCase().trim();
    if (raw === 'follow') return 'follow';
    if (raw === 'ignore' || raw === 'true') return 'ignore';
    return 'disabled';
  }

  getWebFetchUserAgent(): string {
    return process.env.WEBFETCH_USER_AGENT || 'BobBot/1.0';
  }

  // ── xAI configuration ─────────────────────────────────────────

  getXaiApiKey(): string {
    return process.env.XAI_API_KEY || '';
  }

  getXaiEndpoint(): string {
    return process.env.XAI_BASE_URL || 'https://api.x.ai/v1';
  }

  getXaiModel(): string {
    return process.env.XAI_MODEL || '';
  }

  getXaiImageEnabled(): boolean {
    return process.env.XAI_IMAGE_ENABLED === 'true';
  }

  getXaiVideoEnabled(): boolean {
    return process.env.XAI_VIDEO_ENABLED === 'true';
  }

  /** When true, appends a system prompt encouraging xAI built-in tool use. */
  getXaiEncourageBuiltinTools(): boolean {
    return process.env.XAI_ENCOURAGE_BUILTIN_TOOLS === 'true';
  }

  /** HTTP timeout in milliseconds for xAI requests. Default: 120000 (2 min). */
  getXaiTimeout(): number {
    return this.clampTimeout(this.parseIntEnv('XAI_TIMEOUT', 120_000));
  }

  /** xAI model for image generation. Default: grok-imagine-image. */
  getXaiImageModel(): string {
    return process.env.XAI_IMAGE_MODEL || 'grok-imagine-image';
  }

  /** xAI model for video generation. Default: grok-imagine-video. */
  getXaiVideoModel(): string {
    return process.env.XAI_VIDEO_MODEL || 'grok-imagine-video';
  }

  /**
   * Whether xAI-specific debug logging is enabled.
   * When true, logs detailed request/response payloads for xAI calls.
   * Independent of the global DEBUG_LOGGING toggle.
   */
  getXaiDebugLogging(): boolean {
    return process.env.XAI_DEBUG_LOGGING === 'true';
  }

  /**
   * Optional thraken ingest URL for xAI responses.
   * When populated, thinking or response text is POSTed here.
   */
  getXaiThrakenUrl(): string {
    return (process.env.XAI_THRAKEN_URL || '').trim();
  }

  // ── xAI per-stage model / timeout overrides ────────────────

  /** xAI model for tool evaluation. Falls back to XAI_MODEL. */
  getXaiToolModel(): string {
    return (process.env.XAI_TOOL_MODEL || '').trim() || this.getXaiModel();
  }

  /** xAI model for context evaluation. Falls back to XAI_MODEL. */
  getXaiContextEvalModel(): string {
    return (process.env.XAI_CONTEXT_EVAL_MODEL || '').trim() || this.getXaiModel();
  }

  /** xAI model for final pass. Falls back to XAI_MODEL. */
  getXaiFinalPassModel(): string {
    return (process.env.XAI_FINAL_PASS_MODEL || '').trim() || this.getXaiModel();
  }

  /** xAI HTTP timeout for tool evaluation (ms). Falls back to XAI_TIMEOUT. */
  getXaiToolTimeout(): number {
    const raw = process.env.XAI_TOOL_TIMEOUT;
    if (raw) return this.clampTimeout(this.parseIntEnv('XAI_TOOL_TIMEOUT', this.getXaiTimeout()));
    return this.getXaiTimeout();
  }

  /** xAI HTTP timeout for context evaluation (ms). Falls back to XAI_TIMEOUT. */
  getXaiContextEvalTimeout(): number {
    const raw = process.env.XAI_CONTEXT_EVAL_TIMEOUT;
    if (raw) return this.clampTimeout(this.parseIntEnv('XAI_CONTEXT_EVAL_TIMEOUT', this.getXaiTimeout()));
    return this.getXaiTimeout();
  }

  /** xAI HTTP timeout for final pass (ms). Falls back to XAI_TIMEOUT. */
  getXaiFinalPassTimeout(): number {
    const raw = process.env.XAI_FINAL_PASS_TIMEOUT;
    if (raw) return this.clampTimeout(this.parseIntEnv('XAI_FINAL_PASS_TIMEOUT', this.getXaiTimeout()));
    return this.getXaiTimeout();
  }

  // ── Provider stage selectors ────────────────────────────────

  private parseLlmProvider(envKey: string, fallback: LlmProvider = 'ollama'): LlmProvider {
    const raw = (process.env[envKey] || '').trim().toLowerCase();
    if (raw === 'xai') return 'xai';
    if (raw === 'ollama') return 'ollama';
    return fallback;
  }

  /** Provider for tool evaluation stage. Default: ollama. */
  getProviderToolEval(): LlmProvider {
    return this.parseLlmProvider('PROVIDER_TOOL_EVAL');
  }

  /** Provider for final pass stage. Default: ollama. */
  getProviderFinalPass(): LlmProvider {
    return this.parseLlmProvider('PROVIDER_FINAL_PASS');
  }

  /** Provider for context evaluation stage. Default: ollama. */
  getProviderContextEval(): LlmProvider {
    return this.parseLlmProvider('PROVIDER_CONTEXT_EVAL');
  }

  /** Provider for ability retry/refinement stage. Default: ollama. */
  getProviderRetry(): LlmProvider {
    return this.parseLlmProvider('PROVIDER_RETRY');
  }

  /**
   * Image generation backend: 'comfyui' or 'xai'.
   * When 'xai', generate_image uses the xAI API instead of ComfyUI.
   */
  getImageGenerationBackend(): 'comfyui' | 'xai' {
    const raw = (process.env.IMAGE_GENERATION_BACKEND || '').trim().toLowerCase();
    if (raw === 'xai') return 'xai';
    return 'comfyui';
  }

  /**
   * Web search backend: 'serpapi' or 'xai'.
   * When 'xai', web_search uses the xAI built-in web_search tool instead of SerpAPI.
   */
  getWebSearchBackend(): 'serpapi' | 'xai' {
    const raw = (process.env.WEB_SEARCH_BACKEND || '').trim().toLowerCase();
    if (raw === 'xai') return 'xai';
    return 'serpapi';
  }

  /**
   * Maximum number of tool call iterations per user message turn.
   * Limits the tool evaluation loop to prevent runaway API calls.
   * Default: 5, range: 1-10.
   */
  getMaxToolCalls(): number {
    const raw = this.parseIntEnv('MAX_TOOL_CALLS', 5);
    return Math.max(1, Math.min(raw, 10));
  }

  getHttpPort(): number {
    return this.parseIntEnv('HTTP_PORT', 3000);
  }

  getHttpHost(): string {
    return (process.env.HTTP_HOST || '').trim() || '127.0.0.1';
  }

  getOutputsPort(): number {
    return this.parseIntEnv('OUTPUTS_PORT', 3003);
  }

  getOutputsHost(): string {
    return (process.env.OUTPUTS_HOST || '').trim() || '0.0.0.0';
  }

  /**
   * Trust proxy setting for the outputs server.
   * Accepts:
   *  - "false" (default): trust proxy disabled
   *  - "true": trust all proxies
   *  - positive integer string (e.g. "1", "2"): trust N proxy hops
   *  - "0" is normalized to false (zero hops = disabled)
   */
  getOutputsTrustProxy(): boolean | number {
    const raw = (process.env.OUTPUTS_TRUST_PROXY || '').trim().toLowerCase();
    if (!raw || raw === 'false') return false;
    if (raw === 'true') return true;
    if (/^\d+$/.test(raw)) {
      const hops = parseInt(raw, 10);
      if (Number.isFinite(hops) && hops > 0) return hops;
      return false;
    }
    logger.logWarn(
      'config',
      `Environment variable OUTPUTS_TRUST_PROXY has invalid value "${process.env.OUTPUTS_TRUST_PROXY}" — using false`,
    );
    return false;
  }

  getOutputBaseUrl(): string {
    const url = (process.env.OUTPUT_BASE_URL || 'http://localhost:3003').replace(/\/+$/, '');

    // Warn when trust proxy is enabled but OUTPUT_BASE_URL still points at
    // localhost — the links the bot sends to Discord won't be reachable from
    // outside the host, which is almost certainly a misconfiguration.
    if (this.getOutputsTrustProxy() && /localhost|127\.0\.0\.1/i.test(url)) {
      logger.logWarn(
        'config',
        'OUTPUTS_TRUST_PROXY is enabled but OUTPUT_BASE_URL still points at localhost — '
        + 'Activity links sent to Discord users will not be reachable. '
        + 'Set OUTPUT_BASE_URL to your public proxy URL (e.g. https://bot.example.com).',
      );
    }

    return url;
  }

  // ── Outputs-server rate limiting ─────────────────────────────

  /**
   * Rate-limit window in milliseconds for the outputs server.
   * Default: 900000 (15 minutes).  Configurable via OUTPUTS_RATE_LIMIT_WINDOW_MS.
   */
  getOutputsRateLimitWindowMs(): number {
    const raw = this.parseIntEnv('OUTPUTS_RATE_LIMIT_WINDOW_MS', 900000);
    return Math.max(1000, raw);
  }

  /**
   * Maximum number of requests per window for rate-limited outputs-server routes.
   * Default: 100.  Configurable via OUTPUTS_RATE_LIMIT_MAX.
   */
  getOutputsRateLimitMax(): number {
    const raw = this.parseIntEnv('OUTPUTS_RATE_LIMIT_MAX', 100);
    return Math.max(1, raw);
  }

  /**
   * Time-to-live in seconds for the activity monitor access key.
   * After this duration a new key must be requested from Discord.
   * Default: 300 (5 minutes).  Configurable via ACTIVITY_KEY_TTL.
   */
  /**
   * Optional thraken ingest URL for Ollama responses.
   * When populated, thinking or response text is POSTed here.
   */
  getOllamaThrakenUrl(): string {
    return (process.env.OLLAMA_THRAKEN_URL || '').trim();
  }

  getActivityKeyTtl(): number {
    return this.parseIntEnv('ACTIVITY_KEY_TTL', 300);
  }

  /**
   * Maximum session duration in seconds for the activity monitor.
   * Once a key is used to authenticate, a session is created that lasts
   * up to this duration (or until the page is fully refreshed).
   * Default: 86400 (1 day).  Configurable via ACTIVITY_SESSION_MAX_TIME.
   */
  getActivitySessionMaxTime(): number {
    return this.parseIntEnv('ACTIVITY_SESSION_MAX_TIME', 86400);
  }

  /**
   * Optional bearer token for authenticating admin/configurator requests.
   * When set, every request to configurator routes must include an
   * `Authorization: Bearer <token>` header. When unset the configurator
   * relies on the localhostOnly IP guard (legacy behaviour).
   *
   * **Strongly recommended** when the configurator is reachable through a
   * reverse proxy, even if the proxy applies an IP allow-list.
   */
  getAdminToken(): string {
    return (process.env.ADMIN_TOKEN || '').trim();
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
   * Ollama model used for vision/multimodal requests (image analysis).
   * Falls back to the default OLLAMA_MODEL if not set.
   */
  getOllamaVisionModel(): string {
    return process.env.OLLAMA_VISION_MODEL || this.getOllamaModel();
  }

  /**
   * Maximum size in bytes for a single image attachment.
   * Discord attachments exceeding this are skipped. Default: 5 MB.
   */
  getImageAttachmentMaxSize(): number {
    return this.parseIntEnv('IMAGE_ATTACHMENT_MAX_SIZE', 5 * 1024 * 1024);
  }

  /**
   * Maximum number of image attachments processed per message.
   * Additional images beyond this cap are silently ignored. Default: 4.
   */
  getImageAttachmentMaxCount(): number {
    return this.parseIntEnv('IMAGE_ATTACHMENT_MAX_COUNT', 4);
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

  /**
   * Whether global context evaluation is enabled.
   * When false, the bot will skip context filtering and send all messages to Ollama.
   * Default: true.
   */
  getContextEvalEnabled(): boolean {
    return process.env.CONTEXT_EVAL_ENABLED !== 'false';
  }

  /**
   * Ollama model used for context evaluation.
   * Falls back to the default OLLAMA_MODEL if not set.
   */
  getContextEvalModel(): string {
    return process.env.CONTEXT_EVAL_MODEL || this.getOllamaModel();
  }

  /**
   * System prompt used for context evaluation.
   * Default is the built-in prompt from contextEvaluator.ts.
   */
  getContextEvalPrompt(): string {
    const val = process.env.CONTEXT_EVAL_PROMPT;
    if (val === undefined) {
      return 'You are a context relevance evaluator. Your job is to determine which recent conversation messages are relevant to the current user prompt.\n\nYou will be given a list of conversation messages (numbered from most recent to oldest) and the current user prompt.\nDetermine which messages should be included as context for responding to the user.\n\nRules:\n- You MUST always include at least indices 1 through 20 (the most recent messages).\n- You may include up to 30 message(s) total.\n- Prioritize newer messages over older ones — only include older messages when clearly relevant.\n- Messages tagged [reply] or [thread] are from a direct reply chain or thread and are generally more relevant than [channel] messages.\n- If messages vary topics too greatly, prefer the most recent topic.\n- You may select non-contiguous messages (e.g. 1, 3, 5) if only specific older messages are relevant.\n- Respond with ONLY a JSON array of integer indices — e.g. [1, 2, 4].\n- Do not include any explanation, punctuation, or extra text outside of the JSON array.';
    }
    return val;
  }

  /**
   * Ollama context window size (num_ctx) for context evaluation.
   * Default: 2048, range: 256-131072.
   */
  getContextEvalContextSize(): number {
    const raw = this.parseIntEnv('CONTEXT_EVAL_CONTEXT_SIZE', 2048);
    return Math.max(256, Math.min(raw, 131072));
  }

  /**
   * Ollama model used for tool evaluation.
   * Falls back to the default OLLAMA_MODEL if not set.
   */
  getOllamaToolModel(): string {
    return process.env.OLLAMA_TOOL_MODEL || this.getOllamaModel();
  }

  /**
   * Optional system prompt appended during tool evaluation.
   * Empty by default — existing prompt assembly is used as-is.
   */
  getOllamaToolPrompt(): string {
    return process.env.OLLAMA_TOOL_PROMPT ?? '';
  }

  /**
   * Ollama context window size (num_ctx) for tool evaluation.
   * Default: 4096, range: 256-131072.
   */
  getOllamaToolContextSize(): number {
    const raw = this.parseIntEnv('OLLAMA_TOOL_CONTEXT_SIZE', 4096);
    return Math.max(256, Math.min(raw, 131072));
  }

  /**
   * Ollama context window size (num_ctx) for the final response pass.
   * Default: 4096, range: 256-131072.
   */
  getOllamaFinalPassContextSize(): number {
    const raw = this.parseIntEnv('OLLAMA_FINAL_PASS_CONTEXT_SIZE', 4096);
    return Math.max(256, Math.min(raw, 131072));
  }

  // ── Per-model-role HTTP timeouts (ms) ─────────────────────────

  /** Minimum allowed timeout (ms). */
  private static TIMEOUT_MIN_MS = 5_000;
  /** Maximum allowed timeout (ms). */
  private static TIMEOUT_MAX_MS = 600_000;

  /** Clamp a timeout value to [5000, 600000]. */
  private clampTimeout(value: number): number {
    return Math.max(Config.TIMEOUT_MIN_MS, Math.min(value, Config.TIMEOUT_MAX_MS));
  }

  /**
   * Global Ollama HTTP timeout in milliseconds.
   * Applies to all Ollama requests unless a role-specific timeout is set.
   * Default: 120000 (2 min). Range: 5000–600000.
   */
  getOllamaTimeout(): number {
    return this.clampTimeout(this.parseIntEnv('OLLAMA_TIMEOUT', 120_000));
  }

  /**
   * Ollama HTTP timeout for vision model requests.
   * Falls back to OLLAMA_TIMEOUT. Range: 5000–600000.
   */
  getOllamaVisionTimeout(): number {
    const raw = process.env.OLLAMA_VISION_TIMEOUT;
    if (raw) return this.clampTimeout(this.parseIntEnv('OLLAMA_VISION_TIMEOUT', this.getOllamaTimeout()));
    return this.getOllamaTimeout();
  }

  /**
   * Ollama HTTP timeout for context evaluation requests.
   * Falls back to OLLAMA_TIMEOUT. Range: 5000–600000.
   */
  getContextEvalTimeout(): number {
    const raw = process.env.CONTEXT_EVAL_TIMEOUT;
    if (raw) return this.clampTimeout(this.parseIntEnv('CONTEXT_EVAL_TIMEOUT', this.getOllamaTimeout()));
    return this.getOllamaTimeout();
  }

  /**
   * Ollama HTTP timeout for tool evaluation requests.
   * Falls back to OLLAMA_TIMEOUT. Range: 5000–600000.
   */
  getOllamaToolTimeout(): number {
    const raw = process.env.OLLAMA_TOOL_TIMEOUT;
    if (raw) return this.clampTimeout(this.parseIntEnv('OLLAMA_TOOL_TIMEOUT', this.getOllamaTimeout()));
    return this.getOllamaTimeout();
  }

  /**
   * Ollama HTTP timeout for the final refinement pass.
   * Falls back to OLLAMA_TIMEOUT. Range: 5000–600000.
   */
  getOllamaFinalPassTimeout(): number {
    const raw = process.env.OLLAMA_FINAL_PASS_TIMEOUT;
    if (raw) return this.clampTimeout(this.parseIntEnv('OLLAMA_FINAL_PASS_TIMEOUT', this.getOllamaTimeout()));
    return this.getOllamaTimeout();
  }

  /**
   * Ollama HTTP timeout for ability retry/refinement requests.
   * Falls back to OLLAMA_TIMEOUT. Range: 5000–600000.
   */
  getAbilityRetryTimeout(): number {
    const raw = process.env.ABILITY_RETRY_TIMEOUT;
    if (raw) return this.clampTimeout(this.parseIntEnv('ABILITY_RETRY_TIMEOUT', this.getOllamaTimeout()));
    return this.getOllamaTimeout();
  }


  getErrorRateLimitMinutes(): number {
    return this.parseIntEnv('ERROR_RATE_LIMIT_MINUTES', 60);
  }

  /**
   * Ollama model used for the final refinement pass on API results.
   * Falls back to the default OLLAMA_MODEL if not set.
   */
  getOllamaFinalPassModel(): string {
    return process.env.OLLAMA_FINAL_PASS_MODEL || this.getOllamaModel();
  }

  /**
   * Pipeline execution mode: 'unified' (default) or 'legacy'.
   * 'unified' uses cumulative context building with fewer Ollama calls.
   * 'legacy' preserves the original two-stage evaluation flow.
   */
  getPipelineMode(): 'unified' | 'legacy' {
    const raw = (process.env.PIPELINE_MODE || '').trim().toLowerCase();
    if (raw === 'legacy') return 'legacy';
    return 'unified';
  }

  // ── Ollama response fixup ────────────────────────────────

  /** Global toggle for the Ollama response fixup layer. Default: true. */
  getOllamaFixupEnabled(): boolean {
    return process.env.OLLAMA_FIXUP_ENABLED !== 'false';
  }

  /** Extract tool calls from XML-wrapped blocks in response text. Default: true. */
  getOllamaFixupExtractXmlTools(): boolean {
    return process.env.OLLAMA_FIXUP_EXTRACT_XML_TOOLS !== 'false';
  }

  /** Extract tool calls from bare JSON objects in response text. Default: true. */
  getOllamaFixupExtractJsonTools(): boolean {
    return process.env.OLLAMA_FIXUP_EXTRACT_JSON_TOOLS !== 'false';
  }

  /** Repair malformed URLs in response text. Default: true. */
  getOllamaFixupRepairUrls(): boolean {
    return process.env.OLLAMA_FIXUP_REPAIR_URLS !== 'false';
  }

  /** Strip preamble text when tool calls are extracted. Default: true. */
  getOllamaFixupStripToolPreamble(): boolean {
    return process.env.OLLAMA_FIXUP_STRIP_TOOL_PREAMBLE !== 'false';
  }

  /**
   * Whether the final pass requires a separate call.
   * Returns true when the tool-eval and final-pass stages use different
   * providers or different models within the same provider.
   */
  needsSeparateFinalPass(): boolean {
    const toolProvider = this.getProviderToolEval();
    const finalProvider = this.getProviderFinalPass();

    // Different providers always need a separate final pass
    if (toolProvider !== finalProvider) return true;

    if (toolProvider === 'xai') {
      return this.getXaiToolModel().toLowerCase().trim() !== this.getXaiFinalPassModel().toLowerCase().trim();
    }

    const toolModel = this.getOllamaToolModel().toLowerCase().trim();
    const finalModel = this.getOllamaFinalPassModel().toLowerCase().trim();
    return toolModel !== finalModel;
  }

  /**
   * Instruction appended to the system content for every final Ollama pass.
   * Configurable via the configurator UI. Clear to disable.
   */
  getOllamaFinalPassPrompt(): string {
    const val = process.env.OLLAMA_FINAL_PASS_PROMPT;
    if (val === undefined) {
      return 'Review the message context for the tone of the conversation and provide replies in a similar tone. Be helpful, concise with details, and try to maintain continuity between the context, the prompt, and your reply. Review the incoming data and provide a relevant and opinionated response. Treat information from external_data as the most recent update to any related context in conversation_history.\n\nFormatting rules:\n- Basic text styles: Use **text** for bold, *text* or _text_ for italics, __text__ for underline, and ~~text~~ for strikethrough; combine them like ***bold italics*** or __**underline bold**__ for more emphasis.\n- Code & code blocks: Single backticks `code` for inline code, triple backticks for ```code blocks``` (e.g. ```python\\nprint("Hello World!")\\n```)\n- Spoilers & hiding text: Wrap content in ||text|| to create ||spoiler|| tags that hide text until clicked and cannot be used inside of `code` or ```code blocks```.\n- Links and URLs:  Masked links via [text](URL) and cannot be used inside of `code` or ```code blocks```.\n- Quotes & organization: Use the identifier followed by a space; > text for block quotes or >>> text for multi-line quotes; headers with # Header, ## Smaller, etc.; bulleted lists with - item or * item and double-space indent for nested bullets.\n- Tables: Tabularized data needs to be encapsulated in ```code block``` and spaced exactly, markdown tables are not supported.';
    }
    return val;
  }

  // ── Ability retry (global) ───────────────────────────────────

  /**
   * Global toggle for the ability retry/refinement loop.
   * Default: false.
   */
  getAbilityRetryEnabled(): boolean {
    return process.env.ABILITY_RETRY_ENABLED === 'true';
  }

  /**
   * Max number of retries AFTER the initial attempt.
   * Default: 2.
   */
  getAbilityRetryMaxRetries(): number {
    const raw = this.parseIntEnv('ABILITY_RETRY_MAX_RETRIES', 2);
    return Math.max(0, Math.min(raw, 10));
  }

  /**
   * Ollama model to use for parameter refinement.
   * Defaults to OLLAMA_MODEL.
   */
  getAbilityRetryModel(): string {
    return process.env.ABILITY_RETRY_MODEL || this.getOllamaModel();
  }

  /**
   * Generic instruction for parameter refinement calls.
   * AccuWeather may still use a specialized prompt at runtime.
   */
  getAbilityRetryPrompt(): string {
    const val = process.env.ABILITY_RETRY_PROMPT;
    if (val === undefined) {
      return 'Refine the user\'s parameters so the external ability can succeed. Return ONLY the refined parameters, with no extra commentary.';
    }
    return val;
  }

  /**
   * Whether global debug logging is enabled.
   * When true, logs full message content, prompts, and API payloads.
   * Default: false (off).
   */
  getDebugLogging(): boolean {
    return process.env.DEBUG_LOGGING === 'true';
  }

  /**
   * NFL logging verbosity level.
   *   0 = summary only (endpoint, season/week, cache hit/miss, game count)
   *   1 = summary + trimmed payload preview (default)
   *   2 = full payload text
   */
  getNflLoggingLevel(): number {
    const raw = this.parseIntEnv('NFL_LOGGING_LEVEL', 1);
    return Math.max(0, Math.min(raw, 2));
  }

  /**
   * Whether the bot responds to messages from other bots and includes
   * their messages in context history. Default: false.
   */
  getAllowBotInteractions(): boolean {
    return process.env.ALLOW_BOT_INTERACTIONS === 'true';
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
   * Maximum number of messages to traverse in a reply chain or channel history.
   * Deeper chains are truncated at this limit. Default: 30.
   */
  getReplyChainMaxDepth(): number {
    const raw = this.parseIntEnv('REPLY_CHAIN_MAX_DEPTH', 30);
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
   * Whether to extract a single image from the immediate reply parent and
   * include it in the vision payload sent to the LLM.
   * Default: true. Set to false to disable reply-chain image extraction.
   */
  getReplyChainImageEnabled(): boolean {
    const val = process.env.REPLY_CHAIN_IMAGE_ENABLED;
    if (val === undefined) return true;
    return val.toLowerCase() === 'true';
  }

  // ── DM Context configuration ────────────────────────────────

  /**
   * Whether to fetch the bot's DM history with the requesting user
   * and include it as background context for guild channel messages.
   * Default: false (opt-in).
   */
  getDmContextEnabled(): boolean {
    return process.env.DM_CONTEXT_ENABLED === 'true';
  }

  /**
   * Maximum number of DM messages to fetch for guild context.
   * Clamped 0–50, default 10. Setting to 0 effectively disables.
   */
  getDmContextMaxMessages(): number {
    const raw = this.parseIntEnv('DM_CONTEXT_MAX_MESSAGES', 10);
    return Math.max(0, Math.min(raw, 50));
  }

  /**
   * Whether to include the embed block (with internal View link) in image
   * generation responses.  Default: false — only the image attachment is sent.
   */
  getImageResponseIncludeEmbed(): boolean {
    return process.env.IMAGE_RESPONSE_INCLUDE_EMBED === 'true';
  }

  /**
   * Configurator UI theme preference.
   * Valid values: dark, grayscale, green, orange, purple, black-cyan.
   * Default: 'dark'.
   */
  private static VALID_THEMES = ['dark', 'grayscale', 'green', 'orange', 'purple', 'black-cyan'];
  getConfiguratorTheme(): string {
    const raw = (process.env.CONFIGURATOR_THEME || '').trim().toLowerCase();
    return Config.VALID_THEMES.includes(raw) ? raw : 'dark';
  }

  /**
   * Maximum number of file attachments per Discord message.
   * Clamped to 1–10 (Discord's hard limit is 10).
   */
  getMaxAttachments(): number {
    const raw = this.parseIntEnv('MAX_ATTACHMENTS', 10);
    return Math.max(1, Math.min(raw, 10));
  }

  // ── Discord tool-call limits ──────────────────────────────────

  /**
   * Maximum number of messages returned when `get_discord_artifact` is
   * invoked with only a channel (no message_id/search).
   * Clamped 1–20, default 5.
   */
  getDiscordArtifactMaxMessages(): number {
    const raw = this.parseIntEnv('DISCORD_ARTIFACT_MAX_MESSAGES', 5);
    return Math.max(1, Math.min(raw, 20));
  }

  /**
   * Maximum number of image attachments surfaced in a channel-only
   * `get_discord_artifact` response.
   * Clamped 0–5, default 1.  Set to 0 to omit image URLs entirely.
   */
  getDiscordArtifactMaxImages(): number {
    const raw = this.parseIntEnv('DISCORD_ARTIFACT_MAX_IMAGES', 1);
    return Math.max(0, Math.min(raw, 5));
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

  /** Sampler name for the default workflow. Default: euler_ancestral */
  getComfyUIDefaultSampler(): string {
    return process.env.COMFYUI_DEFAULT_SAMPLER || 'euler_ancestral';
  }

  /** Scheduler for the default workflow. Default: beta */
  getComfyUIDefaultScheduler(): string {
    return process.env.COMFYUI_DEFAULT_SCHEDULER || 'beta';
  }

  /** Denoise strength for the default workflow. Default: 0.88 */
  getComfyUIDefaultDenoise(): number {
    return this.parseFloatEnv('COMFYUI_DEFAULT_DENOISE', 0.88);
  }

  /**
   * Seed for the default workflow KSampler.
   * -1 means random (ComfyUI generates a new seed each run).
   * Valid range: -1 or 0–9007199254740991 (Number.MAX_SAFE_INTEGER).
   * Default: -1 (random).
   */
  getComfyUIDefaultSeed(): number {
    const raw = this.parseIntEnv('COMFYUI_DEFAULT_SEED', -1);
    if (raw === -1) return -1;
    return Math.max(0, Math.min(raw, Number.MAX_SAFE_INTEGER));
  }

  /** Default negative prompt prepended to all image generation requests. */
  getComfyUIDefaultNegativePrompt(): string {
    return process.env.COMFYUI_DEFAULT_NEGATIVE_PROMPT || '';
  }

  /** Separate VAE model path for the default workflow. Empty = use checkpoint VAE. */
  getComfyUIDefaultVae(): string {
    return process.env.COMFYUI_DEFAULT_VAE || '';
  }

  /** Separate CLIP model path for the default workflow. Empty = use checkpoint CLIP. */
  getComfyUIDefaultClip(): string {
    return process.env.COMFYUI_DEFAULT_CLIP || '';
  }

  /** Second CLIP model path for DualCLIPLoader. Empty = single CLIP mode. */
  getComfyUIDefaultClip2(): string {
    return process.env.COMFYUI_DEFAULT_CLIP2 || '';
  }

  /** CLIP loader type (e.g. 'stable_diffusion', 'sdxl', 'flux'). Default: 'stable_diffusion'. */
  getComfyUIDefaultClipType(): string {
    return process.env.COMFYUI_DEFAULT_CLIP_TYPE || 'stable_diffusion';
  }

  /** Diffuser/UNET model path for the default workflow. Empty = use checkpoint model. */
  getComfyUIDefaultDiffuser(): string {
    return process.env.COMFYUI_DEFAULT_DIFFUSER || '';
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

  getApiEndpoint(api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi' | 'meme' | 'discord' | 'xai' | 'xai-image' | 'xai-video' | 'webfetch'): string {
    if (api === 'comfyui') return this.getComfyUIEndpoint();
    if (api === 'accuweather') return this.getAccuWeatherEndpoint();
    if (api === 'nfl') return this.getNflEndpoint();
    if (api === 'serpapi') return this.getSerpApiEndpoint();
    if (api === 'meme') return this.getMemeEndpoint();
    if (api === 'discord') return '';
    if (api === 'webfetch') return '';
    if (api === 'xai' || api === 'xai-image' || api === 'xai-video') return this.getXaiEndpoint();
    return this.getOllamaEndpoint();
  }

  /**
   * Reload hot-reloadable config from .env and tools.xml (runtime copy).
   * API endpoints and tools reload in-place.
   * Discord token, client ID, and HTTP port require restart.
   */
  reload(): { reloaded: string[]; requiresRestart: string[] } {
    const requiresRestart: string[] = [];
    const reloaded: string[] = [];

    // Capture current values BEFORE reloading .env
    const prevToken = process.env.DISCORD_TOKEN || '';
    const prevClientId = process.env.DISCORD_CLIENT_ID || '';
    const prevPort = this.port;
    const prevOutputsPort = this.outputsPort;
    const prevHttpHost = this.httpHost;
    const prevOutputsHost = this.outputsHostBound;
    const prevOutputsTrustProxy = this.outputsTrustProxyBound;
    const prevComfyUI = this.getComfyUIEndpoint();
    const prevOllama = this.getOllamaEndpoint();
    const prevAccuWeather = this.getAccuWeatherEndpoint();
    const prevAccuWeatherKey = this.getAccuWeatherApiKey();
    const prevAccuWeatherLocation = this.getAccuWeatherDefaultLocation();
    const prevAccuWeatherWeatherType = this.getAccuWeatherDefaultWeatherType();
    const prevBaseUrl = this.getOutputBaseUrl();
    const prevThreshold = this.getFileSizeThreshold();
    const prevTimeout = this.getDefaultTimeout();
    const prevOllamaModel = this.getOllamaModel();
    const prevOllamaVisionModel = this.getOllamaVisionModel();
    const prevImageAttachMaxSize = this.getImageAttachmentMaxSize();
    const prevImageAttachMaxCount = this.getImageAttachmentMaxCount();
    const prevSystemPrompt = this.getOllamaSystemPrompt();
    const prevErrorMsg = this.getErrorMessage();
    const prevErrorRate = this.getErrorRateLimitMinutes();
    const prevMaxAttach = this.getMaxAttachments();
    const prevArtifactMaxMessages = this.getDiscordArtifactMaxMessages();
    const prevArtifactMaxImages = this.getDiscordArtifactMaxImages();
    const prevAllowBotInteractions = this.getAllowBotInteractions();
    const prevReplyChainEnabled = this.getReplyChainEnabled();
    const prevReplyChainMaxDepth = this.getReplyChainMaxDepth();
    const prevReplyChainMaxTokens = this.getReplyChainMaxTokens();
    const prevReplyChainImageEnabled = this.getReplyChainImageEnabled();
    const prevDmContextEnabled = this.getDmContextEnabled();
    const prevDmContextMaxMessages = this.getDmContextMaxMessages();
    const prevImageResponseIncludeEmbed = this.getImageResponseIncludeEmbed();
    const prevOllamaFinalPassModel = this.getOllamaFinalPassModel();
    const prevDebugLogging = this.getDebugLogging();
    const prevNflLoggingLevel = this.getNflLoggingLevel();
    const prevNflEndpoint = this.getNflEndpoint();
    const prevNflEnabled = this.getNflEnabled();
    const prevMemeEndpoint = this.getMemeEndpoint();
    const prevMemeEnabled = this.getMemeEnabled();
    const prevMemeLoggingDebug = this.getMemeLoggingDebug();
    const prevSerpApiKey = this.getSerpApiKey();
    const prevSerpApiEndpoint = this.getSerpApiEndpoint();
    const prevSerpApiHl = this.getSerpApiHl();
    const prevSerpApiGl = this.getSerpApiGl();
    const prevSerpApiLocation = this.getSerpApiLocation();
    const prevFinalPassPrompt = this.getOllamaFinalPassPrompt();
    const prevAbilityRetryEnabled = this.getAbilityRetryEnabled();
    const prevAbilityRetryMaxRetries = this.getAbilityRetryMaxRetries();
    const prevAbilityRetryModel = this.getAbilityRetryModel();
    const prevAbilityRetryPrompt = this.getAbilityRetryPrompt();
    const prevBotDisplayName = this.getBotDisplayName();
    const prevOllamaTimeout = this.getOllamaTimeout();
    const prevOllamaVisionTimeout = this.getOllamaVisionTimeout();
    const prevContextEvalTimeout = this.getContextEvalTimeout();
    const prevOllamaToolTimeout = this.getOllamaToolTimeout();
    const prevOllamaFinalPassTimeout = this.getOllamaFinalPassTimeout();
    const prevAbilityRetryTimeout = this.getAbilityRetryTimeout();
    const prevDefaultModel = this.getComfyUIDefaultModel();
    const prevDefaultWidth = this.getComfyUIDefaultWidth();
    const prevDefaultHeight = this.getComfyUIDefaultHeight();
    const prevDefaultSteps = this.getComfyUIDefaultSteps();
    const prevDefaultCfg = this.getComfyUIDefaultCfg();
    const prevDefaultSampler = this.getComfyUIDefaultSampler();
    const prevDefaultScheduler = this.getComfyUIDefaultScheduler();
    const prevDefaultDenoise = this.getComfyUIDefaultDenoise();
    const prevDefaultSeed = this.getComfyUIDefaultSeed();
    const prevDefaultNegativePrompt = this.getComfyUIDefaultNegativePrompt();
    const prevDefaultVae = this.getComfyUIDefaultVae();
    const prevDefaultClip = this.getComfyUIDefaultClip();
    const prevDefaultClip2 = this.getComfyUIDefaultClip2();
    const prevDefaultClipType = this.getComfyUIDefaultClipType();
    const prevMaxToolCalls = this.getMaxToolCalls();
    const prevDefaultDiffuser = this.getComfyUIDefaultDiffuser();
    const prevFixupEnabled = this.getOllamaFixupEnabled();
    const prevFixupExtractXml = this.getOllamaFixupExtractXmlTools();
    const prevFixupExtractJson = this.getOllamaFixupExtractJsonTools();
    const prevFixupRepairUrls = this.getOllamaFixupRepairUrls();
    const prevFixupStripPreamble = this.getOllamaFixupStripToolPreamble();
    const prevXaiEndpoint = this.getXaiEndpoint();
    const prevXaiApiKey = this.getXaiApiKey();
    const prevXaiModel = this.getXaiModel();
    const prevXaiImageEnabled = this.getXaiImageEnabled();
    const prevXaiVideoEnabled = this.getXaiVideoEnabled();
    const prevXaiEncourageBuiltinTools = this.getXaiEncourageBuiltinTools();
    const prevXaiTimeout = this.getXaiTimeout();
    const prevXaiImageModel = this.getXaiImageModel();
    const prevXaiVideoModel = this.getXaiVideoModel();
    const prevXaiDebugLogging = this.getXaiDebugLogging();
    const prevXaiToolModel = this.getXaiToolModel();
    const prevXaiContextEvalModel = this.getXaiContextEvalModel();
    const prevXaiFinalPassModel = this.getXaiFinalPassModel();
    const prevXaiToolTimeout = this.getXaiToolTimeout();
    const prevXaiContextEvalTimeout = this.getXaiContextEvalTimeout();
    const prevXaiFinalPassTimeout = this.getXaiFinalPassTimeout();
    const prevProviderToolEval = this.getProviderToolEval();
    const prevProviderFinalPass = this.getProviderFinalPass();
    const prevProviderContextEval = this.getProviderContextEval();
    const prevProviderRetry = this.getProviderRetry();
    const prevImageGenerationBackend = this.getImageGenerationBackend();
    const prevWebSearchBackend = this.getWebSearchBackend();

    // Re-parse .env into process.env
    const envPath = path.join(__dirname, '../../.env');
    const envResult = dotenv.config({ path: envPath, override: true });
    if (envResult.error) {
      logger.logError('config', `Failed to reload .env: ${envResult.error}`);
    }

    // Decode backslash escapes that dotenv leaves as-is
    normalizeEscapedEnvVars();

    // Detect restart-required changes (server bind params)
    const newPort = this.parseIntEnv('HTTP_PORT', 3000);
    if (newPort !== prevPort) requiresRestart.push('HTTP_PORT');
    const newHttpHost = (process.env.HTTP_HOST || '').trim() || '127.0.0.1';
    if (newHttpHost !== prevHttpHost) requiresRestart.push('HTTP_HOST');
    const newOutputsPort = this.parseIntEnv('OUTPUTS_PORT', 3003);
    if (newOutputsPort !== prevOutputsPort) requiresRestart.push('OUTPUTS_PORT');
    const newOutputsHost = this.getOutputsHost();
    if (newOutputsHost !== prevOutputsHost) requiresRestart.push('OUTPUTS_HOST');
    const newOutputsTrustProxy = this.getOutputsTrustProxy();
    if (newOutputsTrustProxy !== prevOutputsTrustProxy) requiresRestart.push('OUTPUTS_TRUST_PROXY');

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
    if (this.getAccuWeatherDefaultWeatherType() !== prevAccuWeatherWeatherType) reloaded.push('ACCUWEATHER_DEFAULT_WEATHER_TYPE');
    if (this.getOutputBaseUrl() !== prevBaseUrl) reloaded.push('OUTPUT_BASE_URL');
    if (this.getFileSizeThreshold() !== prevThreshold) reloaded.push('FILE_SIZE_THRESHOLD');
    if (this.getDefaultTimeout() !== prevTimeout) reloaded.push('DEFAULT_TIMEOUT');
    if (this.getOllamaModel() !== prevOllamaModel) reloaded.push('OLLAMA_MODEL');
    if (this.getOllamaVisionModel() !== prevOllamaVisionModel) reloaded.push('OLLAMA_VISION_MODEL');
    if (this.getImageAttachmentMaxSize() !== prevImageAttachMaxSize) reloaded.push('IMAGE_ATTACHMENT_MAX_SIZE');
    if (this.getImageAttachmentMaxCount() !== prevImageAttachMaxCount) reloaded.push('IMAGE_ATTACHMENT_MAX_COUNT');
    if (this.getOllamaSystemPrompt() !== prevSystemPrompt) reloaded.push('OLLAMA_SYSTEM_PROMPT');
    if (this.getErrorMessage() !== prevErrorMsg) reloaded.push('ERROR_MESSAGE');
    if (this.getErrorRateLimitMinutes() !== prevErrorRate) reloaded.push('ERROR_RATE_LIMIT_MINUTES');
    if (this.getMaxAttachments() !== prevMaxAttach) reloaded.push('MAX_ATTACHMENTS');
    if (this.getDiscordArtifactMaxMessages() !== prevArtifactMaxMessages) reloaded.push('DISCORD_ARTIFACT_MAX_MESSAGES');
    if (this.getDiscordArtifactMaxImages() !== prevArtifactMaxImages) reloaded.push('DISCORD_ARTIFACT_MAX_IMAGES');
    if (this.getAllowBotInteractions() !== prevAllowBotInteractions) reloaded.push('ALLOW_BOT_INTERACTIONS');
    if (this.getReplyChainEnabled() !== prevReplyChainEnabled) reloaded.push('REPLY_CHAIN_ENABLED');
    if (this.getReplyChainMaxDepth() !== prevReplyChainMaxDepth) reloaded.push('REPLY_CHAIN_MAX_DEPTH');
    if (this.getReplyChainMaxTokens() !== prevReplyChainMaxTokens) reloaded.push('REPLY_CHAIN_MAX_TOKENS');
    if (this.getReplyChainImageEnabled() !== prevReplyChainImageEnabled) reloaded.push('REPLY_CHAIN_IMAGE_ENABLED');
    if (this.getDmContextEnabled() !== prevDmContextEnabled) reloaded.push('DM_CONTEXT_ENABLED');
    if (this.getDmContextMaxMessages() !== prevDmContextMaxMessages) reloaded.push('DM_CONTEXT_MAX_MESSAGES');
    if (this.getImageResponseIncludeEmbed() !== prevImageResponseIncludeEmbed) reloaded.push('IMAGE_RESPONSE_INCLUDE_EMBED');
    if (this.getOllamaFinalPassModel() !== prevOllamaFinalPassModel) reloaded.push('OLLAMA_FINAL_PASS_MODEL');
    if (this.getDebugLogging() !== prevDebugLogging) reloaded.push('DEBUG_LOGGING');
    if (this.getNflLoggingLevel() !== prevNflLoggingLevel) reloaded.push('NFL_LOGGING_LEVEL');
    if (this.getNflEndpoint() !== prevNflEndpoint) reloaded.push('NFL_BASE_URL');
    if (this.getNflEnabled() !== prevNflEnabled) reloaded.push('NFL_ENABLED');
    if (this.getMemeEndpoint() !== prevMemeEndpoint) reloaded.push('MEME_BASE_URL');
    if (this.getMemeEnabled() !== prevMemeEnabled) reloaded.push('MEME_ENABLED');
    if (this.getMemeLoggingDebug() !== prevMemeLoggingDebug) reloaded.push('MEME_LOGGING_DEBUG');
    if (this.getSerpApiKey() !== prevSerpApiKey) reloaded.push('SERPAPI_API_KEY');
    if (this.getSerpApiEndpoint() !== prevSerpApiEndpoint) reloaded.push('SERPAPI_ENDPOINT');
    if (this.getSerpApiHl() !== prevSerpApiHl) reloaded.push('SERPAPI_HL');
    if (this.getSerpApiGl() !== prevSerpApiGl) reloaded.push('SERPAPI_GL');
    if (this.getSerpApiLocation() !== prevSerpApiLocation) reloaded.push('SERPAPI_LOCATION');
    if (this.getOllamaFinalPassPrompt() !== prevFinalPassPrompt) reloaded.push('OLLAMA_FINAL_PASS_PROMPT');
    if (this.getAbilityRetryEnabled() !== prevAbilityRetryEnabled) reloaded.push('ABILITY_RETRY_ENABLED');
    if (this.getAbilityRetryMaxRetries() !== prevAbilityRetryMaxRetries) reloaded.push('ABILITY_RETRY_MAX_RETRIES');
    if (this.getAbilityRetryModel() !== prevAbilityRetryModel) reloaded.push('ABILITY_RETRY_MODEL');
    if (this.getAbilityRetryPrompt() !== prevAbilityRetryPrompt) reloaded.push('ABILITY_RETRY_PROMPT');
    if (this.getBotDisplayName() !== prevBotDisplayName) reloaded.push('BOT_DISPLAY_NAME');
    if (this.getOllamaTimeout() !== prevOllamaTimeout) reloaded.push('OLLAMA_TIMEOUT');
    if (this.getOllamaVisionTimeout() !== prevOllamaVisionTimeout) reloaded.push('OLLAMA_VISION_TIMEOUT');
    if (this.getContextEvalTimeout() !== prevContextEvalTimeout) reloaded.push('CONTEXT_EVAL_TIMEOUT');
    if (this.getOllamaToolTimeout() !== prevOllamaToolTimeout) reloaded.push('OLLAMA_TOOL_TIMEOUT');
    if (this.getOllamaFinalPassTimeout() !== prevOllamaFinalPassTimeout) reloaded.push('OLLAMA_FINAL_PASS_TIMEOUT');
    if (this.getAbilityRetryTimeout() !== prevAbilityRetryTimeout) reloaded.push('ABILITY_RETRY_TIMEOUT');
    if (this.getComfyUIDefaultModel() !== prevDefaultModel) reloaded.push('COMFYUI_DEFAULT_MODEL');
    if (this.getComfyUIDefaultWidth() !== prevDefaultWidth) reloaded.push('COMFYUI_DEFAULT_WIDTH');
    if (this.getComfyUIDefaultHeight() !== prevDefaultHeight) reloaded.push('COMFYUI_DEFAULT_HEIGHT');
    if (this.getComfyUIDefaultSteps() !== prevDefaultSteps) reloaded.push('COMFYUI_DEFAULT_STEPS');
    if (this.getComfyUIDefaultCfg() !== prevDefaultCfg) reloaded.push('COMFYUI_DEFAULT_CFG');
    if (this.getComfyUIDefaultSampler() !== prevDefaultSampler) reloaded.push('COMFYUI_DEFAULT_SAMPLER');
    if (this.getComfyUIDefaultScheduler() !== prevDefaultScheduler) reloaded.push('COMFYUI_DEFAULT_SCHEDULER');
    if (this.getComfyUIDefaultDenoise() !== prevDefaultDenoise) reloaded.push('COMFYUI_DEFAULT_DENOISE');
    if (this.getComfyUIDefaultSeed() !== prevDefaultSeed) reloaded.push('COMFYUI_DEFAULT_SEED');
    if (this.getComfyUIDefaultNegativePrompt() !== prevDefaultNegativePrompt) reloaded.push('COMFYUI_DEFAULT_NEGATIVE_PROMPT');
    if (this.getComfyUIDefaultVae() !== prevDefaultVae) reloaded.push('COMFYUI_DEFAULT_VAE');
    if (this.getComfyUIDefaultClip() !== prevDefaultClip) reloaded.push('COMFYUI_DEFAULT_CLIP');
    if (this.getComfyUIDefaultClip2() !== prevDefaultClip2) reloaded.push('COMFYUI_DEFAULT_CLIP2');
    if (this.getComfyUIDefaultClipType() !== prevDefaultClipType) reloaded.push('COMFYUI_DEFAULT_CLIP_TYPE');
    if (this.getMaxToolCalls() !== prevMaxToolCalls) reloaded.push('MAX_TOOL_CALLS');
    if (this.getComfyUIDefaultDiffuser() !== prevDefaultDiffuser) reloaded.push('COMFYUI_DEFAULT_DIFFUSER');
    if (this.getOllamaFixupEnabled() !== prevFixupEnabled) reloaded.push('OLLAMA_FIXUP_ENABLED');
    if (this.getOllamaFixupExtractXmlTools() !== prevFixupExtractXml) reloaded.push('OLLAMA_FIXUP_EXTRACT_XML_TOOLS');
    if (this.getOllamaFixupExtractJsonTools() !== prevFixupExtractJson) reloaded.push('OLLAMA_FIXUP_EXTRACT_JSON_TOOLS');
    if (this.getOllamaFixupRepairUrls() !== prevFixupRepairUrls) reloaded.push('OLLAMA_FIXUP_REPAIR_URLS');
    if (this.getOllamaFixupStripToolPreamble() !== prevFixupStripPreamble) reloaded.push('OLLAMA_FIXUP_STRIP_TOOL_PREAMBLE');
    if (this.getXaiEndpoint() !== prevXaiEndpoint) reloaded.push('XAI_BASE_URL');
    if (this.getXaiApiKey() !== prevXaiApiKey) reloaded.push('XAI_API_KEY');
    if (this.getXaiModel() !== prevXaiModel) reloaded.push('XAI_MODEL');
    if (this.getXaiImageEnabled() !== prevXaiImageEnabled) reloaded.push('XAI_IMAGE_ENABLED');
    if (this.getXaiVideoEnabled() !== prevXaiVideoEnabled) reloaded.push('XAI_VIDEO_ENABLED');
    if (this.getXaiEncourageBuiltinTools() !== prevXaiEncourageBuiltinTools) reloaded.push('XAI_ENCOURAGE_BUILTIN_TOOLS');
    if (this.getXaiTimeout() !== prevXaiTimeout) reloaded.push('XAI_TIMEOUT');
    if (this.getXaiImageModel() !== prevXaiImageModel) reloaded.push('XAI_IMAGE_MODEL');
    if (this.getXaiVideoModel() !== prevXaiVideoModel) reloaded.push('XAI_VIDEO_MODEL');
    if (this.getXaiDebugLogging() !== prevXaiDebugLogging) reloaded.push('XAI_DEBUG_LOGGING');
    if (this.getXaiToolModel() !== prevXaiToolModel) reloaded.push('XAI_TOOL_MODEL');
    if (this.getXaiContextEvalModel() !== prevXaiContextEvalModel) reloaded.push('XAI_CONTEXT_EVAL_MODEL');
    if (this.getXaiFinalPassModel() !== prevXaiFinalPassModel) reloaded.push('XAI_FINAL_PASS_MODEL');
    if (this.getXaiToolTimeout() !== prevXaiToolTimeout) reloaded.push('XAI_TOOL_TIMEOUT');
    if (this.getXaiContextEvalTimeout() !== prevXaiContextEvalTimeout) reloaded.push('XAI_CONTEXT_EVAL_TIMEOUT');
    if (this.getXaiFinalPassTimeout() !== prevXaiFinalPassTimeout) reloaded.push('XAI_FINAL_PASS_TIMEOUT');
    if (this.getProviderToolEval() !== prevProviderToolEval) reloaded.push('PROVIDER_TOOL_EVAL');
    if (this.getProviderFinalPass() !== prevProviderFinalPass) reloaded.push('PROVIDER_FINAL_PASS');
    if (this.getProviderContextEval() !== prevProviderContextEval) reloaded.push('PROVIDER_CONTEXT_EVAL');
    if (this.getProviderRetry() !== prevProviderRetry) reloaded.push('PROVIDER_RETRY');
    if (this.getImageGenerationBackend() !== prevImageGenerationBackend) reloaded.push('IMAGE_GENERATION_BACKEND');
    if (this.getWebSearchBackend() !== prevWebSearchBackend) reloaded.push('WEB_SEARCH_BACKEND');

    // Reload tools
    this.loadTools();
    reloaded.push('tools');

    return { reloaded, requiresRestart };
  }

  /** Port captured at construction time — changes require restart */
  private port = this.parseIntEnv('HTTP_PORT', 3000);
  /** Outputs port captured at construction time — changes require restart */
  private outputsPort = this.parseIntEnv('OUTPUTS_PORT', 3003);
  /** HTTP bind host captured at construction time — changes require restart */
  private httpHost = (process.env.HTTP_HOST || '').trim() || '127.0.0.1';
  /** Outputs bind host captured at construction time — changes require restart */
  private outputsHostBound = this.getOutputsHost();
  /** Outputs trust-proxy mode captured at construction time — changes require restart */
  private outputsTrustProxyBound = this.getOutputsTrustProxy();

  /**
   * Get a safe view of config for the configurator UI.
   * Never exposes Discord token or API keys.
   */
  getPublicConfig(): PublicConfig {
    return {
      discord: {
        clientId: process.env.DISCORD_CLIENT_ID || '',
        tokenConfigured: !!process.env.DISCORD_TOKEN,
        botDisplayName: this.getBotDisplayName(),
      },
      discordTools: {
        artifactMaxMessages: this.getDiscordArtifactMaxMessages(),
        artifactMaxImages: this.getDiscordArtifactMaxImages(),
      },
      apis: {
        comfyui: this.getComfyUIEndpoint(),
        ollama: this.getOllamaEndpoint(),
        ollamaModel: this.getOllamaModel(),
        ollamaVisionModel: this.getOllamaVisionModel(),
        ollamaFinalPassModel: this.getOllamaFinalPassModel(),
        ollamaSystemPrompt: this.getOllamaSystemPrompt(),
        ollamaFinalPassPrompt: this.getOllamaFinalPassPrompt(),
        ollamaToolPrompt: this.getOllamaToolPrompt(),
        ollamaToolContextSize: this.getOllamaToolContextSize(),
        ollamaFinalPassContextSize: this.getOllamaFinalPassContextSize(),
        ollamaTimeout: this.getOllamaTimeout(),
        ollamaVisionTimeout: this.getOllamaVisionTimeout(),
        ollamaToolTimeout: this.getOllamaToolTimeout(),
        ollamaFinalPassTimeout: this.getOllamaFinalPassTimeout(),
        ollamaThrakenUrl: this.getOllamaThrakenUrl(),
        comfyuiWorkflowConfigured: this.hasComfyUIWorkflow(),
        accuweather: this.getAccuWeatherEndpoint(),
        accuweatherDefaultLocation: this.getAccuWeatherDefaultLocation(),
        accuweatherApiKeyConfigured: !!this.getAccuWeatherApiKey(),
        accuweatherDefaultWeatherType: this.getAccuWeatherDefaultWeatherType(),
        nfl: this.getNflEndpoint(),
        nflEnabled: this.getNflEnabled(),
        memeEnabled: this.getMemeEnabled(),
        serpapi: this.getSerpApiEndpoint(),
        serpapiApiKeyConfigured: !!this.getSerpApiKey(),
        serpapiHl: this.getSerpApiHl(),
        serpapiGl: this.getSerpApiGl(),
        serpapiLocation: this.getSerpApiLocation(),
      },
      webFetch: {
        enabled: this.getWebFetchEnabled(),
        robotsTxtMode: this.getWebFetchRobotsTxtMode(),
        timeout: this.getWebFetchTimeout(),
        maxContentChars: this.getWebFetchMaxContentChars(),
        maxRedirects: this.getWebFetchMaxRedirects(),
        userAgent: this.getWebFetchUserAgent(),
        maxTextSize: this.getWebFetchMaxTextSize(),
        maxImageSize: this.getWebFetchMaxImageSize(),
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
        seed: this.getComfyUIDefaultSeed(),
        negativePrompt: this.getComfyUIDefaultNegativePrompt(),
        vae: this.getComfyUIDefaultVae(),
        clip: this.getComfyUIDefaultClip(),
        clip2: this.getComfyUIDefaultClip2(),
        clipType: this.getComfyUIDefaultClipType(),
        diffuser: this.getComfyUIDefaultDiffuser(),
      },
      errorHandling: {
        errorMessage: this.getErrorMessage(),
        errorRateLimitMinutes: this.getErrorRateLimitMinutes(),
      },
      http: {
        port: this.getHttpPort(),
        httpHost: this.getHttpHost(),
        outputsPort: this.getOutputsPort(),
        outputsHost: this.getOutputsHost(),
        outputsTrustProxy: String(this.getOutputsTrustProxy()),
        outputBaseUrl: this.getOutputBaseUrl(),
        activityKeyTtl: this.getActivityKeyTtl(),
        outputsRateLimitWindowMs: this.getOutputsRateLimitWindowMs(),
        outputsRateLimitMax: this.getOutputsRateLimitMax(),
      },
      limits: {
        fileSizeThreshold: this.getFileSizeThreshold(),
        defaultTimeout: this.getDefaultTimeout(),
        maxAttachments: this.getMaxAttachments(),
        imageAttachmentMaxSize: this.getImageAttachmentMaxSize(),
        imageAttachmentMaxCount: this.getImageAttachmentMaxCount(),
        maxToolCalls: this.getMaxToolCalls(),
      },
      tools: this.getTools(),
      toolsLoadError: this.toolsLoadError,
      defaultTools: this.getDefaultTools(),
      allowBotInteractions: this.getAllowBotInteractions(),
      replyChain: {
        enabled: this.getReplyChainEnabled(),
        maxDepth: this.getReplyChainMaxDepth(),
        maxTokens: this.getReplyChainMaxTokens(),
        imageEnabled: this.getReplyChainImageEnabled(),
      },
      contextEval: {
        enabled: this.getContextEvalEnabled(),
        model: this.getContextEvalModel(),
        contextSize: this.getContextEvalContextSize(),
        timeout: this.getContextEvalTimeout(),
        prompt: this.getContextEvalPrompt(),
      },
      dmContext: {
        enabled: this.getDmContextEnabled(),
        maxMessages: this.getDmContextMaxMessages(),
      },
      debugLogging: this.getDebugLogging(),
      nflLogging: {
        level: this.getNflLoggingLevel(),
      },
      memeLogging: {
        debug: this.getMemeLoggingDebug(),
      },
      abilityRetry: {
        enabled: this.getAbilityRetryEnabled(),
        maxRetries: this.getAbilityRetryMaxRetries(),
        model: this.getAbilityRetryModel(),
        prompt: this.getAbilityRetryPrompt(),
        timeout: this.getAbilityRetryTimeout(),
      },
      imageResponse: {
        includeEmbed: this.getImageResponseIncludeEmbed(),
      },
      configuratorTheme: this.getConfiguratorTheme(),
      pipelineMode: this.getPipelineMode(),
      ollamaFixup: {
        enabled: this.getOllamaFixupEnabled(),
        extractXmlTools: this.getOllamaFixupExtractXmlTools(),
        extractJsonTools: this.getOllamaFixupExtractJsonTools(),
        repairUrls: this.getOllamaFixupRepairUrls(),
        stripToolPreamble: this.getOllamaFixupStripToolPreamble(),
      },
      xai: {
        endpoint: this.getXaiEndpoint(),
        apiKeyConfigured: !!this.getXaiApiKey(),
        model: this.getXaiModel(),
        toolModel: this.getXaiToolModel(),
        contextEvalModel: this.getXaiContextEvalModel(),
        finalPassModel: this.getXaiFinalPassModel(),
        imageModel: this.getXaiImageModel(),
        videoModel: this.getXaiVideoModel(),
        timeout: Math.round(this.getXaiTimeout() / 1000),
        toolTimeout: Math.round(this.getXaiToolTimeout() / 1000),
        contextEvalTimeout: Math.round(this.getXaiContextEvalTimeout() / 1000),
        finalPassTimeout: Math.round(this.getXaiFinalPassTimeout() / 1000),
        imageEnabled: this.getXaiImageEnabled(),
        videoEnabled: this.getXaiVideoEnabled(),
        encourageBuiltinTools: this.getXaiEncourageBuiltinTools(),
        debugLogging: this.getXaiDebugLogging(),
        thrakenUrl: this.getXaiThrakenUrl(),
      },
      provider: {
        toolEval: this.getProviderToolEval(),
        finalPass: this.getProviderFinalPass(),
        contextEval: this.getProviderContextEval(),
        retry: this.getProviderRetry(),
      },
      backends: {
        webSearch: this.getWebSearchBackend(),
      },
    };
  }
}

export const config = new Config();
