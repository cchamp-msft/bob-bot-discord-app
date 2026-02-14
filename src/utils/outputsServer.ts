import express, { Express } from 'express';
import * as http from 'http';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';

/**
 * Dedicated HTTP server for serving generated output files (images, etc.).
 * Binds to a public interface (default 0.0.0.0:3003) so Discord can fetch
 * image attachments, while the configurator stays on localhost.
 */
class OutputsServer {
  private app: Express;
  private server: http.Server | null = null;

  constructor() {
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    const outputsDir = path.join(__dirname, '../../outputs');

    // Block access to logs directory
    this.app.use('/logs', (_req, res) => {
      res.status(403).json({ error: 'Forbidden' });
    });

    // Serve static files from outputs directory
    this.app.use(express.static(outputsDir));

    // Health check endpoint
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // 404 handler
    this.app.use((_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
  }

  start(): void {
    const host = config.getOutputsHost();
    const port = config.getOutputsPort();
    const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;

    this.server = this.app.listen(port, host, () => {
      logger.log('success', 'system', `OUTPUTS-SERVER: Listening on http://${displayHost}:${port}`);
    });
  }

  /**
   * Stop the outputs server gracefully.
   * Returns a promise that resolves when all connections are closed.
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        this.server = null;
        if (err) {
          reject(err);
        } else {
          logger.log('success', 'system', 'OUTPUTS-SERVER: Stopped');
          resolve();
        }
      });
    });
  }

  getApp(): Express {
    return this.app;
  }
}

export const outputsServer = new OutputsServer();
