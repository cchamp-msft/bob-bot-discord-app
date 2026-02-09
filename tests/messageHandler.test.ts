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
  ChannelType: { DM: 1, GuildText: 0, GuildAnnouncement: 1 },
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
    getAbilityLoggingDetailed: jest.fn(() => false),
    getNflEndpoint: jest.fn(() => 'https://site.api.espn.com/apis/site/v2/sports/football/nfl'),
    getNflEnabled: jest.fn(() => true),
    getNflLoggingLevel: jest.fn(() => 0),
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
    logDebug: jest.fn(),
    logDebugLazy: jest.fn(),
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
  buildAbilitiesContext: jest.fn().mockReturnValue(''),
}));

jest.mock('../src/utils/apiRouter', () => ({
  executeRoutedRequest: jest.fn(),
}));

jest.mock('../src/utils/contextEvaluator', () => ({
  evaluateContextWindow: jest.fn().mockImplementation((history) => Promise.resolve(history)),
}));

import { config } from '../src/utils/config';
import { classifyIntent, buildAbilitiesContext } from '../src/utils/keywordClassifier';
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

describe('MessageHandler findKeyword (start-anchored)', () => {
  function setKeywords(keywords: any[]) {
    (config.getKeywords as jest.Mock).mockReturnValue(keywords);
  }

  const weatherKw = { keyword: 'weather', api: 'accuweather', timeout: 60, description: 'Weather' };
  const weatherReportKw = { keyword: 'weather report', api: 'accuweather', timeout: 360, description: 'Weather report', finalOllamaPass: true };
  const generateKw = { keyword: 'generate', api: 'comfyui', timeout: 600, description: 'Generate image' };
  const chatKw = { keyword: 'chat', api: 'ollama', timeout: 300, description: 'Chat' };

  afterEach(() => jest.restoreAllMocks());

  it('should match keyword at the start of message', () => {
    setKeywords([weatherKw, generateKw, chatKw]);
    const result = (messageHandler as any).findKeyword('weather 45403');
    expect(result).toBe(weatherKw);
  });

  it('should NOT match keyword in the middle of message', () => {
    setKeywords([weatherKw, generateKw, chatKw]);
    const result = (messageHandler as any).findKeyword('what is the weather like');
    expect(result).toBeUndefined();
  });

  it('should NOT match keyword that appears only inside the message', () => {
    setKeywords([generateKw, chatKw]);
    const result = (messageHandler as any).findKeyword('can you generate a cat');
    expect(result).toBeUndefined();
  });

  it('should match "weather report" over "weather" due to length priority', () => {
    setKeywords([weatherKw, weatherReportKw, chatKw]);
    const result = (messageHandler as any).findKeyword('weather report 28465');
    expect(result).toBe(weatherReportKw);
  });

  it('should match "weather" when message starts with weather but not weather report', () => {
    setKeywords([weatherKw, weatherReportKw, chatKw]);
    const result = (messageHandler as any).findKeyword('weather 45403');
    expect(result).toBe(weatherKw);
  });

  it('should match "generate" at message start', () => {
    setKeywords([weatherKw, generateKw, chatKw]);
    const result = (messageHandler as any).findKeyword('generate a cat picture');
    expect(result).toBe(generateKw);
  });

  it('should be case-insensitive', () => {
    setKeywords([weatherKw, generateKw, chatKw]);
    const result = (messageHandler as any).findKeyword('WEATHER 45403');
    expect(result).toBe(weatherKw);
  });

  it('should not match partial words at start', () => {
    setKeywords([generateKw]);
    const result = (messageHandler as any).findKeyword('generates many images');
    expect(result).toBeUndefined();
  });

  it('should return undefined when no keywords configured', () => {
    setKeywords([]);
    const result = (messageHandler as any).findKeyword('weather 45403');
    expect(result).toBeUndefined();
  });

  it('should return undefined for conversational phrasing', () => {
    setKeywords([weatherKw, generateKw, chatKw]);
    const result = (messageHandler as any).findKeyword('can you tell me the weather for dayton');
    expect(result).toBeUndefined();
  });

  it('should skip disabled keywords', () => {
    const disabledWeather = { ...weatherKw, enabled: false };
    setKeywords([disabledWeather, generateKw, chatKw]);
    const result = (messageHandler as any).findKeyword('weather 45403');
    expect(result).toBeUndefined();
  });

  it('should match enabled keyword when a different keyword is disabled', () => {
    const disabledChat = { ...chatKw, enabled: false };
    setKeywords([weatherKw, generateKw, disabledChat]);
    const result = (messageHandler as any).findKeyword('weather 45403');
    expect(result).toBe(weatherKw);
  });
});

