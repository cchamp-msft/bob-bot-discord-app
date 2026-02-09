import { config, KeywordConfig } from './config';
import { logger } from './logger';
import { ollamaClient, OllamaResponse } from '../api/ollamaClient';
import { requestQueue } from './requestQueue';
import { ChatMessage } from '../types';

/**
 * Build the system prompt for context evaluation.
 * Instructs Ollama to determine how many recent context messages are relevant
 * to the current user prompt.
 */
export function buildContextEvalPrompt(minDepth: number, maxDepth: number): string {
  return [
    'You are a context relevance evaluator. Your job is to determine how many recent conversation messages are relevant to the current user prompt.',
    '',
    'You will be given a list of conversation messages (numbered from most recent to oldest) and the current user prompt.',
    'Determine how many of the most recent messages should be included as context for responding to the user.',
    '',
    'Rules:',
    `- You MUST include at least ${minDepth} message(s) (the most recent ones are always included).`,
    `- You may include up to ${maxDepth} message(s) total.`,
    '- Prioritize newest messages over older ones.',
    '- If messages vary topics too greatly, use the most recent topic, and feel free to transition.',
    '- Respond with ONLY a single integer — the number of most-recent messages to include.',
    '- Do not include any explanation, punctuation, or extra text.',
  ].join('\n');
}

/**
 * Format conversation history for the evaluator prompt.
 * Messages are listed from most recent (1) to oldest (N) so Ollama
 * can reason about recency.
 */
function formatHistoryForEval(messages: ChatMessage[]): string {
  // Reverse to show newest first (depth 1 = newest)
  const reversed = [...messages].reverse();
  return reversed
    .map((msg, i) => `[${i + 1}] (${msg.role}): ${msg.content}`)
    .join('\n');
}

/**
 * Evaluate the conversation history and return a filtered version
 * that respects the keyword's context filter settings.
 *
 * If the keyword does not have context filtering enabled, returns
 * the history unchanged.
 *
 * Depth is counted from the newest message (newest = depth 1).
 * The most recent `minDepth` messages are always included even if
 * Ollama considers them off-topic. Ollama decides how many additional
 * messages (up to `maxDepth`) are relevant.
 *
 * @param conversationHistory - Collected history, oldest-to-newest.
 * @param userPrompt - The current user message content.
 * @param keywordConfig - The keyword config (may have context filter settings).
 * @param requester - Username for logging / queue attribution.
 * @param signal - Optional abort signal for timeout coordination.
 * @returns Filtered conversation history (oldest-to-newest).
 */
export async function evaluateContextWindow(
  conversationHistory: ChatMessage[],
  userPrompt: string,
  keywordConfig: KeywordConfig,
  requester: string,
  signal?: AbortSignal
): Promise<ChatMessage[]> {
  // ── Guard: filter disabled or nothing to filter ───────────────
  if (keywordConfig.contextFilterEnabled !== true) {
    return conversationHistory;
  }

  // Skip system messages when counting depth — they're injected, not user context
  const nonSystemMessages = conversationHistory.filter(m => m.role !== 'system');
  const systemMessages = conversationHistory.filter(m => m.role === 'system');

  if (nonSystemMessages.length === 0) {
    return conversationHistory;
  }

  const minDepth = keywordConfig.contextFilterMinDepth ?? 1;
  const maxDepth = keywordConfig.contextFilterMaxDepth ?? config.getReplyChainMaxDepth();

  // If history is already within minDepth, no filtering needed
  if (nonSystemMessages.length <= minDepth) {
    return conversationHistory;
  }

  // Candidate window: the last `maxDepth` non-system messages
  const candidateCount = Math.min(maxDepth, nonSystemMessages.length);
  const candidates = nonSystemMessages.slice(-candidateCount);

  // If candidate window is within minDepth, keep them all
  if (candidates.length <= minDepth) {
    return [...systemMessages, ...candidates];
  }

  // ── Call Ollama to evaluate relevance ─────────────────────────
  const systemPrompt = buildContextEvalPrompt(minDepth, maxDepth);
  const formattedHistory = formatHistoryForEval(candidates);
  const evalPrompt = `Conversation messages (most recent first):\n${formattedHistory}\n\nCurrent user prompt: ${userPrompt}`;

  try {
    logger.log('success', 'system',
      `CONTEXT-EVAL: Evaluating ${candidates.length} messages (min=${minDepth}, max=${maxDepth}) for keyword "${keywordConfig.keyword}"`);

    const response: OllamaResponse = await requestQueue.execute(
      'ollama',
      requester,
      '__ctx_eval__',
      keywordConfig.timeout ?? config.getDefaultTimeout(),
      (queueSignal) => {
        const combinedSignal = signal
          ? AbortSignal.any([signal, queueSignal])
          : queueSignal;

        return ollamaClient.generate(
          evalPrompt,
          requester,
          config.getOllamaModel(),
          [{ role: 'system', content: systemPrompt }],
          combinedSignal
        );
      }
    );

    if (!response.success || !response.data?.text) {
      logger.logWarn('system',
        `CONTEXT-EVAL: Evaluation failed (${response.error ?? 'no response'}), returning full history`);
      return conversationHistory;
    }

    const rawResult = response.data.text.trim();
    const parsed = parseInt(rawResult, 10);

    if (isNaN(parsed)) {
      logger.logWarn('system',
        `CONTEXT-EVAL: Ollama returned non-numeric "${rawResult}", returning full history`);
      return conversationHistory;
    }

    // Clamp to [minDepth, maxDepth] and available messages
    const includeCount = Math.max(minDepth, Math.min(parsed, maxDepth, candidates.length));

    logger.log('success', 'system',
      `CONTEXT-EVAL: Including ${includeCount} of ${candidates.length} context messages`);

    // Take the last `includeCount` from candidates (preserves oldest→newest order)
    const filtered = candidates.slice(-includeCount);

    // Re-attach any system messages at the front
    return [...systemMessages, ...filtered];
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.logError('system', `CONTEXT-EVAL: Error during evaluation: ${errorMsg}, returning full history`);
    return conversationHistory;
  }
}
