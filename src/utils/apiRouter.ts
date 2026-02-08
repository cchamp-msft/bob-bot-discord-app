import { config, KeywordConfig } from './config';
import { logger } from './logger';
import { requestQueue } from './requestQueue';
import { apiManager, ComfyUIResponse, OllamaResponse, AccuWeatherResponse } from '../api';
import { accuweatherClient } from '../api/accuweatherClient';
import { nflClient } from '../api/nflClient';
import { ChatMessage, NFLResponse } from '../types';
import {
  StageResult,
  extractStageResult,
  buildFinalPassPrompt,
} from './responseTransformer';

/**
 * Result of a routed (potentially multi-stage) API pipeline.
 */
export interface RoutedResult {
  /** The final API response to present to the user. */
  finalResponse: ComfyUIResponse | OllamaResponse | AccuWeatherResponse | NFLResponse;
  /** The API type that produced the final response (for handler dispatch). */
  finalApi: 'comfyui' | 'ollama' | 'accuweather' | 'nfl';
  /** Intermediate stage results (for debugging/logging). */
  stages: StageResult[];
}

/**
 * Execute an API request with an optional final Ollama refinement pass.
 *
 * Flow:
 * 1. Execute the primary API request (keywordConfig.api)
 * 2. If finalOllamaPass is true, pass the result through Ollama for
 *    conversational refinement (abilities context is NOT included to
 *    prevent endless API call loops)
 *
 * The two-stage keyword evaluation (Ollama → classifyIntent → API) is
 * handled by the message handler, not this function. This function only
 * handles the API execution + optional final formatting pass.
 *
 * @param keywordConfig - The keyword configuration with routing fields.
 * @param content - The user's prompt text.
 * @param requester - Username for logging and queue attribution.
 * @param conversationHistory - Optional chat history for Ollama requests.
 * @param signal - Optional abort signal for timeout coordination.
 * @returns The routed result containing final response and stage history.
 */
export async function executeRoutedRequest(
  keywordConfig: KeywordConfig,
  content: string,
  requester: string,
  conversationHistory?: ChatMessage[],
  signal?: AbortSignal
): Promise<RoutedResult> {
  const stages: StageResult[] = [];
  const needsFinalPass = keywordConfig.finalOllamaPass === true;

  // ── Primary API request ───────────────────────────────────────
  logger.log('success', 'system', `ROUTER: Executing ${keywordConfig.api} request for "${keywordConfig.keyword}"`);

  let primaryResult: ComfyUIResponse | OllamaResponse | AccuWeatherResponse | NFLResponse;

  if (keywordConfig.api === 'nfl') {
    // NFL requests bypass the generic apiManager and use the NFL client directly
    primaryResult = await requestQueue.execute(
      'nfl',
      requester,
      keywordConfig.keyword,
      keywordConfig.timeout,
      (sig) => nflClient.handleRequest(content, keywordConfig.keyword, sig),
      signal
    ) as NFLResponse;
  } else {
    primaryResult = await requestQueue.execute(
      keywordConfig.api,
      requester,
      keywordConfig.keyword,
      keywordConfig.timeout,
      (sig) =>
        apiManager.executeRequest(
          keywordConfig.api as 'comfyui' | 'ollama' | 'accuweather',
          requester,
          content,
          keywordConfig.timeout,
          undefined,
          conversationHistory?.length ? conversationHistory : undefined,
          sig,
          keywordConfig.accuweatherMode
        ),
      signal
    ) as ComfyUIResponse | OllamaResponse | AccuWeatherResponse;
  }

  const primaryExtracted = extractStageResult(keywordConfig.api, primaryResult);
  stages.push(primaryExtracted);

  if (!primaryResult.success) {
    logger.logError('system', `ROUTER: ${keywordConfig.api} request failed: ${primaryResult.error}`);
    return { finalResponse: primaryResult, finalApi: keywordConfig.api, stages };
  }

  logger.log('success', 'system', `ROUTER: ${keywordConfig.api} request complete`);

  // ── Final Ollama pass (if configured) ─────────────────────────
  if (needsFinalPass) {
    // Don't double-pass through Ollama if the primary API was already Ollama
    if (keywordConfig.api === 'ollama') {
      logger.log('success', 'system', 'ROUTER: Skipping final Ollama pass — primary API was already Ollama');
      return { finalResponse: primaryResult, finalApi: 'ollama', stages };
    }

    logger.log('success', 'system', 'ROUTER: Final Ollama refinement pass');

    // Build final prompt — use structured AI context for AccuWeather and NFL
    let finalPrompt: string;
    if (keywordConfig.api === 'accuweather') {
      const awResponse = primaryResult as AccuWeatherResponse;
      const locationName = awResponse.data?.location
        ? `${awResponse.data.location.LocalizedName}, ${awResponse.data.location.AdministrativeArea.ID}, ${awResponse.data.location.Country.LocalizedName}`
        : 'Unknown location';
      const aiContext = accuweatherClient.formatWeatherContextForAI(
        locationName,
        awResponse.data?.current ?? null,
        awResponse.data?.forecast ?? null
      );
      finalPrompt = `${aiContext}\n\nUser request: ${content}\n\nPlease provide a helpful, conversational response based on the weather data above. Be concise and natural.`;
    } else if (keywordConfig.api === 'nfl') {
      const nflResponse = primaryResult as NFLResponse;
      const nflData = nflResponse.data?.text ?? 'No NFL data available.';
      finalPrompt = `[NFL Game Data]\n${nflData}\n[End NFL Data]\n\nUser request: ${content}\n\nPlease provide a helpful, conversational response based on the NFL data above. Be concise and natural.`;
    } else {
      finalPrompt = buildFinalPassPrompt(content, primaryExtracted);
    }

    const finalResult = await requestQueue.execute(
      'ollama',
      requester,
      `${keywordConfig.keyword}:final`,
      keywordConfig.timeout,
      (sig) =>
        apiManager.executeRequest(
          'ollama',
          requester,
          finalPrompt,
          keywordConfig.timeout,
          config.getOllamaFinalPassModel() || undefined,
          conversationHistory?.length ? conversationHistory : undefined,
          sig
        ),
      signal
    ) as OllamaResponse;

    const finalExtracted = extractStageResult('ollama', finalResult);
    stages.push(finalExtracted);

    if (!finalResult.success) {
      logger.logWarn('system', `ROUTER: Final Ollama pass failed: ${finalResult.error} — returning API result`);
      return { finalResponse: primaryResult, finalApi: keywordConfig.api, stages };
    }

    logger.log('success', 'system', 'ROUTER: Final Ollama pass complete');
    return { finalResponse: finalResult, finalApi: 'ollama', stages };
  }

  return { finalResponse: primaryResult, finalApi: keywordConfig.api, stages };
}
