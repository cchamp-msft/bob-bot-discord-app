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
    getMaxAttachments: jest.fn(() => 10),
    getImageResponseIncludeEmbed: jest.fn(() => false),
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

jest.mock('../src/utils/keywordClassifier', () => ({
  classifyIntent: jest.fn().mockResolvedValue({ keywordConfig: null, wasClassified: false }),
}));

jest.mock('../src/utils/apiRouter', () => ({
  executeRoutedRequest: jest.fn(),
}));

import { config } from '../src/utils/config';
import { classifyIntent } from '../src/utils/keywordClassifier';
import { executeRoutedRequest } from '../src/utils/apiRouter';

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

describe('MessageHandler Discord mention stripping', () => {
  function createMentionedMessage(content: string): any {
    const botUserId = 'bot-123';
    return {
      author: { bot: false, id: 'user-1', username: 'testuser' },
      client: { user: { id: botUserId } },
      channel: {
        type: 0, // GuildText
        messages: { cache: new Map() },
        send: jest.fn(),
      },
      guild: { name: 'TestGuild' },
      mentions: { has: jest.fn(() => true) },
      reference: null,
      content,
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
      }),
      fetchReference: jest.fn(),
    };
  }

  it('should strip role mentions from message content', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValue({ success: true, data: { text: 'ok' } });

    const msg = createMentionedMessage('<@bot-123> <@&1469385947643777211> generate a cat');
    await messageHandler.handleMessage(msg);

    // The execute callback receives the cleaned content — check the logger
    const { logger } = require('../src/utils/logger');
    const requestCalls = logger.logRequest.mock.calls;
    const lastCall = requestCalls[requestCalls.length - 1];
    // Content should have both bot mention and role mention stripped
    expect(lastCall[1]).toContain('generate a cat');
    expect(lastCall[1]).not.toContain('<@&');
    expect(lastCall[1]).not.toContain('<@bot-123>');
  });

  it('should strip all types of Discord markup', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValue({ success: true, data: { text: 'ok' } });

    const msg = createMentionedMessage(
      '<@bot-123> <@999> <@!888> <@&777> <#666> <:smile:555> <a:wave:444> draw something'
    );
    await messageHandler.handleMessage(msg);

    const { logger } = require('../src/utils/logger');
    const requestCalls = logger.logRequest.mock.calls;
    const lastCall = requestCalls[requestCalls.length - 1];
    expect(lastCall[1]).toContain('draw something');
    expect(lastCall[1]).not.toMatch(/<[@#][^>]*>/);
    expect(lastCall[1]).not.toMatch(/<a?:\w+:\d+>/);
  });
});

describe('MessageHandler stripKeyword', () => {
  it('should strip the first occurrence of the keyword (case-insensitive)', () => {
    const result = (messageHandler as any).stripKeyword('generate a beautiful sunset', 'generate');
    expect(result).toBe('a beautiful sunset');
  });

  it('should strip only the first occurrence when keyword appears multiple times', () => {
    const result = (messageHandler as any).stripKeyword('generate the word generate in a sentence', 'generate');
    expect(result).toBe('the word generate in a sentence');
  });

  it('should be case-insensitive', () => {
    const result = (messageHandler as any).stripKeyword('GENERATE a cat picture', 'generate');
    expect(result).toBe('a cat picture');
  });

  it('should handle keyword at end of string', () => {
    const result = (messageHandler as any).stripKeyword('please generate', 'generate');
    expect(result).toBe('please');
  });

  it('should handle keyword in the middle of string', () => {
    const result = (messageHandler as any).stripKeyword('please imagine a dog', 'imagine');
    expect(result).toBe('please a dog');
  });

  it('should return empty string when content is only the keyword', () => {
    const result = (messageHandler as any).stripKeyword('generate', 'generate');
    expect(result).toBe('');
  });

  it('should not strip partial word matches', () => {
    const result = (messageHandler as any).stripKeyword('regenerate the image', 'generate');
    expect(result).toBe('regenerate the image');
  });

  it('should handle special regex characters in keyword', () => {
    const result = (messageHandler as any).stripKeyword('use draw.io to generate', 'draw.io');
    expect(result).toBe('use to generate');
  });

  it('should collapse multiple spaces after stripping', () => {
    const result = (messageHandler as any).stripKeyword('please  generate  a cat', 'generate');
    expect(result).toBe('please a cat');
  });
});

