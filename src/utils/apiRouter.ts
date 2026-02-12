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

function normalizeOneLine(text: string): string {
  const first = text.split(/\r?\n/).find(l => l.trim().length > 0) ?? '';
  return first.trim();
}

function stripWrappingQuotes(text: string): string {
  const t = text.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function shouldRetryAbility(keywordConfig: KeywordConfig, result: { success: boolean; error?: string }): boolean {
  if (result.success) return false;
  const err = (result.error ?? '').toLowerCase();

  // Initial scope: structured parameter failures for AccuWeather location resolution.
  if (keywordConfig.api === 'accuweather') {
    if (err.includes('no location specified')) return true;
    if (err.includes('could not find location')) return true;
  }

  return false;
}

function renderAbilityInputsForPrompt(keywordConfig: KeywordConfig): string {
  const parts: string[] = [];
  parts.push(`Ability keyword: ${keywordConfig.keyword}`);
  parts.push(`Ability api: ${keywordConfig.api}`);
  parts.push(`Ability description: ${keywordConfig.abilityText ?? keywordConfig.description}`);
  if (keywordConfig.abilityWhen) parts.push(`When: ${keywordConfig.abilityWhen}`);
  if (keywordConfig.abilityInputs) {
    const i = keywordConfig.abilityInputs;
    parts.push(`Inputs mode: ${i.mode}`);
    if (i.required?.length) parts.push(`Required inputs: ${i.required.join(', ')}`);
    if (i.optional?.length) parts.push(`Optional inputs: ${i.optional.join(', ')}`);
    if (i.inferFrom?.length) parts.push(`Infer from: ${i.inferFrom.join(', ')}`);
    if (i.validation) parts.push(`Validation: ${i.validation}`);
    if (i.examples?.length) parts.push(`Examples: ${i.examples.join(' | ')}`);
  }
  return parts.join('\n');
}

function buildRetrySystemPrompt(keywordConfig: KeywordConfig): string {
  // Specialized guidance for AccuWeather: must output a *specific* location string.
  if (keywordConfig.api === 'accuweather') {
    return [
      'You refine parameters for an external weather ability (AccuWeather).',
      'The ability failed to resolve the location. Your job: return a better location string.',
      '',
      'Rules — follow exactly:',
      '1) Output ONLY the refined location string. No explanations. No prefixes.',
      '2) Keep it as close as possible to the user\'s original intent, but make it more specific.',
      '3) Prefer: "City, State" (US) or "City, Region, Country" (non-US). Zip code is OK if user provided one.',
      '4) Expand abbreviations when helpful. If ambiguous, choose the most common match, but stay faithful.',
      '5) Do not invent a new unrelated location.',
    ].join('\n');
  }

  // Generic fallback (kept for future global enablement across more abilities).
  return [
    'You refine parameters for an external ability so it can succeed.',
    'Rules — follow exactly:',
    '1) Output ONLY the refined parameters. No explanations.',
    '2) Stay as close as possible to the original intent; only add specificity/format fixes.',
  ].join('\n');
}

function buildRetryUserPrompt(args: {
  keywordConfig: KeywordConfig;
  originalContent: string;
  lastAttemptContent: string;
  error: string;
}): string {
  const { keywordConfig, originalContent, lastAttemptContent, error } = args;

  // Allow per-keyword prompt override, else use global prompt as a tail instruction.
  const globalTail = config.getAbilityRetryPrompt();
  const keywordTail = keywordConfig.retry?.prompt;
  const tail = (keywordTail && keywordTail.trim().length > 0) ? keywordTail : globalTail;

  return [
    '<ability_context>',
    renderAbilityInputsForPrompt(keywordConfig),
    '</ability_context>',
    '',
    `<original_user_input>${originalContent}</original_user_input>`,
    `<last_attempt_input>${lastAttemptContent}</last_attempt_input>`,
    `<error>${error}</error>`,
    '',
    tail,
  ].join('\n');
}

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

  const apiType = keywordConfig.api as 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi';
  const originalContent = content;
  let attemptContent = content;
  const attemptedInputs = new Set<string>([attemptContent.trim()]);

  const effectiveRetryEnabled = (keywordConfig.retry?.enabled ?? config.getAbilityRetryEnabled()) === true;
  const effectiveMaxRetries = keywordConfig.retry?.maxRetries ?? config.getAbilityRetryMaxRetries();
  const retryModel = keywordConfig.retry?.model || config.getAbilityRetryModel();

  const runAbility = async (labelSuffix: string, input: string) => {
    return await requestQueue.execute(
      keywordConfig.api,
      requester,
      `${keywordConfig.keyword}${labelSuffix}`,
      keywordConfig.timeout,
      (sig) =>
        apiManager.executeRequest(
          apiType,
          requester,
          input,
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
  };

  let primaryResult = await runAbility('', attemptContent);
  let primaryExtracted = extractStageResult(keywordConfig.api, primaryResult);
  stages.push(primaryExtracted);

  // ── Retry loop (parameter refinement) ────────────────────────
  if (!primaryResult.success && effectiveRetryEnabled && effectiveMaxRetries > 0 && shouldRetryAbility(keywordConfig, primaryResult)) {
    logger.logWarn('system', `API-ROUTING: ${keywordConfig.api} failed; attempting parameter refinement retries (maxRetries=${effectiveMaxRetries})`);

    for (let attempt = 1; attempt <= effectiveMaxRetries; attempt++) {
      const error = primaryResult.error ?? 'Unknown error';

      const systemPrompt = buildRetrySystemPrompt(keywordConfig);
      const userPrompt = buildRetryUserPrompt({
        keywordConfig,
        originalContent,
        lastAttemptContent: attemptContent,
        error,
      });

      const refineResult = await requestQueue.execute(
        'ollama',
        requester,
        `${keywordConfig.keyword}:retry-refine:${attempt}`,
        keywordConfig.timeout,
        (sig) =>
          apiManager.executeRequest(
            'ollama',
            requester,
            userPrompt,
            keywordConfig.timeout,
            retryModel || undefined,
            [{ role: 'system', content: systemPrompt }],
            sig,
            undefined,
            { includeSystemPrompt: false }
          ),
        signal
      ) as OllamaResponse;

      stages.push(extractStageResult('ollama', refineResult));

      if (!refineResult.success) {
        logger.logWarn('system', `API-ROUTING: Retry refinement failed (attempt ${attempt}): ${refineResult.error}`);
        break;
      }

      const refinedRaw = refineResult.data?.text ?? '';
      const refined = stripWrappingQuotes(normalizeOneLine(refinedRaw));
      if (!refined) {
        logger.logWarn('system', `API-ROUTING: Retry refinement returned empty input (attempt ${attempt}); aborting retries`);
        break;
      }

      if (attemptedInputs.has(refined.trim())) {
        logger.logWarn('system', `API-ROUTING: Retry refinement repeated a prior input (attempt ${attempt}); aborting retries`);
        break;
      }
      attemptedInputs.add(refined.trim());

      attemptContent = refined;
      logger.log('success', 'system', `API-ROUTING: Retry attempt ${attempt} for ${keywordConfig.api} with refined input: "${attemptContent}"`);

      primaryResult = await runAbility(`:retry:${attempt}`, attemptContent);
      primaryExtracted = extractStageResult(keywordConfig.api, primaryResult);
      stages.push(primaryExtracted);

      if (primaryResult.success) {
        logger.log('success', 'system', `API-ROUTING: ${keywordConfig.api} succeeded after retry attempt ${attempt}`);
        break;
      }

      if (!shouldRetryAbility(keywordConfig, primaryResult)) {
        logger.logWarn('system', `API-ROUTING: ${keywordConfig.api} failed after retry attempt ${attempt} with non-retryable error; stopping retries`);
        break;
      }
    }
  }

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
