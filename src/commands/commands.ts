import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SharedSlashCommand,
} from 'discord.js';
import { config } from '../utils/config';
import { requestQueue } from '../utils/requestQueue';
import { apiManager, ComfyUIResponse, OllamaResponse, AccuWeatherResponse } from '../api';
import { memeClient } from '../api/memeClient';
import { logger } from '../utils/logger';
import { chunkText } from '../utils/chunkText';
import { fileHandler } from '../utils/fileHandler';
import { buildAskPrompt } from '../utils/promptBuilder';

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
        (signal) => apiManager.executeRequest('comfyui', requester, prompt, timeout, undefined, undefined, signal) as Promise<ComfyUIResponse>
      );

      if (!apiResult.success) {
        const errorDetail = apiResult.error ?? 'Unknown API error';
        logger.logError(requester, errorDetail);
        await interaction.editReply({
          content: `⚠️ ${config.getErrorMessage()}`,
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
        content: `⚠️ ${config.getErrorMessage()}`,
      });
    }
  }

  private async handleResponse(
    interaction: ChatInputCommandInteraction,
    apiResult: ComfyUIResponse,
    requester: string
  ): Promise<void> {
    const images = apiResult.data?.images || [];
    const videos = apiResult.data?.videos || [];
    const totalOutputs = images.length + videos.length;

    if (totalOutputs === 0) {
      await interaction.editReply({
        content: 'No images or videos were generated.',
      });
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

    // Process each output
    let savedCount = 0;
    const attachments: { attachment: Buffer; name: string }[] = [];

    const processOutputs = async (urls: string[], description: string, extension: string, label: string) => {
      for (let i = 0; i < urls.length; i++) {
        const fileOutput = await fileHandler.saveFromUrl(requester, description, urls[i], extension);
        if (fileOutput) {
          savedCount++;
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
        }
      }
    };

    await processOutputs(images, 'generated_image', 'png', 'Image');
    await processOutputs(videos, 'generated_video', 'mp4', 'Video');

    if (savedCount === 0) {
      await interaction.editReply({
        content: 'Files were generated but could not be saved or displayed.',
      });
      return;
    }

    // Chunk attachments to respect Discord's per-message limit
    const maxPerMessage = config.getMaxAttachments();
    const firstBatch = attachments.slice(0, maxPerMessage);

    // Provide fallback text when embed is off and no files could be attached
    const hasVisualContent = !!embed || firstBatch.length > 0;
    const content = hasVisualContent ? '' : `✅ ${savedCount} file(s) generated and saved.`;

    await interaction.editReply({
      content,
      embeds: embed ? [embed] : [],
      ...(firstBatch.length > 0 ? { files: firstBatch } : {}),
    });

    // Send remaining attachments as follow-up messages in batches
    for (let i = maxPerMessage; i < attachments.length; i += maxPerMessage) {
      const batch = attachments.slice(i, i + maxPerMessage);
      await interaction.followUp({ content: '📎 Additional files', files: batch, ephemeral: true });
    }

    const parts: string[] = [];
    if (images.length > 0) parts.push(`${images.length} image(s)`);
    if (videos.length > 0) parts.push(`${videos.length} video(s)`);
    logger.logReply(requester, `ComfyUI response sent: ${parts.join(', ')}`);
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
      // Build the XML-tagged single-string prompt for /ask
      const askPrompt = buildAskPrompt(question);

      // Execute through the queue (handles locking + timeout).
      // The persona is embedded in the <system> XML tag inside the prompt,
      // so includeSystemPrompt: false prevents a duplicate system message.
      const timeout = this.getTimeout('ask');
      const apiResult = await requestQueue.execute<OllamaResponse>(
        'ollama',
        requester,
        'ask',
        timeout,
        (signal) => apiManager.executeRequest(
          'ollama', requester, askPrompt, timeout, model, undefined, signal,
          undefined, { includeSystemPrompt: false }
        ) as Promise<OllamaResponse>
      );

      if (!apiResult.success) {
        const errorDetail = apiResult.error ?? 'Unknown API error';
        logger.logError(requester, errorDetail);
        await interaction.editReply({
          content: `⚠️ ${config.getErrorMessage()}`,
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
        content: `⚠️ ${config.getErrorMessage()}`,
      });
    }
  }

  private async handleResponse(
    interaction: ChatInputCommandInteraction,
    apiResult: OllamaResponse,
    requester: string
  ): Promise<void> {
    const text = apiResult.data?.text || 'No response generated.';

    // Split into Discord-safe chunks (newline-aware)
    const chunks = chunkText(text);

    // Edit the deferred reply with the first chunk
    await interaction.editReply({ content: chunks[0] });

    // Send remaining chunks as follow-ups (keep ephemeral to match deferred reply)
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], ephemeral: true });
    }

    logger.logReply(requester, `Ollama response sent: ${text.length} characters`, text);
  }
}

