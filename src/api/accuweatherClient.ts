import axios, { AxiosInstance } from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import {
  AccuWeatherResponse,
  AccuWeatherHealthResult,
  AccuWeatherLocation,
  AccuWeatherCurrentConditions,
  AccuWeatherForecastResponse,
} from '../types';

const ACCUWEATHER_BASE_URL = 'https://dataservice.accuweather.com';

/**
 * Map an AccuWeather icon code (1-44) to a Unicode weather emoji.
 * Icon reference: https://apidev.accuweather.com/developers/weatherIcons
 *
 * Day icons: 1-32, Night icons: 33-44
 */
function getWeatherEmoji(iconCode: number): string {
  switch (iconCode) {
    case 1:                          // Sunny
    case 2:                          // Mostly Sunny
      return '☀️';
    case 3:                          // Partly Sunny
    case 4:                          // Intermittent Clouds
      return '🌤️';
    case 5:                          // Hazy Sunshine
      return '😶‍🌫️';
    case 6:                          // Mostly Cloudy
      return '🌥️';
    case 7:                          // Cloudy
    case 8:                          // Dreary (Overcast)
      return '☁️';
    case 11:                         // Fog
      return '🌫️';
    case 12:                         // Showers
    case 13:                         // Mostly Cloudy w/ Showers
    case 14:                         // Partly Sunny w/ Showers
      return '🌧️';
    case 15:                         // T-Storms
    case 16:                         // Mostly Cloudy w/ T-Storms
    case 17:                         // Partly Sunny w/ T-Storms
      return '⛈️';
    case 18:                         // Rain
      return '🌧️';
    case 19:                         // Flurries
    case 20:                         // Mostly Cloudy w/ Flurries
    case 21:                         // Partly Sunny w/ Flurries
      return '🌨️';
    case 22:                         // Snow
    case 23:                         // Mostly Cloudy w/ Snow
      return '❄️';
    case 24:                         // Ice
    case 25:                         // Sleet
    case 26:                         // Freezing Rain
      return '🧊';
    case 29:                         // Rain and Snow
      return '🌨️';
    case 30:                         // Hot
      return '🔥';
    case 31:                         // Cold
      return '🥶';
    case 32:                         // Windy
      return '💨';
    case 33:                         // Clear (night)
    case 34:                         // Mostly Clear (night)
      return '🌙';
    case 35:                         // Partly Cloudy (night)
    case 36:                         // Intermittent Clouds (night)
      return '🌙';
    case 37:                         // Hazy Moonlight
    case 38:                         // Mostly Cloudy (night)
      return '☁️';
    case 39:                         // Partly Cloudy w/ Showers (night)
    case 40:                         // Mostly Cloudy w/ Showers (night)
      return '🌧️';
    case 41:                         // Partly Cloudy w/ T-Storms (night)
    case 42:                         // Mostly Cloudy w/ T-Storms (night)
      return '⛈️';
    case 43:                         // Mostly Cloudy w/ Flurries (night)
      return '🌨️';
    case 44:                         // Mostly Cloudy w/ Snow (night)
      return '❄️';
    default:
      return '🌤️';
  }
}

/**
 * Map a temperature to a gauge emoji representing comfort level.
 * Accepts both °F and °C via the `unit` parameter (defaults to 'F').
 *
 * Levels (°F thresholds):
 *  - 🥶  0°F and below  (Arctic!)
 *  - 🧊  0–32°F         (Freezing)
 *  - ❄️  32–48°F        (Cold)
 *  - 🧥  48–63°F        (Jacket weather)
 *  - 😊  63–81°F        (Pleasant)
 *  - 🥵  81–100°F       (Hot!)
 *  - 🔥  100°F+         (Scorching!)
 */
