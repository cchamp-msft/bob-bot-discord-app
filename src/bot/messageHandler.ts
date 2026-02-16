import {
  Message,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import { config, KeywordConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { requestQueue } from '../utils/requestQueue';
import { apiManager, ComfyUIResponse, OllamaResponse, AccuWeatherResponse, SerpApiResponse } from '../api';
import { fileHandler } from '../utils/fileHandler';
import { ChatMessage, NFLResponse } from '../types';
import { chunkText } from '../utils/chunkText';
import { classifyIntent } from '../utils/keywordClassifier';
import { executeRoutedRequest, inferAbilityParameters } from '../utils/apiRouter';
import { evaluateContextWindow } from '../utils/contextEvaluator';
import { assemblePrompt, parseFirstLineKeyword } from '../utils/promptBuilder';
import { activityEvents } from '../utils/activityEvents';
import { activityKeyManager } from '../utils/activityKeyManager';

export type { ChatMessage };

class MessageHandler {
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

    if (!content) {
      logger.logIgnored(requester, 'Empty message after mention removal');
      await message.reply(
        'Please include a prompt or question in your message!'
      );
      return;
    }

    // Find matching keyword at message start — fall back to two-stage Ollama evaluation
    let keywordConfig = this.findKeyword(content);
    const keywordMatched = keywordConfig !== undefined;

    // Emit activity event with cleaned message content (no usernames or IDs).
    // Suppress for standalone activity_key requests — those should not appear
    // in the public activity feed.
    const isActivityKey = keywordMatched && keywordConfig!.keyword.toLowerCase() === 'activity_key';
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
      keywordConfig = {
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

    // Route standalone "help" through the normal model path with explicit guidance.
    // This avoids static hardcoded help output while still giving the model
    // concrete topics/usage hints to summarize for the user.
    if (keywordMatched && keywordConfig.keyword.toLowerCase() === 'help') {
      content = this.buildHelpPromptForModel();
    }

    // Route standalone "activity_key" — issue a new rotating key and DM it
    // back to the user. This short-circuits before Ollama/API routing since
    // no model interaction is needed.
    if (keywordMatched && keywordConfig.keyword.toLowerCase() === 'activity_key') {
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

    // Send inline processing message as a reply
    let processingMessage: Message;
    try {
      processingMessage = await message.reply('⏳ Processing your request...');
    } catch (error) {
      logger.logError(
        requester,
        `Failed to send processing message: ${error}`
      );
      return;
    }

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
          processingMessage,
          requester,
          isDM
        );
      } else {
        // ── Ollama path: chat with abilities context, then second evaluation ──
        await this.executeWithTwoStageEvaluation(
          content,
          keywordConfig,
          processingMessage,
          requester,
          conversationHistory,
          isDM,
          botDisplayName
        );
      }
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : 'Unknown error';

      // Log full error to console always
      logger.logError(requester, errorMsg);

      // Emit sanitised error activity event
      activityEvents.emitError('I couldn\'t complete that request');

      // Edit processing message with friendly error
      if (this.canSendErrorMessage()) {
        await processingMessage.edit(`⚠️ ${config.getErrorMessage()}`);
      } else {
        await processingMessage.edit('⚠️ An error occurred processing your request.');
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
    const chain: { role: 'user' | 'assistant'; content: string; authorName?: string; id: string; createdAt: number }[] = [];
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

        if (refContent) {
          const isBot = referenced.author.id === botId;

          // Check total character budget before adding (include potential authorName prefix)
          const prefixLen = isBot ? 0 : ((referenced.member?.displayName ?? referenced.author.username).length + 2);
          const entryLen = refContent.length + prefixLen;
          if (totalChars + entryLen > maxTotalChars) {
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
          });
        }

        current = referenced;
      } catch (error) {
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
        // Skip bot's system/processing messages
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

    let chChars = 0;
    while (chCandidates.length > 0) {
      chChars = chCandidates.reduce((sum, m) => sum + m.content.length, 0);
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
   * Match a keyword only at the very start of the message.
   * Keywords are sorted longest-first so multi-word keywords like
   * "nfl scores" take priority over shorter overlaps.
   * Disabled keywords (enabled === false) are skipped.
   */
  private findKeyword(content: string): KeywordConfig | undefined {
    const lowerContent = content.toLowerCase();
    // Sort longest keyword first so more specific multi-word keywords win.
    const sorted = [...config.getKeywords()]
      .filter((k) => k.enabled !== false)
      .sort(
        (a, b) => b.keyword.length - a.keyword.length
      );
    return sorted.find((k) => {
      const keyword = k.keyword.toLowerCase().trim();
      if (!keyword) return false;

      // Built-in help is intentionally standalone-only.
      // "help" should match, but "help me ..." should not.
      if (keyword === 'help') {
        return lowerContent.trim() === 'help';
      }

      // Built-in activity_key is standalone-only, same as help.
      if (keyword === 'activity_key') {
        return lowerContent.trim() === 'activity_key';
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

  /**
   * Execute the two-stage evaluation flow:
   * 1. Build XML-tagged prompt with abilities context and conversation history
   * 2. Call Ollama — model outputs either a keyword-only line or a normal answer
   * 3. Parse the first non-empty line for an exact keyword match
   * 4. If keyword matched → route to API via executeRoutedRequest
   * 5. If no keyword matched → fall back to classifyIntent (legacy classifier)
   * 6. If still no match → return Ollama's response as the final answer
   */
  private async executeWithTwoStageEvaluation(
    content: string,
    keywordConfig: KeywordConfig,
    processingMessage: Message,
    requester: string,
    conversationHistory: ChatMessage[],
    isDM: boolean,
    botDisplayName?: string
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
          { includeSystemPrompt: false }
        )
    ) as OllamaResponse;

    if (!ollamaResult.success) {
      await this.dispatchResponse(ollamaResult, 'ollama', processingMessage, requester, isDM);
      return;
    }

    const ollamaText = ollamaResult.data?.text;

    // Stage 2a: Parse first line for an exact keyword match (primary routing signal)
    if (ollamaText) {
      const parseResult = parseFirstLineKeyword(ollamaText);

      if (parseResult.matched && parseResult.keywordConfig) {
        const routedInput = (parseResult.inferredInput && parseResult.inferredInput.trim().length > 0)
          ? parseResult.inferredInput
          : content;

        logger.log('success', 'system',
          `TWO-STAGE: First-line keyword match "${parseResult.keywordConfig.keyword}" — executing ${parseResult.keywordConfig.api} API`);
        activityEvents.emitRoutingDecision(parseResult.keywordConfig.api, parseResult.keywordConfig.keyword, 'two-stage-parse');

        const apiResult = await executeRoutedRequest(
          parseResult.keywordConfig,
          routedInput,
          requester,
          filteredHistory.length > 0 ? filteredHistory : undefined,
          botDisplayName
        );

        await this.dispatchResponse(
          apiResult.finalResponse,
          apiResult.finalApi,
          processingMessage,
          requester,
          isDM
        );
        return;
      }

      // Stage 2b: Fallback — use AI classifier on the model output only if
      // first-line parse did not match. This handles edge cases where the model
      // embeds keywords mid-response or uses unexpected formatting.
      const secondClassification = await classifyIntent(ollamaText, requester);

      if (secondClassification.keywordConfig && secondClassification.keywordConfig.api !== 'ollama') {
        const matchedKw = secondClassification.keywordConfig;
        logger.log('success', 'system',
          `TWO-STAGE: Fallback classifier matched "${matchedKw.keyword}" — executing ${matchedKw.api} API`);
        activityEvents.emitRoutingDecision(matchedKw.api, matchedKw.keyword, 'two-stage-classify');

        // When the ability has required inputs, the raw user content is
        // unlikely to be a valid direct parameter (e.g. "what is the
        // capital of Thailand?" is not a city name).  Use Ollama to
        // infer the concrete parameter from the original message.
        let routedInput = content;
        const hasRequiredInputs = matchedKw.abilityInputs?.required &&
          matchedKw.abilityInputs.required.length > 0;

        if (hasRequiredInputs) {
          const inferred = await inferAbilityParameters(matchedKw, content, requester);
          if (inferred) {
            routedInput = inferred;
            logger.log('success', 'system',
              `TWO-STAGE: Inferred parameter "${inferred}" for "${matchedKw.keyword}"`);
          } else {
            logger.logWarn('system',
              `TWO-STAGE: Could not infer parameter for "${matchedKw.keyword}" — using original content`);
          }
        }

        const apiResult = await executeRoutedRequest(
          matchedKw,
          routedInput,
          requester,
          filteredHistory.length > 0 ? filteredHistory : undefined,
          botDisplayName
        );

        await this.dispatchResponse(
          apiResult.finalResponse,
          apiResult.finalApi,
          processingMessage,
          requester,
          isDM
        );
        return;
      }
    }

    // No API keyword found — use Ollama response as-is
    logger.log('success', 'system', 'TWO-STAGE: No API intent detected in Ollama response — returning as direct chat');
    await this.dispatchResponse(ollamaResult, 'ollama', processingMessage, requester, isDM);
  }

  /**
   * Dispatch a response to the appropriate handler based on API type.
   * Handles error responses uniformly.
   */
  private async dispatchResponse(
    response: ComfyUIResponse | OllamaResponse | AccuWeatherResponse | NFLResponse | SerpApiResponse,
    api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi',
    processingMessage: Message,
    requester: string,
    isDM: boolean
  ): Promise<void> {
    if (!response.success) {
      const errorDetail = response.error ?? 'Unknown API error';
      logger.logError(requester, errorDetail);
      activityEvents.emitError('I couldn\'t get a response from the API');

      if (this.canSendErrorMessage()) {
        await processingMessage.edit(`⚠️ ${config.getErrorMessage()}`);
      } else {
        await processingMessage.edit('⚠️ An error occurred processing your request.');
      }
      return;
    }

    if (api === 'comfyui') {
      await this.handleComfyUIResponse(response as ComfyUIResponse, processingMessage, requester, isDM);
    } else if (api === 'accuweather') {
      await this.handleAccuWeatherResponse(response as AccuWeatherResponse, processingMessage, requester, isDM);
    } else if (api === 'nfl') {
      await this.handleNFLResponse(response as NFLResponse, processingMessage, requester, isDM);
    } else if (api === 'serpapi') {
      await this.handleSerpApiResponse(response as SerpApiResponse, processingMessage, requester, isDM);
    } else {
      await this.handleOllamaResponse(response as OllamaResponse, processingMessage, requester, isDM);
    }
  }

  /**
   * Build a model-facing help prompt that asks Ollama to explain what the bot
   * can do and how to invoke each capability.
   */
  buildHelpPromptForModel(): string {
    const keywords = config
      .getKeywords()
      .filter(k => k.enabled !== false && k.keyword.toLowerCase() !== 'help');

    const capabilityLines = keywords.length > 0
      ? keywords.map(k => `- ${k.keyword}: ${k.description}`).join('\n')
      : '- No external keyword abilities are currently configured.';

    return [
      'The user asked for help.',
      'Explain what topics/capabilities this bot supports and how to use them.',
      'Keep the response concise and practical with examples where useful.',
      '',
      'Available keyword capabilities:',
      capabilityLines,
    ].join('\n');
  }

  /**
   * Remove the first occurrence of the routing keyword from the content.
   * Preserves surrounding whitespace and trims the result.
   */
  stripKeyword(content: string, keyword: string): string {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
    return content.replace(pattern, '').replace(/\s+/g, ' ').trim();
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
    processingMessage: Message,
    requester: string,
    _isDM: boolean
  ): Promise<void> {
    if (!apiResult.data?.images || apiResult.data.images.length === 0) {
      await processingMessage.edit('No images were generated.');
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
      await processingMessage.edit('Images were generated but could not be saved or displayed.');
      return;
    }

    // Chunk attachments to respect Discord's per-message limit
    const maxPerMessage = config.getMaxAttachments();
    const firstBatch = attachments.slice(0, maxPerMessage);

    // Provide fallback text when embed is off and no files could be attached
    const hasVisualContent = !!embed || firstBatch.length > 0;
    const fallbackContent = hasVisualContent ? '' : `✅ ${savedCount} image(s) generated and saved.`;

    // Edit the processing message with optional embed and first batch of attachments
    await processingMessage.edit({
      content: fallbackContent,
      embeds: embed ? [embed] : [],
      ...(firstBatch.length > 0 ? { files: firstBatch } : {}),
    });

    // Send remaining attachments as follow-up messages in batches
    for (let i = maxPerMessage; i < attachments.length; i += maxPerMessage) {
      const batch = attachments.slice(i, i + maxPerMessage);
      if ('send' in processingMessage.channel) {
        await processingMessage.channel.send({ content: '📎 Additional images', files: batch });
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
    processingMessage: Message,
    requester: string,
    isDM: boolean
  ): Promise<void> {
    const text = apiResult.data?.text || 'No response generated.';

    // Split into Discord-safe chunks (newline-aware)
    const chunks = chunkText(text);

    // Edit processing message with first chunk as plain text
    await processingMessage.edit({ content: chunks[0], embeds: [] });

    // Send remaining chunks as follow-up messages in the same channel
    for (let i = 1; i < chunks.length; i++) {
      if ('send' in processingMessage.channel) {
        await processingMessage.channel.send(chunks[i]);
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
    processingMessage: Message,
    requester: string,
    isDM: boolean
  ): Promise<void> {
    const text = apiResult.data?.text || 'No weather data available.';

    // Split into Discord-safe chunks (newline-aware)
    const chunks = chunkText(text);

    // Edit processing message with first chunk as plain text
    await processingMessage.edit({ content: chunks[0], embeds: [] });

    // Send remaining chunks as follow-up messages in the same channel
    for (let i = 1; i < chunks.length; i++) {
      if ('send' in processingMessage.channel) {
        await processingMessage.channel.send(chunks[i]);
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
    processingMessage: Message,
    requester: string,
    isDM: boolean
  ): Promise<void> {
    const text = apiResult.data?.text || 'No NFL data available.';

    // Split into Discord-safe chunks (newline-aware)
    const chunks = chunkText(text);

    // Edit processing message with first chunk as plain text
    await processingMessage.edit({ content: chunks[0], embeds: [] });

    // Send remaining chunks as follow-up messages in the same channel
    for (let i = 1; i < chunks.length; i++) {
      if ('send' in processingMessage.channel) {
        await processingMessage.channel.send(chunks[i]);
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
    processingMessage: Message,
    requester: string,
    isDM: boolean
  ): Promise<void> {
    const text = apiResult.data?.text || 'No search results available.';

    // Split into Discord-safe chunks (newline-aware)
    const chunks = chunkText(text);

    // Edit processing message with first chunk as plain text
    await processingMessage.edit({ content: chunks[0], embeds: [], allowedMentions: { parse: [] } });

    // Send remaining chunks as follow-up messages in the same channel
    for (let i = 1; i < chunks.length; i++) {
      if ('send' in processingMessage.channel) {
        await processingMessage.channel.send({ content: chunks[i], allowedMentions: { parse: [] } });
      }
    }

    activityEvents.emitBotReply('serpapi', text, isDM);

    logger.logReply(
      requester,
      `SerpAPI response sent: ${text.length} characters`,
      text
    );
  }
}

export const messageHandler = new MessageHandler();
