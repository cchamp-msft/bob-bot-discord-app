/** A single message in a conversation chain for Ollama chat context. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /**
   * Base64-encoded images attached to this message.
   * Used by vision-capable Ollama models via the `/api/chat` `images` field.
   */
  images?: string[];
  /** How this message was sourced. */
  contextSource?: 'reply' | 'channel' | 'thread' | 'dm' | 'dm_private' | 'trigger';
  /** Discord message snowflake — used for deduplication when merging contexts. */
  discordMessageId?: string;
  /** Message creation timestamp (ms) — used for stable chronological merge. */
  createdAtMs?: number;
  /**
   * Whether this message's content was explicitly prepended with a
   * `"displayName: "` prefix by the handler. When true, `parseSpeakerPrefix`
   * is allowed to extract the speaker name; when false/undefined, the
   * content is treated as unprefixed to avoid false-positive parsing
   * (e.g. "Summary: here's what happened" being split on the colon).
   */
  hasNamePrefix?: boolean;
}

/** Recognized API backend identifiers. */
export type ApiType = 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi' | 'meme' | 'discord' | 'xai' | 'xai-image' | 'xai-video' | 'webfetch';

/** LLM provider identifiers used for per-stage model dispatch. */
export type LlmProvider = 'ollama' | 'xai';

/**
 * Model-inferred intent for whether a final synthesis pass is needed.
 *
 * - `'synthesize'` — The user wants an opinionated, interpreted, or
 *   conversationally refined answer. A final Ollama/xAI pass is run to
 *   inject personality, formatting, and cross-tool synthesis.
 * - `'raw'` — The user wants the data as-is (formatted but not
 *   editorially rewritten). The final pass is skipped and the tool
 *   result (or Stage 1 draft) is returned directly.
 * - `'auto'` — No strong signal was detected; fall back to the
 *   existing pipeline default (final pass runs when tool results exist
 *   or a separate final-pass model is configured).
 */
export type FinalPassIntent = 'synthesize' | 'raw' | 'auto';

// ── Discord action response types ───────────────────────────────

/** Standard response from Discord action tool methods. */
export interface DiscordActionResponse {
  success: boolean;
  data?: { text: string };
  error?: string;
}

// ── AccuWeather response types ─────────────────────────────────

/** AccuWeather location object returned by city/postal code search. */
export interface AccuWeatherLocation {
  Key: string;
  LocalizedName: string;
  Country: { ID: string; LocalizedName: string };
  AdministrativeArea: { ID: string; LocalizedName: string };
}

/** AccuWeather current conditions (trimmed to useful fields). */
export interface AccuWeatherCurrentConditions {
  LocalObservationDateTime: string;
  WeatherText: string;
  WeatherIcon: number;
  HasPrecipitation: boolean;
  PrecipitationType: string | null;
  IsDayTime: boolean;
  Temperature: {
    Metric: { Value: number; Unit: string };
    Imperial: { Value: number; Unit: string };
  };
  RealFeelTemperature: {
    Metric: { Value: number; Unit: string };
    Imperial: { Value: number; Unit: string };
  };
  RelativeHumidity: number;
  Wind: {
    Direction: { Degrees: number; Localized: string };
    Speed: { Metric: { Value: number; Unit: string }; Imperial: { Value: number; Unit: string } };
  };
  UVIndex: number;
  UVIndexText: string;
  Visibility: {
    Metric: { Value: number; Unit: string };
    Imperial: { Value: number; Unit: string };
  };
  CloudCover: number;
  Link: string;
}

/** Single day in AccuWeather 10-day forecast. */
export interface AccuWeatherDailyForecast {
  Date: string;
  Temperature: {
    Minimum: { Value: number; Unit: string };
    Maximum: { Value: number; Unit: string };
  };
  Day: { Icon: number; IconPhrase: string; HasPrecipitation: boolean; PrecipitationType?: string; PrecipitationIntensity?: string };
  Night: { Icon: number; IconPhrase: string; HasPrecipitation: boolean; PrecipitationType?: string; PrecipitationIntensity?: string };
}

/** AccuWeather 10-day forecast response. */
export interface AccuWeatherForecastResponse {
  Headline: { Text: string; Category: string };
  DailyForecasts: AccuWeatherDailyForecast[];
}

