import { config, KeywordConfig } from './config';
import { logger } from './logger';
import { ollamaClient, OllamaResponse } from '../api/ollamaClient';
import { requestQueue } from './requestQueue';
import { ChatMessage } from '../types';
import { formatSourceTag } from './contextFormatter';
import { activityEvents } from './activityEvents';

/**
 * Build the system prompt for context evaluation.
 * Instructs Ollama to return a JSON array of message indices that are relevant
 * to the current user prompt.
 */
export function buildContextEvalPrompt(minDepth: number, maxDepth: number): string {
  return [
    'You are a context relevance evaluator. Your job is to determine which recent conversation messages are relevant to the current user prompt.',
    '',
    'You will be given a list of conversation messages (numbered from most recent to oldest) and the current user prompt.',
    'Determine which messages should be included as context for responding to the user.',
    '',
    'Rules:',
    `- You MUST always include at least indices 1 through ${minDepth} (the most recent messages).`,
    `- You may include up to ${maxDepth} message(s) total.`,
    '- Prioritize newer messages over older ones — only include older messages when clearly relevant.',
    '- Messages tagged [reply] or [thread] are from a direct reply chain or thread and are generally more relevant than [channel] messages.',
    '- If messages vary topics too greatly, prefer the most recent topic.',
    '- You may select non-contiguous messages (e.g. 1, 3, 5) if only specific older messages are relevant.',
    '- Respond with ONLY a JSON array of integer indices — e.g. [1, 2, 4].',
    '- Do not include any explanation, punctuation, or extra text outside of the JSON array.',
  ].join('\n');
}

/**
 * Format conversation history for the evaluator prompt.
 * Messages are listed from most recent (1) to oldest (N) so Ollama
 * can reason about recency.  When contextSource metadata is present,
 * a subtle tag is appended so the evaluator can weight reply/thread
 * messages higher than ambient channel messages.
 */
export function formatHistoryForEval(messages: ChatMessage[]): string {
  // Reverse to show newest first (depth 1 = newest)
  const reversed = [...messages].reverse();
  return reversed
    .map((msg, i) => {
      const tag = formatSourceTag(msg);
      return `[${i + 1}] (${msg.role})${tag}: ${msg.content}`;
    })
    .join('\n');
}

/**
 * Extract the first JSON array substring from raw model output.
 *
 * Handles common model formatting quirks:
 * - Code fences: ```json\n[1, 2]\n```
 * - Leading/trailing commentary: "Selected: [1, 2]"
 * - Trailing commas inside the array: [1, 2,]
 *
 * Returns the extracted substring ready for JSON.parse, or null if
 * no bracket-delimited array is found.
 */
export function extractJsonArray(text: string): string | null {
  // Strip code fences (```json ... ``` or ``` ... ```)
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/i;
  const fenceMatch = text.match(fencePattern);
  const cleaned = fenceMatch ? fenceMatch[1].trim() : text;

  // Find the first '[' and its matching ']'
  const start = cleaned.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '[') depth++;
    else if (cleaned[i] === ']') depth--;
    if (depth === 0) {
      let candidate = cleaned.slice(start, i + 1);
      // Remove trailing commas before closing bracket: [1, 2,] → [1, 2]
      candidate = candidate.replace(/,\s*]/, ']');
      return candidate;
    }
  }

  return null;
}

/**
 * Parse Ollama's context-eval response into a validated array of 1-based indices.
 *
 * Attempts JSON array parse first; falls back to legacy integer parse
 * (interpreted as "most recent N"). Returns null if both fail.
 *
 * @param raw - Raw model output text.
 * @param candidateCount - Number of candidate messages shown to the model.
 * @param minDepth - Minimum required newest indices.
 * @param maxDepth - Maximum allowed indices.
 * @returns Sorted array of valid 1-based indices, or null on parse failure.
 */
