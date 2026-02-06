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

    // Only process DMs or @mentions — ignore everything else
    if (!isDM && !isMentioned) return;

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

    // Extract message content — remove mention patterns like <@123> or <@!123>
    const mentionRegex = new RegExp(
      `<@!?${message.client.user.id}>`,
      'g'
    );
    const content = message.content.replace(mentionRegex, '').trim();

    if (!content) {
      logger.logIgnored(message.author.username, 'Empty message after mention removal');
      await message.reply(
        'Please provide a prompt or question after mentioning me!'
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
        () =>
          apiManager.executeRequest(
            keywordConfig.api,
            message.author.username,
            content,
            keywordConfig.timeout || config.getDefaultTimeout()
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

      if (errorMsg.startsWith('API_BUSY:')) {
        await processingMessage.edit(
          `🔄 The **${keywordConfig.api}** API became busy. ` +
            `Please try again by mentioning me with your request!`
        );
      } else {
        // Log full error to console always
        logger.logError(message.author.username, errorMsg);

        // Edit processing message with error
        if (this.canSendErrorMessage()) {
          await processingMessage.edit(`⚠️ ${config.getErrorMessage()}`);
        } else {
          await processingMessage.edit('⚠️ An error occurred processing your request.');
        }
      }
    }
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

    // Split into chunks if too long (Discord embed limit is 4096)
    const maxLength = 4096;
    const chunks: string[] = [];

    for (let i = 0; i < text.length; i += maxLength) {
      chunks.push(text.substring(i, i + maxLength));
    }

    // Edit processing message with first chunk
    const firstEmbed = new EmbedBuilder()
      .setColor('#0099FF')
      .setTitle('Ollama Response')
      .setDescription(chunks[0])
      .setTimestamp();

    await processingMessage.edit({ content: '', embeds: [firstEmbed] });

    // Send remaining chunks as follow-up messages in the same channel
    for (let i = 1; i < chunks.length; i++) {
      const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setDescription(chunks[i])
        .setTimestamp();

      if ('send' in processingMessage.channel) {
        await processingMessage.channel.send({ embeds: [embed] });
      }
    }

    logger.logReply(
      requester,
      `Ollama response sent: ${text.length} characters`
    );
  }
}

export const messageHandler = new MessageHandler();
