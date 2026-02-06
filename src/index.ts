import { Client, GatewayIntentBits } from 'discord.js';
import { config } from './utils/config';
import { httpServer } from './utils/httpServer';
import { logger } from './utils/logger';
import { messageHandler } from './bot/messageHandler';
import { commandHandler } from './commands';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  logger.log('success', 'system', `Bot logged in as ${client.user?.tag}`);

  // Start HTTP server
  httpServer.start();
});

client.on('messageCreate', async (message) => {
  try {
    await messageHandler.handleMessage(message);
  } catch (error) {
    logger.logError('system', `Error handling message: ${error}`);
  }
});

client.on('interactionCreate', async (interaction) => {
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

client.on('error', (error) => {
  logger.logError('system', `Discord client error: ${error}`);
});

process.on('unhandledRejection', (reason) => {
  logger.logError('system', `Unhandled rejection: ${reason}`);
});

process.on('SIGINT', async () => {
  logger.log('success', 'system', 'Shutting down bot (SIGINT)...');
  await client.destroy();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.log('success', 'system', 'Shutting down bot (SIGTERM)...');
  await client.destroy();
  process.exit(0);
});

// Login
client.login(config.getDiscordToken()).catch((error) => {
  logger.logError('system', `Failed to login: ${error}`);
  process.exit(1);
});
