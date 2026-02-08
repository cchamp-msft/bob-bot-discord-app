import { config, KeywordConfig } from './config';
import { logger } from './logger';
import { ollamaClient, OllamaResponse } from '../api/ollamaClient';
import { requestQueue } from './requestQueue';

/**
 * Result of an AI-based keyword classification attempt.
 */
export interface ClassificationResult {
  /** The matched keyword config, or null if no keyword was identified. */
  keywordConfig: KeywordConfig | null;
  /** Whether the classification was performed by AI (true) or skipped/failed (false). */
  wasClassified: boolean;
}

/**
 * Build the system prompt for keyword classification.
 * Instructs Ollama to analyze user intent and return only the matching keyword.
 */
function buildClassificationPrompt(keywords: KeywordConfig[]): string {
  const keywordList = keywords
    .map((k) => `- "${k.keyword}": ${k.description}`)
    .join('\n');

  return [
    'You are a keyword classifier. Your job is to analyze the user\'s message and determine which keyword best matches their intent.',
    'You MUST respond with ONLY the keyword value — no explanation, no punctuation, no extra text.',
    'If no keyword clearly matches, respond with exactly: NONE',
    '',
    'Available keywords:',
    keywordList,
    '',
    'Rules:',
    '- Respond with exactly one keyword from the list above, or NONE.',
    '- Do not include quotes or formatting.',
    '- Match based on the user\'s intent, not literal word presence.',
  ].join('\n');
}

/**
 * Classify user intent by sending the message to Ollama with a prompt
 * injection that asks it to identify the best-matching keyword.
 *
 * This is used as a fallback when regex-based keyword matching finds no hit.
 *
 * @param content - The user's message content (after mention stripping).
 * @param requester - Username for logging.
 * @param signal - Optional abort signal for timeout coordination.
 * @returns Classification result with matched keyword config or null.
 */
export async function classifyIntent(
  content: string,
  requester: string,
  signal?: AbortSignal
): Promise<ClassificationResult> {
  const keywords = config.getKeywords();

  if (keywords.length === 0) {
    logger.log('success', 'system', 'CLASSIFIER: No keywords configured, skipping classification');
    return { keywordConfig: null, wasClassified: false };
  }

  const systemPrompt = buildClassificationPrompt(keywords);

  try {
    logger.log('success', 'system', `CLASSIFIER: Classifying intent for "${content.substring(0, 80)}..."`);

    const response: OllamaResponse = await requestQueue.execute(
      'ollama',
      requester,
      '__classify__',
      config.getDefaultTimeout(),
      (queueSignal) => {
        // Combine caller signal with queue timeout signal so the request
        // is aborted if *either* fires (prevents resource leak on timeout).
        const combinedSignal = signal
          ? AbortSignal.any([signal, queueSignal])
          : queueSignal;

        return ollamaClient.generate(
          content,
          requester,
          config.getOllamaModel(),
          [{ role: 'system', content: systemPrompt }],
          combinedSignal
        );
      }
    );

    if (!response.success || !response.data?.text) {
      logger.logError('system', `CLASSIFIER: Ollama classification failed: ${response.error ?? 'no response text'}`);
      return { keywordConfig: null, wasClassified: false };
    }

    const rawResult = response.data.text.trim().toLowerCase();

    // Strip any accidental punctuation or quotes from the response
    const cleaned = rawResult.replace(/["""''`.,!?;:]/g, '').trim();

    logger.log('success', 'system', `CLASSIFIER: Ollama returned keyword "${cleaned}"`);

    if (cleaned === 'none') {
      return { keywordConfig: null, wasClassified: true };
    }

    // Look up the keyword config by matching against registered keywords
    const matched = keywords.find(
      (k) => k.keyword.toLowerCase() === cleaned
    );

    if (!matched) {
      logger.logWarn('system', `CLASSIFIER: Ollama returned unrecognized keyword "${cleaned}", falling back`);
      return { keywordConfig: null, wasClassified: true };
    }

    logger.log('success', 'system', `CLASSIFIER: Matched keyword "${matched.keyword}" for user ${requester}`);
    return { keywordConfig: matched, wasClassified: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.logError('system', `CLASSIFIER: Classification error: ${errorMsg}`);
    return { keywordConfig: null, wasClassified: false };
  }
}

// Exported for testing
export { buildClassificationPrompt };

/**
 * Build a system-level context string describing the bot's available API abilities.
 * This helps Ollama understand what external tools are available so it can
 * suggest appropriate API calls in its response.
 *
 * Only keywords with `abilityText` configured and a non-Ollama API are included.
 * Returns empty string if no abilities are configured.
 */
export function buildAbilitiesContext(): string {
  const keywords = config.getKeywords();
  const abilities = keywords
    .filter((k) => k.abilityText && k.api !== 'ollama')
    .map((k) => `- ${k.abilityText} (keyword: "${k.keyword}")`)
    // Deduplicate entries with identical text
    .filter((item, index, self) => self.indexOf(item) === index);

  if (abilities.length === 0) return '';

  return [
    'You have access to the following abilities through external APIs:',
    ...abilities,
    '',
    'If the user\'s request relates to one of these abilities, mention the relevant keyword in your response so it can be routed to the appropriate API.',
    'Do not fabricate data for these abilities — let the API handle the request.',
  ].join('\n');
}
