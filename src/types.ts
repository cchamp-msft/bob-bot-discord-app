/** A single message in a conversation chain for Ollama chat context. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Recognized API backend identifiers. */
export type ApiType = 'comfyui' | 'ollama' | 'accuweather';

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
}

/** Result of an AccuWeather health/connection test. */
export interface AccuWeatherHealthResult {
  healthy: boolean;
  error?: string;
  location?: AccuWeatherLocation;
}

/** Safe (no secrets) config snapshot returned by GET /api/config. */
export interface PublicConfig {
  discord: {
    clientId: string;
    tokenConfigured: boolean;
  };
  apis: {
    comfyui: string;
    ollama: string;
    ollamaModel: string;
    ollamaFinalPassModel: string;
    ollamaSystemPrompt: string;
    comfyuiWorkflowConfigured: boolean;
    accuweather: string;
    accuweatherDefaultLocation: string;
    accuweatherApiKeyConfigured: boolean;
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
    outputBaseUrl: string;
  };
  limits: {
    fileSizeThreshold: number;
    defaultTimeout: number;
    maxAttachments: number;
  };
  keywords: import('./utils/config').KeywordConfig[];
  replyChain: {
    enabled: boolean;
    maxDepth: number;
    maxTokens: number;
  };
  abilityLogging: {
    detailed: boolean;
  };
  imageResponse: {
    includeEmbed: boolean;
  };
}
