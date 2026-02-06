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
    getReplyChainEnabled: jest.fn(() => true),
    getReplyChainMaxDepth: jest.fn(() => 10),
    getReplyChainMaxTokens: jest.fn(() => 16000),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
    logIncoming: jest.fn(),
    logIgnored: jest.fn(),
    logDefault: jest.fn(),
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

describe('MessageHandler collectReplyChain', () => {
  /**
   * Helper to build a minimal mock Message for collectReplyChain.
   * Each message has an author, optional reference, and a fetchReference stub.
   */
  function createMockMessage(
    id: string,
    authorId: string,
    authorUsername: string,
    content: string,
    reference?: { messageId: string },
    fetchReferenceResult?: any,
    memberDisplayName?: string
  ): any {
    return {
      id,
      content,
      author: { id: authorId, username: authorUsername },
      member: memberDisplayName ? { displayName: memberDisplayName } : null,
      reference: reference ? { messageId: reference.messageId } : null,
      client: { user: { id: 'bot-id' } },
      fetchReference: jest.fn().mockResolvedValue(fetchReferenceResult),
    };
  }

  it('should prefix user messages with display name when multiple humans are in the chain', async () => {
    // Deepest message — from User A (no further reference)
    const msgA = createMockMessage(
      'msg-a', 'user-a', 'Alice', 'Hello everyone',
      undefined, undefined, 'Alice Display'
    );

    // Middle message — bot reply to User A
    const msgBot = createMockMessage(
      'msg-bot', 'bot-id', 'Bot', 'Hi Alice!',
      { messageId: 'msg-a' }, msgA
    );

    // Reply from User B to bot — references the bot message
    const msgB = createMockMessage(
      'msg-b', 'user-b', 'Bob', 'What about me?',
      { messageId: 'msg-bot' }, msgBot, 'Bob Display'
    );

    // Current message from User B referencing their own previous message
    const currentMsg = createMockMessage(
      'msg-current', 'user-b', 'Bob', 'Follow up question',
      { messageId: 'msg-b' }, msgB, 'Bob Display'
    );

    const chain = await (messageHandler as any).collectReplyChain(currentMsg);

    // Chain should be oldest-first: Alice's msg, bot's msg, Bob's msg
    expect(chain).toHaveLength(3);

    // Alice's message should be prefixed with her display name (multi-user)
    expect(chain[0].role).toBe('user');
    expect(chain[0].content).toBe('Alice Display: Hello everyone');

    // Bot message — no prefix
    expect(chain[1].role).toBe('assistant');
    expect(chain[1].content).toBe('Hi Alice!');

    // Bob's message should be prefixed with his display name (multi-user)
    expect(chain[2].role).toBe('user');
    expect(chain[2].content).toBe('Bob Display: What about me?');
  });

  it('should NOT prefix user messages when only one human is in the chain', async () => {
    // Deepest message — from User A (no further reference)
    const msgA = createMockMessage(
      'msg-a', 'user-a', 'Alice', 'First question',
      undefined, undefined, 'Alice Display'
    );

    // Bot reply
    const msgBot = createMockMessage(
      'msg-bot', 'bot-id', 'Bot', 'Here is the answer',
      { messageId: 'msg-a' }, msgA
    );

    // Current message — same user replying to bot
    const currentMsg = createMockMessage(
      'msg-current', 'user-a', 'Alice', 'Follow up',
      { messageId: 'msg-bot' }, msgBot, 'Alice Display'
    );

    const chain = await (messageHandler as any).collectReplyChain(currentMsg);

    expect(chain).toHaveLength(2);

    // Single user — no prefix
    expect(chain[0].role).toBe('user');
    expect(chain[0].content).toBe('First question');

    expect(chain[1].role).toBe('assistant');
    expect(chain[1].content).toBe('Here is the answer');
  });

  it('should use member displayName over author username when available', async () => {
    // Message with a guild member displayName
    const msgA = createMockMessage(
      'msg-a', 'user-a', 'alice123', 'Hello',
      undefined, undefined, 'Alice Wonderland'
    );

    // Message from another user to trigger multi-user attribution
    const msgB = createMockMessage(
      'msg-b', 'user-b', 'bob456', 'Hi',
      { messageId: 'msg-a' }, msgA, 'Bob Builder'
    );

    const currentMsg = createMockMessage(
      'msg-current', 'user-b', 'bob456', 'Question',
      { messageId: 'msg-b' }, msgB, 'Bob Builder'
    );

    const chain = await (messageHandler as any).collectReplyChain(currentMsg);

    // Should use member displayName, not username
    expect(chain[0].content).toBe('Alice Wonderland: Hello');
    expect(chain[1].content).toBe('Bob Builder: Hi');
  });

  it('should fall back to author username when member is null (e.g. DMs)', async () => {
    // Message without guild member (DM context)
    const msgA = createMockMessage(
      'msg-a', 'user-a', 'alice123', 'DM message',
      undefined, undefined, undefined // no member
    );

    // Another user to trigger multi-user
    const msgB = createMockMessage(
      'msg-b', 'user-b', 'bob456', 'Reply',
      { messageId: 'msg-a' }, msgA, undefined
    );

    const currentMsg = createMockMessage(
      'msg-current', 'user-b', 'bob456', 'Follow up',
      { messageId: 'msg-b' }, msgB, undefined
    );

    const chain = await (messageHandler as any).collectReplyChain(currentMsg);

    // Should fall back to username
    expect(chain[0].content).toBe('alice123: DM message');
    expect(chain[1].content).toBe('bob456: Reply');
  });

  it('should stop when total character budget is exceeded', async () => {
    (config.getReplyChainMaxTokens as jest.Mock).mockReturnValue(50);

    // Build a chain of 3 messages each with 30 chars of content
    const msg1 = createMockMessage(
      'msg-1', 'user-a', 'Alice', 'a'.repeat(30),
      undefined, undefined, 'Alice'
    );
    const msg2 = createMockMessage(
      'msg-2', 'bot-id', 'Bot', 'b'.repeat(30),
      { messageId: 'msg-1' }, msg1
    );
    const msg3 = createMockMessage(
      'msg-3', 'user-a', 'Alice', 'c'.repeat(30),
      { messageId: 'msg-2' }, msg2, 'Alice'
    );
    const currentMsg = createMockMessage(
      'msg-current', 'user-a', 'Alice', 'question',
      { messageId: 'msg-3' }, msg3, 'Alice'
    );

    const chain = await (messageHandler as any).collectReplyChain(currentMsg);

    // Should have stopped before collecting all 3 — budget is 50 chars
    // First message (30 chars) fits, second (30 chars) pushes to 60 > 50
    expect(chain.length).toBeLessThan(3);
    expect(chain.length).toBe(1);
  });
});