describe('MessageHandler buildHelpResponse', () => {
  function setKeywords(keywords: any[]) {
    (config.getKeywords as jest.Mock).mockReturnValue(keywords);
  }

  afterEach(() => jest.restoreAllMocks());

  it('should list enabled non-builtin keywords with descriptions', () => {
    setKeywords([
      { keyword: 'help', api: 'ollama', timeout: 30, description: 'Show help', builtin: true },
      { keyword: 'generate', api: 'comfyui', timeout: 600, description: 'Generate image using ComfyUI' },
      { keyword: 'weather', api: 'accuweather', timeout: 60, description: 'Get weather' },
    ]);

    const result = (messageHandler as any).buildHelpResponse();
    expect(result).toContain('**generate**');
    expect(result).toContain('Generate image using ComfyUI');
    expect(result).toContain('**weather**');
    expect(result).toContain('Get weather');
    expect(result).not.toContain('**help**');
  });

  it('should exclude disabled keywords', () => {
    setKeywords([
      { keyword: 'help', api: 'ollama', timeout: 30, description: 'Show help', builtin: true },
      { keyword: 'generate', api: 'comfyui', timeout: 600, description: 'Generate image', enabled: false },
      { keyword: 'weather', api: 'accuweather', timeout: 60, description: 'Get weather' },
    ]);

    const result = (messageHandler as any).buildHelpResponse();
    expect(result).not.toContain('**generate**');
    expect(result).toContain('**weather**');
  });

  it('should return message when no keywords are configured', () => {
    setKeywords([
      { keyword: 'help', api: 'ollama', timeout: 30, description: 'Show help', builtin: true },
    ]);

    const result = (messageHandler as any).buildHelpResponse();
    expect(result).toContain('No keywords are currently configured');
  });

  it('should include Available Keywords header', () => {
    setKeywords([
      { keyword: 'ask', api: 'ollama', timeout: 300, description: 'Ask a question' },
    ]);

    const result = (messageHandler as any).buildHelpResponse();
    expect(result).toContain('Available Keywords');
  });
});

