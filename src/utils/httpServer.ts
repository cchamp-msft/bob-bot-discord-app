import express, { Express, Request, Response, NextFunction } from 'express';
import * as http from 'http';
import * as path from 'path';
import { config } from './config';
import { configWriter } from './configWriter';
import { logger } from './logger';
import { fileHandler } from './fileHandler';
import { apiManager } from '../api';
import { comfyuiClient } from '../api/comfyuiClient';
import { discordManager } from '../bot/discordManager';

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
  private server: http.Server | null = null;

  constructor() {
    this.app = express();
    this.port = config.getHttpPort();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    const outputsDir = path.join(__dirname, '../../outputs');
    const publicDir = path.resolve(__dirname, '../../src/public');

    // Parse JSON bodies for API routes (increased limit for workflow uploads)
    this.app.use(express.json({ limit: '10mb' }));

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

    // GET status log for the console panel (tails today's log file)
    this.app.get('/api/config/status', localhostOnly, (_req, res) => {
      res.json({ lines: logger.getRecentLines() });
    });

    // GET test API connectivity
    this.app.get('/api/config/test-connection/:api', localhostOnly, async (req, res) => {
      const api = req.params.api as 'comfyui' | 'ollama' | 'accuweather' | 'nfl';
      if (api !== 'comfyui' && api !== 'ollama' && api !== 'accuweather' && api !== 'nfl') {
        res.status(400).json({ error: 'Invalid API — must be "comfyui", "ollama", "accuweather", or "nfl"' });
        return;
      }

      try {
        if (api === 'ollama') {
          // Enhanced: return model list alongside health status
          const result = await apiManager.testOllamaConnection();
          const endpoint = config.getApiEndpoint(api);
          if (result.healthy) {
            logger.log('success', 'configurator', `Connection test: ollama at ${endpoint} — OK (${result.models.length} model(s) found)`);
          } else {
            logger.logError('configurator', `Connection test: ollama at ${endpoint} — FAILED${result.error ? ': ' + result.error : ''}`);
          }
          res.json({ api, endpoint, healthy: result.healthy, models: result.models, error: result.error });
        } else if (api === 'accuweather') {
          const result = await apiManager.testAccuWeatherConnection();
          const endpoint = config.getApiEndpoint(api);
          if (result.healthy) {
            const locationInfo = result.location
              ? ` (default location: ${result.location.LocalizedName}, ${result.location.AdministrativeArea.ID})`
              : '';
            logger.log('success', 'configurator', `Connection test: accuweather — OK${locationInfo}`);
          } else {
            logger.logError('configurator', `Connection test: accuweather — FAILED${result.error ? ': ' + result.error : ''}`);
          }
          res.json({ api, endpoint, healthy: result.healthy, location: result.location, error: result.error });
        } else if (api === 'nfl') {
          const result = await apiManager.checkNflHealth();
          const endpoint = config.getApiEndpoint('nfl');
          if (result.healthy) {
            logger.log('success', 'configurator', `Connection test: nfl — OK`);
          } else {
            logger.logError('configurator', `Connection test: nfl — FAILED${result.error ? ': ' + result.error : ''}`);
          }
          res.json({ api, endpoint, healthy: result.healthy, error: result.error });
        } else {
          const healthy = await apiManager.checkApiHealth(api);
          const endpoint = config.getApiEndpoint(api as 'comfyui' | 'ollama' | 'accuweather');
          const error = healthy ? undefined : 'ComfyUI did not respond with a healthy status';
          logger.log(healthy ? 'success' : 'error', 'configurator', `Connection test: ${api} at ${endpoint} — ${healthy ? 'OK' : 'FAILED'}`);
          res.json({ api, endpoint, healthy, error });
        }
      } catch (error) {
        const endpoint = config.getApiEndpoint(api);
        logger.logError('configurator', `Connection test: ${api} at ${endpoint} — ERROR: ${error}`);
        res.json({ api, endpoint, healthy: false, error: String(error) });
      }
    });

    // POST upload ComfyUI workflow JSON
    this.app.post('/api/config/upload-workflow', localhostOnly, async (req, res) => {
      try {
        const { workflow, filename } = req.body;

        if (!workflow || typeof workflow !== 'string') {
          logger.logError('configurator', 'Workflow upload FAILED: No workflow data provided');
          res.status(400).json({ success: false, error: 'Workflow JSON string is required' });
          return;
        }

        const safeName = filename || 'comfyui-workflow.json';

        const result = await configWriter.saveWorkflow(workflow, safeName);

        if (result.success) {
          const convertedNote = result.converted ? ' (auto-converted from UI format to API format)' : '';
          logger.log('success', 'configurator', `Workflow uploaded: ${safeName} — validation passed${convertedNote}`);
          res.json({ success: true, filename: safeName, converted: result.converted || false });
        } else {
          logger.logError('configurator', `Workflow upload FAILED: ${result.error}`);
          res.status(400).json({ success: false, error: result.error });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.logError('configurator', `Workflow upload ERROR: ${errorMsg}`);
        res.status(500).json({ success: false, error: errorMsg });
      }
    });

    // DELETE remove custom ComfyUI workflow (fall back to default)
    this.app.delete('/api/config/workflow', localhostOnly, (_req, res) => {
      try {
        const deleted = configWriter.deleteWorkflow();
        if (deleted) {
          logger.log('success', 'configurator', 'Custom workflow removed — will use default workflow');
          apiManager.refreshClients();
          res.json({ success: true, message: 'Custom workflow removed. Default workflow will be used.' });
        } else {
          res.json({ success: true, message: 'No custom workflow was configured.' });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.logError('configurator', `Workflow delete ERROR: ${errorMsg}`);
        res.status(500).json({ success: false, error: errorMsg });
      }
    });

    // GET available ComfyUI samplers
    this.app.get('/api/config/comfyui/samplers', localhostOnly, async (_req, res) => {
      try {
        const samplers = await comfyuiClient.getSamplers();
        res.json(samplers);
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // GET available ComfyUI schedulers
    this.app.get('/api/config/comfyui/schedulers', localhostOnly, async (_req, res) => {
      try {
        const schedulers = await comfyuiClient.getSchedulers();
        res.json(schedulers);
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // GET available ComfyUI checkpoints
    this.app.get('/api/config/comfyui/checkpoints', localhostOnly, async (_req, res) => {
      try {
        const checkpoints = await comfyuiClient.getCheckpoints();
        res.json(checkpoints);
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // POST save default workflow parameters
    this.app.post('/api/config/default-workflow', localhostOnly, async (req, res) => {
      try {
        const body = req.body;
        const errors: string[] = [];

        // Coerce fields that may arrive as strings (e.g. from non-UI callers)
        const model = typeof body.model === 'string' ? body.model.trim() : '';
        const width = Number(body.width);
        const height = Number(body.height);
        const steps = Number(body.steps);
        const cfg = Number(body.cfg);
        const sampler = typeof body.sampler === 'string' ? body.sampler.trim() : '';
        const scheduler = typeof body.scheduler === 'string' ? body.scheduler.trim() : '';
        const denoise = Number(body.denoise);

        if (!model) errors.push('model is required');
        if (isNaN(width) || width <= 0 || width % 8 !== 0) errors.push('width must be a positive multiple of 8');
        if (isNaN(height) || height <= 0 || height % 8 !== 0) errors.push('height must be a positive multiple of 8');
        if (isNaN(steps) || steps <= 0) errors.push('steps must be positive');
        if (isNaN(cfg) || cfg <= 0) errors.push('cfg must be positive');
        if (isNaN(denoise) || denoise < 0 || denoise > 1) errors.push('denoise must be between 0 and 1');

        if (errors.length > 0) {
          res.status(400).json({ success: false, errors });
          return;
        }

        const envUpdates: Record<string, string | number> = {};
        envUpdates.COMFYUI_DEFAULT_MODEL = model;
        envUpdates.COMFYUI_DEFAULT_WIDTH = width;
        envUpdates.COMFYUI_DEFAULT_HEIGHT = height;
        envUpdates.COMFYUI_DEFAULT_STEPS = steps;
        envUpdates.COMFYUI_DEFAULT_CFG = cfg;
        if (sampler) envUpdates.COMFYUI_DEFAULT_SAMPLER = sampler;
        if (scheduler) envUpdates.COMFYUI_DEFAULT_SCHEDULER = scheduler;
        envUpdates.COMFYUI_DEFAULT_DENOISE = denoise;

        await configWriter.updateEnv(envUpdates);
        config.reload();
        apiManager.refreshClients();

        logger.log('success', 'configurator', `Default workflow params saved: model=${model}, ${width}x${height}, steps=${steps}, cfg=${cfg}, sampler=${sampler}, scheduler=${scheduler}, denoise=${denoise}`);
        res.json({ success: true });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.logError('configurator', `Default workflow save ERROR: ${errorMsg}`);
        res.status(500).json({ success: false, error: errorMsg });
      }
    });

    // ── Discord control routes (localhost only) ──────────────────

    // GET Discord bot status
    this.app.get('/api/discord/status', localhostOnly, (_req, res) => {
      res.json(discordManager.getStatus());
    });

    // POST start the Discord bot
    this.app.post('/api/discord/start', localhostOnly, async (_req, res) => {
      logger.log('success', 'configurator', 'Discord bot start requested');
      const result = await discordManager.start();
      logger.log(result.success ? 'success' : 'error', 'configurator', `Discord start: ${result.message}`);
      res.json(result);
    });

    // POST stop the Discord bot
    this.app.post('/api/discord/stop', localhostOnly, async (_req, res) => {
      logger.log('success', 'configurator', 'Discord bot stop requested');
      const result = await discordManager.stop();
      logger.log(result.success ? 'success' : 'error', 'configurator', `Discord stop: ${result.message}`);
      res.json(result);
    });

    // POST test Discord token (does not persist or affect running bot)
    this.app.post('/api/discord/test', localhostOnly, async (req, res) => {
      const { token } = req.body;
      if (!token || typeof token !== 'string') {
        res.status(400).json({ success: false, message: 'Token is required' });
        return;
      }

      logger.log('success', 'configurator', 'Discord token test requested');
      const result = await discordManager.testToken(token);
      // Never log the actual token value
      logger.log(result.success ? 'success' : 'error', 'configurator', `Discord token test: ${result.success ? 'OK' : 'FAILED'} — ${result.message}`);
      res.json(result);
    });

    // POST save config changes
    this.app.post('/api/config/save', localhostOnly, async (req, res) => {
      try {
        const { env, keywords } = req.body;
        const messages: string[] = [];

        // Update .env values if provided
        if (env && typeof env === 'object') {
          // Build a safe list of key names for logging (never log token values)
          const sensitiveKeys = ['DISCORD_TOKEN', 'ACCUWEATHER_API_KEY'];
          const safeKeyNames = Object.keys(env).map(k =>
            sensitiveKeys.includes(k) ? `${k} (changed)` : k
          );

          await configWriter.updateEnv(env);
          messages.push(`Updated .env: ${safeKeyNames.join(', ')}`);
          logger.log('success', 'configurator', `Config saved — .env keys: ${safeKeyNames.join(', ')}`);
        }

        // Update keywords if provided
        if (keywords && Array.isArray(keywords)) {
          await configWriter.updateKeywords(keywords);
          messages.push(`Updated keywords.json: ${keywords.length} keyword(s)`);
          logger.log('success', 'configurator', `Config saved — ${keywords.length} keyword(s) written to keywords.json`);
        }

        // Hot-reload config
        const reloadResult = config.reload();

        // Rebuild API client axios instances if endpoints changed
        apiManager.refreshClients();

        logger.log('success', 'configurator', `Config reloaded — hot: [${reloadResult.reloaded.join(', ')}], restart needed: [${reloadResult.requiresRestart.join(', ') || 'none'}]`);

        if (reloadResult.requiresRestart.length > 0) {
          messages.push(`⚠ Restart required for: ${reloadResult.requiresRestart.join(', ')}`);
        }

        logger.log('success', 'configurator', `Config updated: ${messages.join('; ')}`);
        res.json({ success: true, messages, reloadResult });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.logError('configurator', `Config save failed: ${errorMsg}`);
        res.status(400).json({ success: false, error: errorMsg });
      }
    });

    // ── Test routes (localhost only) ─────────────────────────────

    // POST test image generation — submit a prompt to ComfyUI and return results
    this.app.post('/api/test/generate-image', localhostOnly, async (req, res) => {
      const { prompt } = req.body;

      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        res.status(400).json({ success: false, error: 'A non-empty prompt string is required' });
        return;
      }

      logger.log('success', 'configurator', `Test image generation started — prompt: "${prompt.substring(0, 80)}"`);

      try {
        const controller = new AbortController();
        const result = await comfyuiClient.generateImage(prompt.trim(), 'test', controller.signal);

        if (!result.success) {
          logger.logError('configurator', `Test image generation failed: ${result.error}`);
          res.json({ success: false, error: result.error });
          return;
        }

        // Download and save images to outputs/ with 'test' as requester
        const savedImages: Array<{ url: string; localUrl: string }> = [];
        const images = result.data?.images || [];

        for (const imageUrl of images) {
          const saved = await fileHandler.saveFromUrl('test', prompt, imageUrl, 'png');
          if (saved) {
            savedImages.push({ url: imageUrl, localUrl: saved.url });
          }
        }

        logger.log('success', 'configurator', `Test image generation completed — ${savedImages.length} image(s) saved`);
        res.json({
          success: true,
          images: savedImages.map(img => img.localUrl),
          comfyuiImages: images,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.logError('configurator', `Test image generation error: ${errorMsg}`);
        res.status(500).json({ success: false, error: errorMsg });
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
    this.server = this.app.listen(this.port, () => {
      logger.log('success', 'system', `HTTP-SERVER: Listening on http://localhost:${this.port}`);
      logger.log('success', 'system', `HTTP-SERVER: Configurator: http://localhost:${this.port}/configurator`);
    });
  }

  /**
   * Stop the HTTP server gracefully.
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
          logger.log('success', 'system', 'HTTP-SERVER: Stopped');
          resolve();
        }
      });
    });
  }

  getApp(): Express {
    return this.app;
  }
}

export const httpServer = new HttpServer();