function getTempGaugeEmoji(temp: number, unit: 'F' | 'C' = 'F'): string {
  const f = unit === 'C' ? temp * 9 / 5 + 32 : temp;
  if (f <= 0)   return '🥶';
  if (f <= 32)  return '🧊';
  if (f <= 48)  return '❄️';
  if (f <= 63)  return '🧥';
  if (f <= 81)  return '😊';
  if (f <= 100) return '🥵';
  return '🔥';
}

class AccuWeatherClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.getAccuWeatherEndpoint() || ACCUWEATHER_BASE_URL,
    });
  }

  /**
   * Rebuild the axios instance with the current endpoint from config.
   * Called after config.reload() on config save.
   */
  refresh(): void {
    this.client = axios.create({
      baseURL: config.getAccuWeatherEndpoint() || ACCUWEATHER_BASE_URL,
    });
  }

  /**
   * Resolve a user-provided location string to an AccuWeather location key.
   *
   * Supports:
   *  - Numeric location keys (passed through directly)
   *  - US zip codes (5 digits → postal code search)
   *  - City names (text search)
   *
   * Returns the first matching location, or null if none found.
   */
  async resolveLocation(input: string): Promise<AccuWeatherLocation | null> {
    const trimmed = input.trim();
    if (!trimmed) return null;

    const apiKey = config.getAccuWeatherApiKey();
    if (!apiKey) return null;

    // Pure numeric string of 5+ digits that isn't a zip → treat as location key
    // AccuWeather location keys are typically 5-6 digits
    // US zip codes are exactly 5 digits; we try postal code search for those
    if (/^\d{5}$/.test(trimmed)) {
      // Could be a zip code — try postal code search first
      const postalResult = await this.searchByPostalCode(trimmed);
      if (postalResult) return postalResult;
    }

    // If it's purely numeric (and not 5 digits, or zip search failed), assume location key
    if (/^\d+$/.test(trimmed)) {
      // Validate the key by fetching its info
      try {
        const response = await this.client.get(`/locations/v1/${trimmed}`, {
          params: { apikey: apiKey },
        });
        if (response.status === 200 && response.data?.Key) {
          return response.data as AccuWeatherLocation;
        }
      } catch {
        // Invalid key — fall through to text search
      }
    }

    // Text-based city search
    const cityResult = await this.searchCity(trimmed);
    if (cityResult) return cityResult;

    // Fallback: autocomplete search when direct city search fails
    return await this.searchWithAutocomplete(trimmed);
  }

  /**
   * Search for a location by city name.
   * Returns the first match or null.
   */
  async searchCity(query: string): Promise<AccuWeatherLocation | null> {
    const apiKey = config.getAccuWeatherApiKey();
    if (!apiKey) return null;

    try {
      const response = await this.client.get('/locations/v1/cities/search', {
        params: { apikey: apiKey, q: query },
      });
      if (response.status === 200 && Array.isArray(response.data) && response.data.length > 0) {
        return response.data[0] as AccuWeatherLocation;
      }
      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.logError('accuweather', `City search failed for "${query}": ${errorMsg}`);
      return null;
    }
  }

  /**
   * Search for a location by US postal (zip) code.
   * Returns the first match or null.
   */
  async searchByPostalCode(postalCode: string): Promise<AccuWeatherLocation | null> {
    const apiKey = config.getAccuWeatherApiKey();
    if (!apiKey) return null;

    try {
      const response = await this.client.get('/locations/v1/postalcodes/search', {
        params: { apikey: apiKey, q: postalCode },
      });
      if (response.status === 200 && Array.isArray(response.data) && response.data.length > 0) {
        return response.data[0] as AccuWeatherLocation;
      }
      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.logError('accuweather', `Postal code search failed for "${postalCode}": ${errorMsg}`);
      return null;
    }
  }

  /**
   * Search for a location using the autocomplete API.
   * Used as a fallback when direct city search returns no results.
   * Returns the first (most relevant) match or null.
   */
  async searchWithAutocomplete(query: string): Promise<AccuWeatherLocation | null> {
    const apiKey = config.getAccuWeatherApiKey();
    if (!apiKey) return null;

    try {
      const response = await this.client.get('/locations/v1/cities/autocomplete', {
        params: { apikey: apiKey, q: query },
      });
      if (response.status === 200 && Array.isArray(response.data) && response.data.length > 0) {
        return response.data[0] as AccuWeatherLocation;
      }
      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.logError('accuweather', `Autocomplete search failed for "${query}": ${errorMsg}`);
      return null;
    }
  }

  /**
   * Get current weather conditions for a location key.
   */
  async getCurrentConditions(locationKey: string): Promise<AccuWeatherCurrentConditions | null> {
    const apiKey = config.getAccuWeatherApiKey();
    if (!apiKey) return null;

    try {
      const response = await this.client.get(`/currentconditions/v1/${locationKey}`, {
        params: { apikey: apiKey, details: true },
      });
      if (response.status === 200 && Array.isArray(response.data) && response.data.length > 0) {
        return response.data[0] as AccuWeatherCurrentConditions;
      }
      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.logError('accuweather', `Current conditions fetch failed for key "${locationKey}": ${errorMsg}`);
      return null;
    }
  }

  /**
   * Get 5-day daily forecast for a location key.
   */
  async get5DayForecast(locationKey: string): Promise<AccuWeatherForecastResponse | null> {
    const apiKey = config.getAccuWeatherApiKey();
    if (!apiKey) return null;

    try {
      const response = await this.client.get(`/forecasts/v1/daily/5day/${locationKey}`, {
        params: { apikey: apiKey },
      });
      if (response.status === 200 && response.data?.DailyForecasts) {
        return response.data as AccuWeatherForecastResponse;
      }
      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.logError('accuweather', `5-day forecast fetch failed for key "${locationKey}": ${errorMsg}`);
      return null;
    }
  }

  /**
   * Get full weather data (current conditions + 5-day forecast) for a prompt.
   *
   * This is the main entry point for weather requests. It resolves the
   * location from the prompt, fetches data, and returns a formatted text
   * response.
   *
   * @param prompt - User prompt text (may contain location info).
   * @param requester - Username for logging.
   * @param mode - Which data to fetch: 'current', 'forecast', or 'full'.
   * @returns Standardized AccuWeatherResponse with formatted text.
   */
  async getWeather(
    prompt: string,
    requester: string,
    mode: 'current' | 'forecast' | 'full' = 'full'
  ): Promise<AccuWeatherResponse> {
    const apiKey = config.getAccuWeatherApiKey();
    if (!apiKey) {
      return { success: false, error: 'AccuWeather API key is not configured. Please set it in the configurator.' };
    }

    // Extract location from prompt, or fall back to default
    const locationInput = this.extractLocation(prompt) || config.getAccuWeatherDefaultLocation();
    if (!locationInput) {
      return { success: false, error: 'No location specified and no default location configured. Please provide a location or set a default in the configurator.' };
    }

    logger.logRequest(requester, `AccuWeather ${mode}: resolving location "${locationInput}"`);

    // Resolve to AccuWeather location
    const location = await this.resolveLocation(locationInput);
    if (!location) {
      return { success: false, error: `Could not find location "${locationInput}". Try a different city name or zip code.` };
    }

    const locationName = `${location.LocalizedName}, ${location.AdministrativeArea.ID}, ${location.Country.LocalizedName}`;
    logger.log('success', requester, `AccuWeather: Resolved to ${locationName} (key: ${location.Key})`);

    // Fetch weather data based on mode
    let current: AccuWeatherCurrentConditions | null = null;
    let forecast: AccuWeatherForecastResponse | null = null;

    if (mode === 'current' || mode === 'full') {
      current = await this.getCurrentConditions(location.Key);
      if (!current) {
        return { success: false, error: `Failed to fetch current conditions for ${locationName}.` };
      }
    }

    if (mode === 'forecast' || mode === 'full') {
      forecast = await this.get5DayForecast(location.Key);
      if (!forecast) {
        return { success: false, error: `Failed to fetch forecast for ${locationName}.` };
      }
    }

    // Format the response text
    const text = this.formatWeatherText(locationName, current, forecast, mode);

    // DEBUG: log full AccuWeather API response data
    logger.logDebug(requester, `ACCUWEATHER-REQUEST: mode=${mode}, location="${locationInput}", resolved="${locationName}"`);
    logger.logDebug(requester, `ACCUWEATHER-RESPONSE: ${text}`);

    logger.logReply(requester, `AccuWeather response: ${text.length} characters for ${locationName}`);

    return {
      success: true,
      data: {
        text,
        location,
        current: current ?? undefined,
        forecast: forecast ?? undefined,
      },
    };
  }

  /**
   * Extract a location string from a user prompt.
   *
   * Matches patterns like:
   *  - "weather in Seattle"
   *  - "weather for 90210"
   *  - "Seattle weather"
   *  - "what's the weather in New York City"
   *  - "forecast for 349727"
   *  - "weather Chicago IL"
   *
   * Returns the extracted location string, or empty string if none found.
   */
  extractLocation(prompt: string): string {
    const cleaned = prompt.trim();

    // Pattern: "weather/forecast/conditions in/for/at <location>"
    const inForPattern = /(?:weather|forecast|conditions|temperature)\s+(?:in|for|at)\s+(.+)/i;
    const inForMatch = cleaned.match(inForPattern);
    if (inForMatch) {
      return inForMatch[1].trim().replace(/[?.!]+$/, '').trim();
    }

    // Pattern: "<location> weather/forecast/conditions"
    const suffixPattern = /^(.+?)\s+(?:weather|forecast|conditions|temperature)\b/i;
    const suffixMatch = cleaned.match(suffixPattern);
    if (suffixMatch) {
      // Avoid matching common question words as locations
      const candidate = suffixMatch[1].trim();
      const ignoreWords = /^(what'?s?\s+the|how'?s?\s+the|get|show|tell\s+me|give\s+me|check|what\s+is\s+the|how\s+is\s+the)$/i;
      if (!ignoreWords.test(candidate)) {
        // Strip leading question words if present
        const stripped = candidate.replace(/^(what'?s?\s+the|how'?s?\s+the|get\s+the|show\s+the)\s+/i, '').trim();
        if (stripped) return stripped;
      }
    }

    // Pattern: standalone zip code or location key
    const zipPattern = /\b(\d{5})\b/;
    const zipMatch = cleaned.match(zipPattern);
    if (zipMatch) {
      return zipMatch[1];
    }

    // Fallback: treat the entire input as a location name.
    // This handles keyword-stripped prompts (e.g. "new york" after
    // the message handler removed the "weather" keyword).
    return cleaned;
  }

  /**
   * Format weather data into a human-readable text block.
   * Used for direct (non-routed) responses.
   */
  formatWeatherText(
    locationName: string,
    current: AccuWeatherCurrentConditions | null,
    forecast: AccuWeatherForecastResponse | null,
    mode: 'current' | 'forecast' | 'full'
  ): string {
    const parts: string[] = [];

    // Pick the most relevant icon code for the header emoji
    const headerIcon = current?.WeatherIcon
      ?? forecast?.DailyForecasts?.[0]?.Day?.Icon
      ?? 0;
    const headerEmoji = getWeatherEmoji(headerIcon);
    parts.push(`${headerEmoji} Weather for ${locationName}`);
    parts.push('');

    if (current && (mode === 'current' || mode === 'full')) {
      parts.push('**Current Conditions**');
      parts.push(`• ${current.WeatherText}`);
      parts.push(`• Temperature: ${current.Temperature.Imperial.Value}°F / ${current.Temperature.Metric.Value}°C`);
      parts.push(`• Feels like: ${current.RealFeelTemperature.Imperial.Value}°F / ${current.RealFeelTemperature.Metric.Value}°C`);
      parts.push(`• Humidity: ${current.RelativeHumidity}%`);
      parts.push(`• Wind: ${current.Wind.Direction.Localized} ${current.Wind.Speed.Imperial.Value} mph`);
      parts.push(`• UV Index: ${current.UVIndex} (${current.UVIndexText})`);
      parts.push(`• Cloud Cover: ${current.CloudCover}%`);
      if (current.HasPrecipitation && current.PrecipitationType) {
        parts.push(`• Precipitation: ${current.PrecipitationType}`);
      }
      parts.push('');
    }

    if (forecast && (mode === 'forecast' || mode === 'full')) {
      parts.push('**5-Day Forecast**');
      if (forecast.Headline?.Text) {
        parts.push(`_${forecast.Headline.Text}_`);
      }

      // Pre-scan to find max content width per column
      const cols = forecast.DailyForecasts.map(day => {
        const date = new Date(day.Date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const tempUnit: 'F' | 'C' = day.Temperature.Maximum.Unit === 'F' ? 'F' : 'C';
        const unit = tempUnit === 'F' ? '°F' : '°C';
        const temp = `${day.Temperature.Minimum.Value}-${day.Temperature.Maximum.Value}${unit}`;
        const dayPhrase = `Day: ${day.Day.IconPhrase}`;
        const nightPhrase = `Night: ${day.Night.IconPhrase}`;
        return { date, temp, tempUnit, dayPhrase, nightPhrase };
      });
      // +2 accounts for leading and trailing space inside each code block
      const dateW  = Math.max(...cols.map(c => c.date.length)) + 2;
      const tempW  = Math.max(...cols.map(c => c.temp.length)) + 2;
      const dayW   = Math.max(...cols.map(c => c.dayPhrase.length)) + 2;
      const nightW = Math.max(...cols.map(c => c.nightPhrase.length)) + 2;

      for (const col of cols) {
        const high = forecast.DailyForecasts[cols.indexOf(col)].Temperature.Maximum.Value;
        const dayData = forecast.DailyForecasts[cols.indexOf(col)];
        const tempEmoji = getTempGaugeEmoji(high, col.tempUnit);
        const dayEmoji = getWeatherEmoji(dayData.Day.Icon);
        const nightEmoji = getWeatherEmoji(dayData.Night.Icon);
        const datePad = ` ${col.date} `.padEnd(dateW);
        const tempPad = ` ${col.temp} `.padEnd(tempW);
        const dayPad  = ` ${col.dayPhrase} `.padEnd(dayW);
        const nightPad = ` ${col.nightPhrase} `.padEnd(nightW);
        parts.push(`\`${datePad}\` ${tempEmoji} \`${tempPad}\` ${dayEmoji} \`${dayPad}\` ${nightEmoji} \`${nightPad}\``);
      }
    }

    return parts.join('\n');
  }

  /**
   * Format weather data into a structured context block for AI model consumption.
   * This format is designed to be unambiguous for the model to parse as context.
   */
  formatWeatherContextForAI(
    locationName: string,
    current: AccuWeatherCurrentConditions | null,
    forecast: AccuWeatherForecastResponse | null
  ): string {
    const parts: string[] = [];

    parts.push(`--- BEGIN WEATHER DATA ---`);
    parts.push(`Location: ${locationName}`);
    parts.push('');

    if (current) {
      parts.push('CURRENT CONDITIONS:');
      parts.push(`  Observation Time: ${current.LocalObservationDateTime}`);
      parts.push(`  Conditions: ${current.WeatherText}`);
      parts.push(`  Temperature: ${current.Temperature.Imperial.Value}°F (${current.Temperature.Metric.Value}°C)`);
      parts.push(`  Feels Like: ${current.RealFeelTemperature.Imperial.Value}°F (${current.RealFeelTemperature.Metric.Value}°C)`);
      parts.push(`  Humidity: ${current.RelativeHumidity}%`);
      parts.push(`  Wind: ${current.Wind.Direction.Localized} at ${current.Wind.Speed.Imperial.Value} mph (${current.Wind.Speed.Metric.Value} km/h)`);
      parts.push(`  UV Index: ${current.UVIndex} (${current.UVIndexText})`);
      parts.push(`  Visibility: ${current.Visibility.Imperial.Value} mi (${current.Visibility.Metric.Value} km)`);
      parts.push(`  Cloud Cover: ${current.CloudCover}%`);
      parts.push(`  Time of Day: ${current.IsDayTime ? 'Daytime' : 'Nighttime'}`);
      if (current.HasPrecipitation && current.PrecipitationType) {
        parts.push(`  Precipitation: ${current.PrecipitationType}`);
      }
      parts.push('');
    }

    if (forecast) {
      parts.push('5-DAY FORECAST:');
      if (forecast.Headline?.Text) {
        parts.push(`  Headline: ${forecast.Headline.Text} (${forecast.Headline.Category})`);
      }
      for (const day of forecast.DailyForecasts) {
        const date = new Date(day.Date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        parts.push(`  ${date}:`);
        parts.push(`    High: ${day.Temperature.Maximum.Value}°${day.Temperature.Maximum.Unit} | Low: ${day.Temperature.Minimum.Value}°${day.Temperature.Minimum.Unit}`);
        parts.push(`    Day: ${day.Day.IconPhrase}${day.Day.HasPrecipitation ? ' (' + (day.Day.PrecipitationIntensity || '') + ' ' + (day.Day.PrecipitationType || 'precipitation') + ')' : ''}`);
        parts.push(`    Night: ${day.Night.IconPhrase}${day.Night.HasPrecipitation ? ' (' + (day.Night.PrecipitationIntensity || '') + ' ' + (day.Night.PrecipitationType || 'precipitation') + ')' : ''}`);
      }
      parts.push('');
    }

    parts.push('--- END WEATHER DATA ---');

    return parts.join('\n');
  }

  /**
   * Test connection to AccuWeather API and verify that the API key works.
   * Also attempts to resolve the default location if configured.
   */
  async testConnection(): Promise<AccuWeatherHealthResult> {
    const apiKey = config.getAccuWeatherApiKey();
    if (!apiKey) {
      return { healthy: false, error: 'AccuWeather API key is not configured' };
    }

    try {
      // Test with a simple location search to verify the API key works
      const response = await this.client.get('/locations/v1/cities/search', {
        params: { apikey: apiKey, q: 'New York' },
      });

      if (response.status === 200 && Array.isArray(response.data)) {
        // If a default location is configured, resolve it
        const defaultLocation = config.getAccuWeatherDefaultLocation();
        let location: AccuWeatherLocation | undefined;
        if (defaultLocation) {
          const resolved = await this.resolveLocation(defaultLocation);
          if (resolved) {
            location = resolved;
          }
        }
        return { healthy: true, location };
      }

      return { healthy: false, error: 'Unexpected response from AccuWeather API' };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Check for common API key errors
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        return { healthy: false, error: 'Invalid API key — authentication failed (HTTP 401)' };
      }
      if (axios.isAxiosError(error) && error.response?.status === 503) {
        return { healthy: false, error: 'AccuWeather API key has exceeded its daily call limit or has been revoked (HTTP 503)' };
      }
      return { healthy: false, error: errorMsg };
    }
  }

  /**
   * Simple boolean health check.
   */
  async isHealthy(): Promise<boolean> {
    const result = await this.testConnection();
    return result.healthy;
  }
}

export const accuweatherClient = new AccuWeatherClient();
export { getWeatherEmoji, getTempGaugeEmoji };
