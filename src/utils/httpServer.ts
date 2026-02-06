import express, { Express } from 'express';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';

class HttpServer {
  private app: Express;
  private port: number;

  constructor() {
    this.app = express();
    this.port = config.getHttpPort();
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
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
  }

  start(): void {
    this.app.listen(this.port, () => {
      logger.log('success', 'system', `HTTP server listening on http://localhost:${this.port}`);
      logger.log('success', 'system', `Serving outputs from: http://localhost:${this.port}/`);
    });
  }

  getApp(): Express {
    return this.app;
  }
}

export const httpServer = new HttpServer();