describe('MessageHandler buildImagePromptFromReply', () => {
  function createReplyMessage(
    content: string,
    referencedContent: string,
    referencedAuthorId: string = 'user-2',
    fetchError: boolean = false
  ): any {
    return {
      content,
      reference: { messageId: 'ref-msg-1' },
      client: { user: { id: 'bot-id' } },
      fetchReference: fetchError
        ? jest.fn().mockRejectedValue(new Error('Not found'))
        : jest.fn().mockResolvedValue({
          content: referencedContent,
          author: { id: referencedAuthorId, username: 'OtherUser' },
        }),
    };
  }

  it('should prepend quoted message content to user reply text', async () => {
    const msg = createReplyMessage('a sunset', 'beautiful landscape');
    const result = await (messageHandler as any).buildImagePromptFromReply(msg, 'a sunset');
    expect(result).toBe('beautiful landscape, a sunset');
  });

  it('should strip bot mentions from quoted message', async () => {
    const msg = createReplyMessage('a cat', '<@bot-id> hello world');
    const result = await (messageHandler as any).buildImagePromptFromReply(msg, 'a cat');
    expect(result).toBe('hello world, a cat');
  });

  it('should strip Discord markup from quoted message', async () => {
    const msg = createReplyMessage('a dog', '<@999> <@&777> nice photo');
    const result = await (messageHandler as any).buildImagePromptFromReply(msg, 'a dog');
    expect(result).toBe('nice photo, a dog');
  });

  it('should fall back to reply text only when referenced message is empty', async () => {
    const msg = createReplyMessage('a cat', '');
    const result = await (messageHandler as any).buildImagePromptFromReply(msg, 'a cat');
    expect(result).toBe('a cat');
  });

  it('should fall back to reply text only when fetch fails', async () => {
    const msg = createReplyMessage('a cat', '', 'user-2', true);
    const result = await (messageHandler as any).buildImagePromptFromReply(msg, 'a cat');
    expect(result).toBe('a cat');
  });

  it('should fall back to reply text when no reference messageId', async () => {
    const msg = {
      content: 'a cat',
      reference: {},
      client: { user: { id: 'bot-id' } },
      fetchReference: jest.fn(),
    };
    const result = await (messageHandler as any).buildImagePromptFromReply(msg, 'a cat');
    expect(result).toBe('a cat');
  });

  it('should return only quoted content when replyText is empty', async () => {
    const msg = createReplyMessage('', 'beautiful landscape');
    const result = await (messageHandler as any).buildImagePromptFromReply(msg, '');
    expect(result).toBe('beautiful landscape');
  });
});

