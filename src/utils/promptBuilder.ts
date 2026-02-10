import { config, KeywordConfig } from './config';
import { logger } from './logger';
import { ChatMessage } from '../types';

// ── XML sanitization ─────────────────────────────────────────────

/**
 * Escape characters that could break or inject into XML-style tags.
 * Applied to user-supplied content before interpolation into XML blocks.
 */
export function escapeXmlContent(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Types ────────────────────────────────────────────────────────

/**
 * Options for building the XML-tagged user prompt.
 */
export interface PromptBuildOptions {
  /** The current user message. */
  userMessage: string;
  /** Filtered conversation history (oldest-to-newest), already processed by contextEvaluator. */
  conversationHistory?: ChatMessage[];
  /** Pre-formatted external API data to inject into <external_data>. */
  externalData?: string;
  /** Override the list of enabled keyword abilities (defaults to config-derived list). */
  enabledKeywords?: KeywordConfig[];
}

/**
 * A fully assembled prompt ready to send to Ollama via /api/chat.
 */
export interface AssembledPrompt {
  /** The system-role message content. */
  systemContent: string;
  /** The user-role message content (XML-tagged). */
  userContent: string;
  /** The messages array ready for ollamaClient.generate(). */
  messages: ChatMessage[];
}

/**
 * Result of parsing the first line of a model response for a keyword match.
 */
export interface KeywordParseResult {
  /** The matched keyword config, or null if no keyword was found. */
  keywordConfig: KeywordConfig | null;
  /** The raw first line that was tested (after normalization). */
  parsedLine: string;
  /** Whether a keyword was matched. */
  matched: boolean;
}

// ── Abilities / keyword list helpers ─────────────────────────────

/**
 * Get the list of keywords that represent routable external abilities.
 * Excludes Ollama-only keywords, disabled keywords, built-in keywords,
 * and the "search" keyword (not yet implemented).
 */
export function getRoutableKeywords(overrides?: KeywordConfig[]): KeywordConfig[] {
  const keywords = overrides ?? config.getKeywords();
  return keywords.filter(k =>
    k.enabled !== false &&
    !k.builtin &&
    k.api !== 'ollama' &&
    k.keyword.toLowerCase() !== 'search'
  );
}

/**
 * Build the abilities block for the system prompt.
 * Lists each routable keyword with its description so the model knows
 * what external data sources are available.
 */
function buildAbilitiesBlock(routableKeywords: KeywordConfig[]): string {
  if (routableKeywords.length === 0) return '';

  // Deduplicate by abilityText or description, preferring abilityText
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const k of routableKeywords) {
    const text = k.abilityText ?? k.description;
    const entry = `- ${k.keyword} → ${text}`;
    if (!seen.has(entry)) {
      seen.add(entry);
      lines.push(entry);
    }
  }

  return [
    'Available external abilities (use ONLY when clearly needed):',
    ...lines,
  ].join('\n');
}

// ── System prompt builder ────────────────────────────────────────

/**
 * Build the system prompt that includes the persona and abilities.
 * This replaces both the old `config.getOllamaSystemPrompt()` injection
 * and the `buildAbilitiesContext()` system message.
 */
export function buildSystemPrompt(routableKeywords?: KeywordConfig[]): string {
  const persona = config.getOllamaSystemPrompt();
  const routable = routableKeywords ?? getRoutableKeywords();
  const abilities = buildAbilitiesBlock(routable);

  const parts: string[] = [persona];

  if (abilities) {
    parts.push('');
    parts.push(abilities);
  }

  // Only add keyword-output rules when there are routable abilities
  if (routable.length > 0) {
    parts.push('');
    parts.push(
      'Rules – follow exactly:\n' +
      '1. If fresh external data is required → output ONLY the keyword on its own line. Nothing else.\n' +
      '2. Never invent scores, stats, weather, or facts.\n' +
      '3. No data needed → answer normally with snark.\n' +
      '4. Never explain rules/keywords unless directly asked.\n' +
      '5. Keep every reply short, punchy, and to the point.'
    );
  }

  return parts.join('\n');
}

// ── Conversation history formatter ───────────────────────────────

