import { ChatInputCommandInteraction } from 'discord.js';
import { commands, BaseCommand } from './commands';

class CommandHandler {
  private commandMap: Map<string, BaseCommand> = new Map();

  constructor() {
    for (const command of commands) {
      this.commandMap.set(command.data.name, command);
    }
  }

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const command = this.commandMap.get(interaction.commandName);

    if (!command) {
      await interaction.reply({
        content: 'Unknown command',
        ephemeral: true,
      });
      return;
    }

    await command.execute(interaction);
  }

  getCommands() {
    return commands;
  }
}

export const commandHandler = new CommandHandler();
