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
import { COMMAND_PREFIX } from '../utils/config';

export abstract class BaseCommand {
  abstract data: SharedSlashCommand;
  abstract execute(interaction: ChatInputCommandInteraction): Promise<void>;

  protected getTimeout(keyword: string): number {
    return config.getToolConfig(keyword)?.timeout ?? config.getDefaultTimeout();
  }
}

/** Tool keyword mapping for !-prefix dispatch within the single /bot command. */
interface ToolRoute {
  /** The keyword after the ! prefix (e.g. 'generate', 'weather'). */
  keyword: string;
  /** API type to dispatch to. */
  api: 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi' | 'meme';
  /** Tool name for timeout lookup and logging. */
  toolName: string;
}

/** Built-in tool routes for !-prefix dispatch. */
const TOOL_ROUTES: ToolRoute[] = [
  { keyword: 'generate', api: 'comfyui', toolName: 'generate_image' },
  { keyword: 'weather', api: 'accuweather', toolName: 'get_current_weather' },
  { keyword: 'meme', api: 'meme', toolName: 'generate_meme' },
  { keyword: 'meme_templates', api: 'meme', toolName: 'get_meme_templates' },
  { keyword: 'search', api: 'serpapi', toolName: 'web_search' },
  { keyword: 'nfl', api: 'nfl', toolName: 'nfl_scores' },
];

/** Also match tool names from tools config as routes. */
function findToolRoute(keyword: string): ToolRoute | undefined {
  // Check built-in routes first
  const builtin = TOOL_ROUTES.find(r => r.keyword === keyword);
  if (builtin) return builtin;

  // Check configured tools by name or keyword
  const toolConfig = config.getToolConfig(keyword);
  if (toolConfig) {
    return {
      keyword,
      api: toolConfig.api as ToolRoute['api'],
      toolName: toolConfig.name,
    };
  }
  return undefined;
}

class BotCommand extends BaseCommand {
  data: SharedSlashCommand;

  constructor() {
    super();
    this.data = new SlashCommandBuilder()
      .setName(config.getSlashCommandName())
      .setDescription('Send a message or tool command to the bot')
      .addStringOption((option) =>
        option
          .setName('input')
          .setDescription('Your message or !tool command (e.g. "hello" or "!weather Seattle")')
          .setRequired(true)
      );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const input = interaction.options.getString('input', true);
    const requester = interaction.user.username;

    // Defer reply as ephemeral
    await interaction.deferReply({ ephemeral: true });

    // Check for !tool prefix dispatch
    if (input.startsWith(COMMAND_PREFIX)) {
      const withoutPrefix = input.slice(COMMAND_PREFIX.length);
      const spaceIdx = withoutPrefix.indexOf(' ');
      const keyword = spaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, spaceIdx);
      const content = spaceIdx === -1 ? '' : withoutPrefix.slice(spaceIdx + 1).trim();

      // Special case: !meme_templates (no content needed)
      if (keyword === 'meme_templates') {
        await this.handleMemeTemplates(interaction, requester);
        return;
      }

      const route = findToolRoute(keyword);
      if (route) {
        await this.handleToolRoute(interaction, route, content, requester);
        return;
      }
    }