/** Standard response from AccuWeatherClient methods. */
export interface AccuWeatherResponse {
  success: boolean;
  data?: {
    text: string;
    location?: AccuWeatherLocation;
    current?: AccuWeatherCurrentConditions;
    forecast?: AccuWeatherForecastResponse;
  };
  error?: string;
  /** Structured error code for programmatic retry gating. */
  errorCode?: string;
}

/** Result of an AccuWeather health/connection test. */
export interface AccuWeatherHealthResult {
  healthy: boolean;
  error?: string;
  location?: AccuWeatherLocation;
}

// ── ESPN API response types (raw shapes from the public API) ───

/** Team identity from ESPN scoreboard API. */
export interface ESPNTeam {
  id: string;
  abbreviation: string;
  displayName: string;
  shortDisplayName: string;
  location: string;
  name: string;
  color?: string;
  alternateColor?: string;
  logo?: string;
}

/** Competitor (one team in a game) from ESPN. */
export interface ESPNCompetitor {
  id: string;
  homeAway: 'home' | 'away';
  score: string;
  winner?: boolean;
  team: ESPNTeam;
  records?: { name: string; type: string; summary: string }[];
  leaders?: {
    name: string;
    displayName: string;
    leaders: {
      displayValue: string;
      value: number;
      athlete: { fullName: string; shortName: string; jersey?: string; position?: { abbreviation: string } };
    }[];
  }[];
  linescores?: { value: number }[];
}

/** Game status from ESPN. */
export interface ESPNStatus {
  clock: number;
  displayClock: string;
  period: number;
  type: {
    id: string;
    name: string;
    state: 'pre' | 'in' | 'post';
    completed: boolean;
    description: string;
    detail: string;
    shortDetail: string;
  };
}

/** Venue from ESPN. */
export interface ESPNVenue {
  id: string;
  fullName: string;
  address?: {
    city?: string;
    state?: string;
    country?: string;
  };
  indoor?: boolean;
}

/** Odds from ESPN. */
export interface ESPNOdds {
  provider?: { name: string };
  details?: string;
  overUnder?: number;
  spread?: number;
  awayTeamOdds?: { moneyLine?: number };
  homeTeamOdds?: { moneyLine?: number };
}

/** Game situation (live play-state) from ESPN — present during in-progress games. */
export interface ESPNSituation {
  possession?: string;
  down?: number;
  distance?: number;
  yardLine?: number;
  isRedZone?: boolean;
  lastPlay?: { text?: string };
}

/** Competition (the core game data) from ESPN. */
export interface ESPNCompetition {
  id: string;
  date: string;
  attendance?: number;
  neutralSite?: boolean;
  venue?: ESPNVenue;
  competitors: ESPNCompetitor[];
  status: ESPNStatus;
  notes?: { type: string; headline: string }[];
  broadcasts?: { market: string; names: string[] }[];
  broadcast?: string;
  odds?: ESPNOdds[];
  situation?: ESPNSituation;
  leaders?: { name: string; displayName: string; leaders: { displayValue: string; athlete: { fullName: string } }[] }[];
}

/** Single event (game) from ESPN scoreboard. */
export interface ESPNEvent {
  id: string;
  uid: string;
  date: string;
  name: string;
  shortName: string;
  season: { year: number; type: number; slug?: string };
  week: { number: number };
  competitions: ESPNCompetition[];
  links?: { href: string; text: string }[];
  weather?: { displayValue?: string; temperature?: number };
  status: ESPNStatus;
}

/** Top-level ESPN scoreboard API response. */
export interface ESPNScoreboardResponse {
  leagues?: { season: { year: number; type: number }; calendar?: unknown[] }[];
  season?: { type: number; year: number };
  week?: { number: number };
  events: ESPNEvent[];
}

/** ESPN news article from /news endpoint. */
export interface ESPNNewsArticle {
  id: number;
  type: string;
  headline: string;
  description?: string;
  published: string;
  lastModified?: string;
  premium?: boolean;
  byline?: string;
  categories?: { type?: string; description?: string; teamId?: string }[];
  links?: { web?: { href: string } };
  images?: { url: string; caption?: string }[];
}

