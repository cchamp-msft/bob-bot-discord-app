import { config, ToolConfig } from './config';
import { logger } from './logger';
import { requestQueue } from './requestQueue';
import { apiManager, ComfyUIResponse, XaiImageResponse, XaiVideoResponse, OllamaResponse, AccuWeatherResponse, SerpApiResponse } from '../api';
import { accuweatherClient } from '../api/accuweatherClient';
import { serpApiClient } from '../api/serpApiClient';
import { memeClient } from '../api/memeClient';
import { ApiType, ChatMessage, NFLResponse, MemeResponse, DiscordActionResponse, MediaFollowUp } from '../types';
import {
  StageResult,
  extractStageResult,
} from './responseTransformer';
import { activityEvents } from './activityEvents';
import {
  assembleReprompt,
  escapeXmlContent,
  formatAccuWeatherExternalData,
  formatNFLExternalData,
  formatSerpApiExternalData,
  formatGenericExternalData,
} from './promptBuilder';

function normalizeOneLine(text: string): string {
  const first = text.split(/\r?\n/).find(l => l.trim().length > 0) ?? '';
  return first.trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractInferenceLine(raw: string, keywordConfig: ToolConfig): string {
  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !/^```/.test(line));

  if (lines.length === 0) return '';

  const kwLower = keywordConfig.name.toLowerCase().trim();
  const kwBare = kwLower.startsWith('!') ? kwLower.slice(1) : kwLower;
  const kwEscaped = escapeRegExp(kwBare);

  for (const line of lines) {
    const stripped = stripWrappingQuotes(line);
    if (/^none$/i.test(stripped)) return 'NONE';

    const invocation = stripped.match(new RegExp(`^!?${kwEscaped}\\b(.+)$`, 'i'));
    if (!invocation) continue;

    const remainder = (invocation[1] ?? '')
      .trim()
      .replace(/^[:|;,=\-–—>]+\s*/, '')
      .trim();
    if (remainder.length > 0) return remainder;
  }

  if (keywordConfig.api === 'meme') {
    const structured = lines.find(line => /\|/.test(line));
    if (structured) return stripWrappingQuotes(structured);
  }

  return stripWrappingQuotes(normalizeOneLine(raw));
}

function stripWrappingQuotes(text: string): string {
  const t = text.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function shouldRetryAbility(result: { success: boolean }): boolean {
  if (result.success) return false;
  return true;
}

// ── Ability parameter inference ────────────────────────────────

/**
 * Build a system prompt for parameter inference.
 * Instructs Ollama to extract the required ability input from user content.
 *
 * For the meme ability, the prompt includes the full list of available
 * meme templates so the model can select an appropriate template id.
 */
function buildInferenceSystemPrompt(keywordConfig: ToolConfig): string {
  if (keywordConfig.api === 'accuweather') {
    return [
      'You extract a location from the user\u2019s message for a weather API.',
      '',
      'Rules \u2014 follow exactly:',
      '1) Output ONLY the location string. No explanations, no prefixes, no tools.',
      '2) If the user references a place indirectly (e.g. "capital of Thailand"), resolve it to the concrete name (e.g. "Bangkok").',
      '3) Prefer: "City, Region, Country" format. A zip code is acceptable if the user provided one.',
      '4) If no location can be inferred at all, output exactly: NONE',
    ].join('\n');
  }

  if (keywordConfig.api === 'meme') {
    const templateList = memeClient.getTemplateListForInference();
    const templateBlock = templateList
      ? `\n\nAvailable meme templates (use the id before the colon):\n${templateList}`
      : '';

    return [
      'You select a meme template and compose the meme text lines from the user\u2019s message.',
      '',
      'Rules \u2014 follow exactly:',
      '1) Output ONLY in this format: templateId | top text | bottom text',
      '2) Pick the template whose tone and format best match the subject, mood, or joke the user is going for.',
      '3) If the user names a specific template, use that template id.',
      '4) The number of text lines must match the template\'s expected line count.',
      '5) If no meme can be inferred at all, output exactly: NONE',
      '6) Allowed output formatting: plain text only; no markdown, no code fences, no bullets, no JSON, no XML.',
      '7) Never output explanatory text. Return exactly one line only.',
      templateBlock,
    ].join('\n');
  }

  // Generic inference prompt for other abilities
  return [
    'You extract the required parameters from the user\u2019s message for an external ability.',
    '',
    'Rules \u2014 follow exactly:',
    '1) Output ONLY the extracted parameter value(s). No explanations, no prefixes.',
    '2) If the user references something indirectly, resolve it to a concrete value.',
    '3) If no parameter can be inferred, output exactly: NONE',
  ].join('\n');
}

/**
 * Build the user prompt for parameter inference.
 * When replyContext is provided it is included so the model can resolve
 * references to earlier conversation (e.g. "imagine that" in a reply chain).
 */
function buildInferenceUserPrompt(keywordConfig: ToolConfig, content: string, replyContext?: string): string {
  const extractionLine = keywordConfig.api === 'meme'
    ? 'Extract meme parameters and output ONLY: templateId | top text | bottom text'
    : 'Extract the required parameter from the user message above. Output ONLY the value.';

  const parts: string[] = [
    '<ability_context>',
    renderAbilityInputsForPrompt(keywordConfig),
    '</ability_context>',
    '',
  ];

  if (replyContext) {
    parts.push(`<reply_context>${escapeXmlContent(replyContext)}</reply_context>`, '');
  }

  parts.push(
    `<user_message>${escapeXmlContent(content)}</user_message>`,
    '',
    extractionLine,
  );

  return parts.join('\n');
}

/**
 * Infer ability parameters from user content using Ollama.
 *
 * When the two-stage fallback classifier matches a tool but no inline
 * parameters were provided, this function asks Ollama to extract the
 * required inputs from the user\u2019s original message based on the
 * tool\u2019s ability metadata.
 *
 * @returns The inferred parameter string, or null if inference failed or
 *          the model could not extract a meaningful value.
 */
export async function inferAbilityParameters(
  keywordConfig: ToolConfig,
  content: string,
  requester: string,
  signal?: AbortSignal,
  replyContext?: string
): Promise<string | null> {
  const systemPrompt = buildInferenceSystemPrompt(keywordConfig);
  const userPrompt = buildInferenceUserPrompt(keywordConfig, content, replyContext);
  const retryModel = keywordConfig.retry?.model || config.getAbilityRetryModel();

  logger.log('success', 'system',
    `INFER-PARAMS: Inferring parameters for "${keywordConfig.name}" from user content`);

  // Enhanced logging for meme inference
  if (keywordConfig.api === 'meme' && config.getMemeLoggingDebug()) {
    logger.log('success', 'system',
      `MEME-INFERENCE: Full system prompt (${systemPrompt.length} chars):\n${systemPrompt}`);
    logger.log('success', 'system',
      `MEME-INFERENCE: Full user prompt (${userPrompt.length} chars):\n${userPrompt}`);
  }

  try {
    const result = await requestQueue.execute(
      'ollama',
      requester,
      `${keywordConfig.name}:infer-params`,
      keywordConfig.timeout || config.getDefaultTimeout(),
      (queueSignal) => {
        const combinedSignal = signal
          ? AbortSignal.any([signal, queueSignal])
          : queueSignal;

        return apiManager.executeRequest(
          'ollama',
          requester,
          userPrompt,
          keywordConfig.timeout || config.getDefaultTimeout(),
          retryModel,
          [{ role: 'system', content: systemPrompt }],
          combinedSignal,
          undefined,
          { includeSystemPrompt: false, timeout: config.getAbilityRetryTimeout() }
        );
      }
    ) as OllamaResponse;

    if (!result.success || !result.data?.text) {
      logger.logWarn('system',
        `INFER-PARAMS: Inference failed for "${keywordConfig.name}": ${result.error ?? 'no response'}`);
      return null;
    }

    const raw = result.data.text.trim();
    const inferred = extractInferenceLine(raw, keywordConfig);

    if (!inferred || inferred.toLowerCase() === 'none') {
      logger.log('success', 'system',
        `INFER-PARAMS: Could not infer parameters for "${keywordConfig.name}" — model returned NONE`);
      return null;
    }

    logger.log('success', 'system',
      `INFER-PARAMS: Inferred "${inferred}" for "${keywordConfig.name}"`);

    // Enhanced logging for meme inference — full output only when enabled
    if (keywordConfig.api === 'meme' && config.getMemeLoggingDebug()) {
      logger.log('success', 'system',
        `MEME-INFERENCE: Ollama raw response: "${raw}"`);
      logger.log('success', 'system',
        `MEME-INFERENCE: Resolved inference: "${inferred}"`);
    }

    return inferred;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.logError('system', `INFER-PARAMS: Inference error for "${keywordConfig.name}": ${msg}`);
    return null;
  }
}

function renderAbilityInputsForPrompt(keywordConfig: ToolConfig): string {
  const parts: string[] = [];
  parts.push(`Ability tool: ${keywordConfig.name}`);
  parts.push(`Ability api: ${keywordConfig.api}`);
  parts.push(`Ability description: ${keywordConfig.abilityText ?? keywordConfig.description}`);
  if (keywordConfig.abilityWhen) parts.push(`When: ${keywordConfig.abilityWhen}`);
  if (keywordConfig.abilityInputs) {
    const i = keywordConfig.abilityInputs;
    parts.push(`Inputs mode: ${i.mode}`);
    if (i.required?.length) parts.push(`Required inputs: ${i.required.join(', ')}`);
    if (i.optional?.length) parts.push(`Optional inputs: ${i.optional.join(', ')}`);
    if (i.validation) parts.push(`Validation: ${i.validation}`);
    if (i.examples?.length) parts.push(`Examples: ${i.examples.join(' | ')}`);
  }
  return parts.join('\n');
}

function buildRetrySystemPrompt(keywordConfig: ToolConfig): string {
  return [
    `You refine parameters for an external ability (${keywordConfig.api}) so it can succeed.`,
    'Rules — follow exactly:',
    '1) Output ONLY the refined parameters. No explanations.',
    '2) Stay as close as possible to the original intent; only add specificity/format fixes.',
  ].join('\n');
}

function buildRetryUserPrompt(args: {
  keywordConfig: ToolConfig;
  originalContent: string;
  lastAttemptContent: string;
  error: string;
}): string {
  const { keywordConfig, originalContent, lastAttemptContent, error } = args;

  // Allow per-tool prompt override, else use global prompt as a tail instruction.
  const globalTail = config.getAbilityRetryPrompt();
  const toolTail = keywordConfig.retry?.prompt;
  const tail = (toolTail && toolTail.trim().length > 0) ? toolTail : globalTail;

  return [
    '<ability_context>',
    renderAbilityInputsForPrompt(keywordConfig),
    '</ability_context>',
    '',
    `<original_user_input>${escapeXmlContent(originalContent)}</original_user_input>`,
    `<last_attempt_input>${escapeXmlContent(lastAttemptContent)}</last_attempt_input>`,
    `<error>${escapeXmlContent(error)}</error>`,
    '',
    tail,
  ].join('\n');
}

/**
 * Result of a routed (potentially multi-stage) API pipeline.
 */
export interface RoutedResult {
  /** The final API response to present to the user. */
  finalResponse: ComfyUIResponse | OllamaResponse | AccuWeatherResponse | NFLResponse | SerpApiResponse | MemeResponse | DiscordActionResponse;
  /** The API type that produced the final response (for handler dispatch). */
  finalApi: ApiType;
  /** Intermediate stage results (for debugging/logging). */
  stages: StageResult[];
  /** Media follow-ups to send after the text reply (ComfyUI attachments, meme URLs, etc.). */
  media: MediaFollowUp[];
}

/**
 * Format a single API result as <external_data> XML for use in a final Ollama pass.
 * Used when combining multiple tool results into one final pass.
 */
export function formatApiResultAsExternalData(
  keywordConfig: ToolConfig,
  primaryResult: ComfyUIResponse | OllamaResponse | AccuWeatherResponse | NFLResponse | SerpApiResponse | MemeResponse | DiscordActionResponse,
  queryContent?: string
): string {
  const primaryExtracted = extractStageResult(keywordConfig.api, primaryResult);
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
    return formatAccuWeatherExternalData(locationName, aiContext);
  }
  if (keywordConfig.api === 'nfl') {
    const nflResponse = primaryResult as NFLResponse;
    const nflData = nflResponse.data?.text ?? 'No NFL data available.';
    return formatNFLExternalData(keywordConfig.name, nflData);
  }
  if (keywordConfig.api === 'serpapi') {
    const serpResponse = primaryResult as SerpApiResponse;
    const rawData = serpResponse.data?.raw;
    const searchContext = rawData
      ? serpApiClient.formatSearchContextForAI(rawData as Parameters<typeof serpApiClient.formatSearchContextForAI>[0], queryContent ?? '')
      : serpResponse.data?.text ?? 'No search data available.';
    return formatSerpApiExternalData(queryContent ?? '', searchContext);
  }
  const genericText = primaryExtracted.text ?? 'No data available.';
  return formatGenericExternalData(keywordConfig.api, genericText);
}

/**
 * Execute an API request with an optional final Ollama refinement pass.
 *
 * Flow:
 * 1. Execute the primary API request (keywordConfig.api)
 * 2. For non-Ollama APIs, pass the result through a mandatory Ollama
 *    final pass for conversational refinement (abilities context is NOT
 *    included to prevent endless API call loops)
 *
 * The two-stage tool evaluation (Ollama → parseFirstLineKeyword → API) is
 * handled by the message handler, not this function. This function only
 * handles the API execution + optional retry loop + optional final formatting pass.
 *
 * @param keywordConfig - The tool configuration with routing fields.
 * @param content - The user's prompt text.
 * @param requester - Username for logging and queue attribution.
 * @param conversationHistory - Optional chat history for Ollama requests.
 * @param signal - Optional abort signal for timeout coordination.
 * @returns The routed result containing final response and stage history.
 */
export async function executeRoutedRequest(
  keywordConfig: ToolConfig,
  content: string,
  requester: string,
  conversationHistory?: ChatMessage[],
  botDisplayName?: string,
  signal?: AbortSignal,
  options?: { skipFinalPass?: boolean },
  dmHistory?: ChatMessage[]
): Promise<RoutedResult> {
  const stages: StageResult[] = [];

  // ── Primary API request ───────────────────────────────────────
  logger.log('success', 'system', `API-ROUTING: Executing ${keywordConfig.api} request for "${keywordConfig.name}"`);
  const apiType = keywordConfig.api as ApiType;
  const originalContent = content;
  let attemptContent = content;
  const attemptedInputs = new Set<string>([attemptContent.trim().toLowerCase()]);

  const effectiveRetryEnabled = (keywordConfig.retry?.enabled ?? config.getAbilityRetryEnabled()) === true;
  const effectiveMaxRetries = keywordConfig.retry?.maxRetries ?? config.getAbilityRetryMaxRetries();
  const retryModel = keywordConfig.retry?.model || config.getAbilityRetryModel();

  const runAbility = async (labelSuffix: string, input: string) => {
    return await requestQueue.execute(
      keywordConfig.api,
      requester,
      `${keywordConfig.name}${labelSuffix}`,
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
          undefined,
          undefined,
          keywordConfig.name
        ),
      signal
    ) as ComfyUIResponse | OllamaResponse | AccuWeatherResponse | NFLResponse | SerpApiResponse | MemeResponse;
  };

  let primaryResult = await runAbility('', attemptContent);
  let primaryExtracted = extractStageResult(keywordConfig.api, primaryResult);
  stages.push(primaryExtracted);

  // ── Retry loop (parameter refinement) ────────────────────────
  if (!primaryResult.success && effectiveRetryEnabled && effectiveMaxRetries > 0 && shouldRetryAbility(primaryResult)) {
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
        `${keywordConfig.name}:retry-refine:${attempt}`,
        keywordConfig.timeout,
        (sig) =>
          apiManager.executeRequest(
            'ollama',
            requester,
            userPrompt,
            keywordConfig.timeout,
            retryModel,
            [{ role: 'system', content: systemPrompt }],
            sig,
            undefined,
            { includeSystemPrompt: false, timeout: config.getAbilityRetryTimeout() }
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

      if (attemptedInputs.has(refined.trim().toLowerCase())) {
        logger.logWarn('system', `API-ROUTING: Retry refinement repeated a prior input (attempt ${attempt}); aborting retries`);
        break;
      }
      attemptedInputs.add(refined.trim().toLowerCase());

      attemptContent = refined;
      logger.logDebug('system', `API-ROUTING: Retry attempt ${attempt} for ${keywordConfig.api} with refined input: "${attemptContent}"`);

      primaryResult = await runAbility(`:retry:${attempt}`, attemptContent);
      primaryExtracted = extractStageResult(keywordConfig.api, primaryResult);
      stages.push(primaryExtracted);

      if (primaryResult.success) {
        logger.log('success', 'system', `API-ROUTING: ${keywordConfig.api} succeeded after retry attempt ${attempt}`);
        break;
      }

      if (!shouldRetryAbility(primaryResult)) {
        logger.logWarn('system', `API-ROUTING: ${keywordConfig.api} failed after retry attempt ${attempt} with non-retryable error; stopping retries`);
        break;
      }
    }
  }

  if (!primaryResult.success) {
    logger.logError('system', `API-ROUTING: ${keywordConfig.api} request failed: ${primaryResult.error}`);
    return { finalResponse: primaryResult, finalApi: keywordConfig.api, stages, media: [] };
  }

  logger.log('success', 'system', `API-ROUTING: ${keywordConfig.api} request complete`);

  // ── Skip individual final pass when caller will run a combined pass ──
  if (options?.skipFinalPass) {
    logger.log('success', 'system', 'API-ROUTING: Skipping individual final pass (caller handles combined pass)');
    return { finalResponse: primaryResult, finalApi: keywordConfig.api, stages, media: [] };
  }

  // ── Mandatory final Ollama pass for all non-Ollama APIs ────────
  // Don't double-pass through Ollama if the primary API was already Ollama
  if (keywordConfig.api === 'ollama') {
    logger.log('success', 'system', 'API-ROUTING: Skipping final Ollama pass — primary API was already Ollama');
    return { finalResponse: primaryResult, finalApi: 'ollama', stages, media: [] };
  }

  logger.log('success', 'system', 'API-ROUTING: Final Ollama refinement pass');
  activityEvents.emitFinalPassThought(keywordConfig.name);

  // Use the conversation history as-is — context filtering is done once by the caller.
  // Append the triggering message to context so the model knows who is asking.
  // Guard against duplication: the caller (messageHandler) may have already
  // appended the trigger message before passing history into this function.
  let filteredHistory = conversationHistory;
  const lastMsg = filteredHistory?.[filteredHistory.length - 1];
  if (lastMsg?.contextSource !== 'trigger') {
    filteredHistory = [
      ...(filteredHistory ?? []),
      { role: 'user' as const, content: `${requester}: ${content}`, contextSource: 'trigger' as const, hasNamePrefix: true },
    ];
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
    externalDataBlock = formatNFLExternalData(keywordConfig.name, nflData);
  } else if (keywordConfig.api === 'serpapi') {
    const serpResponse = primaryResult as SerpApiResponse;
    const rawData = serpResponse.data?.raw;
    const searchContext = rawData
      ? serpApiClient.formatSearchContextForAI(rawData as Parameters<typeof serpApiClient.formatSearchContextForAI>[0], content)
      : serpResponse.data?.text ?? 'No search data available.';
    externalDataBlock = formatSerpApiExternalData(content, searchContext);
  } else if (keywordConfig.api === 'meme') {
    const memeResponse = primaryResult as MemeResponse;
    // Only pass the template name — the actual image URL is sent as a
    // separate follow-up message for Discord auto-embed.  Including the
    // URL here causes the LLM to echo it back wrapped in backticks which
    // prevents Discord from parsing it as a link.
    const memeText = memeResponse.data?.text ?? 'No meme data available.';
    externalDataBlock = formatGenericExternalData('meme', memeText);
  } else {
    const genericText = primaryExtracted.text ?? 'No data available.';
    externalDataBlock = formatGenericExternalData(keywordConfig.api, genericText);
  }

  // Build the reprompt using the standard XML template with external data.
  // System prompt excludes tool-routing rules to prevent infinite loops.
  const reprompt = assembleReprompt({
    userMessage: content,
    conversationHistory: filteredHistory,
    externalData: externalDataBlock,
    botDisplayName,
    dmHistory,
  });

  // Append final-pass prompt to persona so OLLAMA_FINAL_PASS_PROMPT
  // actually affects the model's behavior.
  const finalPassPrompt = config.getOllamaFinalPassPrompt();
  const finalSystemContent = finalPassPrompt
    ? `${reprompt.systemContent}\n\n${finalPassPrompt}`
    : reprompt.systemContent;

  const routerFpProvider = config.getProviderFinalPass();
  const routerFpApi = routerFpProvider === 'xai' ? 'xai' as const : 'ollama' as const;
  const routerFpModel = routerFpProvider === 'xai'
    ? config.getXaiFinalPassModel()
    : (config.getOllamaFinalPassModel() || undefined);
  const routerFpTimeout = routerFpProvider === 'xai' ? config.getXaiFinalPassTimeout() : config.getOllamaFinalPassTimeout();

  const finalResult = await requestQueue.execute(
    routerFpApi,
    requester,
    `${keywordConfig.name}:final`,
    keywordConfig.timeout,
    (sig) =>
      apiManager.executeRequest(
        routerFpApi,
        requester,
        reprompt.userContent,
        keywordConfig.timeout,
        routerFpModel,
        [{ role: 'system', content: finalSystemContent }],
        sig,
        undefined,
        { includeSystemPrompt: false, contextSize: config.getOllamaFinalPassContextSize(), timeout: routerFpTimeout }
      ),
    signal
  ) as OllamaResponse;

  const finalExtracted = extractStageResult('ollama', finalResult);
  stages.push(finalExtracted);

  if (!finalResult.success) {
    logger.logWarn('system', `API-ROUTING: Final Ollama pass failed: ${finalResult.error} — returning API result`);
    return { finalResponse: primaryResult, finalApi: keywordConfig.api, stages, media: [] };
  }

  logger.log('success', 'system', 'API-ROUTING: Final Ollama pass complete');
  const media: MediaFollowUp[] = [];
  if (keywordConfig.api === 'comfyui') {
    media.push({ kind: 'comfyui', response: primaryResult as ComfyUIResponse });
  }
  if (keywordConfig.api === 'xai-image') {
    const xaiResp = primaryResult as XaiImageResponse;
    if (xaiResp.data?.images?.length) {
      media.push({ kind: 'xai-image', images: xaiResp.data.images, savedOutputs: xaiResp.data.savedOutputs });
    }
  }
  if (keywordConfig.api === 'xai-video') {
    const xaiResp = primaryResult as XaiVideoResponse;
    if (xaiResp.data?.url) {
      media.push({ kind: 'xai-video', url: xaiResp.data.url, duration: xaiResp.data.duration, savedOutputs: xaiResp.data.savedOutputs });
    }
  }
  if (keywordConfig.api === 'meme') {
    const url = (primaryResult as MemeResponse).data?.imageUrl;
    if (url) media.push({ kind: 'url', url, label: 'meme' });
  }
  return { finalResponse: finalResult, finalApi: 'ollama', stages, media };
}
