import { ComfyUIResponse } from '../api/comfyuiClient';
import { OllamaResponse } from '../api/ollamaClient';
import { AccuWeatherResponse, NFLResponse, SerpApiResponse } from '../types';

/**
 * Unified result from any API stage in a routed pipeline.
 */
export interface StageResult {
  /** The type of API that produced this result. */
  sourceApi: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi' | 'external';
  /** Extracted text content (from Ollama, AccuWeather, NFL, or future text-based APIs). */
  text?: string;
  /** Extracted image URLs (from ComfyUI). */
  images?: string[];
  /** The raw API response for final handling. */
  rawResponse: ComfyUIResponse | OllamaResponse | AccuWeatherResponse | NFLResponse | SerpApiResponse;
}

/**
 * Extract a usable text summary from a ComfyUI response.
 * Returns the image URL(s) as text since ComfyUI produces images, not text.
 */
export function extractFromComfyUI(response: ComfyUIResponse): StageResult {
  const images = response.data?.images ?? [];
  const text = response.data?.text;

  return {
    sourceApi: 'comfyui',
    text: text ?? (images.length > 0 ? `[Generated ${images.length} image(s): ${images.join(', ')}]` : undefined),
    images: images.length > 0 ? images : undefined,
    rawResponse: response,
  };
}

/**
 * Extract usable text content from an Ollama response.
 */
export function extractFromOllama(response: OllamaResponse): StageResult {
  return {
    sourceApi: 'ollama',
    text: response.data?.text ?? undefined,
    rawResponse: response,
  };
}

/**
 * Extract usable text content from an AccuWeather response.
 */
export function extractFromAccuWeather(response: AccuWeatherResponse): StageResult {
  return {
    sourceApi: 'accuweather',
    text: response.data?.text ?? undefined,
    rawResponse: response,
  };
}

/**
 * Extract usable text content from an NFL response.
 */
export function extractFromNFL(response: NFLResponse): StageResult {
  return {
    sourceApi: 'nfl',
    text: response.data?.text ?? undefined,
    rawResponse: response,
  };
}

/**
 * Extract usable text content from a SerpAPI response.
 */
export function extractFromSerpApi(response: SerpApiResponse): StageResult {
  return {
    sourceApi: 'serpapi',
    text: response.data?.text ?? undefined,
    rawResponse: response,
  };
}

/**
 * Extract a StageResult from any API response based on the API type.
 */
export function extractStageResult(
  api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi',
  response: ComfyUIResponse | OllamaResponse | AccuWeatherResponse | NFLResponse | SerpApiResponse
): StageResult {
  if (api === 'comfyui') {
    return extractFromComfyUI(response as ComfyUIResponse);
  }
  if (api === 'accuweather') {
    return extractFromAccuWeather(response as AccuWeatherResponse);
  }
  if (api === 'nfl') {
    return extractFromNFL(response as NFLResponse);
  }
  if (api === 'serpapi') {
    return extractFromSerpApi(response as SerpApiResponse);
  }
  return extractFromOllama(response as OllamaResponse);
}

/**
 * Build a context prompt for the final Ollama pass.
 * Combines the original user prompt with the intermediate API result
 * so Ollama can provide a conversational response.
 */
export function buildFinalPassPrompt(
  originalPrompt: string,
  stageResult: StageResult
): string {
  const parts: string[] = [];

  if (stageResult.sourceApi === 'comfyui') {
    if (stageResult.images && stageResult.images.length > 0) {
      parts.push(`The system generated ${stageResult.images.length} image(s) based on the user's request.`);
      parts.push(`Image URLs: ${stageResult.images.join(', ')}`);
    }
    if (stageResult.text && !stageResult.text.startsWith('[Generated')) {
      parts.push(`Additional output: ${stageResult.text}`);
    }
  } else if (stageResult.sourceApi === 'ollama') {
    if (stageResult.text) {
      parts.push(`Previous analysis result: ${stageResult.text}`);
    }
  } else if (stageResult.sourceApi === 'accuweather') {
    if (stageResult.text) {
      parts.push(`The following weather data was retrieved from AccuWeather:`);
      parts.push('');
      parts.push(stageResult.text);
    }
  } else if (stageResult.sourceApi === 'serpapi') {
    if (stageResult.text) {
      parts.push(`The following search results were retrieved from Google:`);
      parts.push('');
      parts.push(stageResult.text);
    }
  }

  parts.push('');
  parts.push(`The user's original request was: "${originalPrompt}"`);
  parts.push('');
  parts.push('Please provide a helpful, conversational response incorporating the above results. Be concise and natural.');

  return parts.join('\n');
}