describe('MessageHandler built-in help keyword handling', () => {
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

  const helpKw = { keyword: 'help', api: 'ollama' as const, timeout: 30, description: 'Show help', builtin: true };
  const generateKw = { keyword: 'generate', api: 'comfyui' as const, timeout: 600, description: 'Generate image' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should respond with help text when built-in help keyword is enabled', async () => {
    (config.getKeywords as jest.Mock).mockReturnValue([helpKw, generateKw]);

    const msg = createMentionedMessage('<@bot-123> help');
    await messageHandler.handleMessage(msg);

    // Should reply with help text (not go through the normal processing flow)
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('Available Keywords'));
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('**generate**'));
  });

  it('should not trigger help when built-in help is disabled', async () => {
    const disabledHelp = { ...helpKw, enabled: false };
    (config.getKeywords as jest.Mock).mockReturnValue([disabledHelp, generateKw]);

    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValue({
      success: true,
      data: { text: 'I can help you!' },
    });

    (classifyIntent as jest.MockedFunction<typeof classifyIntent>)
      .mockResolvedValue({ keywordConfig: null, wasClassified: false });
    (buildAbilitiesContext as jest.MockedFunction<typeof buildAbilitiesContext>)
      .mockReturnValue('');

    const msg = createMentionedMessage('<@bot-123> help');
    await messageHandler.handleMessage(msg);

    // Should go through normal chat flow, not the help handler
    // The first reply call is the processing message, not the help text
    expect(msg.reply).toHaveBeenCalledWith('⏳ Processing your request...');
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

describe('MessageHandler first-word keyword routing', () => {
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

  const weatherKw = { keyword: 'weather', api: 'accuweather' as const, timeout: 60, description: 'Weather' };
  const weatherReportKw = { keyword: 'weather report', api: 'accuweather' as const, timeout: 360, description: 'AI weather report', finalOllamaPass: true };
  const generateKw = { keyword: 'generate', api: 'comfyui' as const, timeout: 300, description: 'Image gen' };

  beforeEach(() => {
    jest.clearAllMocks();
    (config.getKeywords as jest.Mock).mockReturnValue([weatherKw, weatherReportKw, generateKw]);
  });

  it('should route to API when keyword is at message start', async () => {
    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Sunny' } },
      finalApi: 'accuweather',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> weather 45403');
    await messageHandler.handleMessage(msg);

    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      weatherKw,
      '45403',
      'testuser',
      undefined
    );
  });

  it('should prefer longer keyword when both match at start', async () => {
    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Weather report' } },
      finalApi: 'ollama',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> weather report 28465');
    await messageHandler.handleMessage(msg);

    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      weatherReportKw,
      '28465',
      'testuser',
      undefined
    );
  });

  it('should NOT match keyword in middle of message — goes to two-stage', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValue({
      success: true,
      data: { text: 'chat response' },
    });

    // classifyIntent returns no match so no API routing
    const mockClassifyIntent = classifyIntent as jest.MockedFunction<typeof classifyIntent>;
    mockClassifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: true });

    const msg = createMentionedMessage('<@bot-123> what is the weather like');
    await messageHandler.handleMessage(msg);

    // Should NOT have used the routed pipeline directly
    expect(mockExecuteRoutedRequest).not.toHaveBeenCalled();

    // Should have gone to two-stage path (Ollama call via requestQueue)
    expect(requestQueue.execute).toHaveBeenCalled();
  });

  it('should handle routed pipeline error gracefully', async () => {
    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: false, error: 'Pipeline failed' },
      finalApi: 'comfyui',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> generate something');
    await messageHandler.handleMessage(msg);

    const processingMessage = await msg.reply.mock.results[0].value;
    expect(processingMessage.edit).toHaveBeenCalledWith(
      expect.stringContaining('⚠️')
    );
  });

  it('should preserve "chat" in non-keyword messages (no stripping on default fallback)', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValue({
      success: true,
      data: { text: 'response' },
    });

    const mockClassifyIntent = classifyIntent as jest.MockedFunction<typeof classifyIntent>;
    mockClassifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: true });

    const msg = createMentionedMessage('<@bot-123> let\'s chat about dogs');
    await messageHandler.handleMessage(msg);

    // Content passed to Ollama should still contain "chat" — it was not a keyword match
    expect(requestQueue.execute).toHaveBeenCalledWith(
      'ollama',
      'testuser',
      expect.any(String),
      expect.any(Number),
      expect.any(Function)
    );

    // Verify the executor function receives the unmodified content
    const executorFn = requestQueue.execute.mock.calls[0][4];
    const { apiManager } = require('../src/api');
    apiManager.executeRequest.mockResolvedValue({ success: true, data: { text: 'ok' } });
    await executorFn(new AbortController().signal);
    // Verify the content passed to Ollama still contains "chat"
    const callArgs = apiManager.executeRequest.mock.calls[0];
    expect(callArgs[2]).toContain('chat about dogs');
  });
});

