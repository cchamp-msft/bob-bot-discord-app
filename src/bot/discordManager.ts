import { Client, GatewayIntentBits, Events } from 'discord.js';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { messageHandler } from './messageHandler';
import { commandHandler } from '../commands';

export type BotStatus = 'stopped' | 'connecting' | 'running' | 'error';

interface DiscordStatus {
  status: BotStatus;
  username: string | null;
  error: string | null;
  tokenConfigured: boolean;
}

class DiscordManager {
  private client: Client | null = null;
  private status: BotStatus = 'stopped';
  private username: string | null = null;
  private lastError: string | null = null;

  /** Current bot connection status (safe for API exposure). */
  getStatus(): DiscordStatus {
    return {
      status: this.status,
      username: this.username,
      error: this.lastError,
      tokenConfigured: !!process.env.DISCORD_TOKEN,
    };
  }

  /**
   * Start the Discord bot. Resolves when login is initiated.
   * The 'ready' event sets status to 'running'.
   */
  async start(): Promise<{ success: boolean; message: string }> {
    if (this.status === 'running' || this.status === 'connecting') {
      return { success: false, message: `Bot is already ${this.status}` };
    }

    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      this.status = 'error';
      this.lastError = 'DISCORD_TOKEN not configured';
      return { success: false, message: 'DISCORD_TOKEN not configured — set it in the configurator and try again' };
    }

    this.status = 'connecting';
    this.lastError = null;

    try {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
      });

      this.client.once(Events.ClientReady, () => {
        this.status = 'running';
        this.username = this.client?.user?.tag || null;
        this.lastError = null;
        logger.log('success', 'system', `Bot logged in as ${this.username}`);
      });

      this.client.on('messageCreate', async (message) => {
        try {
          await messageHandler.handleMessage(message);
        } catch (error) {
          logger.logError('system', `Error handling message: ${error}`);
        }
      });

      this.client.on('interactionCreate', async (interaction) => {
        try {
          if (interaction.isChatInputCommand()) {
            await commandHandler.handleCommand(interaction);
          }
        } catch (error) {
          logger.logError('system', `Error handling interaction: ${error}`);
          if (interaction.isRepliable()) {
            try {
              if (interaction.replied || interaction.deferred) {
                await interaction.editReply({
                  content: '❌ An error occurred while processing your command.',
                });
              } else {
                await interaction.reply({
                  content: '❌ An error occurred while processing your command.',
                  ephemeral: true,
                });
              }
            } catch (err) {
              logger.logError('system', `Failed to send error reply: ${err}`);
            }
          }
        }
      });

      this.client.on('error', (error) => {
        logger.logError('system', `Discord client error: ${error}`);
        this.lastError = String(error);
      });

      this.client.on('disconnect', () => {
        this.status = 'stopped';
        this.username = null;
        logger.log('success', 'system', 'Discord client disconnected');
      });

      await this.client.login(token);

      return { success: true, message: 'Bot login initiated' };
    } catch (error) {
      this.status = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      this.client = null;
      logger.logError('system', `Failed to login: ${this.lastError}`);
      return { success: false, message: `Login failed: ${this.lastError}` };
    }
  }

  /** Stop the Discord bot gracefully. */
  async stop(): Promise<{ success: boolean; message: string }> {
    if (this.status === 'stopped') {
      return { success: false, message: 'Bot is already stopped' };
    }

    try {
      if (this.client) {
        await this.client.destroy();
        this.client = null;
      }
      this.status = 'stopped';
      this.username = null;
      this.lastError = null;
      logger.log('success', 'system', 'Bot stopped via configurator');
      return { success: true, message: 'Bot stopped' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.logError('system', `Error stopping bot: ${msg}`);
      return { success: false, message: `Error stopping: ${msg}` };
    }
  }

  /**
   * Test a Discord token without fully connecting.
   * Creates a throwaway client, logs in, then immediately destroys it.
   */
  async testToken(token: string): Promise<{ success: boolean; username: string | null; message: string }> {
    const testClient = new Client({
      intents: [GatewayIntentBits.Guilds],
    });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        testClient.destroy().catch(() => {});
        resolve({ success: false, username: null, message: 'Connection timed out (10s)' });
      }, 10000);

      testClient.once(Events.ClientReady, async () => {
        clearTimeout(timeout);
        const tag = testClient.user?.tag || null;
        await testClient.destroy();
        resolve({ success: true, username: tag, message: `Authenticated as ${tag}` });
      });

      testClient.login(token).catch((error) => {
        clearTimeout(timeout);
        testClient.destroy().catch(() => {});
        const msg = error instanceof Error ? error.message : String(error);
        resolve({ success: false, username: null, message: `Authentication failed: ${msg}` });
      });
    });
  }

  /** Destroy client for process shutdown. */
  async destroy(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
    this.status = 'stopped';
  }
}

export const discordManager = new DiscordManager();
