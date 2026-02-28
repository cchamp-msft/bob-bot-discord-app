import {
  Message,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import axios from 'axios';
import { config, ToolConfig, COMMAND_PREFIX } from '../utils/config';
import { logger } from '../utils/logger';
import { requestQueue } from '../utils/requestQueue';
import { apiManager, ComfyUIResponse, OllamaResponse, AccuWeatherResponse, SerpApiResponse } from '../api';
import { fileHandler } from '../utils/fileHandler';
import { memeClient } from '../api/memeClient';
import { ChatMessage, NFLResponse, MemeResponse, DiscordActionResponse, MediaFollowUp, ComfyUIMediaFollowUp, UrlMediaFollowUp, PipelineContext, ToolInvocation } from '../types';
import * as discordActionClient from '../api/discordActionClient';
import { chunkText } from '../utils/chunkText';
import { executeRoutedRequest, inferAbilityParameters, formatApiResultAsExternalData } from '../utils/apiRouter';
import { evaluateContextWindow } from '../utils/contextEvaluator';
import { assemblePrompt, assembleReprompt, assembleUnifiedReprompt, parseFirstLineTool } from '../utils/promptBuilder';
import type { ToolParseResult } from '../utils/promptBuilder';
import { buildOllamaToolsSchema, resolveToolNameToTool, toolArgumentsToContent } from '../utils/toolsSchema';
import { activityEvents } from '../utils/activityEvents';
import { activityKeyManager } from '../utils/activityKeyManager';

export type { ChatMessage };

class ApiDispatchError extends Error {
  /** The API that produced the error, when available. */
  readonly api?: string;
  constructor(message: string, api?: string) {
    super(message);
    this.api = api;
  }
}

class MessageHandler {
  private static readonly WORKING_EMOJI = '⏳';

  // ── Dedup guards ──────────────────────────────────────────────
  /** Messages currently being processed (catches concurrent shard replays, 8-18ms gap). */
  private processingMessages = new Set<string>();
  /** Recently processed messages with timestamp (catches late replays, 60s TTL). */
  private processedMessages = new Map<string, number>();
  /** TTL for processed message entries in milliseconds. */
  private static readonly DEDUP_TTL_MS = 60_000;

  /** Clear dedup state — exposed for testing. */
  resetDedupState(): void {
    this.processingMessages.clear();
    this.processedMessages.clear();
  }

  /**
   * Compare a tool name (from config — may or may not include the
   * command prefix) against a bare tool name like 'activity_key'.
   */
  private toolNameIs(toolName: string, name: string): boolean {
    const tn = toolName.toLowerCase().trim();
    const bare = tn.startsWith(COMMAND_PREFIX) ? tn.slice(COMMAND_PREFIX.length) : tn;
    return bare === name.toLowerCase().trim();
  }
  private static readonly ERROR_EMOJI = '❌';
  private static readonly MEME_SHRUG_EMOJI = '🤷';

  /** Timestamp of the last error message sent to Discord (for rate limiting) */
  private lastErrorMessageTime: number = 0;

  /**
   * Check whether enough time has passed to send another error message to Discord.
   * Uses configurable ERROR_RATE_LIMIT_MINUTES from .env (default: 60 minutes).
   */
  private canSendErrorMessage(): boolean {
    const rateLimitMs = config.getErrorRateLimitMinutes() * 60 * 1000;
    const now = Date.now();
    if (now - this.lastErrorMessageTime >= rateLimitMs) {
      this.lastErrorMessageTime = now;
      return true;
    }
    return false;
  }

  private async addWorkingReaction(message: Message): Promise<void> {
    try {
      if (typeof message.react === 'function') {
        await message.react(MessageHandler.WORKING_EMOJI);
      }
    } catch (error) {
      logger.logWarn('system', `Failed to add working reaction: ${error}`);
    }
  }

  private async removeBotReaction(message: Message, emoji: string): Promise<void> {
    try {
      const botUserId = message.client.user?.id;
      if (!botUserId || !message.reactions?.resolve) return;

      const reaction = message.reactions.resolve(emoji);
      if (reaction?.users?.remove) {
        await reaction.users.remove(botUserId);
      }
    } catch (error) {
      logger.logWarn('system', `Failed to remove reaction ${emoji}: ${error}`);
    }
  }

  private async markRequestSucceeded(message: Message): Promise<void> {
    await this.removeBotReaction(message, MessageHandler.WORKING_EMOJI);
  }

  private async markRequestFailed(message: Message, api?: string): Promise<void> {
    await this.removeBotReaction(message, MessageHandler.WORKING_EMOJI);

    try {
      if (typeof message.react === 'function') {
        await message.react(MessageHandler.ERROR_EMOJI);
      }
    } catch (error) {
      logger.logWarn('system', `Failed to add error reaction: ${error}`);
    }

    // Add shrug reaction for meme inference/template failures
    if (api === 'meme') {
      try {
        if (typeof message.react === 'function') {
          await message.react(MessageHandler.MEME_SHRUG_EMOJI);
        }
      } catch (error) {
        logger.logWarn('system', `Failed to add meme shrug reaction: ${error}`);
      }
    }
  }

  private isLikelyMemeRequest(content: string): boolean {
    const t = content.toLowerCase();
    return /\b(meme|memegen|image macro|caption this|template)\b/.test(t);
  }

  private isLikelyImageRequest(content: string): boolean {
    const t = content.toLowerCase().trim();
    return /\b(generate|draw|render|visualize|create\s+(an\s+)?image|make\s+(a\s+)?(picture|image))\b/.test(t);
  }

  private isGenericImageReference(content: string): boolean {
    const t = content.toLowerCase().trim();
    return /^(this|that|it|something|anything|image|picture|photo)$/i.test(t);
  }

  private stripSpeakerPrefix(content: string): string {
    return content.replace(/^[^:\n]{1,64}:\s+/, '').trim();
  }

  private isToolNameOnlyInvocation(content: string, toolName: string): boolean {
    const normalizedToolName = toolName
      .toLowerCase()
      .trim()
      .replace(/^!+/, '');

    const normalizedContent = content
      .toLowerCase()
      .trim()
      .replace(/^[@!]+/, '')
      .replace(/[!?.,:;]+$/g, '')
      .trim();

    return normalizedContent === normalizedToolName;
  }

  private deriveImagePromptFromContext(content: string, history: ChatMessage[]): string | null {
    const trimmed = content.trim();

    // Try using direct user text first (remove command-ish lead-ins)
    let direct = trimmed
      .replace(/^[@!]?generate_image\b/i, '')
      .replace(/^[@!]?generate\b/i, '')
      .replace(/^(can|could|would)\s+you\s+/i, '')
      .replace(/^[@!]?generate_image\b/i, '')
      .replace(/^[@!]?generate\b/i, '')
      .replace(/^(please\s+)?(create|make|draw|render|visualize)\s+(an?\s+)?(image|picture|photo)\s+(of\s+)?/i, '')
      .trim();

    direct = direct.replace(/^[:|,\-.\s]+/, '').trim();

    if (direct && !this.isGenericImageReference(direct) && !this.isLikelyImageRequest(direct)) {
      return direct;
    }

    const cleanedHistory = history
      .filter(m => m.role !== 'system')
      .map(m => ({ ...m, content: this.stripSpeakerPrefix(m.content).trim() }));

    // Prefer prior user messages with concrete content.
    for (let i = cleanedHistory.length - 1; i >= 0; i--) {
      const msg = cleanedHistory[i];
      if (msg.role !== 'user') continue;
      if (msg.contextSource === 'trigger') continue;
      if (!msg.content) continue;
      if (this.isLikelyImageRequest(msg.content)) continue;
      if (this.isLikelyMemeRequest(msg.content)) continue;
      if (this.isGenericImageReference(msg.content)) continue;
      return msg.content;
    }

    // Fallback to assistant context if user context is too sparse.
    for (let i = cleanedHistory.length - 1; i >= 0; i--) {
      const msg = cleanedHistory[i];
      if (msg.role !== 'assistant') continue;
      if (!msg.content || /^https?:\/\//i.test(msg.content)) continue;
      if (/what\s+do\s+you\s+want\s+me\s+to\s+(imagine|picture)/i.test(msg.content)) continue;
      return msg.content;
    }

    return null;
  }

  private escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private buildDirectiveCommentary(
    parseResult: ToolParseResult,
    routedInput: string
  ): string | null {
    const commentary = parseResult.commentaryText?.trim();
    if (!commentary || !parseResult.toolConfig) return null;

    const tnLower = parseResult.toolConfig.name.toLowerCase().trim();
    const tnBare = tnLower.startsWith(COMMAND_PREFIX)
      ? tnLower.slice(COMMAND_PREFIX.length)
      : tnLower;
    const tnEscaped = this.escapeRegExp(tnBare);

    const lines = commentary
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map((line) => {
        // Replace explicit command-style invocations inline.
        const withBangReplaced = line.replace(
          new RegExp(`(^|\\s)!${tnEscaped}\\b(?:\\s*[:|;,=\\-–—>]+\\s*|\\s+)`, 'ig'),
          `$1${routedInput} `
        );

        // Replace start-of-line bare directive form (e.g. "generate_image: ...")
        const bareLeadingPattern = new RegExp(`^${tnEscaped}\\b(?:\\s*[:|;,=\\-–—>]+\\s*|\\s+)`, 'i');
        return withBangReplaced.replace(bareLeadingPattern, `${routedInput} `).trim();
      })
      .filter(line => line.length > 0);

    if (lines.length === 0) return null;
    return lines.join('\n').trim() || null;
  }

  private async sendCommentaryPrelude(
    sourceMessage: Message,
    requester: string,
    isDM: boolean,
    text: string
  ): Promise<void> {
    const chunks = chunkText(text);
    await sourceMessage.reply({ content: chunks[0], embeds: [] });
    for (let i = 1; i < chunks.length; i++) {
      if ('send' in sourceMessage.channel) {
        await sourceMessage.channel.send(chunks[i]);
      }
    }

    activityEvents.emitBotReply('ollama', text, isDM);
    logger.logReply(requester, `Two-stage commentary sent: ${text.length} characters`, text);
  }

  private findEnabledToolByName(name: string): ToolConfig | undefined {
    return config
      .getTools()
      .find(k => k.enabled !== false && this.toolNameIs(k.name, name));
  }

  async handleMessage(message: Message): Promise<void> {
    // Ignore bot messages unless ALLOW_BOT_INTERACTIONS is enabled
    if (message.author.bot) {
      if (!config.getAllowBotInteractions()) return;
      // Never respond to our own messages regardless of setting
      if (message.author.id === message.client.user?.id) return;
    }

    // Guard: client.user should always exist after 'ready' but be defensive
    if (!message.client.user) return;

    // ── Dedup guard: reject concurrent duplicates and late shard replays ──
    this.pruneProcessedMessages();
    if (this.processingMessages.has(message.id) || this.processedMessages.has(message.id)) {
      logger.log('success', 'system', `DEDUP: Skipping duplicate message ${message.id} from ${message.author.username}`);
      return;
    }
    this.processingMessages.add(message.id);

    // Determine if this is a DM
    const isDM = message.channel.type === ChannelType.DM;
    const isMentioned = message.mentions.has(message.client.user.id);

    // Check if this is a direct reply to one of the bot's own messages.
    // Use cache first; fall back to a fetch if the message isn't cached.
    let isReplyToBot = false;
    if (!isDM && !isMentioned && message.reference?.messageId) {
      try {
        const cached = message.channel.messages?.cache.get(message.reference.messageId);
        if (cached) {
          isReplyToBot = cached.author.id === message.client.user.id;
        } else {
          const fetched = await message.fetchReference();
          isReplyToBot = fetched.author.id === message.client.user.id;
        }
      } catch {
        // Referenced message deleted or inaccessible — not a reply to bot
      }
    }

    // Process DMs, @mentions, or direct replies to the bot — ignore everything else
    if (!isDM && !isMentioned && !isReplyToBot) return;

    // DM authorization: only respond to users who share at least one guild with the bot.
    // This prevents strangers from interacting with the bot via unsolicited DMs.
    if (isDM) {
      const sharesGuild = await this.userSharesGuildWithBot(message);
      if (!sharesGuild) {
        logger.log('warn', 'system', `DM-GATE: Rejected DM from ${message.author.username} (${message.author.id}) — no shared guild`);
        return;
      }
    }

    // Log incoming message details for diagnostics
    const guildName = message.guild?.name ?? null;
    const channelTypeName = isDM ? 'DM' : message.channel.type === ChannelType.GuildText ? 'GuildText' : 'Channel';
    logger.logIncoming(
      message.author.username,
      message.author.id,
      channelTypeName,
      guildName,
      message.content
    );

    // Prefer the server nickname (member.displayName) over the raw Discord
    // username so that logs, prompts, and error messages show the friendly
    // name the user sees in the guild.  Falls back to username for DMs.
    const requester = message.member?.displayName ?? message.author.displayName ?? message.author.username;

    // Resolve the bot's display name from the Discord client for use in
    // prompt participant blocks (the explicit BOT_DISPLAY_NAME config
    // override is checked inside inferBotName, but we provide the Discord
    // fallback here).
    const botDisplayName = message.client.user.displayName ?? message.client.user.username;

    // Extract message content — remove the bot's own mention first
    const mentionRegex = new RegExp(
      `<@!?${message.client.user.id}>`,
      'g'
    );
    let content = message.content.replace(mentionRegex, '').trim();

    // Strip remaining Discord mentions and emoji markup that shouldn't reach
    // API backends (e.g. ComfyUI workflows break on angle-bracket tokens).
    //   <@123>       — user mention
    //   <@!123>      — user mention (nick form)
    //   <@&123>      — role mention
    //   <#123>       — channel mention
    //   <:name:123>  — custom emoji
    //   <a:name:123> — animated emoji
    content = content.replace(/<@[!&]?\d+>|<#\d+>|<a?:\w+:\d+>/g, '').trim();

    // Extract image attachments (base64-encoded) for vision model processing
    const imagePayloads = await this.extractImageAttachments(message);

    if (!content && imagePayloads.length === 0) {
      logger.logIgnored(requester, 'Empty message after mention removal');
      await message.reply(
        'Please include a prompt or question in your message!'
      );
      return;
    }

    // When the user sends images but no text, use a sensible default prompt
    if (!content && imagePayloads.length > 0) {
      content = imagePayloads.length === 1
        ? 'What do you see in this image?'
        : `What do you see in these ${imagePayloads.length} images?`;
    }

    // Find matching tool at message start — only matches !prefixed commands.
    // Messages without the command prefix go through two-stage Ollama evaluation.
    let toolConfig = this.findTool(content);
    const toolMatched = toolConfig !== undefined;
    const startsWithCommandPrefix = content.trim().startsWith(COMMAND_PREFIX);

    // Emit activity event with cleaned message content (no usernames or IDs).
    // Suppress for standalone activity_key requests — those should not appear
    // in the public activity feed.
    const isActivityKey = toolMatched && this.toolNameIs(toolConfig!.name, 'activity_key');
    if (!isActivityKey) {
      activityEvents.emitMessageReceived(isDM, content);
    }

    if (toolConfig) {
      logger.log('success', 'system', `TOOL: Matched "${toolConfig.name}" at message start`);
    } else {
      logger.log('success', 'system', `TOOL: No first-word match, deferring to two-stage evaluation`);
    }

    // Track whether a non-Ollama API tool was matched (determines execution path)
    const apiToolMatched = toolMatched && toolConfig!.api !== 'ollama';

    if (!toolConfig) {
      toolConfig = {
        name: '__default__',
        api: 'ollama',
        timeout: config.getDefaultTimeout(),
        description: 'Default chat via Ollama',
      };
      logger.logDefault(requester, content);
    }

    // Strip the routing tool name only when it was explicitly matched at the start.
    // The default "chat" fallback should NOT strip — it would mutate free-form content.
    if (toolMatched) {
      content = this.stripToolName(content, toolConfig.name);
    }

    // For image generation replies, combine quoted message content with the user's reply text.
    // Done before the empty-prompt check so that reply-only-tool messages (e.g. replying
    // "generate" to a message) still work — the quoted content fills the prompt.
    if (toolConfig.api === 'comfyui' && message.reference) {
      content = await this.buildImagePromptFromReply(message, content);
    }

    if (!content) {
      // Some tools (e.g. "get_recent_nfl_data") work without extra content.
      // For those, use the tool name itself as the content so the request proceeds.
      const toolAllowsEmpty = toolConfig.allowEmptyContent === true;

      if (toolAllowsEmpty) {
        content = toolConfig.name;
      } else {
        logger.logIgnored(requester, 'Empty message after tool name removal');
        await message.reply(
          'Please include a prompt or question after the tool name!'
        );
        return;
      }
    }

    // Route standalone "!help" — short-circuit with a direct help response.
    // No model call needed; the help text is deterministic.
    if (toolMatched && this.toolNameIs(toolConfig.name, 'help')) {
      const reply = this.buildHelpResponse();
      await message.reply(reply);
      logger.log('success', 'system', `HELP: Direct help response sent to ${requester}`);
      return;
    }

    // Route standalone "!activity_key" — issue a new rotating key and DM it
    // back to the user. This short-circuits before Ollama/API routing since
    // no model interaction is needed.
    if (toolMatched && this.toolNameIs(toolConfig.name, 'activity_key')) {
      const key = activityKeyManager.issueKey();
      const ttl = config.getActivityKeyTtl();
      const sessionMaxTime = config.getActivitySessionMaxTime();
      const url = config.getOutputBaseUrl();

      // Format session duration in a human-friendly way
      const sessionHours = Math.floor(sessionMaxTime / 3600);
      const sessionMins = Math.floor((sessionMaxTime % 3600) / 60);
      const sessionDesc = sessionHours >= 1
        ? `${sessionHours} hour${sessionHours !== 1 ? 's' : ''}${sessionMins > 0 ? ` ${sessionMins} min` : ''}`
        : `${sessionMins} minute${sessionMins !== 1 ? 's' : ''}`;

      const reply = [
        `🔑 Here is your activity monitor key (enter within ${ttl} seconds):`,
        '',
        `\`${key}\``,
        '',
        `Open the activity page and enter this key when prompted:`,
        `${url}/activity`,
        '',
        `Once entered, your session will remain active for up to ${sessionDesc} or until you fully refresh the page. You only need a new key if your session expires.`,
      ].join('\n');

      await message.reply(reply);
      logger.log('success', 'system', `ACTIVITY-KEY: Key issued to ${requester}`);
      return;
    }

    // Route standalone "!get_meme_templates" — return cached template list directly.
    // No model call or context needed; the list is deterministic.
    if (toolMatched && this.toolNameIs(toolConfig.name, 'get_meme_templates')) {
      const ids = memeClient.getTemplateListForInference();
      const reply = ids || 'No meme templates available. Templates may still be loading.';
      const chunks = chunkText(reply);
      await message.reply({ content: chunks[0], allowedMentions: { parse: [] } });
      for (let i = 1; i < chunks.length; i++) {
        if ('send' in message.channel) {
          await message.channel.send({ content: chunks[i], allowedMentions: { parse: [] } });
        }
      }
      logger.log('success', 'system', `MEME-TEMPLATES: Direct template list sent to ${requester}`);
      return;
    }

    // Collect conversation context — needed for any path that may call Ollama
    // (direct chat, two-stage evaluation, or final Ollama pass)
    let conversationHistory: ChatMessage[] = [];
    if (config.getReplyChainEnabled()) {
      if (isDM) {
        // DMs: collect recent DM channel history (no guild channel-context feature)
        conversationHistory = await this.collectDmHistory(message);
      } else {
        // Guild: collect reply chain + channel history
        const maxContextDepth = config.getReplyChainMaxDepth();
        const maxTotalChars = config.getReplyChainMaxTokens();

        let replyChain: ChatMessage[] = [];
        if (message.reference) {
          replyChain = await this.collectReplyChain(message);
        }

        // Always collect channel context for guild messages
        const channelHistory = await this.collectChannelHistory(message, maxContextDepth, maxTotalChars);

        // When in a thread with no reply chain, promote thread source
        if (replyChain.length === 0 && message.channel.isThread()) {
          for (const msg of channelHistory) {
            msg.contextSource = 'thread';
          }
        }

        if (replyChain.length > 0 || channelHistory.length > 0) {
          conversationHistory = this.collateGuildContext(
            replyChain,
            channelHistory,
            maxContextDepth,
            maxTotalChars
          );
        }
      }
    }

    // Optionally fetch the bot's private DM history with this user for guild messages
    let dmHistory: ChatMessage[] = [];
    if (!isDM && config.getDmContextEnabled() && config.getDmContextMaxMessages() > 0) {
      dmHistory = await this.fetchUserDmHistory(message);
    }

    // Log the request
    logger.logRequest(
      requester,
      `[${toolConfig.name}] ${content}`
    );

    await this.addWorkingReaction(message);

    try {
      if (apiToolMatched) {
        // ── API tool path: execute API with optional final Ollama pass ──
        // Append the triggering message so the model always knows who is asking.
        const historyWithTrigger: ChatMessage[] = [
          ...conversationHistory,
          { role: 'user' as const, content: `${requester}: ${content}`, contextSource: 'trigger' as const, hasNamePrefix: true, createdAtMs: message.createdTimestamp },
        ];
        activityEvents.emitRoutingDecision(toolConfig.api, toolConfig.name, 'keyword');

        const routedResult = await executeRoutedRequest(
          toolConfig,
          content,
          requester,
          historyWithTrigger,
          botDisplayName,
          undefined, // signal
          undefined, // options
          dmHistory
        );

        await this.dispatchResponse(
          routedResult.finalResponse,
          routedResult.finalApi,
          message,
          requester,
          isDM,
          routedResult.media
        );
      } else if (config.getPipelineMode() === 'unified') {
        // ── Unified pipeline: cumulative context, fewer Ollama calls ──
        const ctx: PipelineContext = {
          messageId: message.id,
          requester,
          botDisplayName,
          isDM,
          rawContent: content,
          imagePayloads,
          sourceMessage: message,
          conversationHistory,
          dmHistory,
          stage1ToolInvocations: [],
          toolResults: [],
          mediaFollowUps: [],
          ollamaCallCount: 0,
          startedAt: Date.now(),
        };
        await this.executeUnifiedPipeline(ctx, toolConfig);
      } else {
        // ── Legacy Ollama path: chat with abilities context, then second evaluation ──
        await this.executeWithTwoStageEvaluation(
          content,
          toolConfig,
          message,
          requester,
          conversationHistory,
          isDM,
          botDisplayName,
          startsWithCommandPrefix && !toolMatched,
          imagePayloads,
          dmHistory
        );
      }

      await this.markRequestSucceeded(message);
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : 'Unknown error';

      // Log full error to console always
      logger.logError(requester, errorMsg);

      // Emit sanitised error activity event
      if (error instanceof ApiDispatchError) {
        activityEvents.emitError('I couldn\'t get a response from the API');
      } else {
        activityEvents.emitError('I couldn\'t complete that request');
      }

      const failedApi = error instanceof ApiDispatchError ? error.api : undefined;
      await this.markRequestFailed(message, failedApi);
    } finally {
      // Move from processing → processed for late-replay dedup
      this.processingMessages.delete(message.id);
      this.processedMessages.set(message.id, Date.now());
    }
  }

  /** Remove expired entries from the processed messages cache. */
  private pruneProcessedMessages(): void {
    const now = Date.now();
    for (const [id, ts] of this.processedMessages) {
      if (now - ts > MessageHandler.DEDUP_TTL_MS) {
        this.processedMessages.delete(id);
      }
    }
  }

  /**
   * Traverse the Discord reply chain starting from the given message.
   * Returns an array of ChatMessage objects ordered oldest-to-newest,
   * with roles assigned based on whether the author is the bot.
   * Does NOT include the current message — only prior context.
   *
   * Each returned message carries metadata:
   *   contextSource = 'reply',
   *   discordMessageId, createdAtMs.
   */
  async collectReplyChain(message: Message): Promise<ChatMessage[]> {
    const maxDepth = config.getReplyChainMaxDepth();
    const maxTotalChars = config.getReplyChainMaxTokens();
    const imageMaxDepth = config.getReplyChainImageMaxDepth();
    const chain: { role: 'user' | 'assistant'; content: string; authorName?: string; id: string; createdAt: number; images?: string[] }[] = [];
    const visited = new Set<string>();
    const botId = message.client.user?.id;
    const userAuthors = new Set<string>();
    let totalChars = 0;

    let current = message;

    for (let depth = 0; depth < maxDepth; depth++) {
      if (!current.reference?.messageId) break;

      const refId = current.reference.messageId;

      // Circular reference protection
      if (visited.has(refId)) {
        logger.log('success', 'system', `REPLY-CHAIN: Circular reference detected at message ${refId}, stopping`);
        break;
      }
      visited.add(refId);

      try {
        const referenced = await current.fetchReference();

        // Extract content — strip bot mention patterns
        let refContent = referenced.content || '';
        if (botId) {
          const mentionRegex = new RegExp(`<@!?${botId}>`, 'g');
          refContent = refContent.replace(mentionRegex, '').trim();
        }

        // Extract images from referenced messages within image depth window.
        // depth is 0-indexed from the trigger message, so depth < imageMaxDepth
        // covers the N nearest ancestors.
        let refImages: string[] | undefined;
        if (imageMaxDepth > 0 && depth < imageMaxDepth) {
          try {
            const imgs = await this.extractImageAttachments(referenced);
            if (imgs.length > 0) {
              refImages = imgs;
              logger.log('success', 'system',
                `REPLY-CHAIN: Extracted ${imgs.length} image(s) from message ${refId} at depth ${depth}`);
            }
          } catch (imgError) {
            const errMsg = imgError instanceof Error ? imgError.message : String(imgError);
            logger.logWarn('system', `REPLY-CHAIN: Failed to extract images from message ${refId}: ${errMsg}`);
          }
        }

        if (refContent || refImages) {
          const isBot = referenced.author.id === botId;

          // Check total character budget before adding (include potential authorName prefix)
          const prefixLen = isBot ? 0 : ((referenced.member?.displayName ?? referenced.author.username).length + 2);
          const entryLen = (refContent?.length ?? 0) + prefixLen;
          if (refContent && totalChars + entryLen > maxTotalChars) {
            logger.log('success', 'system', `REPLY-CHAIN: Character limit reached (${totalChars}/${maxTotalChars}), stopping at depth ${depth}`);
            break;
          }
          totalChars += entryLen;

          const role = isBot ? 'assistant' as const : 'user' as const;
          const authorName = isBot ? undefined : (referenced.member?.displayName ?? referenced.author.username);

          if (!isBot) {
            userAuthors.add(referenced.author.id);
          }

          chain.push({
            role,
            content: refContent,
            authorName,
            id: referenced.id,
            createdAt: referenced.createdTimestamp,
            ...(refImages && { images: refImages }),
          });
        }

        current = referenced;
      } catch {
        // Message deleted or inaccessible — stop traversal gracefully
        logger.log('success', 'system', `REPLY-CHAIN: Could not fetch message ${refId} (deleted or inaccessible), stopping at depth ${depth}`);
        break;
      }
    }

    if (chain.length > 0) {
      logger.log('success', 'system', `REPLY-CHAIN: Collected ${chain.length} message(s) of context`);
    }

    // Also count the current message author for multi-user detection
    userAuthors.add(message.author.id);
    const multiUser = userAuthors.size > 1;

    // Reverse so oldest message is first, and build final ChatMessage array
    return chain.reverse().map(entry => {
      // Prefix user messages with display name when multiple humans are in the chain
      const hasPfx = !!(multiUser && entry.role === 'user' && entry.authorName);
      const content = hasPfx
        ? `${entry.authorName}: ${entry.content}`
        : entry.content;
      return {
        role: entry.role,
        content,
        contextSource: 'reply' as const,
        discordMessageId: entry.id,
        createdAtMs: entry.createdAt,
        ...(hasPfx && { hasNamePrefix: true }),
        ...(entry.images && { images: entry.images }),
      };
    });
  }

  /**
   * Collect recent DM channel history as conversation context.
   * Unlike reply-chain collection, this fetches the most recent messages
   * in the DM channel so DM conversations flow naturally without requiring
   * explicit replies. Does NOT include the current message.
   */
  async collectDmHistory(message: Message): Promise<ChatMessage[]> {
    const maxDepth = config.getReplyChainMaxDepth();
    const maxTotalChars = config.getReplyChainMaxTokens();
    const botId = message.client.user?.id;

    try {
      // Fetch recent messages before the current one
      const fetched = await message.channel.messages.fetch({
        limit: maxDepth + 1, // +1 because the current message may be included
        before: message.id,
      });

      if (!fetched || fetched.size === 0) return [];

      // Sort oldest-first
      const sorted = [...fetched.values()].reverse();

      let totalChars = 0;

      // Build from oldest but we'll trim from the oldest side at the end
      // to keep the newest messages when budget is exceeded
      const candidates: ChatMessage[] = [];

      for (const msg of sorted) {
        // Skip other bots unless ALLOW_BOT_INTERACTIONS is enabled
        const isThisBot = msg.author.id === botId;
        if (msg.author.bot && !isThisBot && !config.getAllowBotInteractions()) continue;

        let content = msg.content || '';

        // Strip bot mentions
        if (botId) {
          const mentionRegex = new RegExp(`<@!?${botId}>`, 'g');
          content = content.replace(mentionRegex, '').trim();
        }

        if (!content) continue;

        const role = msg.author.id === botId ? 'assistant' as const : 'user' as const;
        // Prefix user messages with display name so the model sees who said what,
        // matching the format used in the trigger message and guild context.
        const isUserMsg = role === 'user';
        if (isUserMsg) {
          const dmDisplayName = msg.author.displayName ?? msg.author.username;
          content = `${dmDisplayName}: ${content}`;
        }
        candidates.push({
          role,
          content,
          contextSource: 'dm',
          createdAtMs: msg.createdTimestamp,
          ...(isUserMsg && { hasNamePrefix: true }),
        });
      }

      // Keep newest messages when character budget is exceeded:
      // walk backwards from newest, accumulate until budget is hit, then reverse
      const kept: ChatMessage[] = [];
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (totalChars + candidates[i].content.length > maxTotalChars) {
          logger.log('success', 'system', `DM-HISTORY: Character limit reached (${totalChars}/${maxTotalChars}), keeping newest`);
          break;
        }
        totalChars += candidates[i].content.length;
        kept.push(candidates[i]);
      }
      kept.reverse(); // restore chronological order (oldest→newest)

      if (kept.length > 0) {
        logger.log('success', 'system', `DM-HISTORY: Collected ${kept.length} message(s) of context`);
      }

      return kept;
    } catch (error) {
      logger.logError('system', `DM-HISTORY: Failed to fetch DM history: ${error}`);
      return [];
    }
  }

  /**
   * Fetch the bot's DM history with the requesting user for use as
   * background context in guild channel messages.
   * Returns an empty array when DMs are disabled or on any error.
   */
  async fetchUserDmHistory(message: Message): Promise<ChatMessage[]> {
    const limit = config.getDmContextMaxMessages();
    if (limit <= 0) return [];

    const botId = message.client.user?.id;

    try {
      const dmChannel = await message.author.createDM();
      const fetched = await dmChannel.messages.fetch({ limit });

      if (!fetched || fetched.size === 0) return [];

      // Sort oldest-first
      const sorted = [...fetched.values()].reverse();

      const results: ChatMessage[] = [];
      for (const msg of sorted) {
        const isThisBot = msg.author.id === botId;
        if (msg.author.bot && !isThisBot) continue;

        let content = msg.content || '';
        if (botId) {
          const mentionRegex = new RegExp(`<@!?${botId}>`, 'g');
          content = content.replace(mentionRegex, '').trim();
        }
        if (!content) continue;

        const role = isThisBot ? 'assistant' as const : 'user' as const;
        const isUserMsg = role === 'user';
        if (isUserMsg) {
          const dmDisplayName = msg.author.displayName ?? msg.author.username;
          content = `${dmDisplayName}: ${content}`;
        }

        results.push({
          role,
          content,
          contextSource: 'dm_private',
          createdAtMs: msg.createdTimestamp,
          ...(isUserMsg && { hasNamePrefix: true }),
        });
      }

      if (results.length > 0) {
        logger.log('success', 'system', `DM-CONTEXT: Fetched ${results.length} private DM message(s) for guild context`);
      }

      return results;
    } catch (error) {
      logger.log('success', 'system', `DM-CONTEXT: Could not fetch DM history (user may have DMs disabled): ${error}`);
      return [];
    }
  }

  /**
   * Collect recent channel (or thread) messages as ambient context.
   * Similar to collectDmHistory but tags each message with channel
   * metadata and supports multi-user display-name attribution.
   * Does NOT include the current message.
   *
   * @param message - The triggering Discord message.
   * @param maxDepth - Maximum messages to fetch (defaults to global config).
   * @param maxTotalChars - Character budget (defaults to global config).
   */
  async collectChannelHistory(
    message: Message,
    maxDepth?: number,
    maxTotalChars?: number
  ): Promise<ChatMessage[]> {
    const effectiveMaxDepth = maxDepth ?? config.getReplyChainMaxDepth();
    const effectiveMaxChars = maxTotalChars ?? config.getReplyChainMaxTokens();
    const botId = message.client.user?.id;

    try {
      const fetched = await message.channel.messages.fetch({
        limit: effectiveMaxDepth + 1,
        before: message.id,
      });

      if (!fetched || fetched.size === 0) return [];

      // Sort oldest-first
      const sorted = [...fetched.values()].reverse();

      const chain: ChatMessage[] = [];
      const userAuthors = new Set<string>();
      let totalChars = 0;

      // First pass: identify unique non-bot authors for multi-user attribution
      for (const msg of sorted) {
        if (msg.author.id !== botId && !msg.author.bot) {
          userAuthors.add(msg.author.id);
        }
      }
      // Include the triggering message author for multi-user detection
      userAuthors.add(message.author.id);
      const multiUser = userAuthors.size > 1;

      for (const msg of sorted) {
        // Skip bot's processing messages
        if (msg.content === '⏳ Processing your request...') continue;

        // Skip other bots unless ALLOW_BOT_INTERACTIONS is enabled
        const isThisBot = msg.author.id === botId;
        if (msg.author.bot && !isThisBot && !config.getAllowBotInteractions()) continue;

        let content = msg.content || '';

        // Strip bot mentions
        if (botId) {
          const mentionRegex = new RegExp(`<@!?${botId}>`, 'g');
          content = content.replace(mentionRegex, '').trim();
        }

        // Strip remaining Discord markup
        content = content.replace(/<@[!&]?\d+>|<#\d+>|<a?:\w+:\d+>/g, '').trim();

        if (!content) continue;

        const isBot = msg.author.id === botId;
        const role = isBot ? 'assistant' as const : 'user' as const;

        // Multi-user attribution
        const hasPfx = !!(multiUser && !isBot);
        if (hasPfx) {
          const displayName = msg.member?.displayName ?? msg.author.username;
          content = `${displayName}: ${content}`;
        }

        // Check character budget — accumulate all candidates first,
        // then trim from oldest side later to keep newest messages
        totalChars += content.length;

        // Determine context source based on channel type
        const isThread = message.channel.isThread();
        const contextSource = isThread ? 'thread' as const : 'channel' as const;

        chain.push({
          role,
          content,
          contextSource,
          discordMessageId: msg.id,
          createdAtMs: msg.createdTimestamp,
          ...(hasPfx && { hasNamePrefix: true }),
        });
      }

      // Trim from oldest side to keep newest messages within char budget
      while (chain.length > 0 && totalChars > effectiveMaxChars) {
        const oldest = chain.shift()!;
        totalChars -= oldest.content.length;
        logger.log('success', 'system', `CHANNEL-HISTORY: Dropping oldest message to fit character budget (${totalChars}/${effectiveMaxChars})`);
      }

      if (chain.length > 0) {
        logger.log('success', 'system', `CHANNEL-HISTORY: Collected ${chain.length} message(s) of ${message.channel.isThread() ? 'thread' : 'channel'} context`);
      }

      return chain;
    } catch (error) {
      logger.logError('system', `CHANNEL-HISTORY: Failed to fetch channel history: ${error}`);
      return [];
    }
  }

  /**
   * Collate reply-chain and channel/thread context into one
   * chronological history. De-duplicates by discordMessageId. Reply/thread
   * messages fill first; channel messages fill remaining slots up to maxDepth.
   * When either budget (depth or chars) is exceeded, the **newest** messages
   * are kept (dropped from the oldest side). The result is sorted oldest→newest.
   */
  collateGuildContext(
    replyContext: ChatMessage[],
    channelContext: ChatMessage[],
    maxDepth: number,
    maxTotalChars: number
  ): ChatMessage[] {
    const seen = new Set<string>();
    let totalChars = 0;

    // Collect all reply/thread context (newest-first so we keep the tail when trimming)
    const allDirect: ChatMessage[] = [];
    for (let i = replyContext.length - 1; i >= 0; i--) {
      const msg = replyContext[i];
      if (msg.discordMessageId) seen.add(msg.discordMessageId);
      allDirect.push(msg);
    }

    // Trim direct context to depth budget, keeping newest
    while (allDirect.length > maxDepth) allDirect.pop();

    // Trim direct context to char budget, dropping oldest (end of reversed array)
    while (allDirect.length > 0) {
      const candidateChars = allDirect.reduce((sum, m) => sum + m.content.length, 0);
      if (candidateChars <= maxTotalChars) {
        totalChars = candidateChars;
        break;
      }
      allDirect.pop(); // drop oldest
    }

    // Restore chronological order
    allDirect.reverse();

    const remainingDepth = maxDepth - allDirect.length;
    const remainingChars = maxTotalChars - totalChars;

    // Collect channel candidates (newest-first), skipping duplicates
    const chCandidates: ChatMessage[] = [];
    for (let i = channelContext.length - 1; i >= 0; i--) {
      const msg = channelContext[i];
      if (msg.discordMessageId && seen.has(msg.discordMessageId)) continue;
      if (msg.discordMessageId) seen.add(msg.discordMessageId);
      chCandidates.push(msg);
    }

    // Trim channel to remaining budgets, keeping newest
    while (chCandidates.length > remainingDepth) chCandidates.pop();

    while (chCandidates.length > 0) {
      const chChars = chCandidates.reduce((sum, m) => sum + m.content.length, 0);
      if (chChars <= remainingChars) break;
      chCandidates.pop(); // drop oldest
    }

    chCandidates.reverse(); // restore chronological order

    const result = [...allDirect, ...chCandidates];

    // Sort chronologically (oldest first) using createdAtMs when available
    result.sort((a, b) => {
      const ta = a.createdAtMs ?? 0;
      const tb = b.createdAtMs ?? 0;
      return ta - tb;
    });

    if (replyContext.length > 0 && channelContext.length > 0) {
      logger.log('success', 'system',
        `CONTEXT-COLLATE: ${replyContext.length} reply/thread + ${channelContext.length} channel → ${result.length} collated (max ${maxDepth})`);
    }

    return result;
  }

  /**
   * Match a tool only when the message starts with the command prefix (!).
   * Tools are sorted longest-first so multi-word tool names like
   * "!get_recent_nfl_data" take priority over shorter overlaps.
   * Disabled tools (enabled === false) are skipped.
   *
   * Messages without the command prefix are NOT matched here — they are
   * routed through the two-stage Ollama evaluation for inference-first
   * parameter extraction.
   */
  private findTool(content: string): ToolConfig | undefined {
    const lowerContent = content.toLowerCase().trim();

    // Only match if the message starts with the command prefix
    if (!lowerContent.startsWith(COMMAND_PREFIX)) return undefined;

    // Sort longest tool name first so more specific multi-word names win.
    const sorted = [...config.getTools()]
      .filter((k) => k.enabled !== false)
      .sort(
        (a, b) => b.name.length - a.name.length
      );
    return sorted.find((k) => {
      const rawName = k.name.toLowerCase().trim();
      if (!rawName) return false;

      // Normalize: ensure tool name includes the command prefix for matching
      const toolName = rawName.startsWith(COMMAND_PREFIX)
        ? rawName
        : `${COMMAND_PREFIX}${rawName}`;

      // Built-in !help is intentionally standalone-only.
      if (this.toolNameIs(rawName, 'help')) {
        return lowerContent === `${COMMAND_PREFIX}help`;
      }

      // Built-in !activity_key is standalone-only, same as help.
      if (this.toolNameIs(rawName, 'activity_key')) {
        return lowerContent === `${COMMAND_PREFIX}activity_key`;
      }

      const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Anchor to START of message + word boundary after tool name
      const pattern = new RegExp(`^${escaped}\\b`, 'i');
      return pattern.test(lowerContent);
    });
  }

  /**
   * Check whether a DM author shares at least one guild with the bot.
   * Uses the client guild cache (populated by the Guilds intent) and
   * attempts a per-guild member fetch, short-circuiting on first hit.
   * Returns false if the user is not found in any mutual guild.
   */
  private async userSharesGuildWithBot(message: Message): Promise<boolean> {
    const userId = message.author.id;
    const guilds = message.client.guilds.cache;

    // Fast path: check in-memory member caches first (no API calls)
    for (const guild of guilds.values()) {
      if (guild.members.cache.has(userId)) return true;
    }

    // Slow path: fetch from API, stopping at first success
    for (const guild of guilds.values()) {
      try {
        await guild.members.fetch(userId);
        return true;
      } catch {
        // User not in this guild — continue to next
      }
    }

    return false;
  }

  /** Allowed MIME types for image attachments. */
  private static readonly IMAGE_MIME_TYPES = new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  ]);

  /**
   * Extract image attachments from a Discord message, downloading each
   * and encoding as base64. Respects configured size and count limits.
   * Returns an array of base64-encoded image strings (may be empty).
   */
  async extractImageAttachments(message: Message): Promise<string[]> {
    if (!message.attachments || typeof message.attachments.values !== 'function') return [];
    const attachments = [...message.attachments.values()];
    if (attachments.length === 0) return [];

    const maxSize = config.getImageAttachmentMaxSize();
    const maxCount = config.getImageAttachmentMaxCount();
    const results: string[] = [];

    for (const attachment of attachments) {
      if (results.length >= maxCount) {
        logger.log('success', 'system',
          `VISION: Reached image cap (${maxCount}) — skipping remaining attachments`);
        break;
      }

      // Validate content type
      const contentType = attachment.contentType ?? '';
      if (!MessageHandler.IMAGE_MIME_TYPES.has(contentType)) {
        // Not an image — skip silently
        continue;
      }

      // Validate size
      if (attachment.size > maxSize) {
        logger.logWarn('system',
          `VISION: Skipping oversized image "${attachment.name}" (${attachment.size} bytes > ${maxSize} limit)`);
        continue;
      }

      try {
        const response = await axios.get(attachment.url, {
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const base64 = Buffer.from(response.data).toString('base64');
        results.push(base64);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.logWarn('system', `VISION: Failed to download image "${attachment.name}": ${errorMsg}`);
      }
    }

    if (results.length > 0) {
      logger.log('success', 'system', `VISION: Extracted ${results.length} image(s) for processing`);
    }

    return results;
  }

  /**
   * Unified pipeline: cumulative context building with 1-2 Ollama calls.
   *
   * Stage 1 — Tool Evaluation + Response (1 Ollama call):
   *   Full conversation history + abilities in a single call. The model
   *   produces a response and any tool selections via native tool_calls.
   *
   * Stage 2 — Parallel Tool Execution (0 Ollama calls):
   *   All tool invocations run in parallel via Promise.all (requestQueue
   *   enforces per-API serialization internally).
   *
   * Stage 3 — Final Pass with Full Context (0-1 Ollama calls):
   *   Only runs when the final pass model differs from the tool model,
   *   or when tools produced external data. Includes full conversation
   *   history alongside any captured Stage 1 response and tool results.
   */
  private async executeUnifiedPipeline(
    ctx: PipelineContext,
    toolConfig: ToolConfig
  ): Promise<void> {
    const timeout = toolConfig.timeout || config.getDefaultTimeout();

    // Append the triggering message to context so the model knows who is asking.
    const historyWithTrigger: ChatMessage[] = [
      ...ctx.conversationHistory,
      {
        role: 'user' as const,
        content: `${ctx.requester}: ${ctx.rawContent}`,
        contextSource: 'trigger' as const,
        hasNamePrefix: true,
        createdAtMs: ctx.sourceMessage.createdTimestamp,
      },
    ];

    // ── Stage 1: Tool Evaluation + Response ─────────────────────
    logger.log('success', 'system', 'UNIFIED: Stage 1 — Tool evaluation + response');

    const tools = buildOllamaToolsSchema(config.getTools());
    const useToolsPath = tools.length > 0;

    const assembled = assemblePrompt({
      userMessage: ctx.rawContent,
      conversationHistory: historyWithTrigger,
      botDisplayName: ctx.botDisplayName,
      dmHistory: ctx.dmHistory,
      ...(useToolsPath ? { enabledTools: [] } : {}),
    });

    if (useToolsPath) {
      logger.log('success', 'system', `UNIFIED: Stage 1 — ${tools.length} native tool(s) available`);
    }

    const toolProvider = config.getProviderToolEval();
    const toolApi = toolProvider === 'xai' ? 'xai' as const : 'ollama' as const;
    const toolModel = toolProvider === 'xai' ? config.getXaiModel() : config.getOllamaToolModel();

    const ollamaResult = await requestQueue.execute(
      toolApi,
      ctx.requester,
      'unified:stage1',
      timeout,
      (signal) =>
        apiManager.executeRequest(
          toolApi,
          ctx.requester,
          assembled.userContent,
          timeout,
          toolModel,
          [{ role: 'system', content: assembled.systemContent }],
          signal,
          undefined,
          {
            includeSystemPrompt: false,
            contextSize: config.getOllamaToolContextSize(),
            timeout: toolProvider === 'xai' ? config.getXaiTimeout() : config.getOllamaToolTimeout(),
            ...(useToolsPath ? { tools } : {}),
            ...(ctx.imagePayloads.length > 0 ? { images: ctx.imagePayloads } : {}),
          }
        )
    ) as OllamaResponse;
    ctx.ollamaCallCount++;

    if (!ollamaResult.success) {
      await this.dispatchResponse(ollamaResult, 'ollama', ctx.sourceMessage, ctx.requester, ctx.isDM);
      return;
    }

    ctx.stage1Draft = ollamaResult.data?.text ?? '';

    // Collect tool calls from native tool_calls
    const toolCalls = (useToolsPath && ollamaResult.data?.tool_calls) ? ollamaResult.data.tool_calls : [];

    // If no native tool_calls, try legacy first-line parsing (text-based directives)
    let legacyParsedTool: ToolParseResult | null = null;
    if (toolCalls.length === 0 && ctx.stage1Draft) {
      const parsed = parseFirstLineTool(ctx.stage1Draft);
      if (parsed.matched && parsed.toolConfig) {
        legacyParsedTool = parsed;
      }
    }

    const hasTools = toolCalls.length > 0 || legacyParsedTool !== null;

    // ── Fast path: no tools, same model → Stage 1 response IS the final response ──
    if (!hasTools && !config.needsSeparateFinalPass()) {
      logger.log('success', 'system', `UNIFIED: Fast path — no tools, same model → 1 Ollama call total`);
      await this.dispatchResponse(ollamaResult, 'ollama', ctx.sourceMessage, ctx.requester, ctx.isDM);
      return;
    }

    // ── No tools, different final model → Stage 3 personality refinement only ──
    if (!hasTools) {
      logger.log('success', 'system', 'UNIFIED: No tools, different final model — running Stage 3 for personality');
      const finalResult = await this.runUnifiedFinalPass(ctx, undefined, timeout);
      await this.dispatchResponse(finalResult ?? ollamaResult, 'ollama', ctx.sourceMessage, ctx.requester, ctx.isDM);
      return;
    }

    // ── Stage 2: Parallel Tool Execution ─────────────────────────
    logger.log('success', 'system', 'UNIFIED: Stage 2 — Parallel tool execution');

    const configuredTools = config.getTools();
    const toolPromises: Promise<ToolInvocation>[] = [];

    if (toolCalls.length > 0) {
      // Native tool_calls path
      for (const tc of toolCalls) {
        const normalizedName = tc.function.name.replace(/^!\s*/, '').trim().toLowerCase();
        if (normalizedName === 'delegate_to_local') {
          ctx.forceOllamaFinalPass = true;
          logger.log('success', 'system', 'UNIFIED: delegate_to_local invoked — final pass will use Ollama');
          continue;
        }
        const resolvedTool = resolveToolNameToTool(tc.function.name, configuredTools);
        if (!resolvedTool) {
          logger.logWarn('system', `UNIFIED: Unknown tool name "${tc.function.name}" — skipping`);
          continue;
        }
        const args = typeof tc.function.arguments === 'object' && tc.function.arguments !== null
          ? (tc.function.arguments as Record<string, unknown>)
          : {};
        const contentStr = toolArgumentsToContent(resolvedTool, args);
        activityEvents.emitRoutingDecision(resolvedTool.api, resolvedTool.name, 'tool-call');

        toolPromises.push(this.executeToolInvocation(resolvedTool, contentStr, ctx, timeout));
      }
    } else if (legacyParsedTool?.toolConfig) {
      // Legacy text-based directive path
      const tool = legacyParsedTool.toolConfig;
      const routedInput = (legacyParsedTool.inferredInput?.trim() || ctx.rawContent);
      activityEvents.emitRoutingDecision(tool.api, tool.name, 'two-stage-parse');

      toolPromises.push(this.executeToolInvocation(tool, routedInput, ctx, timeout));
    }

    // Run all tool invocations in parallel — requestQueue handles per-API serialization
    const results = await Promise.all(toolPromises);

    for (const result of results) {
      // Check for delete_to_local: set ephemeral flag to force Ollama final pass
      if (result.toolName.replace(/^!\s*/, '').trim().toLowerCase() === 'delete_to_local') {
        ctx.forceOllamaFinalPass = true;
        logger.log('success', 'system', 'UNIFIED: delete_to_local invoked — final pass will use Ollama');
        continue;
      }
      ctx.toolResults.push(result);
      if (result.media) ctx.mediaFollowUps.push(result.media);
    }

    // Collect external data from successful tool results
    const externalDataParts = ctx.toolResults
      .filter(r => r.externalData)
      .map(r => r.externalData!);

    if (externalDataParts.length === 0 && toolCalls.length > 0) {
      // All tools failed — return the Stage 1 response as-is
      logger.logWarn('system', 'UNIFIED: All tool calls failed — returning Stage 1 response');
      await this.dispatchResponse(ollamaResult, 'ollama', ctx.sourceMessage, ctx.requester, ctx.isDM);
      return;
    }

    // ── Stage 3: Final Pass with Cumulative Context ──────────────
    const combinedExternalData = externalDataParts.join('\n\n');
    logger.log('success', 'system', `UNIFIED: Stage 3 — Final pass with ${externalDataParts.length} external data fragment(s)`);

    const finalResult = await this.runUnifiedFinalPass(ctx, combinedExternalData, timeout);

    await this.dispatchResponse(
      finalResult ?? ollamaResult,
      'ollama',
      ctx.sourceMessage,
      ctx.requester,
      ctx.isDM,
      ctx.mediaFollowUps.length > 0 ? ctx.mediaFollowUps : undefined
    );

    logger.log('success', 'system',
      `UNIFIED: Pipeline complete — ${ctx.ollamaCallCount} Ollama call(s), ${ctx.toolResults.length} tool(s), ${Date.now() - ctx.startedAt}ms`);
  }

  /**
   * Execute a single tool invocation for the unified pipeline.
   * Returns a ToolInvocation result with external data and media.
   */
  private async executeToolInvocation(
    tool: ToolConfig,
    contentStr: string,
    ctx: PipelineContext,
    _timeout: number
  ): Promise<ToolInvocation> {
    // Discord tools bypass executeRoutedRequest — handled directly
    if (tool.api === 'discord') {
      return this.executeDiscordTool(tool, contentStr, ctx);
    }

    try {
      const apiResult = await executeRoutedRequest(
        tool,
        contentStr,
        ctx.requester,
        ctx.conversationHistory.length > 0
          ? [...ctx.conversationHistory, {
              role: 'user' as const,
              content: `${ctx.requester}: ${ctx.rawContent}`,
              contextSource: 'trigger' as const,
              hasNamePrefix: true,
              createdAtMs: ctx.sourceMessage.createdTimestamp,
            }]
          : undefined,
        ctx.botDisplayName,
        undefined,
        { skipFinalPass: true },
        ctx.dmHistory
      );

      const externalData = formatApiResultAsExternalData(tool, apiResult.finalResponse, contentStr);

      // Capture media follow-ups
      let media: MediaFollowUp | undefined;
      if (tool.api === 'comfyui' && apiResult.finalResponse.success) {
        media = { kind: 'comfyui', response: apiResult.finalResponse as ComfyUIResponse };
      }
      if (tool.api === 'meme' && apiResult.finalResponse.success) {
        const url = (apiResult.finalResponse as MemeResponse).data?.imageUrl;
        if (url) media = { kind: 'url', url, label: 'meme' };
      }

      return {
        toolName: tool.name,
        api: tool.api,
        input: contentStr,
        externalData,
        media,
        success: apiResult.finalResponse.success,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.logError('system', `UNIFIED: Tool "${tool.name}" failed: ${errMsg}`);
      return {
        toolName: tool.name,
        api: tool.api,
        input: contentStr,
        success: false,
      };
    }
  }

  /**
   * Execute a Discord-native tool (send message, DM, get artifact, react).
   * Bypasses the external API routing — uses the bot's own discord.js Client.
   */
  private async executeDiscordTool(
    tool: ToolConfig,
    contentStr: string,
    ctx: PipelineContext,
  ): Promise<ToolInvocation> {
    try {
      let args: Record<string, string>;
      try {
        args = JSON.parse(contentStr);
      } catch {
        args = {};
      }

      const client = ctx.sourceMessage.client;
      const toolName = tool.name.replace(/^!\s*/, '').trim().toLowerCase();
      let result: DiscordActionResponse;

      switch (toolName) {
        case 'send_to_discord_guild':
          result = await discordActionClient.sendToGuildChannel(
            client,
            { guild: args.guild ?? '', channel: args.channel ?? '', content: args.content ?? '' },
            ctx.requester,
          );
          break;
        case 'send_to_discord_user':
          result = await discordActionClient.sendToUser(
            client,
            { user: args.user ?? '', content: args.content ?? '' },
            ctx.requester,
          );
          break;
        case 'get_discord_artifact':
          result = await discordActionClient.getArtifact(
            client,
            { channel: args.channel, message_id: args.message_id, search: args.search },
            ctx.requester,
            ctx.sourceMessage,
          );
          break;
        case 'react_to_message':
          result = await discordActionClient.reactToMessage(
            client,
            { emoji: args.emoji ?? '', target: args.target, message_id: args.message_id },
            ctx.requester,
            ctx.sourceMessage,
          );
          break;
        default:
          result = { success: false, error: `Unknown discord tool "${tool.name}".` };
      }

      const externalData = formatApiResultAsExternalData(tool, result, contentStr);

      return {
        toolName: tool.name,
        api: tool.api,
        input: contentStr,
        externalData,
        success: result.success,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.logError('system', `UNIFIED: Discord tool "${tool.name}" failed: ${errMsg}`);
      return {
        toolName: tool.name,
        api: tool.api,
        input: contentStr,
        success: false,
      };
    }
  }

  /**
   * Run the unified pipeline's Stage 3 final pass.
   * Includes full conversation history for context continuity.
   */
  private async runUnifiedFinalPass(
    ctx: PipelineContext,
    externalData: string | undefined,
    timeout: number
  ): Promise<OllamaResponse | null> {
    logger.log('success', 'system', 'UNIFIED-FINAL: Running Stage 3 final pass');
    activityEvents.emitFinalPassThought(externalData ? 'tools' : 'chat');

    const historyWithTrigger: ChatMessage[] = [
      ...ctx.conversationHistory,
      {
        role: 'user' as const,
        content: `${ctx.requester}: ${ctx.rawContent}`,
        contextSource: 'trigger' as const,
        hasNamePrefix: true,
        createdAtMs: ctx.sourceMessage.createdTimestamp,
      },
    ];

    const reprompt = assembleUnifiedReprompt({
      userMessage: ctx.rawContent,
      draftResponse: ctx.stage1Draft,
      externalData,
      botDisplayName: ctx.botDisplayName,
      requesterName: ctx.requester,
      conversationHistory: historyWithTrigger,
      dmHistory: ctx.dmHistory,
    });

    const finalPassPrompt = config.getOllamaFinalPassPrompt();
    const finalSystemContent = finalPassPrompt
      ? `${reprompt.systemContent}\n\n${finalPassPrompt}`
      : reprompt.systemContent;

    const finalProvider = ctx.forceOllamaFinalPass ? 'ollama' : config.getProviderFinalPass();
    const finalApi = finalProvider === 'xai' ? 'xai' as const : 'ollama' as const;
    const finalModel = finalProvider === 'xai'
      ? config.getXaiModel()
      : (config.getOllamaFinalPassModel() ?? undefined);
    const finalTimeout = finalProvider === 'xai'
      ? config.getXaiTimeout()
      : config.getOllamaFinalPassTimeout();

    try {
      const finalResult = await requestQueue.execute(
        finalApi,
        ctx.requester,
        'unified:final',
        timeout,
        (sig) =>
          apiManager.executeRequest(
            finalApi,
            ctx.requester,
            reprompt.userContent,
            timeout,
            finalModel,
            [{ role: 'system', content: finalSystemContent }],
            sig,
            undefined,
            { includeSystemPrompt: false, contextSize: config.getOllamaFinalPassContextSize(), timeout: finalTimeout }
          )
      ) as OllamaResponse;
      ctx.ollamaCallCount++;

      if (!finalResult.success) {
        logger.logWarn('system', `UNIFIED-FINAL: Final pass failed: ${finalResult.error} — falling back to Stage 1 response`);
        return null;
      }

      logger.log('success', 'system', 'UNIFIED-FINAL: Stage 3 complete');
      return finalResult;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.logError('system', `UNIFIED-FINAL: Final pass error: ${msg} — falling back to Stage 1 response`);
      return null;
    }
  }

  /**
   * Execute the Ollama evaluation flow (legacy pipeline):
   * 1. Build XML-tagged prompt with abilities context and conversation history
   * 2. Call Ollama — model outputs either a tool-only line or a normal answer
   * 3. Parse the first non-empty line for an exact tool match
   * 4. If tool matched → route to API via executeRoutedRequest
   *    (always with final Ollama pass so result is presented conversationally)
   * 5. If no tool matched → return Ollama's response as direct chat
   */
  private async executeWithTwoStageEvaluation(
    content: string,
    toolConfig: ToolConfig,
    sourceMessage: Message,
    requester: string,
    conversationHistory: ChatMessage[],
    isDM: boolean,
    botDisplayName?: string,
    strictNoApiRoutingFromInference: boolean = false,
    imagePayloads: string[] = [],
    dmHistory: ChatMessage[] = []
  ): Promise<void> {
    const timeout = toolConfig.timeout || config.getDefaultTimeout();

    // Apply context filter (Ollama-based relevance evaluation) before building the prompt,
    // only when global context evaluation is enabled.
    let filteredHistory = conversationHistory;
    if (config.getContextEvalEnabled() && conversationHistory.length > 0) {
      const preFilterCount = conversationHistory.filter(m => m.role !== 'system').length;
      logger.log('success', 'system',
        `TWO-STAGE: Context before eval: ${conversationHistory.length} total (${preFilterCount} non-system)`);
      filteredHistory = await evaluateContextWindow(
        conversationHistory,
        content,
        toolConfig,
        requester
      );
      logger.log('success', 'system',
        `TWO-STAGE: Context after eval: ${filteredHistory.length} messages (system messages excluded)`);
    } else if (!config.getContextEvalEnabled() && conversationHistory.length > 0) {
      logger.log('success', 'system',
        `TWO-STAGE: Context eval skipped (global CONTEXT_EVAL_ENABLED is off)`);
    }

    // Append the triggering message to context so the model knows who is asking.
    // This is done after context evaluation so it is never filtered out.
    filteredHistory = [
      ...filteredHistory,
      { role: 'user' as const, content: `${requester}: ${content}`, contextSource: 'trigger' as const, hasNamePrefix: true, createdAtMs: sourceMessage.createdTimestamp },
    ];

    // Native tools path: when tools are available, use Ollama tool_calls (max 3) and one final pass.
    const tools = buildOllamaToolsSchema(config.getTools());
    const useToolsPath = tools.length > 0;

    const assembled = assemblePrompt({
      userMessage: content,
      conversationHistory: filteredHistory,
      botDisplayName,
      dmHistory,
      ...(useToolsPath ? { enabledTools: [] } : {}),
    });

    if (!useToolsPath) {
      const abilityCount = (assembled.systemContent.match(/^- /gm) || []).length;
      if (abilityCount > 0) {
        logger.log('success', 'system', `TWO-STAGE: Legacy path — ${abilityCount} ability/abilities in prompt`);
      } else {
        logger.log('success', 'system', 'TWO-STAGE: No abilities configured — standard Ollama chat');
      }
    } else {
      logger.log('success', 'system', `TWO-STAGE: Native tools mode — ${tools.length} tool(s), max 3 calls per turn`);
    }

    const legacyToolProvider = config.getProviderToolEval();
    const legacyToolApi = legacyToolProvider === 'xai' ? 'xai' as const : 'ollama' as const;
    const legacyToolModel = legacyToolProvider === 'xai' ? config.getXaiModel() : config.getOllamaToolModel();

    const ollamaResult = await requestQueue.execute(
      legacyToolApi,
      requester,
      toolConfig.name,
      timeout,
      (signal) =>
        apiManager.executeRequest(
          legacyToolApi,
          requester,
          assembled.userContent,
          timeout,
          legacyToolModel,
          [{ role: 'system', content: assembled.systemContent }],
          signal,
          undefined,
          {
            includeSystemPrompt: false,
            contextSize: config.getOllamaToolContextSize(),
            timeout: legacyToolProvider === 'xai' ? config.getXaiTimeout() : config.getOllamaToolTimeout(),
            ...(useToolsPath ? { tools } : {}),
            ...(imagePayloads.length > 0 ? { images: imagePayloads } : {}),
          }
        )
    ) as OllamaResponse;

    if (!ollamaResult.success) {
      await this.dispatchResponse(ollamaResult, 'ollama', sourceMessage, requester, isDM);
      return;
    }

    // Tools path: handle structured tool_calls (already trimmed to DEFAULT_MAX_TOOL_CALLS by client).
    if (useToolsPath && ollamaResult.data?.tool_calls && ollamaResult.data.tool_calls.length > 0) {
      const toolCalls = ollamaResult.data.tool_calls;
      const externalDataParts: string[] = [];
      const configuredTools = config.getTools();
      const mediaFollowUps: MediaFollowUp[] = [];
      let forceOllamaFP = false;

      // Resolve tools and extract delegate_to_local before policy check
      const legacyResolved: { tool: ToolConfig; content: string }[] = [];
      for (const tc of toolCalls) {
        const normalizedName = tc.function.name.replace(/^!\s*/, '').trim().toLowerCase();
        if (normalizedName === 'delegate_to_local') {
          forceOllamaFP = true;
          logger.log('success', 'system', 'TWO-STAGE: delegate_to_local invoked — final pass will use Ollama');
          continue;
        }
        const resolvedTool = resolveToolNameToTool(tc.function.name, configuredTools);
        if (!resolvedTool) {
          logger.logWarn('system', `TWO-STAGE: Unknown tool name "${tc.function.name}" — skipping`);
          continue;
        }
        const args = typeof tc.function.arguments === 'object' && tc.function.arguments !== null
          ? (tc.function.arguments as Record<string, unknown>)
          : {};
        const contentStr = toolArgumentsToContent(resolvedTool, args);
        activityEvents.emitRoutingDecision(resolvedTool.api, resolvedTool.name, 'tool-call');

        const apiResult = await executeRoutedRequest(
          resolvedTool,
          contentStr,
          requester,
          filteredHistory.length > 0 ? filteredHistory : undefined,
          botDisplayName,
          undefined,
          { skipFinalPass: true },
          dmHistory
        );
        // Capture media follow-ups for attachment after the text reply
        if (resolvedTool.api === 'comfyui' && apiResult.finalResponse.success
            && !mediaFollowUps.some(m => m.kind === 'comfyui')) {
          mediaFollowUps.push({ kind: 'comfyui', response: apiResult.finalResponse as ComfyUIResponse });
        }
        if (resolvedTool.api === 'meme' && apiResult.finalResponse.success) {
          const url = (apiResult.finalResponse as MemeResponse).data?.imageUrl;
          if (url) mediaFollowUps.push({ kind: 'url', url, label: 'meme' });
        }
        const part = formatApiResultAsExternalData(resolvedTool, apiResult.finalResponse, contentStr);
        externalDataParts.push(part);
      }

      if (externalDataParts.length === 0) {
        await this.dispatchResponse(ollamaResult, 'ollama', sourceMessage, requester, isDM);
        return;
      }

      const combinedExternalData = externalDataParts.join('\n\n');
      const reprompt = assembleReprompt({
        userMessage: content,
        conversationHistory: filteredHistory,
        externalData: combinedExternalData,
        botDisplayName,
      });
      const finalPassPrompt = config.getOllamaFinalPassPrompt();
      const finalSystemContent = finalPassPrompt
        ? `${reprompt.systemContent}\n\n${finalPassPrompt}`
        : reprompt.systemContent;

      const tsFpProvider = forceOllamaFP ? 'ollama' : config.getProviderFinalPass();
      const tsFpApi = tsFpProvider === 'xai' ? 'xai' as const : 'ollama' as const;
      const tsFpModel = tsFpProvider === 'xai' ? config.getXaiModel() : (config.getOllamaFinalPassModel() ?? undefined);
      const tsFpTimeout = tsFpProvider === 'xai' ? config.getXaiTimeout() : config.getOllamaFinalPassTimeout();

      const finalResult = await requestQueue.execute(
        tsFpApi,
        requester,
        'tools:final',
        timeout,
        (sig) =>
          apiManager.executeRequest(
            tsFpApi,
            requester,
            reprompt.userContent,
            timeout,
            tsFpModel,
            [{ role: 'system', content: finalSystemContent }],
            sig,
            undefined,
            { includeSystemPrompt: false, contextSize: config.getOllamaFinalPassContextSize(), timeout: tsFpTimeout }
          )
      ) as OllamaResponse;

      await this.dispatchResponse(finalResult, 'ollama', sourceMessage, requester, isDM, mediaFollowUps);
      return;
    }

    // Tools path with no tool_calls: run mandatory final pass for consistent personality.
    if (useToolsPath) {
      const finalResult = await this.runFinalPass(content, filteredHistory, botDisplayName, requester, timeout);
      await this.dispatchResponse(finalResult ?? ollamaResult, 'ollama', sourceMessage, requester, isDM);
      return;
    }

    const ollamaText = ollamaResult.data?.text;

    // Legacy: parse first line for tool match (when not using native tools).
    if (ollamaText) {
      const parseResult = parseFirstLineTool(ollamaText);

      if (parseResult.matched && parseResult.toolConfig) {
        if (strictNoApiRoutingFromInference) {
          logger.logWarn('system',
            `TWO-STAGE: Ignoring inferred tool "${parseResult.toolConfig.name}" because input was an unknown command-style message`);
          await this.dispatchResponse(ollamaResult, 'ollama', sourceMessage, requester, isDM);
          return;
        }

        let routedInput = (parseResult.inferredInput && parseResult.inferredInput.trim().length > 0)
          ? parseResult.inferredInput
          : content;

        const abilityInputs = parseResult.toolConfig.abilityInputs;
        const isImplicitOrMixed =
          !!abilityInputs &&
          (abilityInputs.mode === 'implicit' || abilityInputs.mode === 'mixed');

        // For implicit/mixed abilities the first-stage model often returns a
        // rich, context-aware prompt inline (parseResult.inferredInput).
        // In reply-chain scenarios this inline input already incorporates
        // conversation context, so we now treat it as the *primary* source.
        // Second-pass content inference is used only as a fallback when
        // no inline input was provided.
        const hasInlineInput = !!parseResult.inferredInput && parseResult.inferredInput.trim().length > 0;

        if (isImplicitOrMixed && hasInlineInput) {
          // Prefer the first-stage inline input — it benefits from full
          // conversation context the model already saw.
          routedInput = parseResult.inferredInput!.trim();
          logger.log('success', 'system',
            `TWO-STAGE: Using first-stage inline input for "${parseResult.toolConfig.name}"`);
        }

        // When the model matched a tool but no inline params were provided,
        // and the tool has required inputs, use Ollama to infer parameters
        // from the user's natural language message (enriched with reply context).
        const hasRequiredInputs = parseResult.toolConfig.abilityInputs?.required &&
          parseResult.toolConfig.abilityInputs.required.length > 0;
        const needsInference = hasRequiredInputs
          ? (!hasInlineInput)
          : (isImplicitOrMixed && !hasInlineInput);
        if (needsInference) {
          // Build reply-context string from conversation history for inference
          const replyContext = filteredHistory
            .filter(m => m.role !== 'system' && m.contextSource !== 'trigger')
            .map(m => m.content)
            .join('\n')
            .trim() || undefined;
          const inferred = await inferAbilityParameters(parseResult.toolConfig, content, requester, undefined, replyContext);
          if (inferred) {
            routedInput = inferred;
            logger.log('success', 'system',
              `TWO-STAGE: Inferred parameter "${inferred}" for "${parseResult.toolConfig.name}"`);
          } else {
            logger.logWarn('system',
              `TWO-STAGE: Could not infer parameter for "${parseResult.toolConfig.name}" — using original content`);
          }
        }

        logger.log('success', 'system',
          `TWO-STAGE: First-line tool match "${parseResult.toolConfig.name}" — executing ${parseResult.toolConfig.api} API`);
        activityEvents.emitRoutingDecision(parseResult.toolConfig.api, parseResult.toolConfig.name, 'two-stage-parse');

        // DISABLED: commentary prelude causes double-reply for routed requests.
        // const commentaryPrelude = this.buildDirectiveCommentary(parseResult, routedInput);
        // if (commentaryPrelude) {
        //   await this.sendCommentaryPrelude(sourceMessage, requester, isDM, commentaryPrelude);
        // }

        const apiResult = await executeRoutedRequest(
          parseResult.toolConfig,
          routedInput,
          requester,
          filteredHistory.length > 0 ? filteredHistory : undefined,
          botDisplayName,
          undefined,
          undefined,
          dmHistory
        );

        await this.dispatchResponse(
          apiResult.finalResponse,
          apiResult.finalApi,
          sourceMessage,
          requester,
          isDM,
          apiResult.media
        );
        return;
      }

    }

    // Fallback: if stage-1 didn't emit an ability directive but the message is
    // clearly an image-generation request, route to generate_image using a
    // context-derived prompt. This avoids brittle dependency on strict
    // first-line directive formatting for natural-language image requests.
    if (!strictNoApiRoutingFromInference && this.isLikelyImageRequest(content)) {
      const imageToolConfig = this.findEnabledToolByName('generate_image');

      if (imageToolConfig && imageToolConfig.api === 'comfyui') {
        const inferredPrompt = this.deriveImagePromptFromContext(content, filteredHistory);
        if (inferredPrompt) {
          logger.log('success', 'system',
            `TWO-STAGE: Image fallback inference succeeded for "${imageToolConfig.name}" — executing comfyui API`);

          const imageResult = await executeRoutedRequest(
            imageToolConfig,
            inferredPrompt,
            requester,
            filteredHistory.length > 0 ? filteredHistory : undefined,
            botDisplayName,
            undefined,
            undefined,
            dmHistory
          );

          await this.dispatchResponse(
            imageResult.finalResponse,
            imageResult.finalApi,
            sourceMessage,
            requester,
            isDM,
            imageResult.media
          );
          return;
        }

        logger.logWarn('system',
          `TWO-STAGE: Image fallback could not infer a concrete prompt for "${imageToolConfig.name}"; returning direct chat response`);
      }
    }

    // Fallback: if stage-1 didn't emit an ability directive but the message is
    // clearly a meme request, run meme parameter inference directly and route
    // to the meme API. This avoids brittle dependency on strict first-line
    // directive formatting for natural-language meme requests.
    if (!strictNoApiRoutingFromInference && this.isLikelyMemeRequest(content)) {
      const memeToolConfig = this.findEnabledToolByName('generate_meme');
      if (memeToolConfig && memeToolConfig.api === 'meme') {
        const inferred = await inferAbilityParameters(memeToolConfig, content, requester);
        if (inferred) {
          logger.log('success', 'system',
            'TWO-STAGE: Meme fallback inference succeeded — executing meme API');

          const memeResult = await executeRoutedRequest(
            memeToolConfig,
            inferred,
            requester,
            filteredHistory.length > 0 ? filteredHistory : undefined,
            botDisplayName,
            undefined,
            undefined,
            dmHistory
          );

          await this.dispatchResponse(
            memeResult.finalResponse,
            memeResult.finalApi,
            sourceMessage,
            requester,
            isDM,
            memeResult.media
          );
          return;
        }

        logger.logWarn('system',
          'TWO-STAGE: Meme fallback inference did not return parameters; returning direct chat response');
      }
    }

    // No ability tool detected — run mandatory final pass for consistent personality
    logger.log('success', 'system', 'TWO-STAGE: No ability directive in Ollama response — running final pass');
    const finalResult = await this.runFinalPass(content, filteredHistory, botDisplayName, requester, timeout);
    await this.dispatchResponse(finalResult ?? ollamaResult, 'ollama', sourceMessage, requester, isDM);
  }

  /**
   * Run the mandatory final Ollama pass for pure chat (no tool matched).
   * Ensures all responses go through the OLLAMA_FINAL_PASS_MODEL with
   * the configured OLLAMA_FINAL_PASS_PROMPT for consistent personality.
   * Returns null if the final pass fails (caller should fall back to the
   * original Ollama result).
   */
  private async runFinalPass(
    content: string,
    conversationHistory: ChatMessage[],
    botDisplayName: string | undefined,
    requester: string,
    timeout: number
  ): Promise<OllamaResponse | null> {
    logger.log('success', 'system', 'FINAL-PASS: Running mandatory final pass for chat response');
    activityEvents.emitFinalPassThought('chat');

    const reprompt = assembleReprompt({
      userMessage: content,
      conversationHistory,
      botDisplayName,
    });

    const finalPassPrompt = config.getOllamaFinalPassPrompt();
    const finalSystemContent = finalPassPrompt
      ? `${reprompt.systemContent}\n\n${finalPassPrompt}`
      : reprompt.systemContent;

    const fpProvider = config.getProviderFinalPass();
    const fpApi = fpProvider === 'xai' ? 'xai' as const : 'ollama' as const;
    const fpModel = fpProvider === 'xai' ? config.getXaiModel() : (config.getOllamaFinalPassModel() ?? undefined);
    const fpTimeout = fpProvider === 'xai' ? config.getXaiTimeout() : config.getOllamaFinalPassTimeout();

    try {
      const finalResult = await requestQueue.execute(
        fpApi,
        requester,
        'chat:final',
        timeout,
        (sig) =>
          apiManager.executeRequest(
            fpApi,
            requester,
            reprompt.userContent,
            timeout,
            fpModel,
            [{ role: 'system', content: finalSystemContent }],
            sig,
            undefined,
            { includeSystemPrompt: false, contextSize: config.getOllamaFinalPassContextSize(), timeout: fpTimeout }
          )
      ) as OllamaResponse;

      if (!finalResult.success) {
        logger.logWarn('system', `FINAL-PASS: Final pass failed: ${finalResult.error} — falling back to tool eval response`);
        return null;
      }

      logger.log('success', 'system', 'FINAL-PASS: Final pass complete');
      return finalResult;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.logError('system', `FINAL-PASS: Final pass error: ${msg} — falling back to tool eval response`);
      return null;
    }
  }

  /**
   * Dispatch a response to the appropriate handler based on API type.
   * Handles error responses uniformly.
   */
  private async dispatchResponse(
    response: ComfyUIResponse | OllamaResponse | AccuWeatherResponse | NFLResponse | SerpApiResponse | MemeResponse | DiscordActionResponse,
    api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi' | 'meme' | 'discord' | 'xai',
    sourceMessage: Message,
    requester: string,
    isDM: boolean,
    media?: MediaFollowUp[]
  ): Promise<void> {
    if (!response.success) {
      const errorDetail = response.error ?? 'Unknown API error';
      throw new ApiDispatchError(errorDetail, api);
    }

    if (api === 'comfyui') {
      await this.handleComfyUIResponse(response as ComfyUIResponse, sourceMessage, requester, isDM);
    } else if (api === 'accuweather') {
      await this.handleAccuWeatherResponse(response as AccuWeatherResponse, sourceMessage, requester, isDM);
    } else if (api === 'nfl') {
      await this.handleNFLResponse(response as NFLResponse, sourceMessage, requester, isDM);
    } else if (api === 'serpapi') {
      await this.handleSerpApiResponse(response as SerpApiResponse, sourceMessage, requester, isDM);
    } else if (api === 'meme') {
      await this.handleMemeResponse(response as MemeResponse, sourceMessage, requester, isDM);
    } else {
      await this.handleOllamaResponse(response as OllamaResponse, sourceMessage, requester, isDM, media);
    }
  }

  /**
   * Build a user-facing help response listing all available tools
   * and how to use them.
   */
  buildHelpResponse(): string {
    const availableTools = config
      .getTools()
      .filter(k => k.enabled !== false && !this.toolNameIs(k.name, 'help'));

    const capabilityLines = availableTools.length > 0
      ? availableTools.map(k => {
          const bare = k.name.startsWith(COMMAND_PREFIX)
            ? k.name.slice(COMMAND_PREFIX.length)
            : k.name;
          return `• \`${COMMAND_PREFIX}${bare}\` — ${k.description}`;
        }).join('\n')
      : 'No tools are currently configured.';

    return [
      `**Available Tools**`,
      `To call a tool, prefix the tool name with \`${COMMAND_PREFIX}\` and provide it as the first word to the bot. Example: \`${COMMAND_PREFIX}web_search pickled eggs\``,
      'You can also describe what you need in natural language and the bot will infer the right action.',
      '',
      capabilityLines,
    ].join('\n');
  }

  /**
   * Remove the first occurrence of the routing tool name (including prefix)
   * from the content. Preserves surrounding whitespace and trims the result.
   */
  stripToolName(content: string, toolName: string): string {
    // Normalize tool name to include command prefix for stripping !-prefixed content
    const tnLower = toolName.toLowerCase().trim();
    const matchToolName = tnLower.startsWith(COMMAND_PREFIX) ? toolName : `${COMMAND_PREFIX}${toolName}`;
    const escaped = matchToolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}\\b\\s*`, 'i');
    return content.replace(pattern, '').trim();
  }

  /**
   * Build a composite image prompt from a reply message.
   * Fetches the replied-to message content and prepends it to the user's
   * reply text so the image model receives full context.
   * Returns "quoted content, user reply text" with usernames stripped.
   */
  private async buildImagePromptFromReply(
    message: Message,
    replyText: string
  ): Promise<string> {
    if (!message.reference?.messageId) return replyText;

    try {
      const referenced = await message.fetchReference();
      let quotedContent = referenced.content || '';

      // Strip bot mentions from the quoted message
      const botId = message.client.user?.id;
      if (botId) {
        const mentionRegex = new RegExp(`<@!?${botId}>`, 'g');
        quotedContent = quotedContent.replace(mentionRegex, '').trim();
      }

      // Strip Discord markup (mentions, emoji)
      quotedContent = quotedContent.replace(/<@[!&]?\d+>|<#\d+>|<a?:\w+:\d+>/g, '').trim();

      if (quotedContent) {
        return replyText ? `${quotedContent}, ${replyText}` : quotedContent;
      }
    } catch {
      // Referenced message deleted or inaccessible — use reply text only
    }

    return replyText;
  }

  /**
   * Download and save ComfyUI media files, returning attachments and metadata.
   * Shared between handleComfyUIResponse and handleOllamaResponse (when ComfyUI media is present).
   */
  private async collectComfyUIMedia(
    comfyResult: ComfyUIResponse,
    requester: string,
    embed?: EmbedBuilder
  ): Promise<{ attachments: { attachment: Buffer; name: string }[]; savedFilePaths: string[]; savedCount: number; imageCount: number; videoCount: number }> {
    const images = comfyResult.data?.images || [];
    const videos = comfyResult.data?.videos || [];
    let savedCount = 0;
    const attachments: { attachment: Buffer; name: string }[] = [];
    const savedFilePaths: string[] = [];

    const extensionFromUrl = (url: string, fallback: string): string => {
      try {
        const filename = new URL(url).searchParams.get('filename') || '';
        const dotIdx = filename.lastIndexOf('.');
        if (dotIdx >= 0) return filename.slice(dotIdx + 1).toLowerCase();
      } catch { /* malformed URL — use fallback */ }
      return fallback;
    };

    const processOutputs = async (urls: string[], description: string, defaultExtension: string, label: string) => {
      for (let i = 0; i < urls.length; i++) {
        const extension = extensionFromUrl(urls[i], defaultExtension);
        const fileOutput = await fileHandler.saveFromUrl(requester, description, urls[i], extension);
        if (fileOutput) {
          if (embed) {
            embed.addFields({
              name: `${label} ${i + 1}`,
              value: `[View](${fileOutput.url})`,
              inline: false,
            });
          }
          if (fileHandler.shouldAttachFile(fileOutput.size)) {
            const fileBuffer = fileHandler.readFile(fileOutput.filePath);
            if (fileBuffer) {
              attachments.push({ attachment: fileBuffer, name: fileOutput.fileName });
            }
          }
          const baseUrl = config.getOutputBaseUrl();
          const relativePath = fileOutput.url.startsWith(baseUrl)
            ? fileOutput.url.slice(baseUrl.length)
            : fileOutput.url;
          savedFilePaths.push(relativePath);
          savedCount++;
        }
      }
    };

    await processOutputs(images, 'generated_image', 'png', 'Image');
    await processOutputs(videos, 'generated_video', 'mp4', 'Video');

    return { attachments, savedFilePaths, savedCount, imageCount: images.length, videoCount: videos.length };
  }

  private async handleComfyUIResponse(
    apiResult: ComfyUIResponse,
    sourceMessage: Message,
    requester: string,
    _isDM: boolean
  ): Promise<void> {
    const images = apiResult.data?.images || [];
    const videos = apiResult.data?.videos || [];
    const totalOutputs = images.length + videos.length;

    if (totalOutputs === 0) {
      await sourceMessage.reply('No images or videos were generated.');
      return;
    }

    const includeEmbed = config.getImageResponseIncludeEmbed();

    let embed: EmbedBuilder | undefined;
    if (includeEmbed) {
      embed = new EmbedBuilder()
        .setColor('#00AA00')
        .setTitle('ComfyUI Generation Complete')
        .setTimestamp();
    }

    const { attachments, savedFilePaths, savedCount } = await this.collectComfyUIMedia(apiResult, requester, embed);

    if (savedCount === 0) {
      await sourceMessage.reply('Files were generated but could not be saved or displayed.');
      return;
    }

    // Chunk attachments to respect Discord's per-message limit
    const maxPerMessage = config.getMaxAttachments();
    const firstBatch = attachments.slice(0, maxPerMessage);

    // Provide fallback text when embed is off and no files could be attached
    const hasVisualContent = !!embed || firstBatch.length > 0;
    const fallbackContent = hasVisualContent ? '' : `✅ ${savedCount} file(s) generated and saved.`;

    // Send first response message with optional embed and first batch of attachments
    await sourceMessage.reply({
      content: fallbackContent,
      embeds: embed ? [embed] : [],
      ...(firstBatch.length > 0 ? { files: firstBatch } : {}),
    });

    // Send remaining attachments as follow-up messages in batches
    for (let i = maxPerMessage; i < attachments.length; i += maxPerMessage) {
      const batch = attachments.slice(i, i + maxPerMessage);
      if ('send' in sourceMessage.channel) {
        await sourceMessage.channel.send({ content: '📎 Additional files', files: batch });
      } else {
        logger.logError(requester, `Cannot send overflow attachments: channel does not support send`);
      }
    }

    // Pass saved-file relative paths to the activity feed (same origin as the activity page)
    activityEvents.emitBotImageReply(totalOutputs, savedFilePaths);

    const parts: string[] = [];
    if (images.length > 0) parts.push(`${images.length} image(s)`);
    if (videos.length > 0) parts.push(`${videos.length} video(s)`);
    logger.logReply(requester, `ComfyUI response sent: ${parts.join(', ')}`);
  }

  /** Regex to strip generated-image URL lines injected by the final Ollama pass. */
  private static readonly GENERATED_MEDIA_LINE_RE = /\[Generated \d+ (?:image|video)\(s\):[^\]]*\]\n?/g;

  private async handleOllamaResponse(
    apiResult: OllamaResponse,
    sourceMessage: Message,
    requester: string,
    isDM: boolean,
    media?: MediaFollowUp[]
  ): Promise<void> {
    let text = apiResult.data?.text || 'No response generated.';

    // When a ComfyUI media source is carried through, download/save files and attach them
    const comfyMedia = media?.find((m): m is ComfyUIMediaFollowUp => m.kind === 'comfyui');
    if (comfyMedia) {
      const mediaSource = comfyMedia.response;
      const totalOutputs = (mediaSource.data?.images?.length || 0) + (mediaSource.data?.videos?.length || 0);
      if (totalOutputs > 0) {
        // Strip URL lines that Ollama echoed from the external data
        text = text.replace(MessageHandler.GENERATED_MEDIA_LINE_RE, '').trim();

        const includeEmbed = config.getImageResponseIncludeEmbed();
        let embed: EmbedBuilder | undefined;
        if (includeEmbed) {
          embed = new EmbedBuilder()
            .setColor('#00AA00')
            .setTitle('ComfyUI Generation Complete')
            .setTimestamp();
        }

        const { attachments, savedFilePaths, savedCount, imageCount, videoCount } =
          await this.collectComfyUIMedia(mediaSource, requester, embed);

        if (savedCount > 0) {
          const maxPerMessage = config.getMaxAttachments();
          const firstBatch = attachments.slice(0, maxPerMessage);

          // Split text into Discord-safe chunks
          const chunks = chunkText(text || 'Here are your results:');

          // Send first chunk with first batch of file attachments
          await sourceMessage.reply({
            content: chunks[0],
            embeds: embed ? [embed] : [],
            ...(firstBatch.length > 0 ? { files: firstBatch } : {}),
          });

          // Send remaining text chunks
          for (let i = 1; i < chunks.length; i++) {
            if ('send' in sourceMessage.channel) {
              await sourceMessage.channel.send(chunks[i]);
            }
          }

          // Send remaining attachments as follow-up messages in batches
          for (let i = maxPerMessage; i < attachments.length; i += maxPerMessage) {
            const batch = attachments.slice(i, i + maxPerMessage);
            if ('send' in sourceMessage.channel) {
              await sourceMessage.channel.send({ content: '📎 Additional files', files: batch });
            } else {
              logger.logError(requester, `Cannot send overflow attachments: channel does not support send`);
            }
          }

          activityEvents.emitBotImageReply(totalOutputs, savedFilePaths);

          const parts: string[] = [];
          if (imageCount > 0) parts.push(`${imageCount} image(s)`);
          if (videoCount > 0) parts.push(`${videoCount} video(s)`);
          logger.logReply(requester, `Ollama+ComfyUI response sent: ${text.length} chars text, ${parts.join(', ')}`);
          return;
        }
      }
    }

    // Split into Discord-safe chunks (newline-aware)
    const chunks = chunkText(text);

    // Send first chunk as a reply
    await sourceMessage.reply({ content: chunks[0], embeds: [] });

    // Send remaining chunks as follow-up messages in the same channel
    for (let i = 1; i < chunks.length; i++) {
      if ('send' in sourceMessage.channel) {
        await sourceMessage.channel.send(chunks[i]);
      }
    }

    // Send URL-based media follow-ups (meme images, weather radar, etc.)
    for (const um of media?.filter((m): m is UrlMediaFollowUp => m.kind === 'url') ?? []) {
      if ('send' in sourceMessage.channel) {
        await sourceMessage.channel.send({ content: um.url, allowedMentions: { parse: [] } });
        activityEvents.emitBotReply(um.label, um.url, isDM);
        logger.logReply(requester, `${um.label} follow-up sent: ${um.url}`);
      }
    }

    activityEvents.emitBotReply('ollama', text, isDM);

    logger.logReply(
      requester,
      `Ollama response sent: ${text.length} characters`,
      text
    );
  }

  private async handleAccuWeatherResponse(
    apiResult: AccuWeatherResponse,
    sourceMessage: Message,
    requester: string,
    isDM: boolean
  ): Promise<void> {
    const text = apiResult.data?.text || 'No weather data available.';

    // Split into Discord-safe chunks (newline-aware)
    const chunks = chunkText(text);

    // Send first chunk as a reply
    await sourceMessage.reply({ content: chunks[0], embeds: [] });

    // Send remaining chunks as follow-up messages in the same channel
    for (let i = 1; i < chunks.length; i++) {
      if ('send' in sourceMessage.channel) {
        await sourceMessage.channel.send(chunks[i]);
      }
    }

    activityEvents.emitBotReply('accuweather', text, isDM);

    logger.logReply(
      requester,
      `AccuWeather response sent: ${text.length} characters`,
      text
    );
  }

  private async handleNFLResponse(
    apiResult: NFLResponse,
    sourceMessage: Message,
    requester: string,
    isDM: boolean
  ): Promise<void> {
    const text = apiResult.data?.text || 'No NFL data available.';

    // Split into Discord-safe chunks (newline-aware)
    const chunks = chunkText(text);

    // Send first chunk as a reply
    await sourceMessage.reply({ content: chunks[0], embeds: [] });

    // Send remaining chunks as follow-up messages in the same channel
    for (let i = 1; i < chunks.length; i++) {
      if ('send' in sourceMessage.channel) {
        await sourceMessage.channel.send(chunks[i]);
      }
    }

    activityEvents.emitBotReply('nfl', text, isDM);

    logger.logReply(
      requester,
      `NFL response sent: ${text.length} characters`,
      text
    );
  }

  /**
   * Handle SerpAPI search response — display formatted search results as text.
   */
  private async handleSerpApiResponse(
    apiResult: SerpApiResponse,
    sourceMessage: Message,
    requester: string,
    isDM: boolean
  ): Promise<void> {
    const text = apiResult.data?.text || 'No search results available.';

    // Split into Discord-safe chunks (newline-aware)
    const chunks = chunkText(text);

    // Send first chunk as a reply
    await sourceMessage.reply({ content: chunks[0], embeds: [], allowedMentions: { parse: [] } });

    // Send remaining chunks as follow-up messages in the same channel
    for (let i = 1; i < chunks.length; i++) {
      if ('send' in sourceMessage.channel) {
        await sourceMessage.channel.send({ content: chunks[i], allowedMentions: { parse: [] } });
      }
    }

    activityEvents.emitBotReply('serpapi', text, isDM);

    logger.logReply(
      requester,
      `SerpAPI response sent: ${text.length} characters`,
      text
    );
  }

  /**
   * Handle Meme API response — display the generated meme image URL.
   * If an imageUrl is present, show it directly so Discord auto-embeds the image.
   */
  private async handleMemeResponse(
    apiResult: MemeResponse,
    sourceMessage: Message,
    requester: string,
    isDM: boolean
  ): Promise<void> {
    const imageUrl = apiResult.data?.imageUrl;
    const text = apiResult.data?.text || 'No meme generated.';

    if (imageUrl) {
      // Post the image URL directly so Discord auto-embeds it
      await sourceMessage.reply({ content: imageUrl, embeds: [], allowedMentions: { parse: [] } });
      activityEvents.emitBotReply('meme', imageUrl, isDM);
      logger.logReply(requester, `Meme generated: ${imageUrl}`, imageUrl);
    } else {
      const chunks = chunkText(text);
      await sourceMessage.reply({ content: chunks[0], embeds: [], allowedMentions: { parse: [] } });
      for (let i = 1; i < chunks.length; i++) {
        if ('send' in sourceMessage.channel) {
          await sourceMessage.channel.send({ content: chunks[i], allowedMentions: { parse: [] } });
        }
      }
      activityEvents.emitBotReply('meme', text, isDM);
      logger.logReply(requester, `Meme response sent: ${text.length} characters`, text);
    }
  }
}

export const messageHandler = new MessageHandler();
