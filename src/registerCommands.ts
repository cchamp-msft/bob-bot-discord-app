import { REST, Routes } from 'discord.js';
import { config } from './utils/config';
import { rebuildCommands, commands } from './commands/commands';
import { logger } from './utils/logger';

export async function registerSlashCommands(): Promise<{ success: boolean; message: string; commandName?: string }> {
  const token = config.getDiscordToken();
  if (!token) {
    return { success: false, message: 'DISCORD_TOKEN not set — cannot register commands' };
  }
  const clientId = config.getClientId();
  if (!clientId) {
    return { success: false, message: 'DISCORD_CLIENT_ID not set — cannot register commands' };
  }

  // Rebuild commands to ensure the name reflects the current config
  rebuildCommands();

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    const commandData = commands.map((cmd) => cmd.data.toJSON());

    // PUT replaces ALL registered commands — old commands are automatically deregistered
    await rest.put(Routes.applicationCommands(clientId), {
      body: commandData,
    });

    const commandName = commandData[0]?.name || config.getSlashCommandName();
    const message = `Successfully registered /${commandName} command`;

    logger.log('success', 'system', message);
    return { success: true, message, commandName };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.logError('system', `Error registering commands: ${errorMsg}`);
    return { success: false, message: `Registration failed: ${errorMsg}` };
  }
}

// Script-mode execution for `npm run register`
if (require.main === module) {
  registerSlashCommands()
    .then((result) => {
      console.log(result.message);
      if (!result.success) process.exit(1);
    })
    .catch((error) => {
      console.error('Error registering commands:', error);
      process.exit(1);
    });
}