    // No tool match — pass to Ollama via buildAskPrompt
    await this.handleAsk(interaction, input, requester);
  }

  private async handleToolRoute(
    interaction: ChatInputCommandInteraction,
    route: ToolRoute,
    content: string,
    requester: string,
  ): Promise<void> {
    logger.logRequest(requester, `[${route.toolName}] ${content}`);

    await interaction.editReply({
      content: `⏳ Processing ${route.toolName} request...`,
    });

    try {
      const timeout = this.getTimeout(route.toolName);

      if (route.api === 'comfyui') {
        const apiResult = await requestQueue.execute<ComfyUIResponse>(
          'comfyui',
          requester,
          route.toolName,
          timeout,
          (signal) => apiManager.executeRequest('comfyui', requester, content, timeout, undefined, undefined, signal) as Promise<ComfyUIResponse>
        );

        if (!apiResult.success) {
          logger.logError(requester, apiResult.error ?? 'Unknown API error');
          await interaction.editReply({ content: `⚠️ ${config.getErrorMessage()}` });
          return;
        }

        await this.handleComfyUIResponse(interaction, apiResult, requester);
      } else if (route.api === 'accuweather') {
        const prompt = content ? `weather in ${content}` : 'weather';
        const apiResult = await requestQueue.execute<AccuWeatherResponse>(
          'accuweather',
          requester,
          route.toolName,
          timeout,
          (signal) => apiManager.executeRequest('accuweather', requester, prompt, timeout, undefined, undefined, signal) as Promise<AccuWeatherResponse>
        );

        if (!apiResult.success) {
          logger.logError(requester, apiResult.error ?? 'Unknown API error');
          await interaction.editReply({ content: `⚠️ ${apiResult.error ?? config.getErrorMessage()}` });
          return;
        }

        await this.handleTextResponse(interaction, apiResult.data?.text || 'No weather data available.', requester, 'Weather');
      } else {
        // Generic text API dispatch (ollama, nfl, serpapi, meme)
        const apiResult = await requestQueue.execute<{ success: boolean; data?: { text: string }; error?: string }>(
          route.api,
          requester,
          route.toolName,
          timeout,
          (signal) => apiManager.executeRequest(route.api, requester, content, timeout, undefined, undefined, signal) as Promise<{ success: boolean; data?: { text: string }; error?: string }>
        );

        if (!apiResult.success) {
          logger.logError(requester, apiResult.error ?? 'Unknown API error');
          await interaction.editReply({ content: `⚠️ ${config.getErrorMessage()}` });
          return;
        }

        await this.handleTextResponse(interaction, apiResult.data?.text || 'No response generated.', requester, route.toolName);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.logError(requester, errorMsg);
      await interaction.editReply({ content: `⚠️ ${config.getErrorMessage()}` });
    }
  }

  private async handleAsk(
    interaction: ChatInputCommandInteraction,
    question: string,
    requester: string,
  ): Promise<void> {
    const model = config.getOllamaModel();
    logger.logRequest(requester, `[ask] (${model}) ${question}`);

    await interaction.editReply({ content: '⏳ Processing your question...' });

    try {
      const askPrompt = buildAskPrompt(question);
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
        logger.logError(requester, apiResult.error ?? 'Unknown API error');
        await interaction.editReply({ content: `⚠️ ${config.getErrorMessage()}` });
        return;
      }

      await this.handleTextResponse(interaction, apiResult.data?.text || 'No response generated.', requester, 'Ollama');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.logError(requester, errorMsg);
      await interaction.editReply({ content: `⚠️ ${config.getErrorMessage()}` });
    }
  }

  private async handleMemeTemplates(
    interaction: ChatInputCommandInteraction,
    requester: string,
  ): Promise<void> {
    logger.logRequest(requester, '[get_meme_templates]');

    const ids = memeClient.getTemplateIds();

    if (!ids) {
      await interaction.editReply({ content: 'No meme templates found' });
      return;
    }

    const chunks = chunkText(ids, 1900);
    await interaction.editReply({ content: chunks[0] });

    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], ephemeral: true });
    }

    logger.logReply(requester, `Meme templates sent: ${ids.length} characters`);
  }

  private async handleTextResponse(
    interaction: ChatInputCommandInteraction,
    text: string,
    requester: string,
    label: string,
  ): Promise<void> {
    const chunks = chunkText(text);
    await interaction.editReply({ content: chunks[0] });

    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], ephemeral: true });
    }

    logger.logReply(requester, `${label} response sent: ${text.length} characters`, text);
  }

  private async handleComfyUIResponse(
    interaction: ChatInputCommandInteraction,
    apiResult: ComfyUIResponse,
    requester: string,
  ): Promise<void> {
    const images = apiResult.data?.images || [];
    const videos = apiResult.data?.videos || [];
    const totalOutputs = images.length + videos.length;

    if (totalOutputs === 0) {
      await interaction.editReply({ content: 'No images or videos were generated.' });
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

    let savedCount = 0;
    const attachments: { attachment: Buffer; name: string }[] = [];

    const preSaved = apiResult.data?.savedOutputs || [];
    if (preSaved.length > 0) {
      for (const persisted of preSaved) {
        savedCount++;
        if (embed) {
          const label = persisted.mediaType === 'video' ? 'Video' : 'Image';
          embed.addFields({
            name: `${label} ${savedCount}`,
            value: `[View](${persisted.url})`,
            inline: false,
          });
        }
        if (fileHandler.shouldAttachFile(persisted.size)) {
          const fileBuffer = fileHandler.readFile(persisted.filePath);
          if (fileBuffer) {
            attachments.push({ attachment: fileBuffer, name: persisted.fileName });
          }
        }
      }
    } else {
      const processOutputs = async (urls: string[], description: string, extension: string, label: string) => {
        for (let i = 0; i < urls.length; i++) {
          const fileOutput = await fileHandler.saveFromUrl(requester, description, urls[i], extension, 'comfyui');
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
    }

    if (savedCount === 0) {
      await interaction.editReply({ content: 'Files were generated but could not be saved or displayed.' });
      return;
    }

    const maxPerMessage = config.getMaxAttachments();
    const firstBatch = attachments.slice(0, maxPerMessage);

    const hasVisualContent = !!embed || firstBatch.length > 0;
    const content = hasVisualContent ? '' : `✅ ${savedCount} file(s) generated and saved.`;

    await interaction.editReply({
      content,
      embeds: embed ? [embed] : [],
      ...(firstBatch.length > 0 ? { files: firstBatch } : {}),
    });

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

export let commands: BaseCommand[] = [new BotCommand()];

/** Rebuild the commands array with a fresh BotCommand (picks up current config name). */
export function rebuildCommands(): void {
  commands = [new BotCommand()];
}
