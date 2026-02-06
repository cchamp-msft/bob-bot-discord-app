import express, { Express } from 'express';
import * as path from 'path';
import { config } from './config';

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
      console.log(
        `HTTP server listening on http://localhost:${this.port}`
      );
      console.log(
        `Serving outputs from: http://localhost:${this.port}/`
      );
    });
  }

  getApp(): Express {
    return this.app;
  }
}

export const httpServer = new HttpServer();
