import { config, ToolConfig, AbilityInputs, COMMAND_PREFIX } from './config';
import { logger } from './logger';
import { ChatMessage, LlmProvider } from '../types';
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
 * Extends entity escaping with `&quot;` so double-quotes are safe
 * inside `attr="…"` strings.
 */
export function escapeXmlAttribute(text: string): string {
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
  /** Override the list of enabled tool abilities (defaults to config-derived list). */
  enabledTools?: ToolConfig[];
  /** Bot display name from the Discord client (used when no explicit override is configured). */
  botDisplayName?: string;
  /** Private DM history with the requesting user (guild messages only). */
  dmHistory?: ChatMessage[];
  /** LLM provider for policy hints and provider-specific guidance. */
  provider?: LlmProvider;
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
 * Result of parsing the first line of a model response for a tool match.
 */
export interface ToolParseResult {
  /** The matched tool config, or null if no tool was found. */
  toolConfig: ToolConfig | null;
  /** The raw first line that was tested (after normalization). */
  parsedLine: string;
  /** Whether a tool was matched. */
  matched: boolean;
  /** Optional inferred input payload extracted from the same first line. */
  inferredInput?: string;
  /** Optional original line containing the matched directive. */
  directiveLine?: string;
  /** Optional commentary text with directive line removed. */
  commentaryText?: string;
}

// ── Abilities / tool list helpers ────────────────────────────────

/**
 * Get the list of tools that represent routable external abilities.
 * Excludes Ollama-only tools, disabled tools, and built-in tools.
 */
export function getRoutableTools(overrides?: ToolConfig[]): ToolConfig[] {
  const tools = overrides ?? config.getTools();
  return tools.filter(k =>
    k.enabled !== false &&
    !k.builtin &&
    k.api !== 'ollama'
  );
}

/**
 * Guidance prompt appended to tool descriptions when consult_grok is available.
 * Only Ollama should receive this guidance (xAI cannot call consult_grok).
 */
export const CONSULT_GROK_GUIDANCE = [
  'Use the consult_grok tool when:',
  '- You need a second opinion on ambiguous or complex reasoning.',
  '- A deeper dive into a topic is required beyond basic facts or web searches.',
  '- Updated or real-time information might be available (e.g., current events, evolving trends).',
  '- Pass the full query context as input to ensure Grok has all necessary details.',
].join('\n');

/**
 * Render the inputs sub-section for one tool's ability block.
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
 * Lists each routable tool with structured what/when/inputs guidance
 * so the model knows what external data sources are available and how
 * to invoke them correctly.
 */
function buildAbilitiesBlock(routableTools: ToolConfig[]): string {
  if (routableTools.length === 0) return '';

  // Deduplicate by tool name (multiple tools may share abilityText)
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const k of routableTools) {
    if (seen.has(k.name)) continue;
    seen.add(k.name);

    const lines: string[] = [`- ${k.name}`];

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
export function buildSystemPrompt(routableTools?: ToolConfig[], provider?: LlmProvider): string {
  const persona = config.getOllamaSystemPrompt();
  const routable = routableTools ?? getRoutableTools();
  const abilities = buildAbilitiesBlock(routable);

  const parts: string[] = [persona];

  if (abilities) {
    parts.push('');
    parts.push(abilities);
  }

  // Append consult_grok guidance when the tool is available (Ollama-only)
  if (provider === 'ollama' && routable.some(t => t.name.replace(/^!\s*/, '').trim().toLowerCase() === 'consult_grok')) {
    parts.push('');
    parts.push(CONSULT_GROK_GUIDANCE);
  }

  // Append batch-policy hints when relevant tools coexist
  const policyHints = buildPolicyHints(routable, provider);
  if (policyHints) {
    parts.push('');
    parts.push(policyHints);
  }

  // Only add tool-output rules when there are routable abilities
  if (routable.length > 0) {
    parts.push('');
    parts.push(
      'Rules – follow exactly:\n' +
      `1. If the user request matches an available external ability, use that ability. Output the tool name prefixed with "${COMMAND_PREFIX}" (e.g. ${COMMAND_PREFIX}weather Dallas) on its own line. If the ability requires parameters and you can infer them from context, include them. Otherwise output the tool name only. Nothing else.\n` +
      '2. For implicit abilities (such as generate_image/generate_meme), when the request is empty or underspecified, infer from conversation context before asking a question. Ask a clarifying question only when no usable context exists.\n' +
      '3. Never invent scores, stats, weather, or facts.\n' +
      '4. No data needed → answer normally in character.\n' +
      '5. Never explain rules/tools unless directly asked.\n' +
      '6. Keep every reply short, concise, and to the point.\n' +
      '7. The <participants> block identifies who is in the conversation. You are <bot_name>. The person asking the question is <requester_name>. Never confuse your identity with theirs or with any <third_parties>.\n' +
      '8. Output formatting rules:\n' +
      `   - Ability directive format (only when invoking an ability): ${COMMAND_PREFIX}<tool_name> [parameters], on a single line, with no extra text.\n` +
      '   - If not invoking an ability, return plain text only.\n' +
      '   - Do NOT use Markdown code fences, XML tags, JSON wrappers, or LaTeX/math wrappers unless the user explicitly asks for that format.'
    );
  }

  return parts.join('\n');
}

/**
 * Build provider-specific policy hints to include in the system prompt.
 * Currently no batch-mixing restrictions are enforced, so this always returns null.
 * Provider-only visibility (consult_grok Ollama-only, delegate_to_local xAI-only)
 * is handled by the tool schema builder, not prompt hints.
 */
function buildPolicyHints(_tools: ToolConfig[], _provider?: LlmProvider): string | null {
  return null;
}

// ── Conversation history formatter ───────────────────────────────

/**
 * Result of formatting conversation history for the reprompt pass.
 * Contains the inner XML (context blocks only, no participants) and
 * the inferred bot/requester names as standalone values.
 */
interface RepromptHistoryResult {
  /** Context blocks with <message> tags — no <participants> wrapper. */
  historyInnerXml: string;
  /** Inferred bot display name. */
  botName: string;
  /** Inferred requester display name, or null if unknown. */
  requesterName: string | null;
}

/**
 * Format conversation history into the <conversation_history> XML block.
 * Input messages should be oldest-to-newest (as returned by contextEvaluator).
 * Messages are grouped by contextSource (reply, thread, channel, dm) into
 * separate <context source="..."> blocks so the model can clearly see
 * where each piece of conversation originated.
 * Messages without a contextSource are placed in a generic block.
 */
function formatConversationHistory(history: ChatMessage[], discordBotName?: string): string {
  if (!history || history.length === 0) return '';

  const groups = groupMessagesBySource(history);

  const inferredBotName = inferBotName(discordBotName);
  const requesterName = inferRequesterName(history);
  const thirdParties = inferThirdPartyNames(history, requesterName);
  const participantsBlock = buildParticipantsBlock(inferredBotName, requesterName, thirdParties);

  // Always emit grouped blocks so every source is uniformly marked
  const blocks: string[] = [];
  for (const [source, msgs] of groups) {
    const lines = msgs.map(msg => {
      const speaker = inferSpeakerName(msg, inferredBotName, requesterName);
      const speakerType = inferSpeakerType(msg, speaker, requesterName);
      // Only strip name prefixes from user messages — assistant content
      // is never prefixed upstream and stripping would corrupt bot output
      // that happens to start with "word: …" patterns.
      const text = msg.role === 'user' ? stripSpeakerPrefix(msg.content, msg.hasNamePrefix) : msg.content;
      const tsAttr = msg.createdAtMs != null ? ` timestamp="${Math.floor(msg.createdAtMs / 1000)}"` : '';
      const idAttr = msg.discordMessageId ? ` discord_message_id="${escapeXmlAttribute(msg.discordMessageId)}"` : '';
      return `<message role="${msg.role}" speaker="${escapeXmlAttribute(speaker)}" speaker_type="${speakerType}"${tsAttr}${idAttr}>${escapeXmlContent(text)}</message>`;
    });
    blocks.push(`<context source="${source}">\n${lines.join('\n')}\n</context>`);
  }

  return [participantsBlock, ...blocks].join('\n');
}

/**
 * Format conversation history for the reprompt (final Ollama pass).
 * Unlike `formatConversationHistory()`, this does NOT include a
 * `<participants>` block — the bot and requester names are returned
 * separately so the caller can emit them as top-level tags.
 */
function formatConversationHistoryForReprompt(
  history: ChatMessage[],
  discordBotName?: string,
): RepromptHistoryResult {
  const inferredBotName = inferBotName(discordBotName);
  const requesterName = inferRequesterName(history);

  if (!history || history.length === 0) {
    return { historyInnerXml: '', botName: inferredBotName, requesterName };
  }

  const groups = groupMessagesBySource(history);

  const blocks: string[] = [];
  for (const [source, msgs] of groups) {
    const lines = msgs.map(msg => {
      const speaker = inferSpeakerName(msg, inferredBotName, requesterName);
      const speakerType = inferSpeakerType(msg, speaker, requesterName);
      const text = msg.role === 'user' ? stripSpeakerPrefix(msg.content, msg.hasNamePrefix) : msg.content;
      const tsAttr = msg.createdAtMs != null ? ` timestamp="${Math.floor(msg.createdAtMs / 1000)}"` : '';
      const idAttr = msg.discordMessageId ? ` discord_message_id="${escapeXmlAttribute(msg.discordMessageId)}"` : '';
      return `<message role="${msg.role}" speaker="${escapeXmlAttribute(speaker)}" speaker_type="${speakerType}"${tsAttr}${idAttr}>${escapeXmlContent(text)}</message>`;
    });
    blocks.push(`<context source="${source}">\n${lines.join('\n')}\n</context>`);
  }

  return { historyInnerXml: blocks.join('\n'), botName: inferredBotName, requesterName };
}

/**
 * Determine the bot's display name for prompt participant blocks.
 *
 * Priority:
 * 1. Explicit `BOT_DISPLAY_NAME` config override (highest).
 * 2. Discord client display name passed at the call site.
 * 3. Regex extraction from the system prompt ("you are X").
 * 4. Fallback `'bot'`.
 */
export function inferBotName(discordBotName?: string): string {
  // 1. Explicit config override
  const override = config.getBotDisplayName();
  if (override) return override;

  // 2. Discord client display name
  if (discordBotName) return discordBotName;

  // 3. Regex fallback from system prompt
  const persona = config.getOllamaSystemPrompt();
  const match = persona.match(/\byou are\s+([A-Za-z0-9._-]+)/i);
  if (match) {
    return match[1].replace(/[.,!?;:]+$/g, '');
  }

  // 4. Generic fallback
  return 'bot';
}

/**
 * Parse a `"speaker: text"` prefix from a message content string.
 * The upstream message handler prepends display names to user messages
 * in DM and multi-user contexts. This function extracts the speaker
 * name (up to 64 non-colon characters) and the remaining text.
 *
 * @param content  - The raw message content.
 * @param hasNamePrefix - When `false` or `undefined`, the function
 *   returns `null` immediately to avoid false-positive parsing on
 *   unprefixed messages (e.g. `"Summary: here's what happened"`).
 * @returns `{ speaker, text }` if a prefix was found, otherwise `null`.
 */
function parseSpeakerPrefix(content: string, hasNamePrefix?: boolean): { speaker: string; text: string } | null {
  if (!hasNamePrefix) return null;

  const match = content.match(/^([^:\n]{1,64}):\s+([\s\S]+)$/);
  if (!match) return null;

  const speaker = match[1].trim();
  const text = match[2].trim();
  if (!speaker || !text) return null;

  return { speaker, text };
}

/**
 * Remove the `"speaker: "` prefix from a message, returning only the
 * body text. Returns the original content unchanged when no prefix
 * is detected (or when `hasNamePrefix` is falsy).
 */
function stripSpeakerPrefix(content: string, hasNamePrefix?: boolean): string {
  const parsed = parseSpeakerPrefix(content, hasNamePrefix);
  return parsed ? parsed.text : content;
}

/**
 * Determine the requester's display name from the conversation history.
 * Prefers the trigger message (most reliable — always set by the handler),
 * then falls back to the most recent user message with a speaker prefix.
 *
 * @returns The requester's name, or `null` if it cannot be determined.
 */
function inferRequesterName(history: ChatMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'user') continue;
    if (msg.contextSource !== 'trigger') continue;
    const parsed = parseSpeakerPrefix(msg.content, msg.hasNamePrefix);
    if (parsed) return parsed.speaker;
  }

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'user') continue;
    const parsed = parseSpeakerPrefix(msg.content, msg.hasNamePrefix);
    if (parsed) return parsed.speaker;
  }

  return null;
}

