import {
  Message,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import { config, KeywordConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { requestQueue } from '../utils/requestQueue';
import { apiManager, ComfyUIResponse, OllamaResponse, AccuWeatherResponse } from '../api';
import { fileHandler } from '../utils/fileHandler';
import { ChatMessage, NFLResponse } from '../types';
import { chunkText } from '../utils/chunkText';
import { classifyIntent, buildAbilitiesContext } from '../utils/keywordClassifier';
import { executeRoutedRequest } from '../utils/apiRouter';
import { evaluateContextWindow } from '../utils/contextEvaluator';
import { NFLClient } from '../api/nflClient';

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
    // Ignore bot messages
    if (message.author.bot) return;

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
      logger.logIgnored(message.author.username, 'Empty message after mention removal');
      await message.reply(
        'Please include a prompt or question in your message!'
      );
      return;
    }

    // Find matching keyword at message start — fall back to two-stage Ollama evaluation
    let keywordConfig = this.findKeyword(content);
    const keywordMatched = keywordConfig !== undefined;

    if (keywordConfig) {
      logger.log('success', 'system', `KEYWORD: Matched "${keywordConfig.keyword}" at message start`);
    } else {
      logger.log('success', 'system', `KEYWORD: No first-word match, deferring to two-stage evaluation`);
    }

    // Built-in help keyword: respond immediately with keyword list
    if (keywordConfig?.builtin && keywordConfig.keyword.toLowerCase() === 'help') {
      logger.logRequest(message.author.username, `[help] ${content}`);
      const helpText = this.buildHelpResponse();
      let processingMessage: Message;
      try {
        processingMessage = await message.reply(helpText);
      } catch (error) {
        logger.logError(message.author.username, `Failed to send help response: ${error}`);
      }
      return;
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
      logger.logDefault(message.author.username, content);
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
      // Some keywords (e.g. "nfl scores", "superbowl") work without extra content.
      // For those, use the keyword itself as the content so the request proceeds.
      const keywordAllowsEmpty =
        (keywordConfig.api === 'nfl' && NFLClient.allowsEmptyContent(keywordConfig.keyword));

      if (keywordAllowsEmpty) {
        content = keywordConfig.keyword;
      } else {
        logger.logIgnored(message.author.username, 'Empty message after keyword removal');
        await message.reply(
          'Please include a prompt or question after the keyword!'
        );
        return;
      }
    }

    // Collect reply chain context — needed for any path that may call Ollama
    // (direct chat, two-stage evaluation, or final Ollama pass)
    let conversationHistory: ChatMessage[] = [];
    if (config.getReplyChainEnabled()) {
      if (isDM) {
        // DMs: collect recent channel history (no reply chain needed)
        conversationHistory = await this.collectDmHistory(message);
      } else if (message.reference) {
        // Guild: only collect context when explicitly replying
        conversationHistory = await this.collectReplyChain(message);
      }
    }

    // Log the request
    logger.logRequest(
      message.author.username,
      `[${keywordConfig.keyword}] ${content}`
    );

    // Send inline processing message as a reply
    let processingMessage: Message;
    try {
      processingMessage = await message.reply('⏳ Processing your request...');
    } catch (error) {
      logger.logError(
        message.author.username,
        `Failed to send processing message: ${error}`
      );
      return;
    }

    try {
      if (apiKeywordMatched) {
        // ── API keyword path: execute API with optional final Ollama pass ──
        const routedResult = await executeRoutedRequest(
          keywordConfig,
          content,
          message.author.username,
          conversationHistory.length > 0 ? conversationHistory : undefined
        );

        await this.dispatchResponse(
          routedResult.finalResponse,
          routedResult.finalApi,
          processingMessage,
          message.author.username
        );
      } else {
        // ── Ollama path: chat with abilities context, then second evaluation ──
        await this.executeWithTwoStageEvaluation(
          content,
          keywordConfig,
          processingMessage,
          message.author.username,
          conversationHistory
        );
      }
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : 'Unknown error';

      // Log full error to console always
      logger.logError(message.author.username, errorMsg);

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
   */
  async collectReplyChain(message: Message): Promise<ChatMessage[]> {
    const maxDepth = config.getReplyChainMaxDepth();
    const maxTotalChars = config.getReplyChainMaxTokens();
    const chain: { role: 'user' | 'assistant'; content: string; authorName?: string }[] = [];
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
        logger.log('success', 'system', `REPLY_CHAIN: Circular reference detected at message ${refId}, stopping`);
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
            logger.log('success', 'system', `REPLY_CHAIN: Character limit reached (${totalChars}/${maxTotalChars}), stopping at depth ${depth}`);
            break;
          }
          totalChars += entryLen;

          const role = isBot ? 'assistant' as const : 'user' as const;
          const authorName = isBot ? undefined : (referenced.member?.displayName ?? referenced.author.username);

          if (!isBot) {
            userAuthors.add(referenced.author.id);
          }

          chain.push({ role, content: refContent, authorName });
        }

        current = referenced;
      } catch (error) {
        // Message deleted or inaccessible — stop traversal gracefully
        logger.log('success', 'system', `REPLY_CHAIN: Could not fetch message ${refId} (deleted or inaccessible), stopping at depth ${depth}`);
        break;
      }
    }

    if (chain.length > 0) {
      logger.log('success', 'system', `REPLY_CHAIN: Collected ${chain.length} message(s) of context`);
    }

    // Also count the current message author for multi-user detection
    userAuthors.add(message.author.id);
    const multiUser = userAuthors.size > 1;

    // Reverse so oldest message is first, and build final ChatMessage array
    return chain.reverse().map(entry => {
      // Prefix user messages with display name when multiple humans are in the chain
      const content = (multiUser && entry.role === 'user' && entry.authorName)
        ? `${entry.authorName}: ${entry.content}`
        : entry.content;
      return { role: entry.role, content };
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

      const chain: ChatMessage[] = [];
      let totalChars = 0;

      for (const msg of sorted) {
        // Skip bot's system/processing messages
        if (msg.content === '⏳ Processing your request...') continue;

        let content = msg.content || '';

        // Strip bot mentions
        if (botId) {
          const mentionRegex = new RegExp(`<@!?${botId}>`, 'g');
          content = content.replace(mentionRegex, '').trim();
        }

        if (!content) continue;

        // Check character budget
        if (totalChars + content.length > maxTotalChars) {
          logger.log('success', 'system', `DM_HISTORY: Character limit reached (${totalChars}/${maxTotalChars}), stopping`);
          break;
        }
        totalChars += content.length;

        const role = msg.author.id === botId ? 'assistant' as const : 'user' as const;
        chain.push({ role, content });
      }

      if (chain.length > 0) {
        logger.log('success', 'system', `DM_HISTORY: Collected ${chain.length} message(s) of context`);
      }

      return chain;
    } catch (error) {
      logger.logError('system', `DM_HISTORY: Failed to fetch DM history: ${error}`);
      return [];
    }
  }

  /**
   * Match a keyword only at the very start of the message.
   * Keywords are sorted longest-first so multi-word keywords like
   * "weather report" take priority over shorter ones like "weather".
   * Disabled keywords (enabled === false) are skipped.
   */
  private findKeyword(content: string): KeywordConfig | undefined {
    const lowerContent = content.toLowerCase();
    // Sort longest keyword first so "weather report" wins over "weather"
    const sorted = [...config.getKeywords()]
      .filter((k) => k.enabled !== false)
      .sort(
        (a, b) => b.keyword.length - a.keyword.length
      );
    return sorted.find((k) => {
      const keyword = k.keyword.toLowerCase().trim();
      if (!keyword) return false;
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Anchor to START of message + word boundary after keyword
      const pattern = new RegExp(`^${escaped}\\b`, 'i');
      return pattern.test(lowerContent);
    });
  }

  /**
   * Execute the two-stage evaluation flow:
   * 1. Call Ollama with abilities context so it knows what APIs are available
   * 2. Classify Ollama's response for non-Ollama API keywords
   * 3. If a non-Ollama API keyword is found, execute that API with optional final pass
   * 4. Otherwise return Ollama's response as the final answer
   */
  private async executeWithTwoStageEvaluation(
    content: string,
    keywordConfig: KeywordConfig,
    processingMessage: Message,
    requester: string,
    conversationHistory: ChatMessage[]
  ): Promise<void> {
    const timeout = keywordConfig.timeout || config.getDefaultTimeout();

    // Build conversation history with abilities context for Ollama
    const abilitiesContext = buildAbilitiesContext();
    const historyWithAbilities: ChatMessage[] = [];
    if (abilitiesContext) {
      historyWithAbilities.push({ role: 'system', content: abilitiesContext });

      // Log abilities passed to the model (detailed logging opt-in)
      if (config.getAbilityLoggingDetailed()) {
        logger.log('success', 'system', `TWO-STAGE: Abilities context passed to model:\n${abilitiesContext}`);
      } else {
        // Always log a summary count
        const abilityCount = (abilitiesContext.match(/^- /gm) || []).length;
        logger.log('success', 'system', `TWO-STAGE: ${abilityCount} ability/abilities passed to model`);
      }
    } else {
      logger.log('success', 'system', 'TWO-STAGE: No abilities configured — standard Ollama chat');
    }
    if (conversationHistory.length > 0) {
      // Apply context filter (Ollama-based relevance evaluation) before stage-1 call.
      // This trims older off-topic messages while always keeping the most recent minDepth.
      conversationHistory = await evaluateContextWindow(
        conversationHistory,
        content,
        keywordConfig,
        requester
      );
      historyWithAbilities.push(...conversationHistory);
    }

    // Stage 1: Call Ollama with abilities context
    const ollamaResult = await requestQueue.execute(
      'ollama',
      requester,
      keywordConfig.keyword,
      timeout,
      (signal) =>
        apiManager.executeRequest(
          'ollama',
          requester,
          content,
          timeout,
          undefined,
          historyWithAbilities.length > 0 ? historyWithAbilities : undefined,
          signal
        )
    ) as OllamaResponse;

    if (!ollamaResult.success) {
      await this.dispatchResponse(ollamaResult, 'ollama', processingMessage, requester);
      return;
    }

    // Stage 2: Classify Ollama's response for API keywords
    const ollamaText = ollamaResult.data?.text;
    if (ollamaText) {
      const secondClassification = await classifyIntent(ollamaText, requester);

      if (secondClassification.keywordConfig && secondClassification.keywordConfig.api !== 'ollama') {
        logger.log('success', 'system',
          `TWO-STAGE: Ollama response classified as "${secondClassification.keywordConfig.keyword}" — executing ${secondClassification.keywordConfig.api} API`);


        // Execute the matched API with optional final Ollama pass
        const apiResult = await executeRoutedRequest(
          secondClassification.keywordConfig,
          content,
          requester,
          conversationHistory.length > 0 ? conversationHistory : undefined
        );

        await this.dispatchResponse(
          apiResult.finalResponse,
          apiResult.finalApi,
          processingMessage,
          requester
        );
        return;
      }
    }

    // No API keyword found in Ollama's response — use it as-is
    logger.log('success', 'system', 'TWO-STAGE: No API intent detected in Ollama response — returning as direct chat');
    await this.dispatchResponse(ollamaResult, 'ollama', processingMessage, requester);
  }

  /**
   * Dispatch a response to the appropriate handler based on API type.
   * Handles error responses uniformly.
   */
  private async dispatchResponse(
    response: ComfyUIResponse | OllamaResponse | AccuWeatherResponse | NFLResponse,
    api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl',
    processingMessage: Message,
    requester: string
  ): Promise<void> {
    if (!response.success) {
      const errorDetail = response.error ?? 'Unknown API error';
      logger.logError(requester, errorDetail);

      if (this.canSendErrorMessage()) {
        await processingMessage.edit(`⚠️ ${config.getErrorMessage()}`);
      } else {
        await processingMessage.edit('⚠️ An error occurred processing your request.');
      }
      return;
    }

    if (api === 'comfyui') {
      await this.handleComfyUIResponse(response as ComfyUIResponse, processingMessage, requester);
    } else if (api === 'accuweather') {
      await this.handleAccuWeatherResponse(response as AccuWeatherResponse, processingMessage, requester);
    } else if (api === 'nfl') {
      await this.handleNFLResponse(response as NFLResponse, processingMessage, requester);
    } else {
      await this.handleOllamaResponse(response as OllamaResponse, processingMessage, requester);
    }
  }

  /**
   * Build the help response text listing all enabled keywords and their descriptions.
   * Built-in keywords (like help itself) are excluded from the list.
   */
  buildHelpResponse(): string {
    const keywords = config.getKeywords().filter(k => k.enabled !== false && !k.builtin);
    if (keywords.length === 0) {
      return 'No keywords are currently configured.';
    }

    const lines = keywords.map(k => `**${k.keyword}** — ${k.description}`);
    return `📖 **Available Keywords:**\n${lines.join('\n')}`;
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
    requester: string
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

    logger.logReply(
      requester,
      `ComfyUI response sent: ${apiResult.data.images.length} images`
    );
  }

  private async handleOllamaResponse(
    apiResult: OllamaResponse,
    processingMessage: Message,
    requester: string
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

    logger.logReply(
      requester,
      `Ollama response sent: ${text.length} characters`
    );
  }

  private async handleAccuWeatherResponse(
    apiResult: AccuWeatherResponse,
    processingMessage: Message,
    requester: string
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

    logger.logReply(
      requester,
      `AccuWeather response sent: ${text.length} characters`
    );
  }

  private async handleNFLResponse(
    apiResult: NFLResponse,
    processingMessage: Message,
    requester: string
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

    logger.logReply(
      requester,
      `NFL response sent: ${text.length} characters`
    );
  }
}

export const messageHandler = new MessageHandler();
