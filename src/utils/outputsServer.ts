import express, { Express, Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';
import { activityEvents } from './activityEvents';
import { activityKeyManager } from './activityKeyManager';

/**
 * Remove fingerprint headers and add minimal security headers.
 */
function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

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

    // Trust-proxy remains disabled by default. Enable only when running behind
    // a trusted reverse proxy and you need client-IP-aware rate limiting.
    const trustProxy = config.getOutputsTrustProxy();
    this.app.set('trust proxy', trustProxy);

    this.setupRoutes();

    // Log trust-proxy setting at construction time so operators can confirm
    // the proxy configuration matches their deployment.
    const proxyLabel = trustProxy === false ? 'disabled'
      : trustProxy === true ? 'all proxies'
      : `${trustProxy} hop(s)`;
    logger.logDebug('system', `OUTPUTS-SERVER: trust proxy = ${proxyLabel}`);
  }

  private setupRoutes(): void {
    const outputsDir = path.join(__dirname, '../../outputs');

    // ── Global middleware ─────────────────────────────────────────
    this.app.use(securityHeaders);

    // Health check endpoint (registered before static/404 so it always responds)
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Block access to logs directory
    this.app.use('/logs', (_req, res) => {
      res.status(403).json({ error: 'Forbidden' });
    });

    // ── Rate limiter for filesystem-serving routes ──────────────────
    // Uses express-rate-limit (recognised by CodeQL js/missing-rate-limiting).
    const rateLimiter = rateLimit({
      windowMs: config.getOutputsRateLimitWindowMs(),
      max: config.getOutputsRateLimitMax(),
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too Many Requests', message: 'Rate limit exceeded. Please try again later.' },
      // Explicit key generator — when trust proxy is enabled, req.ip is the
      // real client IP (from X-Forwarded-For); when disabled, req.ip is the
      // proxy/direct-connect IP.  ipKeyGenerator normalises IPv6 subnets to
      // prevent per-address bypass.
      keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown'),
    });

    // ── Activity feed (key-protected) ───────────────────────────────
    // Serve the activity timeline page
    // Resolve to src/public (same pattern as httpServer's configurator.html)
    // so the path works both in ts-node (dev) and compiled dist/ (production).
    const publicDir = path.resolve(__dirname, '../../src/public');
    this.app.get('/activity', rateLimiter, (req, res) => {
      // Allow the HTML page through — it will prompt for the key client-side
      res.sendFile(path.join(publicDir, 'activity.html'));
    });

    // Privacy policy API — returns raw markdown content for the overlay
    const privacyPolicyPath = path.resolve(__dirname, '../../PRIVACY_POLICY.md');
    this.app.get('/api/privacy-policy', rateLimiter, (_req, res) => {
      fs.readFile(privacyPolicyPath, 'utf-8', (err, data) => {
        if (err) {
          res.status(500).json({ error: 'Could not read privacy policy' });
          return;
        }
        res.type('text/plain').send(data);
      });
    });

    // Activity events API — requires a valid session token or activity key.
    // Authentication flow:
    //   1. Check for an existing session token (long-lived, survives key rotation).
    //   2. If no session, check for a raw activity key (short-lived, used once to
    //      bootstrap a session).
    //   3. On successful key auth, create a session and return the token in the
    //      response so the client can switch to session-based auth.
    this.app.get('/api/activity', (req, res) => {
      // ── Try session token first ──
      const sessionToken = typeof req.query.session === 'string'
        ? req.query.session
        : req.headers['x-activity-session'] as string | undefined;

      let authenticated = false;
      let newSessionToken: string | undefined;

      if (sessionToken && activityKeyManager.isSessionValid(sessionToken)) {
        authenticated = true;
      } else {
        // ── Fall back to raw activity key ──
        const key = typeof req.query.key === 'string'
          ? req.query.key
          : req.headers['x-activity-key'] as string | undefined;

        if (key && activityKeyManager.isValid(key)) {
          authenticated = true;
          // Bootstrap a new session so subsequent polls don't need the key
          newSessionToken = activityKeyManager.createSession();
        }
      }

      if (!authenticated) {
        logger.logDebug('outputs-server', `Activity auth failed — ip=${req.ip}, forwarded-for=${req.headers['x-forwarded-for'] ?? 'none'}`);
        res.status(401).json({
          error: 'Unauthorized',
          message: 'A valid activity key is required. Send "activity_key" to the bot in Discord to get one.',
        });
        return;
      }

      const since = typeof req.query.since === 'string' ? req.query.since : undefined;
      const countParam = typeof req.query.count === 'string' ? parseInt(req.query.count, 10) : undefined;
      const count = countParam && Number.isFinite(countParam) && countParam > 0 ? Math.min(countParam, 100) : 50;

      const events = activityEvents.getRecent(count, since);
      const payload: Record<string, unknown> = { events, serverTime: new Date().toISOString() };
      if (newSessionToken) {
        payload.sessionToken = newSessionToken;
      }
      res.json(payload);
    });

    // Serve static files from outputs directory
    this.app.use(express.static(outputsDir));

    // 404 handler
    this.app.use((_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    // Global error handler — ensures every request gets a JSON response even
    // when an unexpected error occurs.  Without this, Express may drop the
    // connection, causing a reverse proxy (e.g. Nginx) to return 502.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    this.app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
      logger.logError('outputs-server', `Unhandled error on ${req.method} ${req.path}: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error' });
      }
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