/**
 * Collect the display names of other participants in the conversation
 * (users who are neither the bot nor the requester). Comparison with
 * the requester name is case-insensitive. Names are deduplicated
 * case-insensitively and returned with their first-seen casing.
 */
function inferThirdPartyNames(history: ChatMessage[], requesterName: string | null): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const msg of history) {
    if (msg.role !== 'user') continue;
    const parsed = parseSpeakerPrefix(msg.content, msg.hasNamePrefix);
    if (!parsed) continue;
    const lowerSpeaker = parsed.speaker.toLowerCase();
    if (requesterName && lowerSpeaker === requesterName.toLowerCase()) {
      continue;
    }
    if (!seen.has(lowerSpeaker)) {
      seen.add(lowerSpeaker);
      names.push(parsed.speaker);
    }
  }
  return names;
}

/**
 * Determine the display name of the speaker for a single message.
 * - Assistant messages → bot name.
 * - User messages with a name prefix → the parsed speaker name.
 * - User messages without a prefix → requester name (fallback `'user'`).
 */
function inferSpeakerName(msg: ChatMessage, botName: string, requesterName: string | null): string {
  if (msg.role === 'assistant') return botName;

  const parsed = parseSpeakerPrefix(msg.content, msg.hasNamePrefix);
  if (parsed) return parsed.speaker;

  if (msg.contextSource === 'trigger' && requesterName) return requesterName;
  if (requesterName) return requesterName;
  return 'user';
}