/** Top-level ESPN news API response. */
export interface ESPNNewsResponse {
  header?: string;
  articles: ESPNNewsArticle[];
}

// ── NFL internal types ─────────────────────────────────────────

/**
 * Normalised game score — the stable internal model.
 * Originally modeled after SportsData.io; now populated by the ESPN adapter.
 * All downstream formatting, routing, and response code consumes this interface.
 */
export interface NFLGameScore {
  GameKey: string;
  Season: number;
  SeasonType: number;
  Week: number;
  Date: string | null;
  AwayTeam: string;
  HomeTeam: string;
  AwayScore: number | null;
  HomeScore: number | null;
  Channel: string | null;
  Quarter: string | null;
  TimeRemaining: string | null;
  Status: 'Scheduled' | 'InProgress' | 'Final' | 'F/OT' | 'Suspended' | 'Postponed' | 'Delayed' | 'Canceled' | 'Forfeit';
  StadiumDetails: {
    Name: string;
    City: string;
    State: string;
    Country: string;
  } | null;
  IsClosed: boolean;
  AwayTeamMoneyLine: number | null;
  HomeTeamMoneyLine: number | null;
  PointSpread: number | null;
  OverUnder: number | null;
  /** Original ESPN event data, preserved for enhanced formatting (records, leaders, situation). */
  _espn?: ESPNEvent;
}

/** Standard response from NFLClient methods. */
export interface NFLResponse {
  success: boolean;
  data?: {
    text: string;
    games?: NFLGameScore[];
    articles?: ESPNNewsArticle[];
  };
  error?: string;
}

/** Result of an NFL API health check. */
export interface NFLHealthResult {
  healthy: boolean;
  error?: string;
}

// ── SerpAPI response types ──────────────────────────────────────

/** SerpAPI response structure returned by serpApiClient. */
export interface SerpApiResponse {
  success: boolean;
  data?: {
    text: string;
    raw?: unknown;
  };
  error?: string;
}

/** Health-check result for SerpAPI connectivity test. */
export interface SerpApiHealthResult {
  healthy: boolean;
  error?: string;
}

// ── Web Fetch response types ────────────────────────────────────

/** Response from the webFetchClient. */
export interface WebFetchResponse {
  success: boolean;
  data?: {
    text: string;
    url: string;
    contentType: string;
    title?: string;
    imageBase64?: string;
    fallbackUsed?: boolean;
    fallbackReason?: string;
    robotsTxtNote?: string;
  };
  error?: string;
}

/** Health-check result for web fetch connectivity test. */
export interface WebFetchHealthResult {
  healthy: boolean;
  error?: string;
}

// ── Meme (memegen.link) response types ──────────────────────────

/** A single meme template from the memegen.link API. */
export interface MemeTemplate {
  id: string;
  name: string;
  lines: number;
  overlays: number;
  styles: string[];
  blank: string;
  example: {
    text: string[];
    url: string;
  };
  source: string;
}

/** Meme API response structure returned by memeClient. */
export interface MemeResponse {
  success: boolean;
  data?: {
    text: string;
    imageUrl?: string;
  };
  error?: string;
}

/** Health-check result for Meme API connectivity test. */
export interface MemeHealthResult {
  healthy: boolean;
  templateCount?: number;
  error?: string;
}

// ── Unified pipeline types ──────────────────────────────────────

/** Result of a single tool invocation within the unified pipeline. */
export interface ToolInvocation {
  /** The tool config that was invoked. */
  toolName: string;
  /** API type of the tool. */
  api: ApiType;
  /** Raw content/parameters sent to the tool. */
  input: string;
  /** Formatted external data fragment from the tool result. */
  externalData?: string;
  /** Media follow-up produced by this tool (ComfyUI images, meme URLs, etc.). */
  media?: MediaFollowUp;
  /** Whether the tool call succeeded. */
  success: boolean;
}

