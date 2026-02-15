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

/** Structured guidance for how a keyword's inputs are inferred and validated. */
export interface AbilityInputs {
  /** How inputs are provided: 'implicit' (inferred from context), 'explicit' (user must provide), 'mixed' (some inferred, some required). */
  mode: 'implicit' | 'explicit' | 'mixed';
  /** Required input descriptions (e.g., "location", "query"). */
  required?: string[];
  /** Optional input descriptions. */
  optional?: string[];
  /** Allowed inference sources (e.g., "reply_target", "current_message", "recent_user_message"). */
  inferFrom?: string[];
  /** Plain-language validation constraints (e.g., "date must be YYYY-MM-DD or YYYYMMDD"). */
  validation?: string;
  /** 1–2 short usage examples. */
  examples?: string[];
}

export interface KeywordConfig {
  keyword: string;
  api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi';
  timeout: number;
  description: string;
  /** Human-readable description of this keyword's API ability, provided to Ollama as context so it can suggest using this API when relevant. */
  abilityText?: string;
  /** Model-facing: when to use this ability (e.g., "User wants an image generated"). */
  abilityWhen?: string;
  /** Model-facing: structured input inference/validation guidance. */
  abilityInputs?: AbilityInputs;
  /** When true, pass the API result back through Ollama for conversational refinement. */
  finalOllamaPass?: boolean;
  /** When true, this keyword can be invoked with no additional user content (e.g. 'nfl scores' alone). */
  allowEmptyContent?: boolean;
  /** AccuWeather data mode: which data to fetch. Only used when api is 'accuweather'. */
  accuweatherMode?: 'current' | 'forecast' | 'full';
  /** Whether this keyword is currently enabled. Defaults to true when omitted. */
  enabled?: boolean;
  /** Optional per-keyword retry override (global defaults exist). */
  retry?: {
    /** When set, overrides the global ABILITY_RETRY_ENABLED for this keyword. */
    enabled?: boolean;
    /** When set, overrides global ABILITY_RETRY_MAX_RETRIES for this keyword. */
    maxRetries?: number;
    /** Optional per-keyword model override (defaults to global retry model, then default Ollama model). */
    model?: string;
    /** Optional per-keyword prompt override (defaults to global retry prompt). */
    prompt?: string;
  };
  /** Whether this keyword is a built-in that cannot be edited or deleted — only toggled on/off. */
  builtin?: boolean;
  /**
   * @deprecated Context evaluation is always active. This field is accepted
   * for backward compatibility but ignored at runtime. Remove from new configs.
   */
  contextFilterEnabled?: boolean;
  /** Minimum number of most-recent context messages to always include (depth counted from newest). Must be >= 1. Defaults to 1. */
  contextFilterMinDepth?: number;
  /** Maximum number of context messages eligible for inclusion (depth counted from newest). Defaults to global reply-chain max depth. */
  contextFilterMaxDepth?: number;
}

export interface ConfigData {
  keywords: KeywordConfig[];
}

class Config {
  private keywords: KeywordConfig[] = [];

  constructor() {
    this.loadKeywords();
  }

  private getKeywordsPath(): string {
    const envPath = process.env.KEYWORDS_CONFIG_PATH;
    if (envPath) {
      return path.resolve(path.join(__dirname, '../..'), envPath);
    }
    return path.join(__dirname, '../../config/keywords.json');
  }

  private getDefaultKeywordsPath(): string {
    return path.join(__dirname, '../../config/keywords.default.json');
  }

  /**
   * If the runtime keywords.json does not exist and KEYWORDS_CONFIG_PATH is
   * not set, copy from the tracked keywords.default.json template — mirroring
   * the .env.example → .env pattern so the runtime file can be gitignored.
   */
  private ensureKeywordsFile(): void {
    // Skip when user specified a custom path via env.
    if (process.env.KEYWORDS_CONFIG_PATH) return;

    const runtimePath = this.getKeywordsPath();
    if (fs.existsSync(runtimePath)) return;

    const defaultPath = this.getDefaultKeywordsPath();
    if (fs.existsSync(defaultPath)) {
      fs.copyFileSync(defaultPath, runtimePath);
      logger.log('success', 'config', `Created runtime ${path.basename(runtimePath)} from ${path.basename(defaultPath)}`);
    } else {
      logger.logWarn('config', `No keywords config found — neither ${runtimePath} nor ${defaultPath} exist`);
    }
  }

