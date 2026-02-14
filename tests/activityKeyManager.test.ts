/**
 * ActivityKeyManager tests — exercises the in-memory rotating key lifecycle:
 * issue, validate, expire, revoke, and remaining-seconds calculation.
 */

jest.mock('../src/utils/config', () => ({
  config: {
    getActivityKeyTtl: jest.fn(() => 300), // 5 min default
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    log: jest.fn(),
  },
}));

import { activityKeyManager } from '../src/utils/activityKeyManager';
const { config } = require('../src/utils/config');

describe('ActivityKeyManager', () => {
  beforeEach(() => {
    activityKeyManager.revoke();
    jest.clearAllMocks();
    (config.getActivityKeyTtl as jest.Mock).mockReturnValue(300);
  });

  it('issueKey returns a non-empty URL-safe string', () => {
    const key = activityKeyManager.issueKey();
    expect(key).toBeTruthy();
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThanOrEqual(20);
    // base64url characters only
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('issueKey replaces the previous key', () => {
    const first = activityKeyManager.issueKey();
    const second = activityKeyManager.issueKey();
    expect(first).not.toBe(second);
    expect(activityKeyManager.isValid(first)).toBe(false);
    expect(activityKeyManager.isValid(second)).toBe(true);
  });

  it('isValid returns true for the current key within TTL', () => {
    const key = activityKeyManager.issueKey();
    expect(activityKeyManager.isValid(key)).toBe(true);
  });

  it('isValid returns false for an incorrect key', () => {
    activityKeyManager.issueKey();
    expect(activityKeyManager.isValid('wrong-key')).toBe(false);
  });

  it('isValid returns false when no key has been issued', () => {
    expect(activityKeyManager.isValid('anything')).toBe(false);
  });

  it('isExpired returns true when no key exists', () => {
    expect(activityKeyManager.isExpired()).toBe(true);
  });

  it('isExpired returns false immediately after issuing', () => {
    activityKeyManager.issueKey();
    expect(activityKeyManager.isExpired()).toBe(false);
  });

  it('isValid returns false after TTL expires', () => {
    // Set TTL to 1 second for this test
    (config.getActivityKeyTtl as jest.Mock).mockReturnValue(1);

    const key = activityKeyManager.issueKey();
    expect(activityKeyManager.isValid(key)).toBe(true);

    // Advance time past the 1-second TTL
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 1500);

    expect(activityKeyManager.isValid(key)).toBe(false);
    expect(activityKeyManager.isExpired()).toBe(true);

    (Date.now as jest.Mock).mockRestore();
  });

  it('remainingSeconds returns positive value within TTL', () => {
    activityKeyManager.issueKey();
    const remaining = activityKeyManager.remainingSeconds();
    // Should be close to 300 (TTL) since we just issued
    expect(remaining).toBeGreaterThan(295);
    expect(remaining).toBeLessThanOrEqual(300);
  });

  it('remainingSeconds returns 0 when no key exists', () => {
    expect(activityKeyManager.remainingSeconds()).toBe(0);
  });

  it('remainingSeconds returns 0 after expiry', () => {
    (config.getActivityKeyTtl as jest.Mock).mockReturnValue(1);
    activityKeyManager.issueKey();

    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 2000);

    expect(activityKeyManager.remainingSeconds()).toBe(0);

    (Date.now as jest.Mock).mockRestore();
  });

  it('revoke clears the active key', () => {
    const key = activityKeyManager.issueKey();
    expect(activityKeyManager.isValid(key)).toBe(true);
    activityKeyManager.revoke();
    expect(activityKeyManager.isValid(key)).toBe(false);
    expect(activityKeyManager.isExpired()).toBe(true);
  });
});
