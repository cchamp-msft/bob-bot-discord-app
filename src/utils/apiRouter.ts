import { config, KeywordConfig } from './config';
import { logger } from './logger';
import { requestQueue } from './requestQueue';
import { apiManager, ComfyUIResponse, OllamaResponse, AccuWeatherResponse, SerpApiResponse } from '../api';
import { accuweatherClient } from '../api/accuweatherClient';
import { serpApiClient } from '../api/serpApiClient';
import { ChatMessage, NFLResponse } from '../types';
import { evaluateContextWindow } from './contextEvaluator';
import {
  StageResult,
  extractStageResult,
} from './responseTransformer';
import {
  assembleReprompt,
  formatAccuWeatherExternalData,
  formatNFLExternalData,
  formatSerpApiExternalData,
  formatGenericExternalData,
} from './promptBuilder';

/**
 * Result of a routed (potentially multi-stage) API pipeline.
 */
export interface RoutedResult {
  /** The final API response to present to the user. */
  finalResponse: ComfyUIResponse | OllamaResponse | AccuWeatherResponse | NFLResponse | SerpApiResponse;
  /** The API type that produced the final response (for handler dispatch). */
  finalApi: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi';
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
  logger.log('success', 'system', `API-ROUTING: Executing ${keywordConfig.api} request for "${keywordConfig.keyword}"`);

  let primaryResult: ComfyUIResponse | OllamaResponse | AccuWeatherResponse | NFLResponse | SerpApiResponse;

  primaryResult = await requestQueue.execute(
    keywordConfig.api,
    requester,
    keywordConfig.keyword,
    keywordConfig.timeout,
    (sig) =>
      apiManager.executeRequest(
        keywordConfig.api as 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi',
        requester,
        content,
        keywordConfig.timeout,
        undefined,
        conversationHistory?.length ? conversationHistory : undefined,
        sig,
        keywordConfig.accuweatherMode,
        undefined,
        keywordConfig.keyword
      ),
    signal
  ) as ComfyUIResponse | OllamaResponse | AccuWeatherResponse | NFLResponse | SerpApiResponse;

  const primaryExtracted = extractStageResult(keywordConfig.api, primaryResult);
  stages.push(primaryExtracted);

  if (!primaryResult.success) {
    logger.logError('system', `API-ROUTING: ${keywordConfig.api} request failed: ${primaryResult.error}`);
    return { finalResponse: primaryResult, finalApi: keywordConfig.api, stages };
  }

  logger.log('success', 'system', `API-ROUTING: ${keywordConfig.api} request complete`);

  // ── Final Ollama pass (if configured) ─────────────────────────
  if (needsFinalPass) {
    // Don't double-pass through Ollama if the primary API was already Ollama
    if (keywordConfig.api === 'ollama') {
      logger.log('success', 'system', 'API-ROUTING: Skipping final Ollama pass — primary API was already Ollama');
      return { finalResponse: primaryResult, finalApi: 'ollama', stages };
    }

    logger.log('success', 'system', 'API-ROUTING: Final Ollama refinement pass');

    // Apply context filter for the final pass
    let filteredHistory = conversationHistory;
    if (conversationHistory?.length) {
      const preFilterCount = conversationHistory.filter(m => m.role !== 'system').length;
      filteredHistory = await evaluateContextWindow(
        conversationHistory,
        content,
        keywordConfig,
        requester,
        signal
      );
      logger.log('success', 'system',
        `API-ROUTING: Context-eval applied for final pass (${preFilterCount}→${filteredHistory?.length ?? 0} messages)`);
    }

    // Build final prompt — format API data as <external_data> using XML template
    let externalDataBlock: string;
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
      externalDataBlock = formatAccuWeatherExternalData(locationName, aiContext);
    } else if (keywordConfig.api === 'nfl') {
      const nflResponse = primaryResult as NFLResponse;
      const nflData = nflResponse.data?.text ?? 'No NFL data available.';
      externalDataBlock = formatNFLExternalData(keywordConfig.keyword, nflData);
    } else if (keywordConfig.api === 'serpapi') {
      const serpResponse = primaryResult as SerpApiResponse;
      const rawData = serpResponse.data?.raw;
      const searchContext = rawData
        ? serpApiClient.formatSearchContextForAI(rawData as Parameters<typeof serpApiClient.formatSearchContextForAI>[0], content)
        : serpResponse.data?.text ?? 'No search data available.';
      externalDataBlock = formatSerpApiExternalData(content, searchContext);
    } else {
      const genericText = primaryExtracted.text ?? 'No data available.';
      externalDataBlock = formatGenericExternalData(keywordConfig.api, genericText);
    }

    // Build the reprompt using the standard XML template with external data.
    // System prompt excludes keyword-routing rules to prevent infinite loops.
    const reprompt = assembleReprompt({
      userMessage: content,
      conversationHistory: filteredHistory,
      externalData: externalDataBlock,
    });

    const finalSystemContent = reprompt.systemContent;

    const finalResult = await requestQueue.execute(
      'ollama',
      requester,
      `${keywordConfig.keyword}:final`,
      keywordConfig.timeout,
      (sig) =>
        apiManager.executeRequest(
          'ollama',
          requester,
          reprompt.userContent,
          keywordConfig.timeout,
          config.getOllamaFinalPassModel() || undefined,
          [{ role: 'system', content: finalSystemContent }],
          sig,
          undefined,
          { includeSystemPrompt: false }
        ),
      signal
    ) as OllamaResponse;

    const finalExtracted = extractStageResult('ollama', finalResult);
    stages.push(finalExtracted);

    if (!finalResult.success) {
      logger.logWarn('system', `API-ROUTING: Final Ollama pass failed: ${finalResult.error} — returning API result`);
      return { finalResponse: primaryResult, finalApi: keywordConfig.api, stages };
    }

    logger.log('success', 'system', 'API-ROUTING: Final Ollama pass complete');
    return { finalResponse: finalResult, finalApi: 'ollama', stages };
  }

  return { finalResponse: primaryResult, finalApi: keywordConfig.api, stages };
}
