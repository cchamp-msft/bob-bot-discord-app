/**
 * Activity Key Manager — in-memory rotating key for activity monitor access.
 *
 * Provides a single global key that must be requested from Discord via the
 * `activity_key` reserved keyword. The key expires after a configurable TTL
 * (default 300 seconds). After expiry a new key must be requested — the old
 * key is silently invalidated.
 *
 * The key is never persisted to disk/env; it lives only in process memory.
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

class ActivityKeyManager {
  private activeKey: ActiveKey | null = null;

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
}

export const activityKeyManager = new ActivityKeyManager();
