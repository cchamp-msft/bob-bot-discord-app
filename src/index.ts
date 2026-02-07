import { config } from './utils/config';
import { httpServer } from './utils/httpServer';
import { logger } from './utils/logger';
import { discordManager } from './bot/discordManager';

// Start HTTP server immediately (configurator available without Discord)
httpServer.start();

// Auto-connect to Discord if token is configured
const token = process.env.DISCORD_TOKEN;
if (token) {
  discordManager.start().then((result) => {
    if (!result.success) {
      logger.logError('system', `Auto-start failed: ${result.message}`);
      logger.log('success', 'system', `Configurator available at http://localhost:${config.getHttpPort()}/configurator`);
    }
  });
} else {
  logger.log('success', 'system', 'DISCORD_TOKEN not set — bot will not connect to Discord.');
  logger.log('success', 'system', `Open the configurator to get started: http://localhost:${config.getHttpPort()}/configurator`);
}

process.on('unhandledRejection', (reason) => {
  logger.logError('system', `Unhandled rejection: ${reason}`);
});

process.on('SIGINT', async () => {
  logger.log('success', 'system', 'Shutting down (SIGINT)...');
  await discordManager.destroy();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.log('success', 'system', 'Shutting down (SIGTERM)...');
  await discordManager.destroy();
  process.exit(0);
});
