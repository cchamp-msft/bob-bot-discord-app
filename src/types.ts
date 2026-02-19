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
  contextSource?: 'reply' | 'channel' | 'thread' | 'dm' | 'trigger';
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
export type ApiType = 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi' | 'meme';

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

/** Single day in AccuWeather 5-day forecast. */
export interface AccuWeatherDailyForecast {
  Date: string;
  Temperature: {
    Minimum: { Value: number; Unit: string };
    Maximum: { Value: number; Unit: string };
  };
  Day: { Icon: number; IconPhrase: string; HasPrecipitation: boolean; PrecipitationType?: string; PrecipitationIntensity?: string };
  Night: { Icon: number; IconPhrase: string; HasPrecipitation: boolean; PrecipitationType?: string; PrecipitationIntensity?: string };
}

/** AccuWeather 5-day forecast response. */
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

/** Safe (no secrets) config snapshot returned by GET /api/config. */
export interface PublicConfig {
  discord: {
    clientId: string;
    tokenConfigured: boolean;
    /** Explicit bot display name override (empty = use Discord display name). */
    botDisplayName: string;
  };
  apis: {
    comfyui: string;
    ollama: string;
    ollamaModel: string;
    ollamaVisionModel: string;
    ollamaFinalPassModel: string;
    ollamaSystemPrompt: string;
    ollamaFinalPassPrompt: string;
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
  };
  keywords: import('./utils/config').KeywordConfig[];
  defaultKeywords: import('./utils/config').KeywordConfig[];
  allowBotInteractions: boolean;
  replyChain: {
    enabled: boolean;
    maxDepth: number;
    maxTokens: number;
  };
  debugLogging: boolean;
  abilityLogging: {
    detailed: boolean;
  };
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
  };
  imageResponse: {
    includeEmbed: boolean;
  };
  /** Configurator UI theme preference (persisted in .env). */
  configuratorTheme: string;
}