  private loadKeywords(): void {
    this.ensureKeywordsFile();
    const keywordsPath = this.getKeywordsPath();
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
        if (entry.api !== 'comfyui' && entry.api !== 'ollama' && entry.api !== 'accuweather' && entry.api !== 'nfl' && entry.api !== 'serpapi') {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid api "${entry.api}" — must be "comfyui", "ollama", "accuweather", "nfl", or "serpapi"`);
        }
        if (typeof entry.timeout !== 'number' || entry.timeout <= 0) {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid timeout — must be a positive number`);
        }
        if (entry.abilityText !== undefined && typeof entry.abilityText !== 'string') {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid abilityText — must be a string`);
        }
        if (entry.abilityWhen !== undefined && typeof entry.abilityWhen !== 'string') {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid abilityWhen — must be a string`);
        }
        if (entry.abilityInputs !== undefined) {
          const ai = entry.abilityInputs;
          if (typeof ai !== 'object' || ai === null || Array.isArray(ai)) {
            throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid abilityInputs — must be an object`);
          }
          const validModes = ['implicit', 'explicit', 'mixed'];
          if (!validModes.includes(ai.mode)) {
            throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid abilityInputs.mode "${ai.mode}" — must be "implicit", "explicit", or "mixed"`);
          }
          if (ai.required !== undefined && (!Array.isArray(ai.required) || !ai.required.every((s: unknown) => typeof s === 'string'))) {
            throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid abilityInputs.required — must be an array of strings`);
          }
          if (ai.optional !== undefined && (!Array.isArray(ai.optional) || !ai.optional.every((s: unknown) => typeof s === 'string'))) {
            throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid abilityInputs.optional — must be an array of strings`);
          }
          if (ai.inferFrom !== undefined && (!Array.isArray(ai.inferFrom) || !ai.inferFrom.every((s: unknown) => typeof s === 'string'))) {
            throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid abilityInputs.inferFrom — must be an array of strings`);
          }
          if (ai.validation !== undefined && typeof ai.validation !== 'string') {
            throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid abilityInputs.validation — must be a string`);
          }
          if (ai.examples !== undefined && (!Array.isArray(ai.examples) || !ai.examples.every((s: unknown) => typeof s === 'string'))) {
            throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid abilityInputs.examples — must be an array of strings`);
          }
        }
        if (entry.finalOllamaPass !== undefined && typeof entry.finalOllamaPass !== 'boolean') {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid finalOllamaPass — must be a boolean`);
        }
        if (entry.allowEmptyContent !== undefined && typeof entry.allowEmptyContent !== 'boolean') {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid allowEmptyContent — must be a boolean`);
        }
        if (entry.accuweatherMode !== undefined && entry.accuweatherMode !== 'current' && entry.accuweatherMode !== 'forecast' && entry.accuweatherMode !== 'full') {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid accuweatherMode "${entry.accuweatherMode}" — must be "current", "forecast", or "full"`);
        }
        if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid enabled — must be a boolean`);
        }
        if (entry.retry !== undefined) {
          const r = entry.retry;
          if (typeof r !== 'object' || r === null || Array.isArray(r)) {
            throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid retry — must be an object`);
          }
          if (r.enabled !== undefined && typeof r.enabled !== 'boolean') {
            throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid retry.enabled — must be a boolean`);
          }
          if (r.maxRetries !== undefined) {
            if (typeof r.maxRetries !== 'number' || !Number.isInteger(r.maxRetries) || r.maxRetries < 0 || r.maxRetries > 10) {
              throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid retry.maxRetries — must be an integer between 0 and 10`);
            }
          }
          if (r.model !== undefined && typeof r.model !== 'string') {
            throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid retry.model — must be a string`);
          }
          if (r.prompt !== undefined && typeof r.prompt !== 'string') {
            throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid retry.prompt — must be a string`);
          }
        }
        if (entry.builtin !== undefined && typeof entry.builtin !== 'boolean') {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid builtin — must be a boolean`);
        }
        if (entry.contextFilterEnabled !== undefined && typeof entry.contextFilterEnabled !== 'boolean') {
          throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid contextFilterEnabled — must be a boolean`);
        }
        if (entry.contextFilterMinDepth !== undefined) {
          if (typeof entry.contextFilterMinDepth !== 'number' || entry.contextFilterMinDepth < 1 || !Number.isInteger(entry.contextFilterMinDepth)) {
            throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid contextFilterMinDepth — must be a positive integer (>= 1)`);
          }
        }
        if (entry.contextFilterMaxDepth !== undefined) {
          if (typeof entry.contextFilterMaxDepth !== 'number' || !Number.isInteger(entry.contextFilterMaxDepth)) {
            throw new Error(`keywords.json: keyword "${entry.keyword}" has invalid contextFilterMaxDepth — must be an integer`);
          }
          if (entry.contextFilterMaxDepth < 1) {
            logger.logWarn('config', `keyword "${entry.keyword}": contextFilterMaxDepth=${entry.contextFilterMaxDepth} is invalid (≥ 1 required) — treating as unset (global default will be used)`);
            delete entry.contextFilterMaxDepth;
          }
        }
        if (entry.contextFilterMinDepth !== undefined && entry.contextFilterMaxDepth !== undefined) {
          if (entry.contextFilterMinDepth > entry.contextFilterMaxDepth) {
            throw new Error(`keywords.json: keyword "${entry.keyword}" has contextFilterMinDepth (${entry.contextFilterMinDepth}) greater than contextFilterMaxDepth (${entry.contextFilterMaxDepth})`);
          }
        }
      }

      // Enforce: custom "help" keyword is only allowed when the built-in help keyword is disabled
      const builtinHelp = config.keywords.find(k => k.builtin && k.keyword.toLowerCase() === 'help');
      const builtinHelpEnabled = builtinHelp ? builtinHelp.enabled !== false : false;
      if (builtinHelpEnabled) {
        const customHelp = config.keywords.find(k => !k.builtin && k.keyword.toLowerCase() === 'help');
        if (customHelp) {
          logger.logWarn('config', 'Ignoring custom "help" keyword because the built-in help keyword is enabled');
          config.keywords = config.keywords.filter(k => k !== customHelp);
        }
      }

      this.keywords = config.keywords;
      logger.log('success', 'config', `Loaded ${this.keywords.length} keywords from config`);

      // Merge any built-in keywords from the default template that are missing
      // from the runtime config.  This ensures newly added built-in keywords
      // (e.g. activity_key) are available even if keywords.json predates them.
      this.mergeDefaultBuiltins();
    } catch (error) {
      logger.logError('config', `Failed to load keywords config (${keywordsPath}): ${error}`);
      this.keywords = [];
    }
  }

  getKeywords(): KeywordConfig[] {
    return this.keywords;
  }

  /**
   * Return the keyword array from keywords.default.json.
   * Used by the configurator to offer a "sync missing" action.
   */
  getDefaultKeywords(): KeywordConfig[] {
    const defaultPath = this.getDefaultKeywordsPath();
    try {
      const data = fs.readFileSync(defaultPath, 'utf-8');
      const parsed = JSON.parse(data);
      return Array.isArray(parsed.keywords) ? parsed.keywords : [];
    } catch {
      return [];
    }
  }

  /**
   * Ensure every built-in keyword from the default template is present
   * in the runtime keyword list.  Missing built-ins are appended so
   * features like `activity_key` work even if the user's keywords.json
   * was created before that keyword existed.
   */
  private mergeDefaultBuiltins(): void {
    const defaults = this.getDefaultKeywords();
    const builtins = defaults.filter(d => d.builtin);
    const existingKeys = new Set(this.keywords.map(k => k.keyword.toLowerCase()));
    let added = 0;
    for (const b of builtins) {
      if (!existingKeys.has(b.keyword.toLowerCase())) {
        this.keywords.push(b);
        existingKeys.add(b.keyword.toLowerCase());
        added++;
        logger.log('success', 'config',
          `Merged missing built-in keyword "${b.keyword}" from defaults`);
      } else {
        // Backfill missing fields on existing built-in keywords from
        // defaults so that new fields (e.g. allowEmptyContent added to
        // "help") take effect even if the user's keywords.json predates
        // the change.
        const existing = this.keywords.find(
          k => k.keyword.toLowerCase() === b.keyword.toLowerCase() && k.builtin
        );
        if (existing) {
          let patched = false;
          if (existing.allowEmptyContent === undefined && b.allowEmptyContent !== undefined) {
            existing.allowEmptyContent = b.allowEmptyContent;
            patched = true;
          }
          if (patched) {
            logger.log('success', 'config',
              `Backfilled missing fields on built-in keyword "${b.keyword}" from defaults`);
          }
        }
      }
    }
    if (added > 0) {
      logger.log('success', 'config',
        `Merged ${added} missing built-in keyword(s) from defaults — total: ${this.keywords.length}`);
    }
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

  // ── NFL / ESPN configuration ─────────────────────────────

  getNflEndpoint(): string {
    return process.env.NFL_BASE_URL || 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
  }

  getNflEnabled(): boolean {
    return process.env.NFL_ENABLED !== 'false';
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
    return process.env.OUTPUT_BASE_URL || 'http://localhost:3003';
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
   * Ollama model used for the final refinement pass on API results.
   * Falls back to the default OLLAMA_MODEL if not set.
   */
  getOllamaFinalPassModel(): string {
    return process.env.OLLAMA_FINAL_PASS_MODEL || this.getOllamaModel();
  }

  /**
   * Instruction appended to the system content for every final Ollama pass.
   * Configurable via the configurator UI. Clear to disable.
   */
  getOllamaFinalPassPrompt(): string {
    const val = process.env.OLLAMA_FINAL_PASS_PROMPT;
    if (val === undefined) {
      return 'Keeping in character, review the incoming data and provide an opinionated response.';
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
   * Whether detailed ability logging is explicitly configured via env.
   * Does NOT account for DEBUG_LOGGING override.
   * Used by PublicConfig/configurator so the UI reflects the raw env value.
   */
  getAbilityLoggingConfigured(): boolean {
    return process.env.ABILITY_LOGGING_DETAILED === 'true';
  }

  /**
   * Whether detailed ability logging is effectively enabled.
   * True when either ABILITY_LOGGING_DETAILED or DEBUG_LOGGING is on.
   * Use this when deciding whether to log abilities content at runtime.
   */
  getAbilityLoggingDetailed(): boolean {
    return this.getAbilityLoggingConfigured() || this.getDebugLogging();
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

  getApiEndpoint(api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi'): string {
    if (api === 'comfyui') return this.getComfyUIEndpoint();
    if (api === 'accuweather') return this.getAccuWeatherEndpoint();
    if (api === 'nfl') return this.getNflEndpoint();
    if (api === 'serpapi') return this.getSerpApiEndpoint();
    return this.getOllamaEndpoint();
  }

  /**
   * Reload hot-reloadable config from .env and keywords.json (runtime copy).
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
    const prevOutputsPort = this.outputsPort;
    const prevHttpHost = this.httpHost;
    const prevOutputsHost = this.outputsHostBound;
    const prevOutputsTrustProxy = this.outputsTrustProxyBound;
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
    const prevAllowBotInteractions = this.getAllowBotInteractions();
    const prevReplyChainEnabled = this.getReplyChainEnabled();
    const prevReplyChainMaxDepth = this.getReplyChainMaxDepth();
    const prevReplyChainMaxTokens = this.getReplyChainMaxTokens();
    const prevImageResponseIncludeEmbed = this.getImageResponseIncludeEmbed();
    const prevOllamaFinalPassModel = this.getOllamaFinalPassModel();
    const prevDebugLogging = this.getDebugLogging();
    const prevAbilityLogging = this.getAbilityLoggingConfigured();
    const prevNflLoggingLevel = this.getNflLoggingLevel();
    const prevNflEndpoint = this.getNflEndpoint();
    const prevNflEnabled = this.getNflEnabled();
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
    if (this.getOutputBaseUrl() !== prevBaseUrl) reloaded.push('OUTPUT_BASE_URL');
    if (this.getFileSizeThreshold() !== prevThreshold) reloaded.push('FILE_SIZE_THRESHOLD');
    if (this.getDefaultTimeout() !== prevTimeout) reloaded.push('DEFAULT_TIMEOUT');
    if (this.getOllamaModel() !== prevOllamaModel) reloaded.push('OLLAMA_MODEL');
    if (this.getOllamaSystemPrompt() !== prevSystemPrompt) reloaded.push('OLLAMA_SYSTEM_PROMPT');
    if (this.getErrorMessage() !== prevErrorMsg) reloaded.push('ERROR_MESSAGE');
    if (this.getErrorRateLimitMinutes() !== prevErrorRate) reloaded.push('ERROR_RATE_LIMIT_MINUTES');
    if (this.getMaxAttachments() !== prevMaxAttach) reloaded.push('MAX_ATTACHMENTS');
    if (this.getAllowBotInteractions() !== prevAllowBotInteractions) reloaded.push('ALLOW_BOT_INTERACTIONS');
    if (this.getReplyChainEnabled() !== prevReplyChainEnabled) reloaded.push('REPLY_CHAIN_ENABLED');
    if (this.getReplyChainMaxDepth() !== prevReplyChainMaxDepth) reloaded.push('REPLY_CHAIN_MAX_DEPTH');
    if (this.getReplyChainMaxTokens() !== prevReplyChainMaxTokens) reloaded.push('REPLY_CHAIN_MAX_TOKENS');
    if (this.getImageResponseIncludeEmbed() !== prevImageResponseIncludeEmbed) reloaded.push('IMAGE_RESPONSE_INCLUDE_EMBED');
    if (this.getOllamaFinalPassModel() !== prevOllamaFinalPassModel) reloaded.push('OLLAMA_FINAL_PASS_MODEL');
    if (this.getDebugLogging() !== prevDebugLogging) reloaded.push('DEBUG_LOGGING');
    if (this.getAbilityLoggingConfigured() !== prevAbilityLogging) reloaded.push('ABILITY_LOGGING_DETAILED');
    if (this.getNflLoggingLevel() !== prevNflLoggingLevel) reloaded.push('NFL_LOGGING_LEVEL');
    if (this.getNflEndpoint() !== prevNflEndpoint) reloaded.push('NFL_BASE_URL');
    if (this.getNflEnabled() !== prevNflEnabled) reloaded.push('NFL_ENABLED');
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
      },
      apis: {
        comfyui: this.getComfyUIEndpoint(),
        ollama: this.getOllamaEndpoint(),
        ollamaModel: this.getOllamaModel(),
        ollamaFinalPassModel: this.getOllamaFinalPassModel(),
        ollamaSystemPrompt: this.getOllamaSystemPrompt(),
        ollamaFinalPassPrompt: this.getOllamaFinalPassPrompt(),
        comfyuiWorkflowConfigured: this.hasComfyUIWorkflow(),
        accuweather: this.getAccuWeatherEndpoint(),
        accuweatherDefaultLocation: this.getAccuWeatherDefaultLocation(),
        accuweatherApiKeyConfigured: !!this.getAccuWeatherApiKey(),
        nfl: this.getNflEndpoint(),
        nflEnabled: this.getNflEnabled(),
        serpapi: this.getSerpApiEndpoint(),
        serpapiApiKeyConfigured: !!this.getSerpApiKey(),
        serpapiHl: this.getSerpApiHl(),
        serpapiGl: this.getSerpApiGl(),
        serpapiLocation: this.getSerpApiLocation(),
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
      },
      keywords: this.getKeywords(),
      defaultKeywords: this.getDefaultKeywords(),
      allowBotInteractions: this.getAllowBotInteractions(),
      replyChain: {
        enabled: this.getReplyChainEnabled(),
        maxDepth: this.getReplyChainMaxDepth(),
        maxTokens: this.getReplyChainMaxTokens(),
      },
      debugLogging: this.getDebugLogging(),
      abilityLogging: {
        detailed: this.getAbilityLoggingConfigured(),
      },
      nflLogging: {
        level: this.getNflLoggingLevel(),
      },
      abilityRetry: {
        enabled: this.getAbilityRetryEnabled(),
        maxRetries: this.getAbilityRetryMaxRetries(),
        model: this.getAbilityRetryModel(),
        prompt: this.getAbilityRetryPrompt(),
      },
      imageResponse: {
        includeEmbed: this.getImageResponseIncludeEmbed(),
      },
    };
  }
}

export const config = new Config();