describe('MessageHandler two-stage evaluation', () => {
  const mockClassifyIntent = classifyIntent as jest.MockedFunction<typeof classifyIntent>;
  const mockExecuteRoutedRequest = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;
  const mockBuildAbilitiesContext = buildAbilitiesContext as jest.MockedFunction<typeof buildAbilitiesContext>;

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
    (config.getKeywords as jest.Mock).mockReturnValue([]);
    mockClassifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: false });
    mockBuildAbilitiesContext.mockReturnValue('You have abilities: check weather');
  });

  it('should call Ollama then classify response, routing to API on match', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');

    // Ollama response
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'I can check the weather for you!' },
    });

    // classifyIntent call (on Ollama response) matches weather
    const weatherKeyword = {
      keyword: 'weather',
      api: 'accuweather' as const,
      timeout: 60,
      description: 'Get weather',
    };
    mockClassifyIntent.mockResolvedValueOnce({
      keywordConfig: weatherKeyword,
      wasClassified: true,
    });

    // executeRoutedRequest for weather API
    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Sunny, 72°F in Seattle' } },
      finalApi: 'accuweather',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> is it going to rain in Seattle');
    await messageHandler.handleMessage(msg);

    // classifyIntent called once — on Ollama's response only (not on user content)
    expect(mockClassifyIntent).toHaveBeenCalledTimes(1);

    // Should have called executeRoutedRequest with the weather keyword
    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      weatherKeyword,
      'is it going to rain in Seattle',
      'testuser',
      undefined
    );
  });

  it('should return Ollama response when second classification finds no API keyword', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');

    // Ollama response (generic chat, no API suggestion)
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'The meaning of life is 42.' },
    });

    // classifyIntent (on Ollama response): no match
    mockClassifyIntent.mockResolvedValueOnce({
      keywordConfig: null,
      wasClassified: true,
    });

    const msg = createMentionedMessage('<@bot-123> what is the meaning of life');
    await messageHandler.handleMessage(msg);

    // Should NOT have called executeRoutedRequest
    expect(mockExecuteRoutedRequest).not.toHaveBeenCalled();

    // Processing message should show the Ollama response
    const processingMessage = await msg.reply.mock.results[0].value;
    expect(processingMessage.edit).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'The meaning of life is 42.' })
    );
  });

  it('should skip second classification when second classify finds ollama keyword', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Let me think about that...' },
    });

    // classifyIntent (on Ollama response) returns an ollama keyword (should be treated as no API match)
    mockClassifyIntent.mockResolvedValueOnce({
      keywordConfig: { keyword: 'chat', api: 'ollama' as const, timeout: 300, description: 'Chat' },
      wasClassified: true,
    });

    const msg = createMentionedMessage('<@bot-123> tell me a joke');
    await messageHandler.handleMessage(msg);

    // Should NOT route to API since the keyword is ollama
    expect(mockExecuteRoutedRequest).not.toHaveBeenCalled();
  });

  it('should include abilities context in Ollama call', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    const { apiManager } = require('../src/api');

    mockBuildAbilitiesContext.mockReturnValue('You have access to: check weather');

    requestQueue.execute.mockImplementation(
      (_api: any, _req: any, _kw: any, _to: any, executor: any) =>
        executor(new AbortController().signal)
    );

    apiManager.executeRequest.mockResolvedValue({
      success: true,
      data: { text: 'response' },
    });

    const msg = createMentionedMessage('<@bot-123> hello');
    await messageHandler.handleMessage(msg);

    // apiManager.executeRequest should have been called with conversation history
    // that includes the abilities context as a system message
    expect(apiManager.executeRequest).toHaveBeenCalledWith(
      'ollama',
      'testuser',
      'hello',
      expect.any(Number),
      undefined,
      expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: 'You have access to: check weather',
        }),
      ]),
      expect.anything()
    );
  });
});

describe('MessageHandler DM handling', () => {
  function createDmMessage(content: string): any {
    const botUserId = 'bot-123';
    return {
      author: { bot: false, id: 'user-1', username: 'dmuser' },
      client: { user: { id: botUserId } },
      channel: {
        type: 1, // ChannelType.DM
        messages: {
          cache: new Map(),
          fetch: jest.fn().mockResolvedValue(new Map()),
        },
        send: jest.fn(),
      },
      guild: null,
      mentions: { has: jest.fn(() => false) },
      reference: null,
      content,
      id: 'dm-msg-1',
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
      }),
      fetchReference: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (config.getKeywords as jest.Mock).mockReturnValue([]);
    (classifyIntent as jest.MockedFunction<typeof classifyIntent>)
      .mockResolvedValue({ keywordConfig: null, wasClassified: false });
    (buildAbilitiesContext as jest.MockedFunction<typeof buildAbilitiesContext>)
      .mockReturnValue('');
  });

  it('should accept DM messages without mentions or replies', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    const { logger } = require('../src/utils/logger');

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Hello from the bot!' },
    });

    const msg = createDmMessage('hello bot');
    await messageHandler.handleMessage(msg);

    // Should log incoming DM
    expect(logger.logIncoming).toHaveBeenCalledWith(
      'dmuser', 'user-1', 'DM', null, 'hello bot'
    );
  });

  it('should collect DM history when reply chain is enabled', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');

    // Create mock history messages
    const historyMessages = new Map([
      ['older-msg', {
        id: 'older-msg',
        content: 'Previous question',
        author: { id: 'user-1', username: 'dmuser' },
      }],
      ['bot-reply', {
        id: 'bot-reply',
        content: 'Previous answer',
        author: { id: 'bot-123', username: 'bot' },
      }],
    ]);

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Response' },
    });

    const msg = createDmMessage('follow up question');
    msg.channel.messages.fetch.mockResolvedValue(historyMessages);

    (config.getReplyChainEnabled as jest.Mock).mockReturnValue(true);

    await messageHandler.handleMessage(msg);

    // Should have attempted to fetch DM history
    expect(msg.channel.messages.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ before: 'dm-msg-1' })
    );
  });
});