/** Tracks state across pipeline stages without re-fetching. */
export interface PipelineContext {
  /** Discord message snowflake — used for dedup and logging. */
  messageId: string;
  /** Display name of the user who sent the message. */
  requester: string;
  /** Bot's Discord display name (fallback for prompt participant blocks). */
  botDisplayName?: string;
  /** Whether the message arrived via DM. */
  isDM: boolean;
  /** Cleaned message content (mentions stripped, etc.). */
  rawContent: string;
  /** Base64-encoded image attachments for vision models. */
  imagePayloads: string[];
  /** The original Discord message object. */
  sourceMessage: import('discord.js').Message;
  /** Conversation history (oldest→newest), built once at pipeline start. */
  conversationHistory: ChatMessage[];
  /** Private DM history with the requesting user (guild messages only). */
  dmHistory?: ChatMessage[];
  /** Stage 1 response text from Ollama (captured for final-pass context). */
  stage1Draft?: string;
  /** Tool invocations requested by Stage 1. */
  stage1ToolInvocations: ToolInvocation[];
  /** Completed tool results from Stage 2. */
  toolResults: ToolInvocation[];
  /** Media attachments to send after the text reply. */
  mediaFollowUps: MediaFollowUp[];
  /** The final response text after all stages. */
  finalResponse?: string;
  /** Running count of Ollama API calls made in this pipeline run. */
  ollamaCallCount: number;
  /** Timestamp (ms) when the pipeline started. */
  startedAt: number;
  /** When true, forces the final pass to use Ollama regardless of provider config (set by delegate_to_local). */
  forceOllamaFinalPass?: boolean;
  /**
   * Model-inferred intent for the final synthesis pass.
   * Set after Stage 1 based on the user's apparent request style.
   * When `'raw'`, Stage 3 is skipped even if tool results exist.
   */
  finalPassIntent?: FinalPassIntent;
}

// ── Media follow-up types ───────────────────────────────────────

/** Media follow-up sent after the Ollama text reply. */
export type MediaFollowUp =
  | ComfyUIMediaFollowUp
  | XaiImageMediaFollowUp
  | XaiVideoMediaFollowUp
  | UrlMediaFollowUp;

/** ComfyUI file attachments — needs the full response for file
 *  downloading, embed building, and batch sending. */
export interface ComfyUIMediaFollowUp {
  kind: 'comfyui';
  response: {
    success: boolean;
    data?: { text?: string; images?: string[]; videos?: string[] };
    error?: string;
  };
}

/** xAI image generation — carries image URLs or base64 data URLs for attachment. */
export interface XaiImageMediaFollowUp {
  kind: 'xai-image';
  images: string[];
  /** Pre-persisted output descriptors from xaiClient (avoids re-downloading). */
  savedOutputs?: import('./utils/mediaPersistence').PersistedMedia[];
}

/** xAI video generation — carries a temporary video URL for attachment. */
export interface XaiVideoMediaFollowUp {
  kind: 'xai-video';
  url: string;
  duration?: number;
  /** Pre-persisted output descriptors from xaiClient (avoids re-downloading). */
  savedOutputs?: import('./utils/mediaPersistence').PersistedMedia[];
}

/** A bare URL for Discord auto-embed (meme images, weather radar, etc.). */
export interface UrlMediaFollowUp {
  kind: 'url';
  url: string;
  /** Human-readable label for logging/activity events (e.g. 'meme'). */
  label: string;
}

