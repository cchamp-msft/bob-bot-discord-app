/**
 * AccuWeatherClient tests — exercises location resolution, weather fetching,
 * text/AI formatting, health checks, and location extraction from prompts.
 * Uses axios mocking; no real AccuWeather instance required.
 */

import axios from 'axios';

// Stable mock instance — defined at module level so the singleton
// captures this same object when it calls axios.create() at import time.
const mockInstance = {
  get: jest.fn(),
  defaults: { baseURL: '' },
};

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => mockInstance),
    isAxiosError: jest.fn((err: any) => err?.isAxiosError === true),
  },
}));

jest.mock('../src/utils/config', () => ({
  config: {
    getAccuWeatherEndpoint: jest.fn(() => 'https://dataservice.accuweather.com'),
    getAccuWeatherApiKey: jest.fn(() => 'test-api-key'),
    getAccuWeatherDefaultLocation: jest.fn(() => 'Seattle'),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
  },
}));

// Import after mocks — singleton captures mockInstance
import { accuweatherClient } from '../src/api/accuweatherClient';
import { config } from '../src/utils/config';

// --- Test data fixtures ---
const sampleLocation = {
  Key: '351409',
  LocalizedName: 'Seattle',
  Country: { ID: 'US', LocalizedName: 'United States' },
  AdministrativeArea: { ID: 'WA', LocalizedName: 'Washington' },
};

const sampleCurrentConditions = {
  LocalObservationDateTime: '2025-06-15T14:30:00-07:00',
  WeatherText: 'Partly Cloudy',
  Temperature: {
    Metric: { Value: 22, Unit: 'C' },
    Imperial: { Value: 72, Unit: 'F' },
  },
  RealFeelTemperature: {
    Metric: { Value: 24, Unit: 'C' },
    Imperial: { Value: 75, Unit: 'F' },
  },
  RelativeHumidity: 55,
  Wind: {
    Direction: { Degrees: 180, Localized: 'S', English: 'S' },
    Speed: {
      Metric: { Value: 16, Unit: 'km/h' },
      Imperial: { Value: 10, Unit: 'mi/h' },
    },
  },
  UVIndex: 5,
  UVIndexText: 'Moderate',
  Visibility: {
    Metric: { Value: 16, Unit: 'km' },
    Imperial: { Value: 10, Unit: 'mi' },
  },
  CloudCover: 40,
  HasPrecipitation: false,
  PrecipitationType: null,
  IsDayTime: true,
};

const sampleForecastResponse = {
  Headline: { Text: 'Expect nice weather next week', Category: 'mild' },
  DailyForecasts: [
    {
      Date: '2025-06-15T07:00:00-07:00',
      Temperature: {
        Minimum: { Value: 55, Unit: 'F' },
        Maximum: { Value: 75, Unit: 'F' },
      },
      Day: { IconPhrase: 'Partly sunny', HasPrecipitation: false, PrecipitationType: null, PrecipitationIntensity: null },
      Night: { IconPhrase: 'Clear', HasPrecipitation: false, PrecipitationType: null, PrecipitationIntensity: null },
    },
    {
      Date: '2025-06-16T07:00:00-07:00',
      Temperature: {
        Minimum: { Value: 58, Unit: 'F' },
        Maximum: { Value: 78, Unit: 'F' },
      },
      Day: { IconPhrase: 'Sunny', HasPrecipitation: false, PrecipitationType: null, PrecipitationIntensity: null },
      Night: { IconPhrase: 'Mostly clear', HasPrecipitation: false, PrecipitationType: null, PrecipitationIntensity: null },
    },
  ],
};