/**
 * Classify a speaker as `'bot'`, `'requester'`, or `'third_party'`.
 * Used to populate the `speaker_type` attribute on `<message>` tags.
 */
function inferSpeakerType(msg: ChatMessage, speaker: string, requesterName: string | null): 'bot' | 'requester' | 'third_party' {
  if (msg.role === 'assistant') return 'bot';
  if (requesterName && speaker.toLowerCase() === requesterName.toLowerCase()) return 'requester';
  return 'third_party';
}

/**
 * Render the `<participants>` XML block that identifies who is in the
 * conversation: the bot, the requester, and any third-party users.
 */
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

/**
 * Build an XML tag containing the current Unix epoch timestamp (seconds)
 * so the model can compute relative ages of messages in conversation history.
 *
 * @param now - Optional Date for testing; defaults to `new Date()`.
 */
export function getCurrentTimestampTag(now?: Date): string {
  const d = now ?? new Date();
  const epochSeconds = Math.floor(d.getTime() / 1000);
  return `<current_timestamp>${epochSeconds}</current_timestamp>`;
}

// ── DM history formatter ─────────────────────────────────────────

/**
 * Format DM history messages as XML `<message>` tags for the
 * `<private_direct_messages>` block.
 */
function formatDmHistoryMessages(dmHistory: ChatMessage[], botName: string): string {
  return dmHistory.map(msg => {
    const speaker = msg.role === 'assistant'
      ? botName
      : (parseSpeakerPrefix(msg.content, msg.hasNamePrefix)?.speaker ?? 'user');
    const text = msg.role === 'user' ? stripSpeakerPrefix(msg.content, msg.hasNamePrefix) : msg.content;
    const tsAttr = msg.createdAtMs != null ? ` timestamp="${Math.floor(msg.createdAtMs / 1000)}"` : '';
    return `<message role="${msg.role}" speaker="${escapeXmlAttribute(speaker)}"${tsAttr}>${escapeXmlContent(text)}</message>`;
  }).join('\n');
}