describe('MessageHandler empty-content bypass for NFL keywords', () => {
  function createDmMessage(content: string): any {
    const botUserId = 'bot-123';
    return {
      author: { bot: false, id: 'user-1', username: 'nfluser' },
      client: { user: { id: botUserId } },
      channel: {
        type: 1, // ChannelType.DM
        messages: {
          cache: new Map(),
          fetch: jest.fn().mockResolvedValue(new Map()),
        },
        send: jest.fn(),
      },
      guild: null,
      mentions: { has: jest.fn(() => false) },
      reference: null,
      content,
      id: 'dm-nfl-1',
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
      }),
      fetchReference: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (config.getKeywords as jest.Mock).mockReturnValue([
      { keyword: 'nfl scores', api: 'nfl', timeout: 30, description: 'All scores' },
      { keyword: 'nfl score', api: 'nfl', timeout: 30, description: 'Team score' },
      { keyword: 'superbowl', api: 'nfl', timeout: 30, description: 'Super Bowl' },
    ]);
    (classifyIntent as jest.MockedFunction<typeof classifyIntent>)
      .mockResolvedValue({ keywordConfig: null, wasClassified: false });
    (buildAbilitiesContext as jest.MockedFunction<typeof buildAbilitiesContext>)
      .mockReturnValue('');
  });

  it('should NOT reply with empty-content error for "nfl scores" with no extra text', async () => {
    const mockRouted = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;
    mockRouted.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: '🏈 **NFL Scores**\n\n✅ Some game' } },
      finalApi: 'nfl',
      stages: [],
    });

    const msg = createDmMessage('nfl scores');
    await messageHandler.handleMessage(msg);

    // Should NOT show the "please include a prompt" message
    expect(msg.reply).not.toHaveBeenCalledWith(
      'Please include a prompt or question after the keyword!'
    );
    // Should have called executeRoutedRequest
    expect(mockRouted).toHaveBeenCalled();
  });

  it('should still reject empty content for "nfl score" (requires team parameter)', async () => {
    const { logger } = require('../src/utils/logger');
    const msg = createDmMessage('nfl score');
    await messageHandler.handleMessage(msg);

    // Should show the "please include a prompt" message
    expect(msg.reply).toHaveBeenCalledWith(
      'Please include a prompt or question after the keyword!'
    );
    expect(logger.logIgnored).toHaveBeenCalled();
  });

  it('should NOT reply with empty-content error for "superbowl" with no extra text', async () => {
    const mockRouted = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;
    mockRouted.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: '🏈 **Super Bowl** 🏈' } },
      finalApi: 'nfl',
      stages: [],
    });

    const msg = createDmMessage('superbowl');
    await messageHandler.handleMessage(msg);

    expect(msg.reply).not.toHaveBeenCalledWith(
      'Please include a prompt or question after the keyword!'
    );
    expect(mockRouted).toHaveBeenCalled();
  });
});

describe('MessageHandler — Context Evaluation integration', () => {
  const { evaluateContextWindow } = require('../src/utils/contextEvaluator');
  const mockEvaluate = evaluateContextWindow as jest.MockedFunction<typeof evaluateContextWindow>;

  const weatherKw = {
    keyword: 'weather',
    api: 'accuweather' as const,
    timeout: 60,
    description: 'Weather',
    contextFilterMinDepth: 1,
    contextFilterMaxDepth: 5,
  };

  function createMentionedMsg(content: string, hasReference = false) {
    return {
      author: { id: 'user-1', bot: false, username: 'ctxuser', displayName: 'CtxUser' },
      content,
      mentions: { has: () => true },
      channel: { type: 0 },
      client: { user: { id: 'bot-123' } },
      reference: hasReference ? { messageId: 'ref-1' } : null,
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn(),
        attachments: { size: 0 },
        embeds: [],
      }),
      attachments: { size: 0 },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (config.getKeywords as jest.Mock).mockReturnValue([weatherKw]);
    (config.getReplyChainEnabled as jest.Mock).mockReturnValue(true);
    mockEvaluate.mockImplementation((history: any) => Promise.resolve(history));
  });

  it('should not call evaluateContextWindow when no conversation history (no reply)', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    const { classifyIntent, buildAbilitiesContext } = require('../src/utils/keywordClassifier');

    buildAbilitiesContext.mockReturnValue('');
    classifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: false });

    // Ollama direct chat response
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Just chatting!' },
    });

    const msg = createMentionedMsg('<@bot-123> hello there');
    await messageHandler.handleMessage(msg as any);

    // No reply reference means no history — evaluator should not be called
    expect(mockEvaluate).not.toHaveBeenCalled();
  });
});