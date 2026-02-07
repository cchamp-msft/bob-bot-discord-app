import {
  Message,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import { config, KeywordConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { requestQueue } from '../utils/requestQueue';
import { apiManager, ComfyUIResponse, OllamaResponse } from '../api';
import { fileHandler } from '../utils/fileHandler';
import { ChatMessage } from '../types';
import { chunkText } from '../utils/chunkText';

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

    // Find matching keyword — fall back to Ollama (chat) if none found
    let keywordConfig = this.findKeyword(content);

    if (!keywordConfig) {
      keywordConfig = {
        keyword: 'chat',
        api: 'ollama',
        timeout: config.getDefaultTimeout(),
        description: 'Default chat via Ollama',
      };
      logger.logDefault(message.author.username, content);
    }

    // Collect reply chain context for Ollama requests
    let conversationHistory: ChatMessage[] = [];
    if (keywordConfig.api === 'ollama' && config.getReplyChainEnabled() && message.reference) {
      conversationHistory = await this.collectReplyChain(message);
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
      // Execute through the queue (handles locking + timeout)
      const apiResult = await requestQueue.execute(
        keywordConfig.api,
        message.author.username,
        keywordConfig.keyword,
        keywordConfig.timeout || config.getDefaultTimeout(),
        (signal) =>
          apiManager.executeRequest(
            keywordConfig.api,
            message.author.username,
            content,
            keywordConfig.timeout || config.getDefaultTimeout(),
            undefined,
            conversationHistory.length > 0 ? conversationHistory : undefined,
            signal
          )
      );

      if (!apiResult.success) {
        const errorDetail = apiResult.error ?? 'Unknown API error';
        logger.logError(message.author.username, errorDetail);

        // Edit processing message with error
        if (this.canSendErrorMessage()) {
          await processingMessage.edit(`⚠️ ${config.getErrorMessage()}`);
        } else {
          await processingMessage.edit('⚠️ An error occurred processing your request.');
        }
        return;
      }

      // Handle response based on API type
      if (keywordConfig.api === 'comfyui') {
        await this.handleComfyUIResponse(
          apiResult as ComfyUIResponse,
          processingMessage,
          message.author.username
        );
      } else {
        await this.handleOllamaResponse(
          apiResult as OllamaResponse,
          processingMessage,
          message.author.username
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

  private findKeyword(content: string): KeywordConfig | undefined {
    const lowerContent = content.toLowerCase();
    return config.getKeywords().find((k) => {
      const keyword = k.keyword.toLowerCase().trim();
      if (!keyword) return false;
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
      return pattern.test(lowerContent);
    });
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

    const embed = new EmbedBuilder()
      .setColor('#00AA00')
      .setTitle('ComfyUI Generation Complete')
      .setTimestamp();

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
        embed.addFields({
          name: `Image ${i + 1}`,
          value: `[View](${fileOutput.url})`,
          inline: false,
        });

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

    // Edit the processing message with embed and first batch of attachments
    await processingMessage.edit({
      content: '',
      embeds: [embed],
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
}

export const messageHandler = new MessageHandler();
