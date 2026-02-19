import {
  Message,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import axios from 'axios';
import { config, KeywordConfig, COMMAND_PREFIX } from '../utils/config';
import { logger } from '../utils/logger';
import { requestQueue } from '../utils/requestQueue';
import { apiManager, ComfyUIResponse, OllamaResponse, AccuWeatherResponse, SerpApiResponse } from '../api';
import { fileHandler } from '../utils/fileHandler';
import { ChatMessage, NFLResponse, MemeResponse } from '../types';
import { chunkText } from '../utils/chunkText';
import { executeRoutedRequest, inferAbilityParameters } from '../utils/apiRouter';
import { evaluateContextWindow } from '../utils/contextEvaluator';
import { assemblePrompt, parseFirstLineKeyword } from '../utils/promptBuilder';
import type { KeywordParseResult } from '../utils/promptBuilder';
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

  /**
   * Compare a keyword value (from config — may or may not include the
   * command prefix) against a bare keyword name like 'activity_key'.
   */
  private keywordIs(keyword: string, name: string): boolean {
    const kw = keyword.toLowerCase().trim();
    const bare = kw.startsWith(COMMAND_PREFIX) ? kw.slice(COMMAND_PREFIX.length) : kw;
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
    return /\b(imagine|generate|draw|render|visualize|create\s+(an\s+)?image|make\s+(a\s+)?(picture|image))\b/.test(t);
  }

  private isGenericImageReference(content: string): boolean {
    const t = content.toLowerCase().trim();
    return /^(this|that|it|something|anything|image|picture|photo)$/i.test(t);
  }

  private stripSpeakerPrefix(content: string): string {
    return content.replace(/^[^:\n]{1,64}:\s+/, '').trim();
  }

  private isKeywordOnlyInvocation(content: string, keyword: string): boolean {
    const normalizedKeyword = keyword
      .toLowerCase()
      .trim()
      .replace(/^!+/, '');

    const normalizedContent = content
      .toLowerCase()
      .trim()
      .replace(/^[@!]+/, '')
      .replace(/[!?.,:;]+$/g, '')
      .trim();

    return normalizedContent === normalizedKeyword;
  }

  private deriveImagePromptFromContext(content: string, history: ChatMessage[]): string | null {
    const trimmed = content.trim();

    // Try using direct user text first (remove command-ish lead-ins)
    let direct = trimmed
      .replace(/^[@!]?imagine\b/i, '')
      .replace(/^[@!]?generate\b/i, '')
      .replace(/^(can|could|would)\s+you\s+/i, '')
      .replace(/^[@!]?imagine\b/i, '')
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

  private shouldForceFinalOllamaPassForApi(api: KeywordConfig['api']): boolean {
    // Keep raw media-style API outputs (image URLs/files) intact.
    // Force conversational final-pass only for text-oriented data APIs.
    return api === 'accuweather' || api === 'nfl' || api === 'serpapi';
  }

  private escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private buildDirectiveCommentary(
    parseResult: KeywordParseResult,
    routedInput: string
  ): string | null {
    const commentary = parseResult.commentaryText?.trim();
    if (!commentary || !parseResult.keywordConfig) return null;

    const kwLower = parseResult.keywordConfig.keyword.toLowerCase().trim();
    const kwBare = kwLower.startsWith(COMMAND_PREFIX)
      ? kwLower.slice(COMMAND_PREFIX.length)
      : kwLower;
    const kwEscaped = this.escapeRegExp(kwBare);

    const lines = commentary
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map((line) => {
        // Replace explicit command-style invocations inline.
        const withBangReplaced = line.replace(
          new RegExp(`(^|\\s)!${kwEscaped}\\b(?:\\s*[:|;,=\\-–—>]+\\s*|\\s+)`, 'ig'),
          `$1${routedInput} `
        );

        // Replace start-of-line bare directive form (e.g. "imagine: ...")
        const bareLeadingPattern = new RegExp(`^${kwEscaped}\\b(?:\\s*[:|;,=\\-–—>]+\\s*|\\s+)`, 'i');
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

  private findEnabledKeywordByName(name: string): KeywordConfig | undefined {
    return config
      .getKeywords()
      .find(k => k.enabled !== false && this.keywordIs(k.keyword, name));
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

    // Find matching keyword at message start — only matches !prefixed commands.
    // Messages without the command prefix go through two-stage Ollama evaluation.
    let keywordConfig = this.findKeyword(content);
    const keywordMatched = keywordConfig !== undefined;
    const startsWithCommandPrefix = content.trim().startsWith(COMMAND_PREFIX);

    // Emit activity event with cleaned message content (no usernames or IDs).
    // Suppress for standalone activity_key requests — those should not appear
    // in the public activity feed.
    const isActivityKey = keywordMatched && this.keywordIs(keywordConfig!.keyword, 'activity_key');
    if (!isActivityKey) {
      activityEvents.emitMessageReceived(isDM, content);
    }

    if (keywordConfig) {
      logger.log('success', 'system', `KEYWORD: Matched "${keywordConfig.keyword}" at message start`);
    } else {
      logger.log('success', 'system', `KEYWORD: No first-word match, deferring to two-stage evaluation`);
    }

    // Track whether a non-Ollama API keyword was matched (determines execution path)
    const apiKeywordMatched = keywordMatched && keywordConfig!.api !== 'ollama';

    if (!keywordConfig) {
      const configuredChat = this.findEnabledKeywordByName('chat');
      keywordConfig = configuredChat ?? {
        keyword: 'chat',
        api: 'ollama',
        timeout: config.getDefaultTimeout(),
        description: 'Default chat via Ollama',
      };
      logger.logDefault(requester, content);
    }

    // Strip the routing keyword only when it was explicitly matched at the start.
    // The default "chat" fallback should NOT strip — it would mutate free-form content.
    if (keywordMatched) {
      content = this.stripKeyword(content, keywordConfig.keyword);
    }

    // For image generation replies, combine quoted message content with the user's reply text.
    // Done before the empty-prompt check so that reply-only-keyword messages (e.g. replying
    // "generate" to a message) still work — the quoted content fills the prompt.
    if (keywordConfig.api === 'comfyui' && message.reference) {
      content = await this.buildImagePromptFromReply(message, content);
    }

    if (!content) {
      // Some keywords (e.g. "nfl scores", "nfl news") work without extra content.
      // For those, use the keyword itself as the content so the request proceeds.
      const keywordAllowsEmpty = keywordConfig.allowEmptyContent === true;

      if (keywordAllowsEmpty) {
        content = keywordConfig.keyword;
      } else {
        logger.logIgnored(requester, 'Empty message after keyword removal');
        await message.reply(
          'Please include a prompt or question after the keyword!'
        );
        return;
      }
    }

    // Route standalone "!help" — short-circuit with a direct help response.
    // No model call needed; the help text is deterministic.
    if (keywordMatched && this.keywordIs(keywordConfig.keyword, 'help')) {
      const reply = this.buildHelpResponse();
      await message.reply(reply);
      logger.log('success', 'system', `HELP: Direct help response sent to ${requester}`);
      return;
    }

    // Route standalone "!activity_key" — issue a new rotating key and DM it
    // back to the user. This short-circuits before Ollama/API routing since
    // no model interaction is needed.
    if (keywordMatched && this.keywordIs(keywordConfig.keyword, 'activity_key')) {
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

    // Collect conversation context — needed for any path that may call Ollama
    // (direct chat, two-stage evaluation, or final Ollama pass)
    let conversationHistory: ChatMessage[] = [];
    if (config.getReplyChainEnabled()) {
      if (isDM) {
        // DMs: collect recent DM channel history (no guild channel-context feature)
        conversationHistory = await this.collectDmHistory(message);
      } else {
        // Guild: collect reply chain + channel history
        const keywordMax = keywordConfig.contextFilterMaxDepth ?? config.getReplyChainMaxDepth();
        const globalMax = config.getReplyChainMaxDepth();
        const maxContextDepth = Math.min(keywordMax, globalMax);
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

    // Log the request
    logger.logRequest(
      requester,
      `[${keywordConfig.keyword}] ${content}`
    );

    await this.addWorkingReaction(message);

    try {
      if (apiKeywordMatched) {
        // ── API keyword path: execute API with optional final Ollama pass ──
        // Append the triggering message so the model always knows who is asking.
        const historyWithTrigger: ChatMessage[] = [
          ...conversationHistory,
          { role: 'user' as const, content: `${requester}: ${content}`, contextSource: 'trigger' as const, hasNamePrefix: true },
        ];
        activityEvents.emitRoutingDecision(keywordConfig.api, keywordConfig.keyword, 'keyword');

        const routedResult = await executeRoutedRequest(
          keywordConfig,
          content,
          requester,
          historyWithTrigger,
          botDisplayName
        );

        await this.dispatchResponse(
          routedResult.finalResponse,
          routedResult.finalApi,
          message,
          requester,
          isDM
        );
      } else {
        // ── Ollama path: chat with abilities context, then second evaluation ──
        await this.executeWithTwoStageEvaluation(
          content,
          keywordConfig,
          message,
          requester,
          conversationHistory,
          isDM,
          botDisplayName,
          startsWithCommandPrefix && !keywordMatched,
          imagePayloads
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
   * Match a keyword only when the message starts with the command prefix (!).
   * Keywords are sorted longest-first so multi-word keywords like
   * "!nfl scores" take priority over shorter overlaps.
   * Disabled keywords (enabled === false) are skipped.
   *
   * Messages without the command prefix are NOT matched here — they are
   * routed through the two-stage Ollama evaluation for inference-first
   * parameter extraction.
   */
  private findKeyword(content: string): KeywordConfig | undefined {
    const lowerContent = content.toLowerCase().trim();

    // Only match if the message starts with the command prefix
    if (!lowerContent.startsWith(COMMAND_PREFIX)) return undefined;

    // Sort longest keyword first so more specific multi-word keywords win.
    const sorted = [...config.getKeywords()]
      .filter((k) => k.enabled !== false)
      .sort(
        (a, b) => b.keyword.length - a.keyword.length
      );
    return sorted.find((k) => {
      const rawKeyword = k.keyword.toLowerCase().trim();
      if (!rawKeyword) return false;

      // Normalize: ensure keyword includes the command prefix for matching
      const keyword = rawKeyword.startsWith(COMMAND_PREFIX)
        ? rawKeyword
        : `${COMMAND_PREFIX}${rawKeyword}`;

      // Built-in !help is intentionally standalone-only.
      if (this.keywordIs(rawKeyword, 'help')) {
        return lowerContent === `${COMMAND_PREFIX}help`;
      }

      // Built-in !activity_key is standalone-only, same as help.
      if (this.keywordIs(rawKeyword, 'activity_key')) {
        return lowerContent === `${COMMAND_PREFIX}activity_key`;
      }

      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Anchor to START of message + word boundary after keyword
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
   * Execute the Ollama evaluation flow:
   * 1. Build XML-tagged prompt with abilities context and conversation history
   * 2. Call Ollama — model outputs either a keyword-only line or a normal answer
   * 3. Parse the first non-empty line for an exact keyword match
   * 4. If keyword matched → route to API via executeRoutedRequest
   *    (always with final Ollama pass so result is presented conversationally)
   * 5. If no keyword matched → return Ollama's response as direct chat
   */
  private async executeWithTwoStageEvaluation(
    content: string,
    keywordConfig: KeywordConfig,
    sourceMessage: Message,
    requester: string,
    conversationHistory: ChatMessage[],
    isDM: boolean,
    botDisplayName?: string,
    strictNoApiRoutingFromInference: boolean = false,
    imagePayloads: string[] = []
  ): Promise<void> {
    const timeout = keywordConfig.timeout || config.getDefaultTimeout();

    // Apply context filter (Ollama-based relevance evaluation) before building the prompt,
    // only when the keyword has contextFilterEnabled set to true.
    let filteredHistory = conversationHistory;
    if (keywordConfig.contextFilterEnabled && conversationHistory.length > 0) {
      const preFilterCount = conversationHistory.filter(m => m.role !== 'system').length;
      logger.log('success', 'system',
        `TWO-STAGE: Context before eval: ${conversationHistory.length} total (${preFilterCount} non-system)`);
      filteredHistory = await evaluateContextWindow(
        conversationHistory,
        content,
        keywordConfig,
        requester
      );
      logger.log('success', 'system',
        `TWO-STAGE: Context after eval: ${filteredHistory.length} messages (system messages excluded)`);
    } else if (!keywordConfig.contextFilterEnabled && conversationHistory.length > 0) {
      logger.log('success', 'system',
        `TWO-STAGE: Context eval skipped (contextFilterEnabled is off for "${keywordConfig.keyword}")`);
    }

    // Append the triggering message to context so the model knows who is asking.
    // This is done after context evaluation so it is never filtered out.
    filteredHistory = [
      ...filteredHistory,
      { role: 'user' as const, content: `${requester}: ${content}`, contextSource: 'trigger' as const, hasNamePrefix: true },
    ];

    // Build the XML-tagged prompt with abilities context
    const assembled = assemblePrompt({
      userMessage: content,
      conversationHistory: filteredHistory,
      botDisplayName,
    });

    // Log abilities summary
    const abilityCount = (assembled.systemContent.match(/^- /gm) || []).length;
    if (abilityCount > 0) {
      if (config.getAbilityLoggingDetailed()) {
        logger.log('success', 'system', `TWO-STAGE: Abilities context passed to model:\n${assembled.systemContent}`);
      } else {
        logger.log('success', 'system', `TWO-STAGE: ${abilityCount} ability/abilities passed to model`);
      }
    } else {
      logger.log('success', 'system', 'TWO-STAGE: No abilities configured — standard Ollama chat');
    }

    // Stage 1: Call Ollama with the XML-tagged prompt.
    // System content from assemblePrompt replaces the global persona;
    // includeSystemPrompt: false prevents OllamaClient from duplicating it.
    // When image payloads are present, they are forwarded to the vision model.
    const ollamaResult = await requestQueue.execute(
      'ollama',
      requester,
      keywordConfig.keyword,
      timeout,
      (signal) =>
        apiManager.executeRequest(
          'ollama',
          requester,
          assembled.userContent,
          timeout,
          undefined,
          [{ role: 'system', content: assembled.systemContent }],
          signal,
          undefined,
          {
            includeSystemPrompt: false,
            ...(imagePayloads.length > 0 ? { images: imagePayloads } : {}),
          }
        )
    ) as OllamaResponse;

    if (!ollamaResult.success) {
      await this.dispatchResponse(ollamaResult, 'ollama', sourceMessage, requester, isDM);
      return;
    }

    const ollamaText = ollamaResult.data?.text;

    // Stage 2a: Parse first line for an exact keyword match (primary routing signal)
    if (ollamaText) {
      const parseResult = parseFirstLineKeyword(ollamaText);

      if (parseResult.matched && parseResult.keywordConfig) {
        if (strictNoApiRoutingFromInference) {
          logger.logWarn('system',
            `TWO-STAGE: Ignoring inferred keyword "${parseResult.keywordConfig.keyword}" because input was an unknown command-style message`);
          await this.dispatchResponse(ollamaResult, 'ollama', sourceMessage, requester, isDM);
          return;
        }

        let routedInput = (parseResult.inferredInput && parseResult.inferredInput.trim().length > 0)
          ? parseResult.inferredInput
          : content;

        const abilityInputs = parseResult.keywordConfig.abilityInputs;
        const shouldPreferContentInference =
          !!abilityInputs &&
          (abilityInputs.mode === 'implicit' || abilityInputs.mode === 'mixed') &&
          Array.isArray(abilityInputs.inferFrom) &&
          abilityInputs.inferFrom.length > 0;

        // For implicit/mixed abilities, prefer deriving parameters from the
        // original user content/context rather than trusting model-authored
        // inline remainder text (which may include extra conversational chatter).
        // However, keep the inline inferred input as a fallback for abilities
        // without required fields (e.g. meme) so it can be used if context-based
        // inference fails later.
        let inlineInferredFallback: string | undefined;
        if (shouldPreferContentInference && parseResult.inferredInput) {
          if (this.isKeywordOnlyInvocation(content, parseResult.keywordConfig.keyword)) {
            routedInput = parseResult.inferredInput.trim();
            logger.log('success', 'system',
              `TWO-STAGE: Using inline inferred input for "${parseResult.keywordConfig.keyword}" because user message was keyword-only`);
          } else {
            inlineInferredFallback = parseResult.inferredInput.trim();
            logger.log('success', 'system',
              `TWO-STAGE: Preferring context-based inference for "${parseResult.keywordConfig.keyword}" (inline fallback retained)`);
            routedInput = content;
          }
        }

        // When the model matched a keyword but no inline params were provided,
        // and the keyword has required inputs, use Ollama to infer parameters
        // from the user's natural language message.
        const hasRequiredInputs = parseResult.keywordConfig.abilityInputs?.required &&
          parseResult.keywordConfig.abilityInputs.required.length > 0;
        const needsInference = hasRequiredInputs
          ? (shouldPreferContentInference || !parseResult.inferredInput || parseResult.inferredInput.trim().length === 0)
          : (shouldPreferContentInference && routedInput === content);
        if (needsInference) {
          const inferred = await inferAbilityParameters(parseResult.keywordConfig, content, requester);
          if (inferred) {
            routedInput = inferred;
            logger.log('success', 'system',
              `TWO-STAGE: Inferred parameter "${inferred}" for "${parseResult.keywordConfig.keyword}"`);
          } else if (inlineInferredFallback) {
            // Use the model's inline directive params as a fallback when
            // context-based inference could not produce usable parameters.
            routedInput = inlineInferredFallback;
            logger.log('success', 'system',
              `TWO-STAGE: Context inference failed — falling back to inline inferred input for "${parseResult.keywordConfig.keyword}"`);
          } else {
            logger.logWarn('system',
              `TWO-STAGE: Could not infer parameter for "${parseResult.keywordConfig.keyword}" — using original content`);
          }
        }

        logger.log('success', 'system',
          `TWO-STAGE: First-line keyword match "${parseResult.keywordConfig.keyword}" — executing ${parseResult.keywordConfig.api} API`);
        activityEvents.emitRoutingDecision(parseResult.keywordConfig.api, parseResult.keywordConfig.keyword, 'two-stage-parse');

        // DISABLED: commentary prelude causes double-reply for routed requests.
        // const commentaryPrelude = this.buildDirectiveCommentary(parseResult, routedInput);
        // if (commentaryPrelude) {
        //   await this.sendCommentaryPrelude(sourceMessage, requester, isDM, commentaryPrelude);
        // }

        // Force final Ollama pass only for text-centric external APIs.
        // For media APIs (e.g., meme/comfyui), keep raw API output so
        // Discord receives image URLs/files directly.
        const inferredConfig = {
          ...parseResult.keywordConfig,
          finalOllamaPass: this.shouldForceFinalOllamaPassForApi(parseResult.keywordConfig.api),
        };

        const apiResult = await executeRoutedRequest(
          inferredConfig,
          routedInput,
          requester,
          filteredHistory.length > 0 ? filteredHistory : undefined,
          botDisplayName
        );

        await this.dispatchResponse(
          apiResult.finalResponse,
          apiResult.finalApi,
          sourceMessage,
          requester,
          isDM
        );
        return;
      }

    }

    // Fallback: if stage-1 didn't emit an ability directive but the message is
    // clearly an image-generation request, route to imagine/generate using a
    // context-derived prompt. This avoids brittle dependency on strict
    // first-line directive formatting for natural-language image requests.
    if (!strictNoApiRoutingFromInference && this.isLikelyImageRequest(content)) {
      const normalized = content.toLowerCase();
      const imagineKeywordConfig = this.findEnabledKeywordByName('imagine');
      const generateKeywordConfig = this.findEnabledKeywordByName('generate');

      const imageKeywordConfig = normalized.includes('imagine')
        ? (imagineKeywordConfig ?? generateKeywordConfig)
        : (generateKeywordConfig ?? imagineKeywordConfig);

      if (imageKeywordConfig && imageKeywordConfig.api === 'comfyui') {
        const inferredPrompt = this.deriveImagePromptFromContext(content, filteredHistory);
        if (inferredPrompt) {
          logger.log('success', 'system',
            `TWO-STAGE: Image fallback inference succeeded for "${imageKeywordConfig.keyword}" — executing comfyui API`);

          const imageConfig = { ...imageKeywordConfig, finalOllamaPass: false };
          const imageResult = await executeRoutedRequest(
            imageConfig,
            inferredPrompt,
            requester,
            filteredHistory.length > 0 ? filteredHistory : undefined,
            botDisplayName
          );

          await this.dispatchResponse(
            imageResult.finalResponse,
            imageResult.finalApi,
            sourceMessage,
            requester,
            isDM
          );
          return;
        }

        logger.logWarn('system',
          `TWO-STAGE: Image fallback could not infer a concrete prompt for "${imageKeywordConfig.keyword}"; returning direct chat response`);
      }
    }

    // Fallback: if stage-1 didn't emit an ability directive but the message is
    // clearly a meme request, run meme parameter inference directly and route
    // to the meme API. This avoids brittle dependency on strict first-line
    // directive formatting for natural-language meme requests.
    if (!strictNoApiRoutingFromInference && this.isLikelyMemeRequest(content)) {
      const memeKeywordConfig = this.findEnabledKeywordByName('meme');
      if (memeKeywordConfig && memeKeywordConfig.api === 'meme') {
        const inferred = await inferAbilityParameters(memeKeywordConfig, content, requester);
        if (inferred) {
          logger.log('success', 'system',
            'TWO-STAGE: Meme fallback inference succeeded — executing meme API');

          const memeConfig = { ...memeKeywordConfig, finalOllamaPass: false };
          const memeResult = await executeRoutedRequest(
            memeConfig,
            inferred,
            requester,
            filteredHistory.length > 0 ? filteredHistory : undefined,
            botDisplayName
          );

          await this.dispatchResponse(
            memeResult.finalResponse,
            memeResult.finalApi,
            sourceMessage,
            requester,
            isDM
          );
          return;
        }

        logger.logWarn('system',
          'TWO-STAGE: Meme fallback inference did not return parameters; returning direct chat response');
      }
    }

    // No ability keyword detected — return Ollama's response as direct chat
    logger.log('success', 'system', 'TWO-STAGE: No ability directive in Ollama response — returning as direct chat');
    await this.dispatchResponse(ollamaResult, 'ollama', sourceMessage, requester, isDM);
  }

  /**
   * Dispatch a response to the appropriate handler based on API type.
   * Handles error responses uniformly.
   */
  private async dispatchResponse(
    response: ComfyUIResponse | OllamaResponse | AccuWeatherResponse | NFLResponse | SerpApiResponse | MemeResponse,
    api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi' | 'meme',
    sourceMessage: Message,
    requester: string,
    isDM: boolean
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
      await this.handleOllamaResponse(response as OllamaResponse, sourceMessage, requester, isDM);
    }
  }

  /**
   * Build a user-facing help response listing all available commands
   * and how to use them.
   */
  buildHelpResponse(): string {
    const keywords = config
      .getKeywords()
      .filter(k => k.enabled !== false && !this.keywordIs(k.keyword, 'help'));

    const capabilityLines = keywords.length > 0
      ? keywords.map(k => {
          const bare = k.keyword.startsWith(COMMAND_PREFIX)
            ? k.keyword.slice(COMMAND_PREFIX.length)
            : k.keyword;
          return `• \`${COMMAND_PREFIX}${bare}\` — ${k.description}`;
        }).join('\n')
      : 'No commands are currently configured.';

    return [
      `**Available Commands**`,
      `All commands start with \`${COMMAND_PREFIX}\` (e.g. \`${COMMAND_PREFIX}weather Dallas\`).`,
      'You can also describe what you need in natural language and the bot will infer the right action.',
      '',
      capabilityLines,
    ].join('\n');
  }

  /**
   * Remove the first occurrence of the routing keyword (including prefix)
   * from the content. Preserves surrounding whitespace and trims the result.
   */
  stripKeyword(content: string, keyword: string): string {
    // Normalize keyword to include command prefix for stripping !-prefixed content
    const kwLower = keyword.toLowerCase().trim();
    const matchKeyword = kwLower.startsWith(COMMAND_PREFIX) ? keyword : `${COMMAND_PREFIX}${keyword}`;
    const escaped = matchKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  private async handleComfyUIResponse(
    apiResult: ComfyUIResponse,
    sourceMessage: Message,
    requester: string,
    _isDM: boolean
  ): Promise<void> {
    if (!apiResult.data?.images || apiResult.data.images.length === 0) {
      await sourceMessage.reply('No images were generated.');
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

    // Process each image — collect attachable files
    let savedCount = 0;
    const attachments: { attachment: Buffer; name: string }[] = [];
    const savedImagePaths: string[] = [];

    for (let i = 0; i < apiResult.data.images.length; i++) {
      const imageUrl = apiResult.data.images[i];

      // Try to download and save the image
      const fileOutput = await fileHandler.saveFromUrl(
        requester,
        'generated_image',
        imageUrl,
        'png'
      );

      if (fileOutput) {
        if (embed) {
          embed.addFields({
            name: `Image ${i + 1}`,
            value: `[View](${fileOutput.url})`,
            inline: false,
          });
        }

        // Collect file for attachment if small enough
        if (fileHandler.shouldAttachFile(fileOutput.size)) {
          const fileBuffer = fileHandler.readFile(fileOutput.filePath);
          if (fileBuffer) {
            attachments.push({ attachment: fileBuffer, name: fileOutput.fileName });
          }
        }

        // Collect relative path for the activity feed (same origin)
        const baseUrl = config.getOutputBaseUrl();
        const relativePath = fileOutput.url.startsWith(baseUrl)
          ? fileOutput.url.slice(baseUrl.length)
          : fileOutput.url;
        savedImagePaths.push(relativePath);

        savedCount++;
      }
    }

    if (savedCount === 0) {
      await sourceMessage.reply('Images were generated but could not be saved or displayed.');
      return;
    }

    // Chunk attachments to respect Discord's per-message limit
    const maxPerMessage = config.getMaxAttachments();
    const firstBatch = attachments.slice(0, maxPerMessage);

    // Provide fallback text when embed is off and no files could be attached
    const hasVisualContent = !!embed || firstBatch.length > 0;
    const fallbackContent = hasVisualContent ? '' : `✅ ${savedCount} image(s) generated and saved.`;

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
        await sourceMessage.channel.send({ content: '📎 Additional images', files: batch });
      } else {
        logger.logError(requester, `Cannot send overflow attachments: channel does not support send`);
      }
    }

    // Pass saved-file relative paths to the activity feed (same origin as the activity page)
    activityEvents.emitBotImageReply(apiResult.data.images.length, savedImagePaths);

    logger.logReply(
      requester,
      `ComfyUI response sent: ${apiResult.data.images.length} images`
    );
  }

  private async handleOllamaResponse(
    apiResult: OllamaResponse,
    sourceMessage: Message,
    requester: string,
    isDM: boolean
  ): Promise<void> {
    const text = apiResult.data?.text || 'No response generated.';

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