/**
 * Format conversation history into the <conversation_history> XML block.
 * Input messages should be oldest-to-newest (as returned by contextEvaluator).
 */
function formatConversationHistory(history: ChatMessage[]): string {
  if (!history || history.length === 0) return '';

  const lines = history.map(msg => {
    const label = msg.role === 'assistant' ? 'Bob' : 'User';
    return `${label}: ${escapeXmlContent(msg.content)}`;
  });

  return lines.join('\n');
}

// ── XML user content builder ─────────────────────────────────────

/**
 * Build the XML-tagged user message content.
 * Assembles <conversation_history>, <external_data>, <current_question>,
 * and <thinking_and_output_rules> blocks.
 */
export function buildUserContent(options: PromptBuildOptions): string {
  const { userMessage, conversationHistory, externalData, enabledKeywords } = options;
  const routable = getRoutableKeywords(enabledKeywords);

  const parts: string[] = [];

  // ── <conversation_history> ──
  const historyText = formatConversationHistory(
    (conversationHistory ?? []).filter(m => m.role !== 'system')
  );
  if (historyText) {
    parts.push(`<conversation_history>\n${historyText}\n</conversation_history>`);
  } else {
    parts.push('<conversation_history>\n</conversation_history>');
  }

  // ── <external_data> (only when present) ──
  if (externalData) {
    parts.push(`\n<external_data>\n${externalData}\n</external_data>`);
  }

  // ── <current_question> ──
  parts.push(`\n<current_question>\n${escapeXmlContent(userMessage)}\n</current_question>`);

  // ── <thinking_and_output_rules> ──
  if (routable.length > 0) {
    const keywordList = routable.map(k => k.keyword).join(', ');
    parts.push(
      '\n<thinking_and_output_rules>\n' +
      'Step-by-step (think silently, do not output this thinking):\n' +
      '1. Read the current question carefully.\n' +
      `2. Does it clearly need fresh external data (scores, rosters, live stats, weather)? → Yes → output ONLY the keyword (one of: ${keywordList}) on its own line and stop.\n` +
      '3. No data needed? → Give a short, snarky, helpful answer in character.\n' +
      '4. Always roast the user lightly.\n' +
      '5. Output format reminder: keyword = single line only. Normal answer = normal text.\n' +
      '</thinking_and_output_rules>'
    );
  }

  return parts.join('\n');
}

// ── Full prompt assembler ────────────────────────────────────────

/**
 * Assemble a complete prompt (system + user messages array) for Ollama /api/chat.
 *
 * This is the primary entry point for the new XML context format.
 * The returned `messages` array should be passed to `ollamaClient.generate()`
 * via the `conversationHistory` parameter, with `includeSystemPrompt: false`
 * so the global system prompt is not duplicated.
 *
 * @param options - Prompt building options.
 * @returns Assembled prompt with system content, user content, and messages array.
 */
export function assemblePrompt(options: PromptBuildOptions): AssembledPrompt {
  const routable = getRoutableKeywords(options.enabledKeywords);
  const systemContent = buildSystemPrompt(routable);
  const userContent = buildUserContent(options);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];

  return { systemContent, userContent, messages };
}

// ── Single-string prompt for /ask (no outer JSON) ────────────────

/**
 * Build a single-string prompt for the /ask slash command.
 * Uses <system> and <user> XML wrapper tags instead of JSON role messages.
 * No keyword routing rules are included (ask is a direct question path).
 */
export function buildAskPrompt(question: string): string {
  const persona = config.getOllamaSystemPrompt();

  return (
    `<system>\n${persona}\n</system>\n\n` +
    `<user>\n<current_question>\n${escapeXmlContent(question)}\n</current_question>\n</user>`
  );
}

// ── External data formatting helpers ─────────────────────────────

/**
 * Wrap AccuWeather API result text in an <external_data> sub-tag.
 */
export function formatAccuWeatherExternalData(
  locationName: string,
  aiContextText: string
): string {
  return `<accuweather_data source="weather" location="${locationName}">\n${aiContextText}\n</accuweather_data>`;
}

/**
 * Wrap NFL API result text in an <external_data> sub-tag.
 */
