import express, { Express, Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import * as http from 'http';
import * as path from 'path';
import { config } from './config';
import { configWriter } from './configWriter';
import { logger } from './logger';
import { fileHandler } from './fileHandler';
import { apiManager } from '../api';
import { comfyuiClient } from '../api/comfyuiClient';
import { discordManager } from '../bot/discordManager';

// ── Security middleware ──────────────────────────────────────────

/** Check if an IPv4 address (dot-decimal or ::ffff:...) is inside a CIDR. Exported for tests. */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const normalized = ip.replace(/^::ffff:/i, '');
  const parts = normalized.split('.');
  if (parts.length !== 4) return false;
  let ipNum = 0;
  for (let i = 0; i < 4; i++) {
    const n = parseInt(parts[i], 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) return false;
    ipNum = (ipNum << 8) | n;
  }
  const slash = cidr.indexOf('/');
  if (slash === -1) {
    const cidrParts = cidr.split('.');
    if (cidrParts.length !== 4) return false;
    let cidrNum = 0;
    for (let i = 0; i < 4; i++) {
      const n = parseInt(cidrParts[i], 10);
      if (!Number.isFinite(n) || n < 0 || n > 255) return false;
      cidrNum = (cidrNum << 8) | n;
    }
    return ipNum === cidrNum;
  }
  const base = cidr.slice(0, slash).trim();
  const prefixLen = parseInt(cidr.slice(slash + 1), 10);
  if (!Number.isFinite(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;
  const baseParts = base.split('.');
  if (baseParts.length !== 4) return false;
  let baseNum = 0;
  for (let i = 0; i < 4; i++) {
    const n = parseInt(baseParts[i], 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) return false;
    baseNum = (baseNum << 8) | n;
  }
  const mask = prefixLen === 0 ? 0 : 0xffffffff << (32 - prefixLen);
  return (ipNum & mask) === (baseNum & mask);
}

/** Check if IP is localhost (any common form). */
function isLocalhost(ip: string): boolean {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1'
  );
}

/**
 * Returns true if the request IP is allowed by the configurator allowlist.
 * When CONFIGURATOR_ALLOW_REMOTE is false, only localhost is allowed.
 * When true, localhost plus CONFIGURATOR_ALLOWED_IPS entries are allowed.
 */
function isIpAllowedByConfig(ip: string): boolean {
  if (isLocalhost(ip)) return true;
  if (!config.getConfiguratorAllowRemote()) return false;
  const allowed = config.getConfiguratorAllowedIps();
  for (const entry of allowed) {
    if (entry.includes('.') && (entry.includes('/') || entry.split('.').length === 4)) {
      if (ipv4InCidr(ip, entry)) return true;
    } else if (ip === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Middleware that restricts access to localhost only (legacy mode).
 * Rejects forwarded-header spoofing: when Express `trust proxy` is disabled
 * (the default) `req.ip` equals `req.socket.remoteAddress`, so upstream
 * `X-Forwarded-For` headers cannot trick the check.
 */
function localhostOnly(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || '';
  if (!isLocalhost(ip)) {
    logger.logWarn('http', `Blocked non-local request to ${req.path} from ${ip}`);
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

/**
 * Middleware that allows access when IP is in the configurator allowlist
 * (localhost or CONFIGURATOR_ALLOWED_IPS when CONFIGURATOR_ALLOW_REMOTE is true).
 */
function allowlistOnly(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || '';
  if (!isIpAllowedByConfig(ip)) {
    logger.logWarn('http', `Blocked non-allowed request to ${req.path} from ${ip}`);
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

/**
 * Network guard for configurator: localhost-only when CONFIGURATOR_ALLOW_REMOTE
 * is false, otherwise allowlist-based (for Docker/host browser access).
 */
function networkGuard(req: Request, res: Response, next: NextFunction): void {
  if (config.getConfiguratorAllowRemote()) {
    allowlistOnly(req, res, next);
  } else {
    localhostOnly(req, res, next);
  }
}

/**
 * Middleware that enforces bearer-token authentication when ADMIN_TOKEN is
 * configured. It is applied **before** the network guard so that proxied
 * environments get a strong authn check even if the IP check passes.
 *
 * When ADMIN_TOKEN is unset (empty) the middleware is a no-op, preserving
 * backward-compatible localhost-only behaviour.
 *
 * Uses constant-time comparison to prevent timing-based token leakage.
 */
function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = config.getAdminToken();
  if (!expected) {
    next();
    return;
  }

  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(\S+)$/i);
  const provided = match ? match[1] : '';

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  const lengthMatch = expectedBuf.length === providedBuf.length;
  const timingSafe = lengthMatch
    ? crypto.timingSafeEqual(expectedBuf, providedBuf)
    : false;

  if (!timingSafe) {
    logger.logWarn('http', `Unauthorized admin request to ${req.path} from ${req.ip}`);
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

/**
 * Guard for the configurator HTML page: network only (no Bearer required so
 * the browser can load the page; when CONFIGURATOR_ALLOW_REMOTE is true,
 * ADMIN_TOKEN is required for API calls and entered in the UI).
 */
const configuratorPageGuard = [networkGuard];

/**
 * Guard for configurator API routes: token auth then network check.
 * APIs always require Bearer when ADMIN_TOKEN is set.
 */
const configuratorApiGuard = [adminAuth, networkGuard];

/**
 * Remove common server fingerprint headers and add minimal security
 * headers. Applied once as app-level middleware.
 */
function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.removeHeader('X-Powered-By');
  // Prevent MIME-type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

/**
 * Wrap an async route handler so that unhandled rejections are caught and
 * returned as a generic 500 — internal details are logged, not exposed.
 */
function safeHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, _next: NextFunction) => void {
  return (req, res, _next) => {
    fn(req, res).catch((err) => {
      logger.logError('http', `Unhandled error on ${req.method} ${req.path}: ${err}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
      // Do NOT call next(err) — the error is logged and responded to.
      // Propagating it to Express 5's default handler would destroy the
      // underlying socket and break keep-alive / future connections.
    });
  };
}

class HttpServer {
  private app: Express;
  private port: number;
  private server: http.Server | null = null;

  constructor() {
    this.app = express();
    this.port = config.getHttpPort();

    // Explicitly disable trust proxy — req.ip must always be the direct
    // socket address so the localhostOnly guard cannot be bypassed via
    // spoofed X-Forwarded-For headers.
    this.app.set('trust proxy', false);

    this.setupRoutes();
  }

  private setupRoutes(): void {
    const publicDir = path.resolve(__dirname, '../../src/public');

    // ── Global middleware ─────────────────────────────────────────
    this.app.use(securityHeaders);

    // Parse JSON bodies for API routes (increased limit for workflow uploads)
    this.app.use(express.json({ limit: '10mb' }));

    // ── Configurator routes ───────────────────────────────────────

    // Serve the configurator SPA (network guard only; no Bearer so browser can load)
    this.app.get('/configurator', ...configuratorPageGuard, (_req, res) => {
      res.sendFile(path.join(publicDir, 'configurator.html'));
    });

    // GET current config (safe view — no secrets)
    this.app.get('/api/config', ...configuratorApiGuard, safeHandler(async (_req, res) => {
      res.json(config.getPublicConfig());
    }));

    // GET status log for the console panel (tails today's log file)
    this.app.get('/api/config/status', ...configuratorApiGuard, (_req, res) => {
      res.json({ lines: logger.getRecentLines() });
    });

    // GET test API connectivity
    this.app.get('/api/config/test-connection/:api', ...configuratorApiGuard, safeHandler(async (req, res) => {
      const api = req.params.api as 'comfyui' | 'ollama' | 'accuweather' | 'nfl' | 'serpapi';
      if (api !== 'comfyui' && api !== 'ollama' && api !== 'accuweather' && api !== 'nfl' && api !== 'serpapi') {
        res.status(400).json({ error: 'Invalid API — must be "comfyui", "ollama", "accuweather", "nfl", or "serpapi"' });
        return;
      }

      try {
        if (api === 'ollama') {
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
        } else if (api === 'serpapi') {
          const result = await apiManager.testSerpApiConnection();
          const endpoint = config.getApiEndpoint('serpapi');
          if (result.healthy) {
            logger.log('success', 'configurator', `Connection test: serpapi — OK`);
          } else {
            logger.logError('configurator', `Connection test: serpapi — FAILED${result.error ? ': ' + result.error : ''}`);
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
        res.json({ api, endpoint, healthy: false, error: 'Connection test failed' });
      }
    }));

    // POST upload ComfyUI workflow JSON
    this.app.post('/api/config/upload-workflow', ...configuratorApiGuard, safeHandler(async (req, res) => {
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
    }));

    // DELETE remove custom ComfyUI workflow (fall back to default)
    this.app.delete('/api/config/workflow', ...configuratorApiGuard, safeHandler(async (_req, res) => {
      const deleted = configWriter.deleteWorkflow();
      if (deleted) {
        logger.log('success', 'configurator', 'Custom workflow removed — will use default workflow');
        apiManager.refreshClients();
        res.json({ success: true, message: 'Custom workflow removed. Default workflow will be used.' });
      } else {
        res.json({ success: true, message: 'No custom workflow was configured.' });
      }
    }));

    // GET available ComfyUI samplers
    this.app.get('/api/config/comfyui/samplers', ...configuratorApiGuard, safeHandler(async (_req, res) => {
      const samplers = await comfyuiClient.getSamplers();
      res.json(samplers);
    }));

    // GET available ComfyUI schedulers
    this.app.get('/api/config/comfyui/schedulers', ...configuratorApiGuard, safeHandler(async (_req, res) => {
      const schedulers = await comfyuiClient.getSchedulers();
      res.json(schedulers);
    }));

    // GET available ComfyUI checkpoints
    this.app.get('/api/config/comfyui/checkpoints', ...configuratorApiGuard, safeHandler(async (_req, res) => {
      const checkpoints = await comfyuiClient.getCheckpoints();
      res.json(checkpoints);
    }));

    // GET export currently active workflow as ComfyUI API format JSON
    this.app.get('/api/config/workflow/export', ...configuratorApiGuard, safeHandler(async (_req, res) => {
      const result = await comfyuiClient.getExportWorkflow();
      if (!result) {
        res.status(400).json({
          success: false,
          error: 'No workflow configured. Upload a custom workflow or configure default workflow settings first.',
        });
        return;
      }
      logger.log('success', 'configurator', `Workflow exported (source: ${result.source})`);
      res.json({ success: true, workflow: result.workflow, source: result.source, params: result.params });
    }));

    // POST save default workflow parameters
    this.app.post('/api/config/default-workflow', ...configuratorApiGuard, safeHandler(async (req, res) => {
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
    }));

    // ── Discord control routes (admin-guarded) ──────────────────

    // GET Discord bot status
    this.app.get('/api/discord/status', ...configuratorApiGuard, (_req, res) => {
      res.json(discordManager.getStatus());
    });

    // POST start the Discord bot
    this.app.post('/api/discord/start', ...configuratorApiGuard, safeHandler(async (_req, res) => {
      logger.log('success', 'configurator', 'Discord bot start requested');
      const result = await discordManager.start();
      logger.log(result.success ? 'success' : 'error', 'configurator', `Discord start: ${result.message}`);
      res.json(result);
    }));

    // POST stop the Discord bot
    this.app.post('/api/discord/stop', ...configuratorApiGuard, safeHandler(async (_req, res) => {
      logger.log('success', 'configurator', 'Discord bot stop requested');
      const result = await discordManager.stop();
      logger.log(result.success ? 'success' : 'error', 'configurator', `Discord stop: ${result.message}`);
      res.json(result);
    }));

    // POST test Discord token (does not persist or affect running bot)
    this.app.post('/api/discord/test', ...configuratorApiGuard, safeHandler(async (req, res) => {
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
    }));

    // POST save config changes
    this.app.post('/api/config/save', ...configuratorApiGuard, safeHandler(async (req, res) => {
      const { env, keywords } = req.body;
        const messages: string[] = [];

        // Update .env values if provided
        if (env && typeof env === 'object') {
          // Build a safe list of key names for logging (never log token values)
          const sensitiveKeys = ['DISCORD_TOKEN', 'ACCUWEATHER_API_KEY', 'SERPAPI_API_KEY'];
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
          messages.push(`Updated keywords config: ${keywords.length} keyword(s)`);
          logger.log('success', 'configurator', `Config saved — ${keywords.length} keyword(s) written to keywords config`);
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
    }));

    // ── Test routes (admin-guarded) ──────────────────────────────

    // POST test image generation — submit a prompt to ComfyUI and return results
    this.app.post('/api/test/generate-image', ...configuratorApiGuard, safeHandler(async (req, res) => {
      const { prompt } = req.body;

      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        res.status(400).json({ success: false, error: 'A non-empty prompt string is required' });
        return;
      }

      logger.log('success', 'configurator', `Test image generation started — prompt: "${prompt.substring(0, 80)}"`);

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
    }));

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
    if (config.getConfiguratorAllowRemote() && !config.getAdminToken()) {
      const msg = 'CONFIGURATOR_ALLOW_REMOTE is true but ADMIN_TOKEN is not set — set ADMIN_TOKEN when allowing remote configurator access (e.g. Docker).';
      logger.logError('system', msg);
      throw new Error(msg);
    }

    const host = config.getHttpHost();
    const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    const guardMode = config.getConfiguratorAllowRemote() ? 'allowlist' : 'localhost-only';

    this.server = this.app.listen(this.port, host, () => {
      logger.log('success', 'system', `HTTP-SERVER: Configurator (${guardMode}) on http://${displayHost}:${this.port}`);
      logger.log('success', 'system', `HTTP-SERVER: Configurator: http://${displayHost}:${this.port}/configurator`);
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
