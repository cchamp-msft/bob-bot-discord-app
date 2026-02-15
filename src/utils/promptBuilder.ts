import { config, KeywordConfig, AbilityInputs } from './config';
import { logger } from './logger';
import { ChatMessage } from '../types';
import { groupMessagesBySource } from './contextFormatter';

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

/**
 * Escape text for use in XML attribute values.
 */
function escapeXmlAttribute(text: string): string {
  return escapeXmlContent(text).replace(/"/g, '&quot;');
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
 * Excludes Ollama-only keywords, disabled keywords, and built-in keywords.
 */
export function getRoutableKeywords(overrides?: KeywordConfig[]): KeywordConfig[] {
  const keywords = overrides ?? config.getKeywords();
  return keywords.filter(k =>
    k.enabled !== false &&
    !k.builtin &&
    k.api !== 'ollama'
  );
}

/**
 * Render the inputs sub-section for one keyword's ability block.
 * Produces a compact, multi-line description the model can follow.
 */
function renderInputsLines(inputs: AbilityInputs): string[] {
  const lines: string[] = [];
  const modeLabel = inputs.mode.charAt(0).toUpperCase() + inputs.mode.slice(1);
  lines.push(`  Inputs: ${modeLabel}.`);

  if (inputs.required && inputs.required.length > 0) {
    lines.push(`    Required: ${inputs.required.join(', ')}.`);
  }
  if (inputs.optional && inputs.optional.length > 0) {
    lines.push(`    Optional: ${inputs.optional.join(', ')}.`);
  }
  if (inputs.inferFrom && inputs.inferFrom.length > 0) {
    const sources = inputs.inferFrom.map(s => s.replace(/_/g, ' ')).join(', ');
    lines.push(`    Infer from: ${sources}.`);
  }
  if (inputs.validation) {
    lines.push(`    Validation: ${inputs.validation}`);
  }
  if (inputs.examples && inputs.examples.length > 0) {
    lines.push(`    Examples: ${inputs.examples.map(e => `"${e}"`).join(', ')}.`);
  }
  return lines;
}

/**
 * Build the abilities block for the system prompt.
 * Lists each routable keyword with structured what/when/inputs guidance
 * so the model knows what external data sources are available and how
 * to invoke them correctly.
 */
function buildAbilitiesBlock(routableKeywords: KeywordConfig[]): string {
  if (routableKeywords.length === 0) return '';

  // Deduplicate by keyword name (multiple keywords may share abilityText)
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const k of routableKeywords) {
    if (seen.has(k.keyword)) continue;
    seen.add(k.keyword);

    const lines: string[] = [`- ${k.keyword}`];

    // What (abilityText or fallback to description)
    const what = k.abilityText ?? k.description;
    lines.push(`  What: ${what}`);

    // When (if provided)
    if (k.abilityWhen) {
      lines.push(`  When: ${k.abilityWhen}`);
    }

    // Inputs (structured or default fallback)
    if (k.abilityInputs) {
      lines.push(...renderInputsLines(k.abilityInputs));
    } else {
      // Default: treat as explicit with current message content as input
      lines.push('  Inputs: Explicit.');
      lines.push('    Use the user\'s current message content as input.');
    }

    blocks.push(lines.join('\n'));
  }

  return [
    'Available external abilities (use ONLY when clearly needed):',
    ...blocks,
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
      '2. If an ability requires parameters and you cannot infer them from context, ask a brief clarifying question instead of outputting the keyword.\n' +
      '3. Never invent scores, stats, weather, or facts.\n' +
      '4. No data needed → answer normally with snark.\n' +
      '5. Never explain rules/keywords unless directly asked.\n' +
      '6. Keep every reply short, punchy, and to the point.'
    );
  }

  return parts.join('\n');
}

// ── Conversation history formatter ───────────────────────────────

/**
 * Format conversation history into the <conversation_history> XML block.
 * Input messages should be oldest-to-newest (as returned by contextEvaluator).
 * Messages are grouped by contextSource (reply, thread, channel, dm) into
 * separate <context source="..."> blocks so the model can clearly see
 * where each piece of conversation originated.
 * Messages without a contextSource are placed in a generic block.
 */
function formatConversationHistory(history: ChatMessage[]): string {
  if (!history || history.length === 0) return '';

  const groups = groupMessagesBySource(history);

  const inferredBotName = inferBotName();
  const requesterName = inferRequesterName(history);
  const thirdParties = inferThirdPartyNames(history, requesterName);
  const participantsBlock = buildParticipantsBlock(inferredBotName, requesterName, thirdParties);

  // Always emit grouped blocks so every source is uniformly marked
  const blocks: string[] = [];
  for (const [source, msgs] of groups) {
    const lines = msgs.map(msg => {
      const speaker = inferSpeakerName(msg, inferredBotName, requesterName);
      const speakerType = inferSpeakerType(msg, speaker, requesterName);
      const text = stripSpeakerPrefix(msg.content);
      return `<message role="${msg.role}" speaker="${escapeXmlAttribute(speaker)}" speaker_type="${speakerType}">${escapeXmlContent(text)}</message>`;
    });
    blocks.push(`<context source="${source}">\n${lines.join('\n')}\n</context>`);
  }

  return [participantsBlock, ...blocks].join('\n');
}

