import express, { Express, Request, Response, NextFunction } from 'express';
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

// ── Lightweight in-memory sliding-window rate limiter ────────────────

interface RateLimitEntry {
  timestamps: number[];
}

/**
 * Create an Express middleware that rate-limits requests by client IP.
 * Uses a simple sliding-window counter stored in a Map (no external deps).
 */
function createRateLimiter(windowMs: number, max: number) {
  const clients = new Map<string, RateLimitEntry>();

  // Periodically prune expired entries to prevent unbounded memory growth
  const pruneInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of clients) {
      entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);
      if (entry.timestamps.length === 0) clients.delete(ip);
    }
  }, windowMs);
  // Allow the Node process to exit even if the interval is still running
  if (pruneInterval.unref) pruneInterval.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let entry = clients.get(ip);
    if (!entry) {
      entry = { timestamps: [] };
      clients.set(ip, entry);
    }

    // Drop timestamps outside the current window
    entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);

    if (entry.timestamps.length >= max) {
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${Math.ceil(windowMs / 1000)} seconds.`,
      });
      return;
    }

    entry.timestamps.push(now);
    next();
  };
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

    // Explicitly disable trust proxy — this server intentionally binds on a
    // public interface but should never interpret forwarded headers.
    this.app.set('trust proxy', false);

    this.setupRoutes();
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
    const rateLimiter = createRateLimiter(
      config.getOutputsRateLimitWindowMs(),
      config.getOutputsRateLimitMax(),
    );

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