describe('MessageHandler shouldRespond — guild reply to bot', () => {
  function createGuildMessage(opts: {
    authorBot?: boolean;
    isMentioned?: boolean;
    isDM?: boolean;
    reference?: { messageId: string };
    fetchReferenceResult?: any;
    content?: string;
  }): any {
    const botUserId = 'bot-123';
    const channelMessages = new Map<string, any>();
    // Pre-cache the referenced message if provided
    if (opts.reference && opts.fetchReferenceResult) {
      channelMessages.set(opts.reference.messageId, opts.fetchReferenceResult);
    }
    return {
      author: { bot: opts.authorBot ?? false, id: 'user-1', username: 'testuser' },
      client: { user: { id: botUserId } },
      channel: {
        type: opts.isDM ? 1 : 0, // 1 = DM, 0 = GuildText
        messages: { cache: channelMessages },
        send: jest.fn(),
      },
      guild: opts.isDM ? null : { name: 'TestGuild' },
      mentions: { has: jest.fn(() => opts.isMentioned ?? false) },
      reference: opts.reference ?? null,
      content: opts.content ?? 'hello bot',
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
      }),
      fetchReference: jest.fn().mockResolvedValue(opts.fetchReferenceResult),
    };
  }

  it('should process a guild reply to the bot even without @mention', async () => {
    const botReply = {
      author: { id: 'bot-123', username: 'Bot' },
      content: 'I am the bot',
    };
    const msg = createGuildMessage({
      reference: { messageId: 'bot-msg-1' },
      fetchReferenceResult: botReply,
      content: 'follow up question',
    });

    await messageHandler.handleMessage(msg);

    // Should have proceeded to send a processing message (reply was called)
    expect(msg.reply).toHaveBeenCalled();
  });

  it('should ignore guild messages that are not mentions, DMs, or replies to bot', async () => {
    const msg = createGuildMessage({
      content: 'random message',
    });

    await messageHandler.handleMessage(msg);

    // Should NOT have called reply (message was ignored)
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it('should ignore guild replies to other users (not the bot)', async () => {
    const otherUserMsg = {
      author: { id: 'other-user', username: 'OtherUser' },
      content: 'some message',
    };
    const msg = createGuildMessage({
      reference: { messageId: 'other-msg' },
      fetchReferenceResult: otherUserMsg,
      content: 'reply to other user',
    });

    await messageHandler.handleMessage(msg);

    expect(msg.reply).not.toHaveBeenCalled();
  });
});
