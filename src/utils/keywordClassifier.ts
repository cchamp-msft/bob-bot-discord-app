import { config, ToolConfig, COMMAND_PREFIX } from './config';
import { logger } from './logger';
import { ollamaClient, OllamaResponse } from '../api/ollamaClient';
import { requestQueue } from './requestQueue';

/**
 * Result of an AI-based tool classification attempt.
 */
export interface ClassificationResult {
  /** The matched tool config, or null if no tool was identified. */
  toolConfig: ToolConfig | null;
  /** Whether the classification was performed by AI (true) or skipped/failed (false). */
  wasClassified: boolean;
}

/**
 * Build the system prompt for tool classification.
 * Instructs Ollama to analyze user intent and return only the matching tool name.
 */
function buildClassificationPrompt(tools: ToolConfig[]): string {
  // Filter out Ollama-only tools to avoid confusion during classification
  const filteredTools = tools.filter(k => k.api !== 'ollama' || k.builtin === true);
  
  const toolList = filteredTools
    .map((k) => `- "${k.name}": ${k.description}`)
    .join('\n');

  return [
    'You are a tool classifier. Your job is to analyze the user\'s message and determine which tool best matches their intent.',
    'You MUST respond with ONLY the tool name — no explanation, no punctuation, no extra text.',
    'If no tool clearly matches, respond with exactly: NONE',
    '',
    'Available tools:',
    toolList,
    '',
    'Rules:',
    '- Respond with exactly one tool name from the list above, or NONE.',
    '- Do not include quotes or formatting.',
    '- Match based on the user\'s intent, not literal word presence.',
    '- If the message is a plain answer, clarification question, or conversational filler (not a user request), return NONE.',
    '- Only return meme when the user is explicitly asking to create/generate a meme image.',
  ].join('\n');
}

/**
 * Classify user intent by sending the message to Ollama with a prompt
 * injection that asks it to identify the best-matching tool.
 *
 * This is used as a fallback when direct tool matching finds no hit.
 *
 * @param content - The user's message content (after mention stripping).
 * @param requester - Username for logging.
 * @param signal - Optional abort signal for timeout coordination.
 * @returns Classification result with matched tool config or null.
 */
export async function classifyIntent(
  content: string,
  requester: string,
  signal?: AbortSignal
): Promise<ClassificationResult> {
  const tools = config.getTools().filter(k => k.enabled !== false);

  if (tools.length === 0) {
    logger.log('success', 'system', 'CLASSIFIER: No tools configured, skipping classification');
    return { toolConfig: null, wasClassified: false };
  }

  const systemPrompt = buildClassificationPrompt(tools);

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
          combinedSignal,
          { includeSystemPrompt: false, timeout: config.getOllamaToolTimeout() }
        );
      }
    );

    if (!response.success || !response.data?.text) {
      logger.logError('system', `CLASSIFIER: Ollama classification failed: ${response.error ?? 'no response text'}`);
      return { toolConfig: null, wasClassified: false };
    }

    const rawResult = response.data.text.trim().toLowerCase();

    // Strip any accidental punctuation or quotes from the response
    const cleaned = rawResult.replace(/["""''`.,!?;:]/g, '').trim();
    // Strip the command prefix if the model included it
    const cleanedBare = cleaned.startsWith(COMMAND_PREFIX) ? cleaned.slice(COMMAND_PREFIX.length) : cleaned;

    logger.log('success', 'system', `CLASSIFIER: Ollama returned tool "${cleaned}"`);

    if (cleaned === 'none' || cleanedBare === 'none') {
      return { toolConfig: null, wasClassified: true };
    }

    // Look up the tool config by matching against registered tools
    // Support both prefixed and bare tool name matches
    const matched = tools.find(
      (k) => {
        const nameLower = k.name.toLowerCase();
        const nameBare = nameLower.startsWith(COMMAND_PREFIX) ? nameLower.slice(COMMAND_PREFIX.length) : nameLower;
        return nameLower === cleaned || nameBare === cleanedBare;
      }
    );

    if (!matched) {
      logger.logWarn('system', `CLASSIFIER: Ollama returned unrecognized tool "${cleaned}", falling back`);
      return { toolConfig: null, wasClassified: true };
    }

    logger.log('success', 'system', `CLASSIFIER: Matched tool "${matched.name}" for user ${requester}`);
    return { toolConfig: matched, wasClassified: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.logError('system', `CLASSIFIER: Classification error: ${errorMsg}`);
    return { toolConfig: null, wasClassified: false };
  }
}

// Exported for testing
export { buildClassificationPrompt };

/**
 * Build a system-level context string describing the bot's available API abilities.
 * This helps Ollama understand what external tools are available so it can
 * suggest appropriate API calls in its response.
 *
 * Only tools with `abilityText` configured and a non-Ollama API are included.
 * Returns empty string if no abilities are configured.
 */
export function buildAbilitiesContext(): string {
  const tools = config.getTools().filter(k => k.enabled !== false);
  const abilities = tools
    .filter((k) => k.abilityText && k.api !== 'ollama')
    .map((k) => `- ${k.abilityText} (tool: "${k.name}")`)
    // Deduplicate entries with identical text
    .filter((item, index, self) => self.indexOf(item) === index);

  if (abilities.length === 0) return '';

  return [
    'You have access to the following abilities through external APIs:',
    ...abilities,
    '',
    `If the user's request requires one of these abilities, include ONLY the tool name on its own line prefixed with "${COMMAND_PREFIX}" (e.g. "${COMMAND_PREFIX}weather") so the request can be routed to the correct API.`,
    'Do not fabricate data for these abilities — if an ability is needed, state the tool name and let the API handle it.',
  ].join('\n');
}
