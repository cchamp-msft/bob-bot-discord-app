import express, { Express, Request, Response, NextFunction } from 'express';
import * as path from 'path';
import { config } from './config';
import { configWriter } from './configWriter';
import { logger } from './logger';
import { apiManager } from '../api';

/** Status messages for the configurator console panel */
const statusLog: string[] = [];
const MAX_STATUS_LINES = 200;

function pushStatus(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  statusLog.push(line);
  if (statusLog.length > MAX_STATUS_LINES) {
    statusLog.splice(0, statusLog.length - MAX_STATUS_LINES);
  }
}

/**
 * Middleware that restricts access to localhost only.
 * Blocks any request not originating from 127.0.0.1 or ::1.
 */
function localhostOnly(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || '';
  const isLocal =
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1';

  if (!isLocal) {
    res.status(403).json({ error: 'Forbidden — configurator is localhost only' });
    return;
  }
  next();
}

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
    const publicDir = path.resolve(__dirname, '../../src/public');

    // Parse JSON bodies for API routes
    this.app.use(express.json());

    // ── Configurator routes (localhost only) ──────────────────────

    // Serve the configurator SPA
    this.app.get('/configurator', localhostOnly, (_req, res) => {
      res.sendFile(path.join(publicDir, 'configurator.html'));
    });

    // GET current config (safe view — no secrets)
    this.app.get('/api/config', localhostOnly, (_req, res) => {
      try {
        res.json(config.getPublicConfig());
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // GET status log for the console panel
    this.app.get('/api/config/status', localhostOnly, (_req, res) => {
      res.json({ lines: statusLog });
    });

    // GET test API connectivity
    this.app.get('/api/config/test-connection/:api', localhostOnly, async (req, res) => {
      const api = req.params.api as 'comfyui' | 'ollama';
      if (api !== 'comfyui' && api !== 'ollama') {
        res.status(400).json({ error: 'Invalid API — must be "comfyui" or "ollama"' });
        return;
      }

      try {
        const healthy = await apiManager.checkApiHealth(api);
        const endpoint = config.getApiEndpoint(api);
        pushStatus(`Connection test: ${api} at ${endpoint} — ${healthy ? 'OK' : 'FAILED'}`);
        res.json({ api, endpoint, healthy });
      } catch (error) {
        const endpoint = config.getApiEndpoint(api);
        pushStatus(`Connection test: ${api} at ${endpoint} — ERROR: ${error}`);
        res.json({ api, endpoint, healthy: false, error: String(error) });
      }
    });

    // POST save config changes
    this.app.post('/api/config/save', localhostOnly, async (req, res) => {
      try {
        const { env, keywords } = req.body;
        const messages: string[] = [];

        // Update .env values if provided
        if (env && typeof env === 'object') {
          await configWriter.updateEnv(env);
          messages.push(`Updated .env: ${Object.keys(env).join(', ')}`);
          pushStatus(`Config saved — .env keys: ${Object.keys(env).join(', ')}`);
        }

        // Update keywords if provided
        if (keywords && Array.isArray(keywords)) {
          await configWriter.updateKeywords(keywords);
          messages.push(`Updated keywords.json: ${keywords.length} keyword(s)`);
          pushStatus(`Config saved — ${keywords.length} keyword(s) written to keywords.json`);
        }

        // Hot-reload config
        const reloadResult = config.reload();
        pushStatus(`Config reloaded — hot: [${reloadResult.reloaded.join(', ')}], restart needed: [${reloadResult.requiresRestart.join(', ') || 'none'}]`);

        if (reloadResult.requiresRestart.length > 0) {
          messages.push(`⚠ Restart required for: ${reloadResult.requiresRestart.join(', ')}`);
        }

        logger.log('success', 'configurator', `Config updated: ${messages.join('; ')}`);
        res.json({ success: true, messages, reloadResult });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        pushStatus(`Config save FAILED: ${errorMsg}`);
        logger.logError('configurator', `Config save failed: ${errorMsg}`);
        res.status(400).json({ success: false, error: errorMsg });
      }
    });

    // ── Output file routes ───────────────────────────────────────

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
    this.app.listen(this.port, () => {
      logger.log('success', 'system', `HTTP server listening on http://localhost:${this.port}`);
      logger.log('success', 'system', `Configurator: http://localhost:${this.port}/configurator`);
      pushStatus('HTTP server started');
      pushStatus(`Configurator available at http://localhost:${this.port}/configurator`);
    });
  }

  getApp(): Express {
    return this.app;
  }
}

export const httpServer = new HttpServer();
