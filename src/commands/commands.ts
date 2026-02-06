import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SharedSlashCommand,
} from 'discord.js';
import { config, KeywordConfig } from '../utils/config';
import { requestQueue } from '../utils/requestQueue';
import { apiManager } from '../api';
import { logger } from '../utils/logger';
import { fileHandler } from '../utils/fileHandler';

export abstract class BaseCommand {
  abstract data: SharedSlashCommand;
  abstract execute(interaction: ChatInputCommandInteraction): Promise<void>;
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

    // Check if API is available
    if (!requestQueue.isApiAvailable('comfyui')) {
      logger.logBusy(requester, 'comfyui');

      await interaction.editReply({
        content: '🔄 The ComfyUI API is currently busy. Please try again with `/generate` in a moment!',
      });
      return;
    }

    // Log the request
    logger.logRequest(requester, `[generate] ${prompt}`);

    // Start processing message
    await interaction.editReply({
      content: '⏳ Processing your image generation request...',
    });

    try {
      // Execute through the queue (handles locking + timeout)
      const apiResult = await requestQueue.execute(
        'comfyui',
        requester,
        'generate',
        300,
        () => apiManager.executeRequest('comfyui', requester, prompt, 300)
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
      logger.logError(requester, errorMsg);
      await interaction.editReply({
        content: `❌ Error processing request: ${errorMsg}`,
      });
    }
  }

  private async handleResponse(
    interaction: ChatInputCommandInteraction,
    apiResult: any,
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
    for (let i = 0; i < apiResult.data.images.length; i++) {
      const imageUrl = apiResult.data.images[i];

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
      }
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
        .setDescription('Which model to use (default: llama2)')
        .setRequired(false)
        .addChoices(
          { name: 'llama2', value: 'llama2' },
          { name: 'neural-chat', value: 'neural-chat' }
        )
    );

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const question = interaction.options.getString('question', true);
    const model = interaction.options.getString('model') || 'llama2';
    const requester = interaction.user.username;

    // Defer reply as ephemeral
    await interaction.deferReply({ ephemeral: true });

    // Check if API is available
    if (!requestQueue.isApiAvailable('ollama')) {
      logger.logBusy(requester, 'ollama');

      await interaction.editReply({
        content: '🔄 The Ollama API is currently busy. Please try again with `/ask` in a moment!',
      });
      return;
    }

    // Log the request
    logger.logRequest(requester, `[ask] (${model}) ${question}`);

    // Start processing message
    await interaction.editReply({
      content: '⏳ Processing your question...',
    });

    try {
      // Execute through the queue (handles locking + timeout)
      const apiResult = await requestQueue.execute(
        'ollama',
        requester,
        'ask',
        300,
        () => apiManager.executeRequest('ollama', requester, question, 300)
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
      logger.logError(requester, errorMsg);
      await interaction.editReply({
        content: `❌ Error processing request: ${errorMsg}`,
      });
    }
  }

  private async handleResponse(
    interaction: ChatInputCommandInteraction,
    apiResult: any,
    requester: string
  ): Promise<void> {
    const text = apiResult.data?.text || 'No response generated.';

    const embed = new EmbedBuilder()
      .setColor('#0099FF')
      .setTitle('Ollama Response')
      .setDescription(text.substring(0, 4096)) // Discord embed description limit
      .setTimestamp();

    await interaction.editReply({
      content: '',
      embeds: [embed],
    });

    logger.logReply(requester, `Ollama response sent: ${text.length} characters`);
  }
}

export const commands: BaseCommand[] = [new GenerateCommand(), new AskCommand()];