export function parseEvalResponse(
  raw: string,
  candidateCount: number,
  minDepth: number,
  maxDepth: number
): number[] | null {
  const trimmed = raw.trim();

  // ── Attempt 1: JSON array of integers ─────────────────────────
  // Try strict JSON.parse first, then fall back to extracting the first
  // JSON array substring. Models sometimes wrap the array in code fences,
  // trailing commas, or leading commentary.
  const jsonCandidate = extractJsonArray(trimmed);
  if (jsonCandidate !== null) {
    try {
      const parsed = JSON.parse(jsonCandidate);
      if (Array.isArray(parsed) && parsed.every(v => typeof v === 'number' && Number.isInteger(v))) {
        // Deduplicate and filter to valid range [1, candidateCount]
        let indices = [...new Set(parsed as number[])].filter(i => i >= 1 && i <= candidateCount);

        // Enforce minDepth: always include 1..minDepth
        for (let i = 1; i <= Math.min(minDepth, candidateCount); i++) {
          if (!indices.includes(i)) indices.push(i);
        }

        // Sort ascending (by index — 1 = newest)
        indices.sort((a, b) => a - b);

        // Enforce maxDepth: drop the highest indices first (oldest messages)
        if (indices.length > maxDepth) {
          indices = indices.slice(0, maxDepth);
        }

        return indices;
      }
    } catch {
      // Extracted substring wasn't valid JSON — fall through
    }
  }

  // ── Attempt 2: Legacy integer ("include the most recent N messages") ──
  const asInt = parseInt(trimmed, 10);
  if (!isNaN(asInt)) {
    const count = Math.max(minDepth, Math.min(asInt, maxDepth, candidateCount));
    return Array.from({ length: count }, (_, i) => i + 1);
  }

  return null;
}

/**
 * Evaluate the conversation history and return a filtered version.
 *
 * Context evaluation is only applied when global context evaluation is enabled.
 * System messages (e.g. abilities context) are excluded from evaluation
 * and are NOT returned — callers attach their own system context after
 * this function returns.
 *
 * Depth is counted from the newest message (newest = index 1).
 * The most recent `minDepth` messages are always included even if
 * Ollama considers them off-topic. Ollama returns a JSON array of
 * indices selecting which messages to keep (sparse selection).
 *
 * @param conversationHistory - Collected history, oldest-to-newest.
 * @param userPrompt - The current user message content.
 * @param keywordConfig - The keyword config (may have context filter settings).
 * @param requester - Username for logging / queue attribution.
 * @param signal - Optional abort signal for timeout coordination.
 * @returns Filtered conversation history (oldest-to-newest), system messages excluded.
 */
