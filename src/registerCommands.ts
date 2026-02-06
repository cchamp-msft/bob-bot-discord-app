import { REST, Routes } from 'discord.js';
import { config } from './utils/config';
import { commands } from './commands/commands';

const rest = new REST({ version: '10' }).setToken(config.getDiscordToken());

async function registerCommands(): Promise<void> {
  try {
    console.log('Started refreshing application (/) commands...');

    const commandData = commands.map((cmd) => cmd.data.toJSON());

    await rest.put(Routes.applicationCommands(config.getClientId()), {
      body: commandData,
    });

    console.log('Successfully registered application (/) commands:');
    commandData.forEach((cmd) => {
      console.log(`  /${cmd.name} - ${cmd.description}`);
    });
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

registerCommands();
