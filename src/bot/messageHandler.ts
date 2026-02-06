import {
  Message,
  EmbedBuilder,
  AnyThreadChannel,
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

    // Check if bot is mentioned
    if (!message.mentions.has(message.client.user.id)) return;

    // Extract message content — remove mention patterns like <@123> or <@!123>
    const mentionRegex = new RegExp(
      `<@!?${message.client.user.id}>`,
      'g'
    );
    const content = message.content.replace(mentionRegex, '').trim();

    if (!content) {
      await message.reply(
        'Please provide a prompt or question after mentioning me!'
      );
      return;
    }

    // Find matching keyword
    const keywordConfig = this.findKeyword(content);

    if (!keywordConfig) {
      await message.reply(
        'I did not recognize any keywords in your message. Available keywords: ' +
          config
            .getKeywords()
            .map((k) => `\`${k.keyword}\``)
            .join(', ')
      );
      return;
    }

    // Create or reuse a thread for the response
    const threadName = `${keywordConfig.keyword} - ${message.author.username} - ${new Date().toLocaleTimeString()}`;
    let thread: AnyThreadChannel | null = null;

    try {
      if (message.channel.isThread()) {
        thread = message.channel;
      } else if (message.hasThread && message.thread) {
        thread = message.thread;
      } else if (
        message.channel.type === ChannelType.GuildText ||
        message.channel.type === ChannelType.GuildAnnouncement
      ) {
        thread = await message.startThread({
          name: threadName.substring(0, 100), // Discord limit
          autoArchiveDuration: 60,
        });
      }
    } catch (error) {
      logger.logError(
        message.author.username,
        `Failed to create thread: ${error}`
      );
      await message.reply('❌ Failed to create a response thread.');
      return;
    }

    if (!thread) {
      await message.reply(
        '❌ Unable to create a thread in this channel. Please try in a text channel.'
      );
      return;
    }

    // Log the request
    logger.logRequest(
      message.author.username,
      `[${keywordConfig.keyword}] ${content}`
    );

    // Notify user that processing has started
    await thread.send('⏳ Processing your request...');

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

        // Only send error message to Discord if rate limit allows
        if (this.canSendErrorMessage()) {
          await thread.send(`⚠️ ${config.getErrorMessage()}`);
        }
        return;
      }

      // Handle response based on API type
      if (keywordConfig.api === 'comfyui') {
        await this.handleComfyUIResponse(
          apiResult as ComfyUIResponse,
          thread,
          message.author.username
        );
      } else {
        await this.handleOllamaResponse(
          apiResult as OllamaResponse,
          thread,
          message.author.username
        );
      }
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : 'Unknown error';

      if (errorMsg.startsWith('API_BUSY:')) {
        await thread.send(
          `🔄 The **${keywordConfig.api}** API became busy. ` +
            `Please try again by mentioning me with your request!`
        );
      } else {
        // Log full error to console always
        logger.logError(message.author.username, errorMsg);

        // Only send error message to Discord if rate limit allows
        if (this.canSendErrorMessage()) {
          await thread.send(`⚠️ ${config.getErrorMessage()}`);
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
    thread: AnyThreadChannel,
    requester: string
  ): Promise<void> {
    if (!apiResult.data?.images || apiResult.data.images.length === 0) {
      await thread.send('No images were generated.');
      return;
    }

    const embed = new EmbedBuilder()
      .setColor('#00AA00')
      .setTitle('ComfyUI Generation Complete')
      .setTimestamp();

    // Process each image
    let savedCount = 0;
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

        // Attach file if small enough
        if (fileHandler.shouldAttachFile(fileOutput.size)) {
          const fileBuffer = fileHandler.readFile(fileOutput.filePath);
          if (fileBuffer) {
            await thread.send({
              files: [
                { attachment: fileBuffer, name: fileOutput.fileName },
              ],
            });
          }
        }
        savedCount++;
      }
    }

    if (savedCount === 0) {
      await thread.send('Images were generated but could not be saved or displayed.');
      return;
    }

    await thread.send({ embeds: [embed] });
    logger.logReply(
      requester,
      `ComfyUI response sent: ${apiResult.data.images.length} images`
    );
  }

  private async handleOllamaResponse(
    apiResult: OllamaResponse,
    thread: AnyThreadChannel,
    requester: string
  ): Promise<void> {
    const text = apiResult.data?.text || 'No response generated.';

    // Split into chunks if too long (Discord embed limit is 4096)
    const maxLength = 4096;
    const chunks: string[] = [];

    for (let i = 0; i < text.length; i += maxLength) {
      chunks.push(text.substring(i, i + maxLength));
    }

    for (const chunk of chunks) {
      const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle('Ollama Response')
        .setDescription(chunk)
        .setTimestamp();

      await thread.send({ embeds: [embed] });
    }

    logger.logReply(
      requester,
      `Ollama response sent: ${text.length} characters`
    );
  }
}

export const messageHandler = new MessageHandler();
