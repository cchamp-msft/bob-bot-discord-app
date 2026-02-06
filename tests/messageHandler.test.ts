/**
 * MessageHandler error rate-limit tests — exercises the canSendErrorMessage
 * logic that throttles user-facing error messages in Discord.
 *
 * We test the rate-limit behavior by extracting it into a testable pattern:
 * instantiate a fresh MessageHandler and poke the private method via
 * property access (acceptable in test code).
 */

jest.mock('discord.js', () => ({
  EmbedBuilder: jest.fn().mockImplementation(() => ({
    setColor: jest.fn().mockReturnThis(),
    setTitle: jest.fn().mockReturnThis(),
    setDescription: jest.fn().mockReturnThis(),
    setTimestamp: jest.fn().mockReturnThis(),
    addFields: jest.fn().mockReturnThis(),
  })),
  ChannelType: { GuildText: 0, GuildAnnouncement: 1 },
}));

jest.mock('../src/utils/config', () => ({
  config: {
    getErrorRateLimitMinutes: jest.fn(() => 1), // 1 minute for test speed
    getErrorMessage: jest.fn(() => 'Test error message'),
    getKeywords: jest.fn(() => []),
    getKeywordConfig: jest.fn(),
    getDefaultTimeout: jest.fn(() => 300),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
    log: jest.fn(),
  },
}));

jest.mock('../src/utils/requestQueue', () => ({
  requestQueue: { execute: jest.fn() },
}));

jest.mock('../src/api', () => ({
  apiManager: { executeRequest: jest.fn() },
}));

jest.mock('../src/utils/fileHandler', () => ({
  fileHandler: { saveFromUrl: jest.fn(), shouldAttachFile: jest.fn(), readFile: jest.fn() },
}));

import { config } from '../src/utils/config';

// We need to test the rate-limit behavior. The MessageHandler class is not
// exported directly, but the singleton is. We can access its private method.
import { messageHandler } from '../src/bot/messageHandler';

describe('MessageHandler error rate limiting', () => {
  beforeEach(() => {
    // Reset the internal timestamp by accessing private field
    (messageHandler as any).lastErrorMessageTime = 0;
    (config.getErrorRateLimitMinutes as jest.Mock).mockReturnValue(1);
  });

  it('should allow the first error message', () => {
    const canSend = (messageHandler as any).canSendErrorMessage();
    expect(canSend).toBe(true);
  });

  it('should block a second error message within the rate limit window', () => {
    // First call — allowed
    const first = (messageHandler as any).canSendErrorMessage();
    expect(first).toBe(true);

    // Second call immediately — blocked
    const second = (messageHandler as any).canSendErrorMessage();
    expect(second).toBe(false);
  });

  it('should allow error message after rate limit window expires', () => {
    // Simulate first call
    (messageHandler as any).canSendErrorMessage();

    // Move lastErrorMessageTime back beyond the rate limit
    const rateLimitMs = 1 * 60 * 1000; // 1 minute
    (messageHandler as any).lastErrorMessageTime = Date.now() - rateLimitMs - 1;

    const canSend = (messageHandler as any).canSendErrorMessage();
    expect(canSend).toBe(true);
  });

  it('should respect configurable rate limit minutes', () => {
    // Set rate limit to 5 minutes
    (config.getErrorRateLimitMinutes as jest.Mock).mockReturnValue(5);

    // First call — allowed
    (messageHandler as any).canSendErrorMessage();

    // Set timestamp to 3 minutes ago (still within 5 min window)
    (messageHandler as any).lastErrorMessageTime = Date.now() - 3 * 60 * 1000;
    expect((messageHandler as any).canSendErrorMessage()).toBe(false);

    // Set timestamp to 6 minutes ago (outside 5 min window)
    (messageHandler as any).lastErrorMessageTime = Date.now() - 6 * 60 * 1000;
    expect((messageHandler as any).canSendErrorMessage()).toBe(true);
  });

  it('should update lastErrorMessageTime when message is allowed', () => {
    (messageHandler as any).lastErrorMessageTime = 0;

    const before = Date.now();
    (messageHandler as any).canSendErrorMessage();
    const after = Date.now();

    const timestamp = (messageHandler as any).lastErrorMessageTime;
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('should not update lastErrorMessageTime when message is blocked', () => {
    // First call sets the timestamp
    (messageHandler as any).canSendErrorMessage();
    const firstTimestamp = (messageHandler as any).lastErrorMessageTime;

    // Second call is blocked — timestamp should not change
    (messageHandler as any).canSendErrorMessage();
    expect((messageHandler as any).lastErrorMessageTime).toBe(firstTimestamp);
  });
});