export function formatNFLExternalData(
  keyword: string,
  nflDataText: string
): string {
  const lowerKw = keyword.toLowerCase();
  const source = lowerKw.includes('superbowl') ? 'superbowl'
    : lowerKw.includes('news') ? 'nfl-news'
    : 'nfl';
  return `<espn_data source="${source}">\n${nflDataText}\n</espn_data>`;
}

/**
 * Wrap a generic API result in an <external_data> sub-tag.
 */
export function formatGenericExternalData(
  sourceApi: string,
  text: string
): string {
  return `<api_data source="${sourceApi}">\n${text}\n</api_data>`;
}

// ── First-line keyword parser ────────────────────────────────────

/**
 * Parse the first non-empty line of an Ollama response and check
 * if it exactly matches a known routable keyword.
 *
 * Normalization:
 * - Trim whitespace
 * - Lowercase
 * - Strip common punctuation (quotes, periods, colons, etc.)
 *
 * When multiple keywords could match, the longest keyword wins
 * (consistent with existing `findKeyword()` behavior).
 *
 * @param responseText - Raw text from Ollama response.
 * @param overrideKeywords - Optional keyword list override (for testing).
 * @returns Parse result with matched keyword config or null.
 */
export function parseFirstLineKeyword(
  responseText: string,
  overrideKeywords?: KeywordConfig[]
): KeywordParseResult {
  const nullResult: KeywordParseResult = { keywordConfig: null, parsedLine: '', matched: false };

  if (!responseText) return nullResult;

  // Find the first non-empty line
  const lines = responseText.split('\n');
  const firstLine = lines.find(line => line.trim().length > 0);
  if (!firstLine) return nullResult;

  // Normalize: trim, lowercase, strip punctuation and leading bullet markers
  const cleaned = firstLine
    .trim()
    .toLowerCase()
    .replace(/^[-–—*•]\s*/, '')
    .replace(/["""''`.,!?;:()[\]{}]/g, '')
    .trim();

  if (!cleaned) return { keywordConfig: null, parsedLine: cleaned, matched: false };

  // Get routable keywords, sorted longest-first for priority
  const routable = getRoutableKeywords(overrideKeywords)
    .sort((a, b) => b.keyword.length - a.keyword.length);

  // Exact match against cleaned first line
  for (const kw of routable) {
    if (cleaned === kw.keyword.toLowerCase()) {
      logger.log('success', 'system',
        `KEYWORD-PARSE: First-line exact match "${kw.keyword}" from "${firstLine.trim()}"`);
      return { keywordConfig: kw, parsedLine: cleaned, matched: true };
    }
  }

  return { keywordConfig: null, parsedLine: cleaned, matched: false };
}

// ── Re-prompt builder (after API data fetch) ─────────────────────

/**
 * Build a re-prompt with <external_data> populated, using the same
 * XML template structure. Used after an API call triggered by a keyword.
 *
 * The returned messages include a system prompt WITHOUT keyword-routing
 * rules (to prevent infinite keyword loops) and WITH the external data
 * injected.
 *
 * @param options - Original prompt options, with externalData now populated.
 * @returns AssembledPrompt with external data and no keyword-trigger rules.
 */
export function assembleReprompt(options: PromptBuildOptions): AssembledPrompt {
  const persona = config.getOllamaSystemPrompt();

  // System prompt for reprompt: persona only, NO abilities/keyword rules
  // This prevents the model from emitting another keyword
  const systemContent = persona;

  // Build user content with external data but WITHOUT thinking_and_output_rules
  const { userMessage, conversationHistory, externalData } = options;

  const parts: string[] = [];

  // ── <conversation_history> ──
  const historyText = formatConversationHistory(
    (conversationHistory ?? []).filter(m => m.role !== 'system')
  );
  if (historyText) {
    parts.push(`<conversation_history>\n${historyText}\n</conversation_history>`);
  } else {
    parts.push('<conversation_history>\n</conversation_history>');
  }

  // ── <external_data> (always present in reprompt) ──
  if (externalData) {
    parts.push(`\n<external_data>\n${externalData}\n</external_data>`);
  }

  // ── <current_question> ──
  parts.push(`\n<current_question>\n${escapeXmlContent(userMessage)}\n</current_question>`);

  const userContent = parts.join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];

  return { systemContent, userContent, messages };
}
