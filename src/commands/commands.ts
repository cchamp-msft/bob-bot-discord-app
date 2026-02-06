import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SharedSlashCommand,
} from 'discord.js';
import { config } from '../utils/config';
import { requestQueue } from '../utils/requestQueue';
import { apiManager, ComfyUIResponse, OllamaResponse } from '../api';
import { logger } from '../utils/logger';
import { fileHandler } from '../utils/fileHandler';

export abstract class BaseCommand {
  abstract data: SharedSlashCommand;
  abstract execute(interaction: ChatInputCommandInteraction): Promise<void>;

  protected getTimeout(keyword: string): number {
    return config.getKeywordConfig(keyword)?.timeout ?? config.getDefaultTimeout();
  }
}

class GenerateCommand extends BaseCommand {
  data = new SlashCommandBuilder()
    .setName('generate')
    .setDescription('Generate an image using ComfyUI')
    .addStringOption((option) =>
      option
        .setName('prompt')
        .setDescription('The prompt for image generation')
        .setRequired(true)
    );

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const prompt = interaction.options.getString('prompt', true);
    const requester = interaction.user.username;

    // Defer reply as ephemeral
    await interaction.deferReply({ ephemeral: true });

    // Log the request
    logger.logRequest(requester, `[generate] ${prompt}`);

    // Start processing message
    await interaction.editReply({
      content: '⏳ Processing your image generation request...',
    });

    try {
      // Execute through the queue (handles locking + timeout)
      const timeout = this.getTimeout('generate');
      const apiResult = await requestQueue.execute<ComfyUIResponse>(
        'comfyui',
        requester,
        'generate',
        timeout,
        () => apiManager.executeRequest('comfyui', requester, prompt, timeout) as Promise<ComfyUIResponse>
      );

      if (!apiResult.success) {
        await interaction.editReply({
          content: `❌ Error: ${apiResult.error}`,
        });
        return;
      }

      // Handle response
      await this.handleResponse(interaction, apiResult, requester);
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : 'Unknown error';
      if (errorMsg.startsWith('API_BUSY:')) {
        await interaction.editReply({
          content: '🔄 The ComfyUI API became busy. Please retry with `/generate`.',
        });
      } else {
        logger.logError(requester, errorMsg);
        await interaction.editReply({
          content: `❌ Error processing request: ${errorMsg}`,
        });
      }
    }
  }

  private async handleResponse(
    interaction: ChatInputCommandInteraction,
    apiResult: ComfyUIResponse,
    requester: string
  ): Promise<void> {
    if (!apiResult.data?.images || apiResult.data.images.length === 0) {
      await interaction.editReply({
        content: 'No images were generated.',
      });
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

      const fileOutput = await fileHandler.saveFromUrl(
        requester,
        'generated_image',
        imageUrl,
        'png'
      );

      if (fileOutput) {
        savedCount++;
        embed.addFields({
          name: `Image ${i + 1}`,
          value: `[View](${fileOutput.url})`,
          inline: false,
        });
      }
    }

    if (savedCount === 0) {
      await interaction.editReply({
        content: 'Images were generated but could not be saved or displayed.',
      });
      return;
    }

    await interaction.editReply({
      content: '',
      embeds: [embed],
    });

    logger.logReply(
      requester,
      `ComfyUI response sent: ${apiResult.data.images.length} images`
    );
  }
}

class AskCommand extends BaseCommand {
  data = new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask a question to Ollama AI')
    .addStringOption((option) =>
      option
        .setName('question')
        .setDescription('Your question for the AI')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('model')
        .setDescription('Which model to use (uses configured default if omitted)')
        .setRequired(false)
    );

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const question = interaction.options.getString('question', true);
    const model = interaction.options.getString('model') || config.getOllamaModel();
    const requester = interaction.user.username;

    // Defer reply as ephemeral
    await interaction.deferReply({ ephemeral: true });

    // Log the request
    logger.logRequest(requester, `[ask] (${model}) ${question}`);

    // Start processing message
    await interaction.editReply({
      content: '⏳ Processing your question...',
    });

    try {
      // Execute through the queue (handles locking + timeout)
      const timeout = this.getTimeout('ask');
      const apiResult = await requestQueue.execute<OllamaResponse>(
        'ollama',
        requester,
        'ask',
        timeout,
        () => apiManager.executeRequest('ollama', requester, question, timeout, model) as Promise<OllamaResponse>
      );

      if (!apiResult.success) {
        await interaction.editReply({
          content: `❌ Error: ${apiResult.error}`,
        });
        return;
      }

      // Handle response
      await this.handleResponse(interaction, apiResult, requester);
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : 'Unknown error';
      if (errorMsg.startsWith('API_BUSY:')) {
        await interaction.editReply({
          content: '🔄 The Ollama API became busy. Please retry with `/ask`.',
        });
      } else {
        logger.logError(requester, errorMsg);
        await interaction.editReply({
          content: `❌ Error processing request: ${errorMsg}`,
        });
      }
    }
  }

  private async handleResponse(
    interaction: ChatInputCommandInteraction,
    apiResult: OllamaResponse,
    requester: string
  ): Promise<void> {
    const text = apiResult.data?.text || 'No response generated.';
    const truncated = text.length > 4096;
    const displayText = truncated
      ? text.substring(0, 4050) + '\n\n… *(response truncated)*'
      : text;

    const embed = new EmbedBuilder()
      .setColor('#0099FF')
      .setTitle('Ollama Response')
      .setDescription(displayText)
      .setTimestamp();

    await interaction.editReply({
      content: '',
      embeds: [embed],
    });

    logger.logReply(requester, `Ollama response sent: ${text.length} characters`);
  }
}

export const commands: BaseCommand[] = [new GenerateCommand(), new AskCommand()];
