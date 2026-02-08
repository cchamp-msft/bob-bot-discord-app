import { KeywordConfig } from './config';
import { logger } from './logger';
import { requestQueue } from './requestQueue';
import { apiManager, ComfyUIResponse, OllamaResponse, AccuWeatherResponse } from '../api';
import { accuweatherClient } from '../api/accuweatherClient';
import { ChatMessage } from '../types';
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
  finalResponse: ComfyUIResponse | OllamaResponse | AccuWeatherResponse;
  /** The API type that produced the final response (for handler dispatch). */
  finalApi: 'comfyui' | 'ollama' | 'accuweather';
  /** Intermediate stage results (for debugging/logging). */
  stages: StageResult[];
}

/**
 * Execute a routed API request pipeline based on keyword configuration.
 *
 * Flow:
 * 1. Execute the primary API request (keywordConfig.api)
 * 2. If routeApi is specified and differs from api, execute a second request
 *    passing stage 1's result as context
 * 3. If finalOllamaPass is true, run the result through Ollama for
 *    conversational refinement
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
  const effectiveRouteApi = keywordConfig.routeApi ?? keywordConfig.api;
  const needsRouting = keywordConfig.routeApi !== undefined && keywordConfig.routeApi !== keywordConfig.api;
  const needsFinalPass = keywordConfig.finalOllamaPass === true;

  // ── Stage 1: Primary API request ──────────────────────────────
  logger.log('success', 'system', `ROUTER: Stage 1 — executing ${keywordConfig.api} request for "${keywordConfig.keyword}"`);

  const stage1Result = await requestQueue.execute(
    keywordConfig.api,
    requester,
    keywordConfig.keyword,
    keywordConfig.timeout,
    (sig) =>
      apiManager.executeRequest(
        keywordConfig.api,
        requester,
        content,
        keywordConfig.timeout,
        undefined,
        conversationHistory?.length ? conversationHistory : undefined,
        sig,
        keywordConfig.accuweatherMode
      )
  );

  const stage1Extracted = extractStageResult(keywordConfig.api, stage1Result);
  stages.push(stage1Extracted);

  // Check for stage 1 failure
  if (!stage1Result.success) {
    logger.logError('system', `ROUTER: Stage 1 failed: ${stage1Result.error}`);
    return { finalResponse: stage1Result, finalApi: keywordConfig.api, stages };
  }

  logger.log('success', 'system', `ROUTER: Stage 1 complete — ${keywordConfig.api} returned successfully`);

  // ── Stage 2: Routed API request (if configured) ──────────────
  let currentResult = stage1Result;
  let currentApi = keywordConfig.api;

  if (needsRouting && effectiveRouteApi !== 'external') {
    logger.log('success', 'system', `ROUTER: Stage 2 — routing to ${effectiveRouteApi}`);

    // Build the stage 2 prompt from stage 1's output
    let stage2Prompt: string;
    if (stage1Extracted.sourceApi === 'accuweather' && effectiveRouteApi === 'ollama') {
      // For AccuWeather → Ollama routing, use the AI-formatted context
      const awResponse = stage1Extracted.rawResponse as AccuWeatherResponse;
      const aiContext = accuweatherClient.formatWeatherContextForAI(
        awResponse.data?.location
          ? `${awResponse.data.location.LocalizedName}, ${awResponse.data.location.AdministrativeArea.ID}, ${awResponse.data.location.Country.LocalizedName}`
          : 'Unknown location',
        awResponse.data?.current ?? null,
        awResponse.data?.forecast ?? null
      );
      stage2Prompt = `${aiContext}\n\nUser request: ${content}`;
    } else {
      stage2Prompt = stage1Extracted.text
        ? `${stage1Extracted.text}\n\nOriginal request: ${content}`
        : content;
    }

    const stage2Model = keywordConfig.routeModel;

    const stage2Result = await requestQueue.execute(
      effectiveRouteApi as 'comfyui' | 'ollama' | 'accuweather',
      requester,
      `${keywordConfig.keyword}:routed`,
      keywordConfig.timeout,
      (sig) =>
        apiManager.executeRequest(
          effectiveRouteApi as 'comfyui' | 'ollama' | 'accuweather',
          requester,
          stage2Prompt,
          keywordConfig.timeout,
          stage2Model,
          undefined,
          sig
        )
    );

    const stage2Extracted = extractStageResult(effectiveRouteApi as 'comfyui' | 'ollama' | 'accuweather', stage2Result);
    stages.push(stage2Extracted);

    if (!stage2Result.success) {
      // Stage 2 failed — return stage 1 result with a warning
      logger.logWarn('system', `ROUTER: Stage 2 (${effectiveRouteApi}) failed: ${stage2Result.error} — returning stage 1 result`);
      return { finalResponse: stage1Result, finalApi: keywordConfig.api, stages };
    }

    logger.log('success', 'system', `ROUTER: Stage 2 complete — ${effectiveRouteApi} returned successfully`);
    currentResult = stage2Result;
    currentApi = effectiveRouteApi as 'comfyui' | 'ollama' | 'accuweather';
  } else if (needsRouting && effectiveRouteApi === 'external') {
    logger.logWarn('system', `ROUTER: External API routing not yet implemented — skipping stage 2`);
  }

  // ── Stage 3: Final Ollama pass (if configured) ────────────────
  if (needsFinalPass) {
    // Don't double-pass through Ollama if the last stage was already Ollama
    // and there was no routing (i.e., it would just be sending the same thing twice)
    const lastStage = stages[stages.length - 1];
    const shouldSkipFinalPass = currentApi === 'ollama' && !needsRouting;

    if (shouldSkipFinalPass) {
      logger.log('success', 'system', 'ROUTER: Skipping final Ollama pass — last stage was already Ollama with no routing');
    } else {
      logger.log('success', 'system', 'ROUTER: Stage 3 — final Ollama refinement pass');

      const finalPrompt = buildFinalPassPrompt(content, lastStage);

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
            keywordConfig.routeModel,
            conversationHistory?.length ? conversationHistory : undefined,
            sig
          )
      );

      const finalExtracted = extractStageResult('ollama', finalResult);
      stages.push(finalExtracted);

      if (!finalResult.success) {
        logger.logWarn('system', `ROUTER: Final Ollama pass failed: ${finalResult.error} — returning previous result`);
        return { finalResponse: currentResult, finalApi: currentApi, stages };
      }

      logger.log('success', 'system', 'ROUTER: Final Ollama pass complete');
      return { finalResponse: finalResult, finalApi: 'ollama', stages };
    }
  }

  return { finalResponse: currentResult, finalApi: currentApi, stages };
}
