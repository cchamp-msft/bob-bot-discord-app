import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { config } from './utils/config';
import { httpServer } from './utils/httpServer';
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
  console.log(`✅ Bot logged in as ${client.user?.tag}`);

  // Start HTTP server
  httpServer.start();
});

client.on('messageCreate', async (message) => {
  try {
    await messageHandler.handleMessage(message);
  } catch (error) {
    console.error('Error handling message:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await commandHandler.handleCommand(interaction);
    }
  } catch (error) {
    console.error('Error handling interaction:', error);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content: '❌ An error occurred while processing your command.',
          ephemeral: true,
        });
      } catch (err) {
        console.error('Failed to send error reply:', err);
      }
    }
  }
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

process.on('SIGINT', async () => {
  console.log('Shutting down bot...');
  await client.destroy();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down bot...');
  await client.destroy();
  process.exit(0);
});

// Login
client.login(config.getDiscordToken()).catch((error) => {
  console.error('Failed to login:', error);
  process.exit(1);
});