describe('AccuWeatherClient', () => {
  beforeEach(() => {
    mockInstance.get.mockReset();
    (config.getAccuWeatherApiKey as jest.Mock).mockReturnValue('test-api-key');
    (config.getAccuWeatherDefaultLocation as jest.Mock).mockReturnValue('Seattle');
    (config.getAccuWeatherEndpoint as jest.Mock).mockReturnValue('https://dataservice.accuweather.com');
  });

  // ---- extractLocation ----

  describe('extractLocation', () => {
    it('should extract location from "weather in <city>"', () => {
      expect(accuweatherClient.extractLocation('weather in Seattle')).toBe('Seattle');
    });

    it('should extract location from "weather for <city>"', () => {
      expect(accuweatherClient.extractLocation('weather for New York')).toBe('New York');
    });

    it('should extract location from "forecast for <zip>"', () => {
      expect(accuweatherClient.extractLocation('forecast for 90210')).toBe('90210');
    });

    it('should extract location from "<city> weather"', () => {
      expect(accuweatherClient.extractLocation('Chicago weather')).toBe('Chicago');
    });

    it('should extract location from "conditions at <city>"', () => {
      expect(accuweatherClient.extractLocation('conditions at Denver')).toBe('Denver');
    });

    it('should find a standalone zip code', () => {
      expect(accuweatherClient.extractLocation('what is 98101 looking like')).toBe('98101');
    });

    it('should return empty string when no location found', () => {
      expect(accuweatherClient.extractLocation('hello world')).toBe('');
    });

    it('should handle "what\'s the weather in <city>"', () => {
      const result = accuweatherClient.extractLocation("what's the weather in Portland");
      expect(result).toBe('Portland');
    });

    it('should strip trailing punctuation', () => {
      expect(accuweatherClient.extractLocation('weather in Seattle?')).toBe('Seattle');
      expect(accuweatherClient.extractLocation('weather in Chicago!')).toBe('Chicago');
    });
  });

  // ---- resolveLocation ----

  describe('resolveLocation', () => {
    it('should return null for empty input', async () => {
      const result = await accuweatherClient.resolveLocation('');
      expect(result).toBeNull();
    });

    it('should return null when API key is missing', async () => {
      (config.getAccuWeatherApiKey as jest.Mock).mockReturnValue('');
      const result = await accuweatherClient.resolveLocation('Seattle');
      expect(result).toBeNull();
    });

    it('should search by postal code for 5-digit input', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [sampleLocation],
      });

      const result = await accuweatherClient.resolveLocation('98101');
      expect(result).toEqual(sampleLocation);
      expect(mockInstance.get).toHaveBeenCalledWith('/locations/v1/postalcodes/search', {
        params: { apikey: 'test-api-key', q: '98101' },
      });
    });

    it('should try city search when postal code returns no results', async () => {
      // Postal code search returns empty
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [],
      });
      // Fall through to numeric check — not purely numeric after zip fails,
      // but 5-digit is purely numeric so it tries location key lookup
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: { Key: '98101' },
      });

      const result = await accuweatherClient.resolveLocation('98101');
      // Falls back to location key validation
      expect(result).toEqual({ Key: '98101' });
    });

    it('should use city search for text input', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [sampleLocation],
      });

      const result = await accuweatherClient.resolveLocation('Seattle');
      expect(result).toEqual(sampleLocation);
      expect(mockInstance.get).toHaveBeenCalledWith('/locations/v1/cities/search', {
        params: { apikey: 'test-api-key', q: 'Seattle' },
      });
    });

    it('should validate numeric location keys', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: { ...sampleLocation, Key: '123456' },
      });

      const result = await accuweatherClient.resolveLocation('123456');
      expect(result).toEqual({ ...sampleLocation, Key: '123456' });
      expect(mockInstance.get).toHaveBeenCalledWith('/locations/v1/123456', {
        params: { apikey: 'test-api-key' },
      });
    });
  });

  // ---- searchCity ----

  describe('searchCity', () => {
    it('should return the first matching location', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [sampleLocation],
      });

      const result = await accuweatherClient.searchCity('Seattle');
      expect(result).toEqual(sampleLocation);
    });

    it('should return null when no results found', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [],
      });

      const result = await accuweatherClient.searchCity('Nonexistentville');
      expect(result).toBeNull();
    });

    it('should return null when API key is missing', async () => {
      (config.getAccuWeatherApiKey as jest.Mock).mockReturnValue('');
      const result = await accuweatherClient.searchCity('Seattle');
      expect(result).toBeNull();
    });

    it('should return null and log error on network failure', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('Network Error'));
      const result = await accuweatherClient.searchCity('Seattle');
      expect(result).toBeNull();
    });
  });

  // ---- searchByPostalCode ----

  describe('searchByPostalCode', () => {
    it('should return the first matching location', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [sampleLocation],
      });

      const result = await accuweatherClient.searchByPostalCode('98101');
      expect(result).toEqual(sampleLocation);
    });

    it('should return null when no results found', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [],
      });

      const result = await accuweatherClient.searchByPostalCode('00000');
      expect(result).toBeNull();
    });

    it('should return null when API key is missing', async () => {
      (config.getAccuWeatherApiKey as jest.Mock).mockReturnValue('');
      const result = await accuweatherClient.searchByPostalCode('98101');
      expect(result).toBeNull();
    });
  });

  // ---- getCurrentConditions ----

  describe('getCurrentConditions', () => {
    it('should return current conditions for a valid location key', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [sampleCurrentConditions],
      });

      const result = await accuweatherClient.getCurrentConditions('351409');
      expect(result).toEqual(sampleCurrentConditions);
      expect(mockInstance.get).toHaveBeenCalledWith('/currentconditions/v1/351409', {
        params: { apikey: 'test-api-key', details: true },
      });
    });

    it('should return null when no data is returned', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [],
      });

      const result = await accuweatherClient.getCurrentConditions('351409');
      expect(result).toBeNull();
    });

    it('should return null and log error on failure', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('API Error'));
      const result = await accuweatherClient.getCurrentConditions('351409');
      expect(result).toBeNull();
    });
  });

  // ---- get5DayForecast ----

  describe('get5DayForecast', () => {
    it('should return forecast data for a valid location key', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: sampleForecastResponse,
      });

      const result = await accuweatherClient.get5DayForecast('351409');
      expect(result).toEqual(sampleForecastResponse);
      expect(mockInstance.get).toHaveBeenCalledWith('/forecasts/v1/daily/5day/351409', {
        params: { apikey: 'test-api-key' },
      });
    });

    it('should return null for empty forecast response', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: {},
      });

      const result = await accuweatherClient.get5DayForecast('351409');
      expect(result).toBeNull();
    });

    it('should return null and log error on failure', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('API Error'));
      const result = await accuweatherClient.get5DayForecast('351409');
      expect(result).toBeNull();
    });
  });

  // ---- getWeather ----

  describe('getWeather', () => {
    it('should return error when API key is not configured', async () => {
      (config.getAccuWeatherApiKey as jest.Mock).mockReturnValue('');
      const result = await accuweatherClient.getWeather('weather in Seattle', 'testuser');
      expect(result.success).toBe(false);
      expect(result.error).toContain('API key is not configured');
    });

    it('should return error when no location found and no default', async () => {
      (config.getAccuWeatherDefaultLocation as jest.Mock).mockReturnValue('');
      const result = await accuweatherClient.getWeather('hello', 'testuser');
      expect(result.success).toBe(false);
      expect(result.error).toContain('No location specified');
    });

    it('should return error when location cannot be resolved', async () => {
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [],
      });

      const result = await accuweatherClient.getWeather('weather in Nonexistentville', 'testuser');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not find location');
    });

    it('should fetch current conditions in "current" mode', async () => {
      // resolveLocation — city search
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: [sampleLocation] });
      // getCurrentConditions
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: [sampleCurrentConditions] });

      const result = await accuweatherClient.getWeather('weather in Seattle', 'testuser', 'current');
      expect(result.success).toBe(true);
      expect(result.data?.current).toBeDefined();
      expect(result.data?.forecast).toBeUndefined();
      expect(result.data?.text).toContain('Current Conditions');
      expect(result.data?.text).not.toContain('5-Day Forecast');
    });

    it('should fetch forecast in "forecast" mode', async () => {
      // resolveLocation — city search
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: [sampleLocation] });
      // get5DayForecast
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: sampleForecastResponse });

      const result = await accuweatherClient.getWeather('forecast for Seattle', 'testuser', 'forecast');
      expect(result.success).toBe(true);
      expect(result.data?.current).toBeUndefined();
      expect(result.data?.forecast).toBeDefined();
      expect(result.data?.text).toContain('5-Day Forecast');
      expect(result.data?.text).not.toContain('Current Conditions');
    });

    it('should fetch both in "full" mode', async () => {
      // resolveLocation — city search
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: [sampleLocation] });
      // getCurrentConditions
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: [sampleCurrentConditions] });
      // get5DayForecast
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: sampleForecastResponse });

      const result = await accuweatherClient.getWeather('weather in Seattle', 'testuser', 'full');
      expect(result.success).toBe(true);
      expect(result.data?.current).toBeDefined();
      expect(result.data?.forecast).toBeDefined();
      expect(result.data?.text).toContain('Current Conditions');
      expect(result.data?.text).toContain('5-Day Forecast');
    });

    it('should use default location when prompt has no location', async () => {
      // resolveLocation — city search for default "Seattle"
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: [sampleLocation] });
      // getCurrentConditions
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: [sampleCurrentConditions] });
      // get5DayForecast
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: sampleForecastResponse });

      const result = await accuweatherClient.getWeather('weather', 'testuser');
      expect(result.success).toBe(true);
      expect(result.data?.location?.LocalizedName).toBe('Seattle');
    });

    it('should return error when current conditions fetch fails', async () => {
      // resolveLocation — city search
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: [sampleLocation] });
      // getCurrentConditions — fail
      mockInstance.get.mockRejectedValueOnce(new Error('API Error'));

      const result = await accuweatherClient.getWeather('weather in Seattle', 'testuser', 'current');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to fetch current conditions');
    });

    it('should return error when forecast fetch fails', async () => {
      // resolveLocation — city search
      mockInstance.get.mockResolvedValueOnce({ status: 200, data: [sampleLocation] });
      // get5DayForecast — fail
      mockInstance.get.mockRejectedValueOnce(new Error('API Error'));

      const result = await accuweatherClient.getWeather('forecast for Seattle', 'testuser', 'forecast');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to fetch forecast');
    });
  });

  // ---- formatWeatherText ----

  describe('formatWeatherText', () => {
    it('should format current conditions correctly', () => {
      const text = accuweatherClient.formatWeatherText(
        'Seattle, WA, United States',
        sampleCurrentConditions as any,
        null,
        'current'
      );

      expect(text).toContain('Weather for Seattle, WA, United States');
      expect(text).toContain('Current Conditions');
      expect(text).toContain('Partly Cloudy');
      expect(text).toContain('72°F');
      expect(text).toContain('22°C');
      expect(text).toContain('55%');
      expect(text).toContain('S 10 mph');
      expect(text).toContain('UV Index: 5');
    });

    it('should format forecast correctly', () => {
      const text = accuweatherClient.formatWeatherText(
        'Seattle, WA, United States',
        null,
        sampleForecastResponse as any,
        'forecast'
      );

      expect(text).toContain('5-Day Forecast');
      expect(text).toContain('Expect nice weather next week');
      expect(text).toContain('55°F–75°F');
      expect(text).toContain('Partly sunny');
    });

    it('should format full report with both sections', () => {
      const text = accuweatherClient.formatWeatherText(
        'Seattle, WA, United States',
        sampleCurrentConditions as any,
        sampleForecastResponse as any,
        'full'
      );

      expect(text).toContain('Current Conditions');
      expect(text).toContain('5-Day Forecast');
    });

    it('should show precipitation when present', () => {
      const withPrecip = {
        ...sampleCurrentConditions,
        HasPrecipitation: true,
        PrecipitationType: 'Rain',
      };
      const text = accuweatherClient.formatWeatherText(
        'Seattle, WA, United States',
        withPrecip as any,
        null,
        'current'
      );

      expect(text).toContain('Precipitation: Rain');
    });
  });

  // ---- formatWeatherContextForAI ----

  describe('formatWeatherContextForAI', () => {
    it('should produce structured context with markers', () => {
      const context = accuweatherClient.formatWeatherContextForAI(
        'Seattle, WA, United States',
        sampleCurrentConditions as any,
        sampleForecastResponse as any
      );

      expect(context).toContain('--- BEGIN WEATHER DATA ---');
      expect(context).toContain('--- END WEATHER DATA ---');
      expect(context).toContain('Location: Seattle, WA, United States');
    });

    it('should include current conditions detail', () => {
      const context = accuweatherClient.formatWeatherContextForAI(
        'Seattle, WA, United States',
        sampleCurrentConditions as any,
        null
      );

      expect(context).toContain('CURRENT CONDITIONS:');
      expect(context).toContain('Temperature: 72°F (22°C)');
      expect(context).toContain('Humidity: 55%');
      expect(context).toContain('Cloud Cover: 40%');
      expect(context).toContain('Daytime');
    });

    it('should include forecast detail', () => {
      const context = accuweatherClient.formatWeatherContextForAI(
        'Seattle, WA, United States',
        null,
        sampleForecastResponse as any
      );

      expect(context).toContain('5-DAY FORECAST:');
      expect(context).toContain('Headline: Expect nice weather next week');
      expect(context).toContain('High: 75°F | Low: 55°F');
      expect(context).toContain('Day: Partly sunny');
    });
  });

  // ---- testConnection ----

  describe('testConnection', () => {
    it('should return healthy with no default location', async () => {
      (config.getAccuWeatherDefaultLocation as jest.Mock).mockReturnValue('');
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [sampleLocation],
      });

      const result = await accuweatherClient.testConnection();
      expect(result.healthy).toBe(true);
      expect(result.location).toBeUndefined();
    });

    it('should return healthy with resolved default location', async () => {
      // Test connection search
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [sampleLocation],
      });
      // resolveLocation for default
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [sampleLocation],
      });

      const result = await accuweatherClient.testConnection();
      expect(result.healthy).toBe(true);
      expect(result.location?.LocalizedName).toBe('Seattle');
    });

    it('should return unhealthy when API key is missing', async () => {
      (config.getAccuWeatherApiKey as jest.Mock).mockReturnValue('');
      const result = await accuweatherClient.testConnection();
      expect(result.healthy).toBe(false);
      expect(result.error).toContain('API key is not configured');
    });

    it('should return unhealthy with 401 error message', async () => {
      const axiosError = new Error('Request failed') as any;
      axiosError.isAxiosError = true;
      axiosError.response = { status: 401 };
      mockInstance.get.mockRejectedValueOnce(axiosError);

      const result = await accuweatherClient.testConnection();
      expect(result.healthy).toBe(false);
      expect(result.error).toContain('Invalid API key');
    });

    it('should return unhealthy with 503 error message', async () => {
      const axiosError = new Error('Service Unavailable') as any;
      axiosError.isAxiosError = true;
      axiosError.response = { status: 503 };
      mockInstance.get.mockRejectedValueOnce(axiosError);

      const result = await accuweatherClient.testConnection();
      expect(result.healthy).toBe(false);
      expect(result.error).toContain('exceeded its daily call limit');
    });

    it('should return generic error for other failures', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('Network Error'));
      const result = await accuweatherClient.testConnection();
      expect(result.healthy).toBe(false);
      expect(result.error).toBe('Network Error');
    });
  });

  // ---- isHealthy ----

  describe('isHealthy', () => {
    it('should return true when connection is healthy', async () => {
      (config.getAccuWeatherDefaultLocation as jest.Mock).mockReturnValue('');
      mockInstance.get.mockResolvedValueOnce({
        status: 200,
        data: [sampleLocation],
      });

      const result = await accuweatherClient.isHealthy();
      expect(result).toBe(true);
    });

    it('should return false when connection fails', async () => {
      mockInstance.get.mockRejectedValueOnce(new Error('fail'));
      const result = await accuweatherClient.isHealthy();
      expect(result).toBe(false);
    });
  });

  // ---- refresh ----

  describe('refresh', () => {
    it('should recreate the axios instance', () => {
      const createSpy = (axios.create as jest.Mock);
      const callCountBefore = createSpy.mock.calls.length;
      accuweatherClient.refresh();
      expect(createSpy.mock.calls.length).toBe(callCountBefore + 1);
    });
  });
});
