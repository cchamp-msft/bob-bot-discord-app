/**
 * Activity Key Manager — in-memory rotating key for activity monitor access.
 *
 * Provides a single global key that must be requested from Discord via the
 * `activity_key` reserved keyword. The key expires after a configurable TTL
 * (default 300 seconds). After expiry a new key must be requested — the old
 * key is silently invalidated.
 *
 * Once a key is successfully validated, a **session** can be created that
 * outlives the key. Sessions last until the configured max session time
 * (default 1 day) or until the page is fully refreshed. This decouples
 * initial authentication (short-lived key) from ongoing authorization
 * (long-lived session).
 *
 * The key and session are never persisted to disk/env; they live only in
 * process memory.
 */

import { randomBytes } from 'crypto';
import { config } from './config';
import { logger } from './logger';

/** Active key state. `null` means no key has been issued yet. */
interface ActiveKey {
  /** The key string presented to the user and validated on HTTP requests. */
  value: string;
  /** Unix-ms timestamp when this key was issued. */
  issuedAt: number;
}

/** Active session state. `null` means no session exists. */
interface ActiveSession {
  /** The session token sent to the client after initial key authentication. */
  token: string;
  /** Unix-ms timestamp when this session was created. */
  createdAt: number;
}

class ActivityKeyManager {
  private activeKey: ActiveKey | null = null;
  private activeSession: ActiveSession | null = null;

  /**
   * Issue a new activity key, replacing any existing one.
   * Returns the new key value (to be sent to the requester via DM).
   */
  issueKey(): string {
    const value = randomBytes(24).toString('base64url'); // 32-char URL-safe key
    this.activeKey = { value, issuedAt: Date.now() };
    logger.log('success', 'system', 'ACTIVITY-KEY: New key issued');
    return value;
  }

  /**
   * Validate a presented key against the current active key.
   * Returns `true` only when:
   *   1. A key has been issued.
   *   2. The presented value matches exactly.
   *   3. The key has not expired (TTL not exceeded).
   */
  isValid(presented: string): boolean {
    if (!this.activeKey) return false;
    if (presented !== this.activeKey.value) return false;
    return !this.isExpired();
  }

  /**
   * Whether the current key has exceeded its TTL.
   * Returns `true` when no key exists (nothing to validate against).
   */
  isExpired(): boolean {
    if (!this.activeKey) return true;
    const ttlMs = config.getActivityKeyTtl() * 1000;
    return Date.now() - this.activeKey.issuedAt >= ttlMs;
  }

  /**
   * Return the remaining seconds before the current key expires.
   * Returns 0 when there is no active key or it has already expired.
   */
  remainingSeconds(): number {
    if (!this.activeKey) return 0;
    const ttlMs = config.getActivityKeyTtl() * 1000;
    const elapsed = Date.now() - this.activeKey.issuedAt;
    const remaining = Math.max(0, ttlMs - elapsed);
    return Math.ceil(remaining / 1000);
  }

  /** Explicitly revoke the current key (useful for testing). */
  revoke(): void {
    this.activeKey = null;
  }

  // ── Session management ──────────────────────────────────────

  /**
   * Create a new session, replacing any existing one.
   * Returns the session token to send to the client.
   */
  createSession(): string {
    const token = randomBytes(32).toString('base64url'); // 43-char URL-safe token
    this.activeSession = { token, createdAt: Date.now() };
    logger.log('success', 'system', 'ACTIVITY-SESSION: New session created');
    return token;
  }

  /**
   * Validate a presented session token.
   * Returns `true` only when:
   *   1. A session exists.
   *   2. The presented token matches exactly.
   *   3. The session has not exceeded the max session time.
   */
  isSessionValid(presented: string): boolean {
    if (!this.activeSession) return false;
    if (presented !== this.activeSession.token) return false;
    return !this.isSessionExpired();
  }

  /**
   * Whether the current session has exceeded its max time.
   * Returns `true` when no session exists.
   */
  isSessionExpired(): boolean {
    if (!this.activeSession) return true;
    const maxTimeMs = config.getActivitySessionMaxTime() * 1000;
    return Date.now() - this.activeSession.createdAt >= maxTimeMs;
  }

  /**
   * Return the remaining seconds before the current session expires.
   * Returns 0 when there is no active session or it has already expired.
   */
  sessionRemainingSeconds(): number {
    if (!this.activeSession) return 0;
    const maxTimeMs = config.getActivitySessionMaxTime() * 1000;
    const elapsed = Date.now() - this.activeSession.createdAt;
    const remaining = Math.max(0, maxTimeMs - elapsed);
    return Math.ceil(remaining / 1000);
  }

  /** Explicitly revoke the current session (useful for testing). */
  revokeSession(): void {
    this.activeSession = null;
  }
}

export const activityKeyManager = new ActivityKeyManager();