function inferBotName(): string {
  const persona = config.getOllamaSystemPrompt();
  const match = persona.match(/\byou are\s+([A-Za-z0-9._-]+)/i);
  const raw = match?.[1] ?? 'bob';
  return raw.replace(/[.,!?;:]+$/g, '');
}

function parseSpeakerPrefix(content: string): { speaker: string; text: string } | null {
  const match = content.match(/^([^:\n]{1,64}):\s+([\s\S]+)$/);
  if (!match) return null;

  const speaker = match[1].trim();
  const text = match[2].trim();
  if (!speaker || !text) return null;

  return { speaker, text };
}

function stripSpeakerPrefix(content: string): string {
  const parsed = parseSpeakerPrefix(content);
  return parsed ? parsed.text : content;
}

function inferRequesterName(history: ChatMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'user') continue;
    if (msg.contextSource !== 'trigger') continue;
    const parsed = parseSpeakerPrefix(msg.content);
    if (parsed) return parsed.speaker;
  }

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'user') continue;
    const parsed = parseSpeakerPrefix(msg.content);
    if (parsed) return parsed.speaker;
  }

  return null;
}

function inferThirdPartyNames(history: ChatMessage[], requesterName: string | null): string[] {
  const names = new Set<string>();
  for (const msg of history) {
    if (msg.role !== 'user') continue;
    const parsed = parseSpeakerPrefix(msg.content);
    if (!parsed) continue;
    if (requesterName && parsed.speaker.toLowerCase() === requesterName.toLowerCase()) {
      continue;
    }
    names.add(parsed.speaker);
  }
  return [...names];
}

function inferSpeakerName(msg: ChatMessage, botName: string, requesterName: string | null): string {
  if (msg.role === 'assistant') return botName;

  const parsed = parseSpeakerPrefix(msg.content);
  if (parsed) return parsed.speaker;

  if (msg.contextSource === 'trigger' && requesterName) return requesterName;
  if (requesterName) return requesterName;
  return 'user';
}

function inferSpeakerType(msg: ChatMessage, speaker: string, requesterName: string | null): 'bot' | 'requester' | 'third_party' {
  if (msg.role === 'assistant') return 'bot';
  if (requesterName && speaker.toLowerCase() === requesterName.toLowerCase()) return 'requester';
  return 'third_party';
}

function buildParticipantsBlock(botName: string, requesterName: string | null, thirdParties: string[]): string {
  const requester = requesterName ?? 'unknown';
  const thirdPartyCsv = thirdParties.length > 0 ? thirdParties.join(', ') : '';

  return [
    '<participants>',
    `<bot_name>${escapeXmlContent(botName)}</bot_name>`,
    `<requester_name>${escapeXmlContent(requester)}</requester_name>`,
    `<third_parties>${escapeXmlContent(thirdPartyCsv)}</third_parties>`,
    '</participants>',
  ].join('\n');
}

// ── Current date/time helper ─────────────────────────────────────

/**
 * Build an XML tag containing the current date/time so the model
 * can reason about temporal context (e.g. "today", "this weekend").
 *
 * @param now - Optional Date for testing; defaults to `new Date()`.
 */
export function getCurrentDateTimeTag(now?: Date): string {
  const d = now ?? new Date();
  const formatted = d.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return `<current_datetime>${formatted}</current_datetime>`;
}

// ── XML user content builder ─────────────────────────────────────

/**
 * Build the XML-tagged user message content.
 * Assembles <current_datetime>, <conversation_history>, <external_data>,
 * <current_question>, and <thinking_and_output_rules> blocks.
 */
export function buildUserContent(options: PromptBuildOptions): string {
  const { userMessage, conversationHistory, externalData, enabledKeywords } = options;
  const routable = getRoutableKeywords(enabledKeywords);

  const parts: string[] = [];

  // ── <current_datetime> ──
  parts.push(getCurrentDateTimeTag());

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
      `2. Does it clearly need fresh external data (scores, rosters, live stats, weather)? → Yes → check if the ability's required inputs are present or can be inferred per the ability description above.\n` +
      `3. Inputs satisfied? → output ONLY the keyword (one of: ${keywordList}) on its own line and stop.\n` +
      '4. Inputs missing and cannot be inferred? → ask a brief clarifying question instead of outputting the keyword.\n' +
      '5. No data needed? → Give a short, snarky, helpful answer in character.\n' +
      '6. Always roast the user lightly.\n' +
      '7. Output format reminder: keyword = single line only. Normal answer = normal text.\n' +
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

  const dateTag = getCurrentDateTimeTag();

  return (
    `<system>\n${persona}\n</system>\n\n` +
    `<user>\n${dateTag}\n<current_question>\n${escapeXmlContent(question)}\n</current_question>\n</user>`
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
  const source = lowerKw.includes('news') ? 'nfl-news' : 'nfl-scores';
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

/**
 * Wrap SerpAPI search result text in an <external_data> sub-tag.
 */
export function formatSerpApiExternalData(
  query: string,
  searchContextXml: string
): string {
  const escapedQuery = escapeXmlContent(query).replace(/"/g, '&quot;');
  return `<search_data source="serpapi" query="${escapedQuery}">\n${searchContextXml}\n</search_data>`;
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