/** Safe (no secrets) config snapshot returned by GET /api/config. */
export interface PublicConfig {
  discord: {
    clientId: string;
    tokenConfigured: boolean;
    /** Explicit bot display name override (empty = use Discord display name). */
    botDisplayName: string;
  };
  /** Discord tool-call limits for channel-only artifact retrieval. */
  discordTools: {
    /** Max messages returned when get_discord_artifact is called with channel only. */
    artifactMaxMessages: number;
    /** Max image attachments returned for channel-only artifact retrieval. */
    artifactMaxImages: number;
  };
  apis: {
    comfyui: string;
    ollama: string;
    ollamaModel: string;
    ollamaVisionModel: string;
    ollamaFinalPassModel: string;
    ollamaSystemPrompt: string;
    ollamaFinalPassPrompt: string;
    ollamaToolPrompt: string;
    ollamaToolContextSize: number;
    ollamaFinalPassContextSize: number;
    ollamaTimeout: number;
    ollamaVisionTimeout: number;
    ollamaToolTimeout: number;
    ollamaFinalPassTimeout: number;
    ollamaThrakenUrl: string;
    comfyuiWorkflowConfigured: boolean;
    accuweather: string;
    accuweatherDefaultLocation: string;
    accuweatherApiKeyConfigured: boolean;
    accuweatherDefaultWeatherType: 'current' | 'forecast' | 'full';
    nfl: string;
    nflEnabled: boolean;
    memeEnabled: boolean;
    serpapi: string;
    serpapiApiKeyConfigured: boolean;
    serpapiHl: string;
    serpapiGl: string;
    serpapiLocation: string;
    webfetchEnabled: boolean;
  };
  defaultWorkflow: {
    model: string;
    width: number;
    height: number;
    steps: number;
    cfg: number;
    sampler: string;
    scheduler: string;
    denoise: number;
    seed: number;
    negativePrompt: string;
    vae: string;
    clip: string;
    clip2: string;
    clipType: string;
    diffuser: string;
  };
  errorHandling: {
    errorMessage: string;
    errorRateLimitMinutes: number;
  };
  http: {
    port: number;
    httpHost: string;
    outputsPort: number;
    outputsHost: string;
    outputsTrustProxy: string;
    outputBaseUrl: string;
    activityKeyTtl: number;
    outputsRateLimitWindowMs: number;
    outputsRateLimitMax: number;
  };
  limits: {
    fileSizeThreshold: number;
    defaultTimeout: number;
    maxAttachments: number;
    imageAttachmentMaxSize: number;
    imageAttachmentMaxCount: number;
    maxToolCalls: number;
  };
  tools: import('./utils/config').ToolConfig[];
  /**
   * Non-null when `loadTools()` failed to parse `tools.xml`.
   * Contains a human-readable diagnostic message for the configurator banner.
   */
  toolsLoadError: string | null;
  defaultTools: import('./utils/config').ToolConfig[];
  allowBotInteractions: boolean;
  replyChain: {
    enabled: boolean;
    maxDepth: number;
    maxTokens: number;
    imageEnabled: boolean;
  };
  contextEval: {
    enabled: boolean;
    model: string;
    contextSize: number;
    timeout: number;
    prompt: string;
  };
  debugLogging: boolean;
  nflLogging: {
    level: number;
  };
  memeLogging: {
    debug: boolean;
  };
  abilityRetry: {
    enabled: boolean;
    /** Max number of retries AFTER the initial attempt. */
    maxRetries: number;
    /** Model used for refinement. */
    model: string;
    /** Generic refinement prompt (abilities may still use specialized prompts internally). */
    prompt: string;
    /** HTTP timeout in milliseconds for retry requests. */
    timeout: number;
  };
  imageResponse: {
    includeEmbed: boolean;
  };
  /** Configurator UI theme preference (persisted in .env). */
  configuratorTheme: string;
  /** Pipeline execution mode: 'unified' or 'legacy'. */
  pipelineMode: 'unified' | 'legacy';
  dmContext: {
    enabled: boolean;
    maxMessages: number;
  };
  ollamaFixup: {
    enabled: boolean;
    extractXmlTools: boolean;
    extractJsonTools: boolean;
    repairUrls: boolean;
    stripToolPreamble: boolean;
  };
  xai: {
    endpoint: string;
    apiKeyConfigured: boolean;
    model: string;
    toolModel: string;
    contextEvalModel: string;
    finalPassModel: string;
    imageModel: string;
    videoModel: string;
    timeout: number;
    toolTimeout: number;
    contextEvalTimeout: number;
    finalPassTimeout: number;
    imageEnabled: boolean;
    videoEnabled: boolean;
    encourageBuiltinTools: boolean;
    debugLogging: boolean;
    thrakenUrl: string;
  };
  /** LLM provider selection for each pipeline stage. */
  provider: {
    toolEval: import('./types').LlmProvider;
    finalPass: import('./types').LlmProvider;
    contextEval: import('./types').LlmProvider;
    retry: import('./types').LlmProvider;
  };
  /** Backend selections for web search. */
  backends: {
    webSearch: 'serpapi' | 'xai';
  };
}
