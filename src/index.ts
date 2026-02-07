import { config } from './utils/config';
import { httpServer } from './utils/httpServer';
import { logger } from './utils/logger';
import { discordManager } from './bot/discordManager';
import { comfyuiClient } from './api/comfyuiClient';

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

// ── Shutdown & crash handling ─────────────────────────────────────

let shutdownInProgress = false;

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  logger.log('success', 'system', `Shutting down (${reason})...`);

  try { comfyuiClient.close(); } catch (e) {
    logger.logError('system', `Error closing ComfyUI client: ${e}`);
  }
  try { await discordManager.destroy(); } catch (e) {
    logger.logError('system', `Error destroying Discord client: ${e}`);
  }
  try { await httpServer.stop(); } catch (e) {
    logger.logError('system', `Error stopping HTTP server: ${e}`);
  }

  process.exit(exitCode);
}

process.on('unhandledRejection', (reason) => {
  logger.logError('system', `Unhandled rejection: ${reason}`);
  shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (err) => {
  logger.logError('system', `Uncaught exception: ${err?.stack ?? err}`);
  shutdown('uncaughtException', 1);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
