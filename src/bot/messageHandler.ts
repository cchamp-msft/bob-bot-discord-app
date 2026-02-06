import {
  Message,
  EmbedBuilder,
  AnyThreadChannel,
} from 'discord.js';
import { config, KeywordConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { requestQueue } from '../utils/requestQueue';
import { apiManager } from '../api';
import { fileHandler } from '../utils/fileHandler';

class MessageHandler {
  async handleMessage(message: Message): Promise<void> {
    // Ignore bot messages
    if (message.author.bot) return;

    // Check if bot is mentioned
    if (!message.mentions.has(message.client.user!.id)) return;

    // Extract message content — remove mention patterns like <@123> or <@!123>
    const mentionRegex = new RegExp(
      `<@!?${message.client.user!.id}>`,
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

    // Check if API is available (quick check before creating thread)
    if (!requestQueue.isApiAvailable(keywordConfig.api)) {
      logger.logBusy(message.author.username, keywordConfig.api);

      await message.reply(
        `🔄 The **${keywordConfig.api}** API is currently busy. ` +
          `Please try again in a moment by mentioning me with your request!`
      );
      return;
    }

    // Create a thread for the response
    const threadName = `${keywordConfig.keyword} - ${message.author.username} - ${new Date().toLocaleTimeString()}`;
    let thread: AnyThreadChannel;

    try {
      thread = await message.startThread({
        name: threadName.substring(0, 100), // Discord limit
        autoArchiveDuration: 60,
      });
    } catch (error) {
      console.error('Failed to create thread:', error);
      await message.reply('❌ Failed to create a response thread.');
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
        keywordConfig.timeout,
        () =>
          apiManager.executeRequest(
            keywordConfig.api,
            message.author.username,
            content,
            keywordConfig.timeout
          )
      );

      if (!apiResult.success) {
        await thread.send(`❌ Error: ${apiResult.error}`);
        logger.logError(message.author.username, apiResult.error);
        return;
      }

      // Handle response based on API type
      if (keywordConfig.api === 'comfyui') {
        await this.handleComfyUIResponse(
          apiResult,
          thread,
          message.author.username
        );
      } else {
        await this.handleOllamaResponse(
          apiResult,
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
        await thread.send(`❌ Error processing request: ${errorMsg}`);
      }

      logger.logError(message.author.username, errorMsg);
    }
  }

  private findKeyword(content: string): KeywordConfig | undefined {
    const lowerContent = content.toLowerCase();
    return config.getKeywords().find((k) =>
      lowerContent.includes(k.keyword.toLowerCase())
    );
  }

  private async handleComfyUIResponse(
    apiResult: any,
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
      }
    }

    await thread.send({ embeds: [embed] });
    logger.logReply(
      requester,
      `ComfyUI response sent: ${apiResult.data.images.length} images`
    );
  }

  private async handleOllamaResponse(
    apiResult: any,
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