// ── XML user content builder ─────────────────────────────────────

/**
 * Build the XML-tagged user message content.
 * Assembles <current_datetime>, <conversation_history>, <external_data>,
 * <current_question>, and <thinking_and_output_rules> blocks.
 */
export function buildUserContent(options: PromptBuildOptions): string {
  const { userMessage, conversationHistory, externalData, enabledTools, botDisplayName, dmHistory } = options;
  const routable = getRoutableTools(enabledTools);

  const parts: string[] = [];

  // ── <current_datetime> ──
  parts.push(getCurrentDateTimeTag());

  // ── <conversation_history> ──
  const historyText = formatConversationHistory(
    (conversationHistory ?? []).filter(m => m.role !== 'system'),
    botDisplayName
  );
  if (historyText) {
    // Include epoch timestamp so the model can reason about message ages
    parts.push(getCurrentTimestampTag());
    parts.push(`<conversation_history>\n${historyText}\n</conversation_history>`);
  } else {
    parts.push('<conversation_history>\n</conversation_history>');
  }

  // ── <private_direct_messages> (only for guild messages with DM context) ──
  if (dmHistory && dmHistory.length > 0) {
    const inferredBotName = inferBotName(botDisplayName);
    const dmLines = formatDmHistoryMessages(dmHistory, inferredBotName);
    parts.push(
      `<private_direct_messages note="Background context from private DMs with the requester. Do not mention or reference these unless the user explicitly refers to a prior DM conversation.">\n${dmLines}\n</private_direct_messages>`
    );
  }

  // ── <external_data> (only when present) ──
  if (externalData) {
    parts.push(`\n<external_data>\n${externalData}\n</external_data>`);
  }

  // ── <current_question> ──
  parts.push(`\n<current_question>\n${escapeXmlContent(userMessage)}\n</current_question>`);

  // ── <thinking_and_output_rules> ──
  if (routable.length > 0) {
    const toolList = routable.map(k => k.name).join(', ');
    parts.push(
      '\n<thinking_and_output_rules>\n' +
      'Step-by-step (think silently, do not output this thinking):\n' +
      '1. Read the current question carefully.\n' +
      '2. Does the request match one of the listed external abilities? → Yes → check if the ability\'s required inputs are present or can be inferred per the ability description above.\n' +
      `3. Inputs satisfied? → output the tool name with "${COMMAND_PREFIX}" prefix (one of: ${toolList}) and any parameters on its own line and stop.\n` +
      '4. For implicit abilities, if the request is empty or vague, infer from conversation context first. Ask a brief clarifying question only if no usable context exists.\n' +
      '5. No data needed? → Give a short, helpful answer in character.\n' +
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
  const routable = getRoutableTools(options.enabledTools);
  const systemContent = buildSystemPrompt(routable, options.provider);
  const userContent = buildUserContent(options); // botDisplayName flows via options

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
 * No tool routing rules are included (ask is a direct question path).
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
  toolName: string,
  nflDataText: string
): string {
  const lowerName = toolName.toLowerCase();
  // Detect news vs scores from tool name (legacy) or content (unified tool)
  const isNews = lowerName.includes('news') || /📰|NFL News/i.test(nflDataText);
  const source = isNews ? 'nfl-news' : 'nfl-scores';
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
  return `<search_data source="serpapi" query="${escapeXmlAttribute(query)}">\n${searchContextXml}\n</search_data>`;
}

// ── First-line tool parser ───────────────────────────────────────

/**
 * Parse the first non-empty line of an Ollama response and check
 * if it exactly matches a known routable tool.
 *
 * Normalization:
 * - Trim whitespace
 * - Lowercase
 * - Strip common punctuation (quotes, periods, colons, etc.)
 *
 * When multiple tools could match, the longest tool name wins
 * (consistent with existing `findTool()` behavior).
 *
 * @param responseText - Raw text from Ollama response.
 * @param overrideTools - Optional tool list override (for testing).
 * @returns Parse result with matched tool config or null.
 */
export function parseFirstLineTool(
  responseText: string,
  overrideTools?: ToolConfig[]
): ToolParseResult {
  const nullResult: ToolParseResult = { toolConfig: null, parsedLine: '', matched: false };

  if (!responseText) return nullResult;

  // Keep non-empty lines only; directive may appear after commentary.
  const nonEmptyLines = responseText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  if (nonEmptyLines.length === 0) return nullResult;

  // Get routable tools, sorted longest-first for priority
  const routable = getRoutableTools(overrideTools)
    .sort((a, b) => b.name.length - a.name.length);

  const normalizeForToolParse = (line: string): string => {
    return line
      .trim()
      .toLowerCase()
      .replace(/^[-–—*•]\s*/, '')
      .replace(/["""''`.,!?;:()[\]{}]/g, '')
      .trim();
  };

  const parseDirectiveLine = (line: string): ToolParseResult | null => {
    const cleaned = normalizeForToolParse(line);
    if (!cleaned) return null;

    // Exact match against cleaned line (with or without command prefix)
    for (const tool of routable) {
      const toolLower = tool.name.toLowerCase();
      const toolBare = toolLower.startsWith(COMMAND_PREFIX) ? toolLower.slice(COMMAND_PREFIX.length) : toolLower;
      const cleanedBare = cleaned.startsWith(COMMAND_PREFIX) ? cleaned.slice(COMMAND_PREFIX.length) : cleaned;
      if (cleanedBare === toolBare) {
        return {
          toolConfig: tool,
          parsedLine: cleaned,
          matched: true,
          directiveLine: line,
        };
      }
    }

    // Prefix match with inline parameters, e.g. "weather: Seattle, WA"
    const strippedLine = line
      .trim()
      .replace(/^[-–—*•]\s*/, '')
      .trim();

    for (const tool of routable) {
      const toolLower = tool.name.toLowerCase();
      const toolBare = toolLower.startsWith(COMMAND_PREFIX) ? toolLower.slice(COMMAND_PREFIX.length) : toolLower;

      for (const variant of [`${COMMAND_PREFIX}${toolBare}`, toolBare]) {
        const escapedToolName = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const prefixPattern = new RegExp(`^${escapedToolName}\\b(.+)$`, 'i');
        const match = strippedLine.match(prefixPattern);
        if (!match) continue;

        const remainder = (match[1] ?? '').trim();
        const inferredInput = remainder
          .replace(/^[:|;,=\-–—>]+\s*/, '')
          .trim();

        if (!inferredInput) continue;

        return {
          toolConfig: tool,
          parsedLine: cleaned,
          matched: true,
          inferredInput,
          directiveLine: line,
        };
      }
    }

    return null;
  };

  // Scan all non-empty lines; model may put commentary first and directive later.
  for (let i = 0; i < nonEmptyLines.length; i++) {
    const line = nonEmptyLines[i];
    const parsed = parseDirectiveLine(line);
    if (!parsed?.matched || !parsed.toolConfig) continue;

    const commentaryText = nonEmptyLines
      .filter((_, idx) => idx !== i)
      .join('\n')
      .trim();

    if (parsed.inferredInput) {
      logger.log('success', 'system',
        `TOOL-PARSE: Matched directive "${parsed.toolConfig.name}" with inferred input "${parsed.inferredInput}"`);
    } else {
      logger.log('success', 'system',
        `TOOL-PARSE: Matched directive "${parsed.toolConfig.name}" from line "${line}"`);
    }

    return {
      ...parsed,
      commentaryText: commentaryText.length > 0 ? commentaryText : undefined,
    };
  }

  const firstParsedLine = normalizeForToolParse(nonEmptyLines[0] ?? '');
  return { toolConfig: null, parsedLine: firstParsedLine, matched: false };
}

// ── Re-prompt builder (after API data fetch) ─────────────────────

/**
 * Build a re-prompt with <external_data> populated, using the same
 * XML template structure. Used after an API call triggered by a tool.
 *
 * The returned messages include a system prompt WITHOUT tool-routing
 * rules (to prevent infinite tool loops) and WITH the external data
 * injected.
 *
 * @param options - Original prompt options, with externalData now populated.
 * @returns AssembledPrompt with external data and no tool-trigger rules.
 */
export function assembleReprompt(options: PromptBuildOptions): AssembledPrompt {
  const persona = config.getOllamaSystemPrompt();

  // System prompt for reprompt: persona only, NO abilities/tool rules
  // This prevents the model from emitting another tool directive
  const systemContent = persona;

  // Build user content with external data but WITHOUT thinking_and_output_rules
  const { userMessage, conversationHistory, externalData, botDisplayName, dmHistory } = options;

  const filtered = (conversationHistory ?? []).filter(m => m.role !== 'system');
  const { historyInnerXml, botName, requesterName } = formatConversationHistoryForReprompt(
    filtered,
    botDisplayName,
  );

  const parts: string[] = [];

  // ── <current_question> (highest priority — what to answer) ──
  parts.push(`<current_question>\n${escapeXmlContent(userMessage)}\n</current_question>`);

  // ── <requester_name> and <bot_name> (who is asking / who is answering) ──
  parts.push(`<requester_name>${escapeXmlContent(requesterName ?? 'unknown')}</requester_name>`);
  parts.push(`<bot_name>${escapeXmlContent(botName)}</bot_name>`);

  // ── <current_datetime> (human-readable temporal context) ──
  parts.push(getCurrentDateTimeTag());

  // ── <external_data> (data needed to formulate the answer) ──
  if (externalData) {
    parts.push(`<external_data>\n${externalData}\n</external_data>`);
  }

  // ── <private_direct_messages> (only for guild messages with DM context) ──
  if (dmHistory && dmHistory.length > 0) {
    const dmLines = formatDmHistoryMessages(dmHistory, botName);
    parts.push(
      `<private_direct_messages note="Background context from private DMs with the requester. Do not mention or reference these unless the user explicitly refers to a prior DM conversation.">\n${dmLines}\n</private_direct_messages>`
    );
  }

  // ── <conversation_history> (background context, lowest priority) ──
  if (historyInnerXml) {
    const epochSeconds = Math.floor(Date.now() / 1000);
    parts.push(`<conversation_history current_timestamp="${epochSeconds}">\n${historyInnerXml}\n</conversation_history>`);
  } else {
    parts.push('<conversation_history>\n</conversation_history>');
  }

  const userContent = parts.join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];

  return { systemContent, userContent, messages };
}

// ── Unified pipeline reprompt builder ─────────────────────────────

/**
 * Options for building the unified pipeline Stage 3 prompt.
 */
export interface UnifiedRepromptOptions {
  /** The original user message. */
  userMessage: string;
  /** Stage 1 response text captured from the tool-evaluation model (may be empty). */
  draftResponse?: string;
  /** Combined external data from tool invocations. */
  externalData?: string;
  /** Bot display name from the Discord client. */
  botDisplayName?: string;
  /** Requester display name. */
  requesterName?: string;
  /** Full conversation history (oldest-to-newest) for context continuity. */
  conversationHistory?: ChatMessage[];
  /** Private DM history with the requesting user (guild messages only). */
  dmHistory?: ChatMessage[];
}

/**
 * Build the reprompt for the unified pipeline's Stage 3.
 *
 * Includes full conversation history (when provided) so the final-pass
 * model has the same context breadth as Stage 1. Additionally receives:
 * - `<current_question>` — original user message
 * - `<draft_response>` — Stage 1 response (when captured)
 * - `<external_data>` — combined tool results
 * - Requester/bot identity + datetime
 * - System prompt + OLLAMA_FINAL_PASS_PROMPT
 */
export function assembleUnifiedReprompt(options: UnifiedRepromptOptions): AssembledPrompt {
  const { userMessage, draftResponse, externalData, botDisplayName, requesterName, conversationHistory, dmHistory } = options;
  const persona = config.getOllamaSystemPrompt();
  const systemContent = persona;

  const filtered = (conversationHistory ?? []).filter(m => m.role !== 'system');
  const { historyInnerXml, botName } = formatConversationHistoryForReprompt(
    filtered,
    botDisplayName,
  );

  const parts: string[] = [];

  // ── <current_question> (what to answer) ──
  parts.push(`<current_question>\n${escapeXmlContent(userMessage)}\n</current_question>`);

  // ── Identity tags ──
  parts.push(`<requester_name>${escapeXmlContent(requesterName ?? 'unknown')}</requester_name>`);
  parts.push(`<bot_name>${escapeXmlContent(botName)}</bot_name>`);

  // ── <current_datetime> ──
  parts.push(getCurrentDateTimeTag());

  // ── <draft_response> (Stage 1 response, when captured) ──
  if (draftResponse) {
    parts.push(`<draft_response>\n${escapeXmlContent(draftResponse)}\n</draft_response>`);
  }

  // ── <external_data> (tool results from Stage 2) ──
  if (externalData) {
    parts.push(`<external_data>\n${externalData}\n</external_data>`);
  }

  // ── <private_direct_messages> (only for guild messages with DM context) ──
  if (dmHistory && dmHistory.length > 0) {
    const dmLines = formatDmHistoryMessages(dmHistory, botName);
    parts.push(
      `<private_direct_messages note="Background context from private DMs with the requester. Do not mention or reference these unless the user explicitly refers to a prior DM conversation.">\n${dmLines}\n</private_direct_messages>`
    );
  }

  // ── <conversation_history> (full context for continuity) ──
  if (historyInnerXml) {
    const epochSeconds = Math.floor(Date.now() / 1000);
    parts.push(`<conversation_history current_timestamp="${epochSeconds}">\n${historyInnerXml}\n</conversation_history>`);
  } else {
    parts.push('<conversation_history>\n</conversation_history>');
  }

  const userContent = parts.join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];

  return { systemContent, userContent, messages };
}

// ── Deprecated aliases (will be removed in a future release) ─────

/** @deprecated Use ToolParseResult instead. */
export type KeywordParseResult = ToolParseResult;

/** @deprecated Use getRoutableTools instead. */
export const getRoutableKeywords = getRoutableTools;

/** @deprecated Use parseFirstLineTool instead. */
export const parseFirstLineKeyword = parseFirstLineTool;