class WeatherCommand extends BaseCommand {
  data = new SlashCommandBuilder()
    .setName('weather')
    .setDescription('Get weather conditions and forecast')
    .addStringOption((option) =>
      option
        .setName('location')
        .setDescription('City name, zip code, or location key (uses default if omitted)')
        .setRequired(false)
    );

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const location = interaction.options.getString('location') || '';
    const requester = interaction.user.username;

    // Defer reply as ephemeral
    await interaction.deferReply({ ephemeral: true });

    // Build a prompt-like string for the weather client
    const prompt = location ? `weather in ${location}` : 'weather';

    // Log the request
    logger.logRequest(requester, `[weather] ${config.getAccuWeatherDefaultWeatherType()} — ${location || '(default location)'}`);

    await interaction.editReply({
      content: '⏳ Fetching weather data…',
    });

    try {
      const timeout = this.getTimeout('weather');
      const apiResult = await requestQueue.execute<AccuWeatherResponse>(
        'accuweather',
        requester,
        'weather',
        timeout,
        (signal) => apiManager.executeRequest('accuweather', requester, prompt, timeout, undefined, undefined, signal) as Promise<AccuWeatherResponse>
      );

      if (!apiResult.success) {
        const errorDetail = apiResult.error ?? 'Unknown API error';
        logger.logError(requester, errorDetail);
        await interaction.editReply({
          content: `⚠️ ${errorDetail}`,
        });
        return;
      }

      await this.handleResponse(interaction, apiResult, requester);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.logError(requester, errorMsg);
      await interaction.editReply({
        content: `⚠️ ${config.getErrorMessage()}`,
      });
    }
  }

  private async handleResponse(
    interaction: ChatInputCommandInteraction,
    apiResult: AccuWeatherResponse,
    requester: string
  ): Promise<void> {
    const text = apiResult.data?.text || 'No weather data available.';

    // Split into Discord-safe chunks (newline-aware)
    const chunks = chunkText(text);

    // Edit the deferred reply with the first chunk
    await interaction.editReply({ content: chunks[0] });

    // Send remaining chunks as follow-ups
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], ephemeral: true });
    }

    logger.logReply(requester, `Weather response sent: ${text.length} characters`, text);
  }
}

class MemeTemplatesCommand extends BaseCommand {
  data = new SlashCommandBuilder()
    .setName('meme_templates')
    .setDescription('List available meme template ids');

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const requester = interaction.user.username;

    await interaction.deferReply({ ephemeral: true });
    logger.logRequest(requester, '[meme_templates]');

    const ids = memeClient.getTemplateIds();

    if (!ids) {
      await interaction.editReply({
        content: 'No meme templates found',
      });
      return;
    }

    // Discord messages have a 2000-char limit; chunk if needed
    const chunks = chunkText(ids, 1900);

    await interaction.editReply({ content: chunks[0] });

    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], ephemeral: true });
    }

    logger.logReply(requester, `Meme templates sent: ${ids.length} characters`);
  }
}

export const commands: BaseCommand[] = [new GenerateCommand(), new AskCommand(), new WeatherCommand(), new MemeTemplatesCommand()];