describe('MessageHandler handleComfyUIResponse fallback content', () => {
  const { fileHandler } = require('../src/utils/fileHandler');

  afterEach(() => {
    jest.clearAllMocks();
  });

  function createProcessingMessage() {
    return {
      edit: jest.fn().mockResolvedValue(undefined),
      channel: { send: jest.fn().mockResolvedValue(undefined) },
    };
  }

  it('should show fallback text when embed is off and no files are attachable', async () => {
    (config.getImageResponseIncludeEmbed as jest.Mock).mockReturnValue(false);
    fileHandler.saveFromUrl.mockResolvedValue({
      url: 'http://localhost/img.png',
      filePath: '/tmp/img.png',
      fileName: 'img.png',
      size: 999999999,
    });
    fileHandler.shouldAttachFile.mockReturnValue(false); // too large

    const processing = createProcessingMessage();
    const apiResult = {
      success: true,
      data: { images: ['http://comfyui/img.png'] },
    };

    await (messageHandler as any).handleComfyUIResponse(apiResult, processing, 'testuser');

    expect(processing.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('1 image(s) generated and saved'),
      })
    );
  });

  it('should show empty content when embed is on', async () => {
    (config.getImageResponseIncludeEmbed as jest.Mock).mockReturnValue(true);
    fileHandler.saveFromUrl.mockResolvedValue({
      url: 'http://localhost/img.png',
      filePath: '/tmp/img.png',
      fileName: 'img.png',
      size: 999999999,
    });
    fileHandler.shouldAttachFile.mockReturnValue(false);

    const processing = createProcessingMessage();
    const apiResult = {
      success: true,
      data: { images: ['http://comfyui/img.png'] },
    };

    await (messageHandler as any).handleComfyUIResponse(apiResult, processing, 'testuser');

    expect(processing.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '',
      })
    );
  });

  it('should show empty content when files are attachable (embed off)', async () => {
    (config.getImageResponseIncludeEmbed as jest.Mock).mockReturnValue(false);
    (config.getMaxAttachments as jest.Mock).mockReturnValue(10);
    fileHandler.saveFromUrl.mockResolvedValue({
      url: 'http://localhost/img.png',
      filePath: '/tmp/img.png',
      fileName: 'img.png',
      size: 1000,
    });
    fileHandler.shouldAttachFile.mockReturnValue(true);
    fileHandler.readFile.mockReturnValue(Buffer.from('fake'));

    const processing = createProcessingMessage();
    const apiResult = {
      success: true,
      data: { images: ['http://comfyui/img.png'] },
    };

    await (messageHandler as any).handleComfyUIResponse(apiResult, processing, 'testuser');

    expect(processing.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '',
      })
    );
  });
});

describe('MessageHandler reply-only-keyword for comfyui', () => {
  function createComfyUIReplyMessage(content: string, referencedContent: string): any {
    const botUserId = 'bot-123';
    return {
      author: { bot: false, id: 'user-1', username: 'testuser' },
      client: { user: { id: botUserId } },
      channel: {
        type: 0, // GuildText
        messages: { cache: new Map() },
        send: jest.fn(),
      },
      guild: { name: 'TestGuild' },
      mentions: { has: jest.fn(() => true) },
      reference: { messageId: 'ref-msg-1' },
      content,
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
      }),
      fetchReference: jest.fn().mockResolvedValue({
        content: referencedContent,
        author: { id: 'user-2', username: 'OtherUser' },
      }),
    };
  }

  it('should use quoted content when user replies with only the keyword', async () => {
    (config.getKeywords as jest.Mock).mockReturnValue([
      { keyword: 'generate', api: 'comfyui', timeout: 300, description: 'Image gen' },
    ]);
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValue({
      success: true,
      data: { images: [] },
    });

    const msg = createComfyUIReplyMessage(
      '<@bot-123> generate',
      'a beautiful sunset'
    );

    await messageHandler.handleMessage(msg);

    // Should have proceeded (reply was called for processing message)
    expect(msg.reply).toHaveBeenCalled();

    // The logger should show the quoted content was used
    const { logger } = require('../src/utils/logger');
    const requestCalls = logger.logRequest.mock.calls;
    const lastCall = requestCalls[requestCalls.length - 1];
    expect(lastCall[1]).toContain('a beautiful sunset');
  });
});