export async function evaluateContextWindow(
  conversationHistory: ChatMessage[],
  userPrompt: string,
  keywordConfig: KeywordConfig,
  requester: string,
  signal?: AbortSignal
): Promise<ChatMessage[]> {
  // If global context evaluation is disabled, skip evaluation and return history unchanged
  if (!config.getContextEvalEnabled()) {
    return conversationHistory;
  }

  // Exclude system messages entirely — they must not be evaluated or returned
  const nonSystemMessages = conversationHistory.filter(m => m.role !== 'system');

  if (nonSystemMessages.length === 0) {
    return [];
  }

  const minDepth = keywordConfig.contextFilterMinDepth ?? 1;
  const maxDepth = keywordConfig.contextFilterMaxDepth ?? config.getReplyChainMaxDepth();

  // If history is already within minDepth, no filtering needed
  if (nonSystemMessages.length <= minDepth) {
    return nonSystemMessages;
  }

  // Build the candidate window (up to maxDepth) with source awareness:
  //   1. Take most-recent reply/thread messages first (direct conversation).
  //   2. Fill remaining slots with most-recent channel/dm messages.
  //   3. Re-sort into chronological (oldest→newest) order.
  const candidateCount = Math.min(maxDepth, nonSystemMessages.length);
  let candidates: ChatMessage[];

  const hasSource = nonSystemMessages.some(m => m.contextSource);
  if (hasSource) {
    const directMsgs = nonSystemMessages.filter(m => m.contextSource === 'reply' || m.contextSource === 'thread');
    const ambientMsgs = nonSystemMessages.filter(m => m.contextSource !== 'reply' && m.contextSource !== 'thread');
    // Take newest direct (reply/thread) first, then newest ambient, up to candidateCount
    const selectedDirect = directMsgs.slice(-candidateCount);
    const remainingSlots = candidateCount - selectedDirect.length;
    const selectedAmbient = remainingSlots > 0 ? ambientMsgs.slice(-remainingSlots) : [];
    candidates = [...selectedDirect, ...selectedAmbient];
    // Re-sort chronologically
    candidates.sort((a, b) => {
      const ta = a.createdAtMs ?? 0;
      const tb = b.createdAtMs ?? 0;
      return ta - tb;
    });
  } else {
    candidates = nonSystemMessages.slice(-candidateCount);
  }

  // If candidate window is within minDepth, keep them all
  if (candidates.length <= minDepth) {
    return candidates;
  }

  // ── Call Ollama to evaluate relevance ─────────────────────────
  const customPrompt = config.getContextEvalPrompt()?.trim() ?? '';
  const systemPrompt = customPrompt !== '' ? customPrompt : buildContextEvalPrompt(minDepth, maxDepth);
  const formattedHistory = formatHistoryForEval(candidates);
  const evalPrompt = `Conversation messages (most recent first):\n${formattedHistory}\n\nCurrent user prompt: ${userPrompt}`;

  try {
    logger.log('success', 'system',
      `CONTEXT-EVAL: Evaluating ${candidates.length} messages (min=${minDepth}, max=${maxDepth}) for keyword "${keywordConfig.keyword}"`);

    // DEBUG: log full context-eval prompt
    logger.logDebug('system', `CONTEXT-EVAL [system prompt]: ${systemPrompt}`);
    logger.logDebug('system', `CONTEXT-EVAL [eval prompt]: ${evalPrompt}`);

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
          config.getContextEvalModel(),
          [{ role: 'system', content: systemPrompt }],
          combinedSignal,
          {
            includeSystemPrompt: false,
            contextSize: config.getContextEvalContextSize()
          }
        );
      }
    );

    if (!response.success || !response.data?.text) {
      logger.logWarn('system',
        `CONTEXT-EVAL: Evaluation failed (${response.error ?? 'no response'}), returning full history`);
      return nonSystemMessages;
    }

    const rawResult = response.data.text.trim();
    const indices = parseEvalResponse(rawResult, candidates.length, minDepth, maxDepth);

    if (indices === null) {
      logger.logWarn('system',
        `CONTEXT-EVAL: Ollama returned unparseable "${rawResult}", returning full history`);
      return nonSystemMessages;
    }

    logger.log('success', 'system',
      `CONTEXT-EVAL: Including ${indices.length} of ${candidates.length} context messages (indices: [${indices.join(', ')}])`);

    // Surface the context-filter decision as an activity thought
    activityEvents.emitContextDecision(
      indices.length,
      candidates.length,
      keywordConfig.keyword,
      indices
    );

    // Map indices (1=newest) back to candidates (oldest→newest order).
    // Reverse the candidates to get newest-first, pick by index, then
    // re-sort into chronological (oldest→newest) order.
    const reversedCandidates = [...candidates].reverse();
    const selected = indices.map(i => reversedCandidates[i - 1]);
    // Restore chronological order by reversing the index-based order:
    // indices are sorted ascending (1,2,4…) so selected is newest-first;
    // reversing gives oldest-first.
    selected.reverse();

    return selected;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.logError('system', `CONTEXT-EVAL: Error during evaluation: ${errorMsg}, returning full history`);
    return nonSystemMessages;
  }
}
