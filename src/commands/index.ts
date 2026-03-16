import { ChatInputCommandInteraction } from 'discord.js';
import { commands, rebuildCommands } from './commands';

class CommandHandler {
  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    // Single command — always dispatch to it regardless of interaction.commandName
    // (future-proofs against name changes via config)
    const command = commands[0];

    if (!command) {
      await interaction.reply({
        content: 'Unknown command',
        ephemeral: true,
      });
      return;
    }

    await command.execute(interaction);
  }

  /** Rebuild the internal command with the current config name. */
  rebuild(): void {
    rebuildCommands();
  }

  getCommands() {
    return commands;
  }
}

export const commandHandler = new CommandHandler();
