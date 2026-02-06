import { REST, Routes } from 'discord.js';
import { config } from './utils/config';
import { commands } from './commands/commands';
import { logger } from './utils/logger';

const token = config.getDiscordToken();
if (!token) {
  console.error('DISCORD_TOKEN not set in .env — cannot register commands');
  process.exit(1);
}
const clientId = config.getClientId();
if (!clientId) {
  console.error('DISCORD_CLIENT_ID not set in .env — cannot register commands');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

async function registerCommands(): Promise<void> {
  try {
    console.log('Started refreshing application (/) commands...');

    const commandData = commands.map((cmd) => cmd.data.toJSON());

    await rest.put(Routes.applicationCommands(clientId), {
      body: commandData,
    });

    console.log('Successfully registered application (/) commands:');
    commandData.forEach((cmd) => {
      console.log(`  /${cmd.name} - ${cmd.description}`);
    });
  } catch (error) {
    logger.logError('system', `Error registering commands: ${error}`);
    process.exit(1);
  }
}

registerCommands();