describe('MessageHandler AI-classified routing path', () => {
  const mockClassifyIntent = classifyIntent as jest.MockedFunction<typeof classifyIntent>;
  const mockExecuteRoutedRequest = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;

  function createMentionedMessage(content: string): any {
    const botUserId = 'bot-123';
    return {
      author: { bot: false, id: 'user-1', username: 'testuser' },
      client: { user: { id: botUserId } },
      channel: {
        type: 0,
        messages: { cache: new Map() },
        send: jest.fn(),
      },
      guild: { name: 'TestGuild' },
      mentions: { has: jest.fn(() => true) },
      reference: null,
      content,
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
      }),
      fetchReference: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // No regex-matched keywords so AI classification kicks in
    (config.getKeywords as jest.Mock).mockReturnValue([]);
  });

  afterEach(() => {
    // Reset default
    mockClassifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: false });
  });

  it('should use routed pipeline when AI-classified keyword has routeApi', async () => {
    const routedKeyword = {
      keyword: 'generate',
      api: 'comfyui' as const,
      timeout: 300,
      description: 'Image gen',
      routeApi: 'ollama' as const,
    };

    mockClassifyIntent.mockResolvedValueOnce({
      keywordConfig: routedKeyword,
      wasClassified: true,
    });

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'routed response' } },
      finalApi: 'ollama',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> draw me a sunset');
    await messageHandler.handleMessage(msg);

    // Should have called the routed pipeline
    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      routedKeyword,
      expect.stringContaining('draw me a sunset'),
      'testuser',
      undefined
    );

    // Processing message should have been edited with the response
    const processingMessage = await msg.reply.mock.results[0].value;
    expect(processingMessage.edit).toHaveBeenCalled();
  });

  it('should use routed pipeline when AI-classified keyword has finalOllamaPass', async () => {
    const routedKeyword = {
      keyword: 'analyze',
      api: 'ollama' as const,
      timeout: 300,
      description: 'Analyze content',
      finalOllamaPass: true,
    };

    mockClassifyIntent.mockResolvedValueOnce({
      keywordConfig: routedKeyword,
      wasClassified: true,
    });

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'final result' } },
      finalApi: 'ollama',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> analyze this data');
    await messageHandler.handleMessage(msg);

    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      routedKeyword,
      expect.stringContaining('analyze this data'),
      'testuser',
      undefined
    );
  });

  it('should not strip keyword from content when AI-classified', async () => {
    const routedKeyword = {
      keyword: 'generate',
      api: 'comfyui' as const,
      timeout: 300,
      description: 'Image gen',
      routeApi: 'ollama' as const,
    };

    mockClassifyIntent.mockResolvedValueOnce({
      keywordConfig: routedKeyword,
      wasClassified: true,
    });

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'ok' } },
      finalApi: 'ollama',
      stages: [],
    });

    // Content doesn't literally have "generate" — AI inferred it
    const msg = createMentionedMessage('<@bot-123> make me a picture of a cat');
    await messageHandler.handleMessage(msg);

    // Content should be passed unmodified (no keyword stripping)
    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      routedKeyword,
      'make me a picture of a cat',
      'testuser',
      undefined
    );
  });

  it('should fall back to default chat when AI classification returns no match', async () => {
    mockClassifyIntent.mockResolvedValueOnce({
      keywordConfig: null,
      wasClassified: true,
    });

    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValue({
      success: true,
      data: { text: 'chat response' },
    });

    const msg = createMentionedMessage('<@bot-123> random unclassified message');
    await messageHandler.handleMessage(msg);

    // Should NOT have used the routed pipeline
    expect(mockExecuteRoutedRequest).not.toHaveBeenCalled();

    // Should have used the direct execution path
    expect(requestQueue.execute).toHaveBeenCalled();
  });

  it('should handle routed pipeline error gracefully', async () => {
    const routedKeyword = {
      keyword: 'generate',
      api: 'comfyui' as const,
      timeout: 300,
      description: 'Image gen',
      routeApi: 'ollama' as const,
    };

    mockClassifyIntent.mockResolvedValueOnce({
      keywordConfig: routedKeyword,
      wasClassified: true,
    });

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: false, error: 'Pipeline failed' },
      finalApi: 'ollama',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> generate something');
    await messageHandler.handleMessage(msg);

    // Should have sent an error response to the user
    const processingMessage = await msg.reply.mock.results[0].value;
    expect(processingMessage.edit).toHaveBeenCalledWith(
      expect.stringContaining('⚠️')
    );
  });
});