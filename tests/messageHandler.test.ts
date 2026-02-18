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
  COMMAND_PREFIX: '!',
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
    getAllowBotInteractions: jest.fn(() => false),
    getActivityKeyTtl: jest.fn(() => 300),
    getActivitySessionMaxTime: jest.fn(() => 86400),
    getOutputBaseUrl: jest.fn(() => 'http://localhost:3003'),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
    logWarn: jest.fn(),
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

jest.mock('../src/utils/promptBuilder', () => ({
  assemblePrompt: jest.fn(({ userMessage }: any) => ({
    systemContent: 'You are Bob. Rude but helpful.',
    userContent: `<conversation_history>\n</conversation_history>\n\n<current_question>\n${userMessage}\n</current_question>`,
    messages: [
      { role: 'system', content: 'You are Bob. Rude but helpful.' },
      { role: 'user', content: `<conversation_history>\n</conversation_history>\n\n<current_question>\n${userMessage}\n</current_question>` },
    ],
  })),
  parseFirstLineKeyword: jest.fn(() => ({ keywordConfig: null, parsedLine: '', matched: false })),
}));

jest.mock('../src/utils/apiRouter', () => ({
  executeRoutedRequest: jest.fn(),
  inferAbilityParameters: jest.fn(),
}));

jest.mock('../src/utils/contextEvaluator', () => ({
  evaluateContextWindow: jest.fn().mockImplementation((history) => Promise.resolve(history)),
}));

jest.mock('../src/utils/activityEvents', () => ({
  activityEvents: {
    emit: jest.fn(),
    emitMessageReceived: jest.fn(),
    emitRoutingDecision: jest.fn(),
    emitBotReply: jest.fn(),
    emitBotImageReply: jest.fn(),
    emitError: jest.fn(),
    emitWarning: jest.fn(),
    emitContextDecision: jest.fn(),
    emitFinalPassThought: jest.fn(),
    getRecent: jest.fn(() => []),
    clear: jest.fn(),
  },
}));

jest.mock('../src/utils/activityKeyManager', () => ({
  activityKeyManager: {
    issueKey: jest.fn(() => 'mock-activity-key-abc'),
    isValid: jest.fn(() => true),
    isExpired: jest.fn(() => false),
    remainingSeconds: jest.fn(() => 300),
    revoke: jest.fn(),
  },
}));

import { config } from '../src/utils/config';
import { classifyIntent, buildAbilitiesContext } from '../src/utils/keywordClassifier';
import { executeRoutedRequest, inferAbilityParameters } from '../src/utils/apiRouter';
import { assemblePrompt, parseFirstLineKeyword } from '../src/utils/promptBuilder';
import { activityEvents } from '../src/utils/activityEvents';

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
      client: { user: { id: 'bot-id', username: 'BotUser' } },
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
      client: { user: { id: botUserId, username: 'BotUser' } },
      channel: {
        type: opts.isDM ? 1 : 0, // 1 = DM, 0 = GuildText
        isThread: () => false,
        messages: { cache: channelMessages, fetch: jest.fn().mockResolvedValue(new Map()) },
        send: jest.fn(),
      },
      guild: opts.isDM ? null : { name: 'TestGuild' },
      mentions: { has: jest.fn(() => opts.isMentioned ?? false) },
      reference: opts.reference ?? null,
      content: opts.content ?? 'hello bot',
      id: 'guild-msg-1',
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
      }),
      fetchReference: jest.fn().mockResolvedValue(opts.fetchReferenceResult),
      react: jest.fn().mockResolvedValue(undefined),
      reactions: { resolve: jest.fn(() => ({ users: { remove: jest.fn().mockResolvedValue(undefined) } })) },
    };
  }

  it('should process a guild reply to the bot even without @mention', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Here is a follow-up answer.' },
    });

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
      client: { user: { id: botUserId, username: 'BotUser' } },
      channel: {
        type: 0, // GuildText
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
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
    const result = (messageHandler as any).stripKeyword('!generate a beautiful sunset', '!generate');
    expect(result).toBe('a beautiful sunset');
  });

  it('should strip only the first occurrence when keyword appears multiple times', () => {
    const result = (messageHandler as any).stripKeyword('!generate the word generate in a sentence', '!generate');
    expect(result).toBe('the word generate in a sentence');
  });

  it('should be case-insensitive', () => {
    const result = (messageHandler as any).stripKeyword('!GENERATE a cat picture', '!generate');
    expect(result).toBe('a cat picture');
  });

  it('should handle keyword at end of string', () => {
    const result = (messageHandler as any).stripKeyword('!generate please', '!generate');
    expect(result).toBe('please');
  });

  it('should handle keyword in the middle of string', () => {
    const result = (messageHandler as any).stripKeyword('!imagine please a dog', '!imagine');
    expect(result).toBe('please a dog');
  });

  it('should return empty string when content is only the keyword', () => {
    const result = (messageHandler as any).stripKeyword('!generate', '!generate');
    expect(result).toBe('');
  });

  it('should not strip partial word matches', () => {
    const result = (messageHandler as any).stripKeyword('regenerate the image', '!generate');
    expect(result).toBe('regenerate the image');
  });

  it('should handle special regex characters in keyword', () => {
    const result = (messageHandler as any).stripKeyword('!draw.io use to generate', '!draw.io');
    expect(result).toBe('use to generate');
  });

  it('should collapse multiple spaces after stripping', () => {
    const result = (messageHandler as any).stripKeyword('!generate  please  a cat', '!generate');
    expect(result).toBe('please  a cat');
  });
});

describe('MessageHandler findKeyword (start-anchored)', () => {
  function setKeywords(keywords: any[]) {
    (config.getKeywords as jest.Mock).mockReturnValue(keywords);
  }

  const weatherKw = { keyword: '!weather', api: 'accuweather', timeout: 60, description: 'Weather' };
  const nflKw = { keyword: '!nfl', api: 'nfl', timeout: 30, description: 'NFL generic' };
  const nflScoresKw = { keyword: '!nfl scores', api: 'nfl', timeout: 30, description: 'NFL scores' };
  const generateKw = { keyword: '!generate', api: 'comfyui', timeout: 600, description: 'Generate image' };
  const helpKw = { keyword: '!help', api: 'ollama', timeout: 30, description: 'Help', builtin: true, allowEmptyContent: true };
  const chatKw = { keyword: '!chat', api: 'ollama', timeout: 300, description: 'Chat' };

  afterEach(() => jest.restoreAllMocks());

  it('should match keyword at the start of message', () => {
    setKeywords([weatherKw, generateKw, chatKw]);
    const result = (messageHandler as any).findKeyword('!weather 45403');
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

  it('should match longer multi-word keyword over shorter overlap', () => {
    setKeywords([nflKw, nflScoresKw, chatKw]);
    const result = (messageHandler as any).findKeyword('!nfl scores 20251116');
    expect(result).toBe(nflScoresKw);
  });

  it('should match shorter keyword when longer overlap does not match', () => {
    setKeywords([nflKw, nflScoresKw, chatKw]);
    const result = (messageHandler as any).findKeyword('!nfl preseason update');
    expect(result).toBe(nflKw);
  });

  it('should match "weather" when message starts with weather', () => {
    setKeywords([weatherKw, chatKw]);
    const result = (messageHandler as any).findKeyword('!weather 45403');
    expect(result).toBe(weatherKw);
  });

  it('should match "generate" at message start', () => {
    setKeywords([weatherKw, generateKw, chatKw]);
    const result = (messageHandler as any).findKeyword('!generate a cat picture');
    expect(result).toBe(generateKw);
  });

  it('should be case-insensitive', () => {
    setKeywords([weatherKw, generateKw, chatKw]);
    const result = (messageHandler as any).findKeyword('!WEATHER 45403');
    expect(result).toBe(weatherKw);
  });

  it('should not match partial words at start', () => {
    setKeywords([generateKw]);
    const result = (messageHandler as any).findKeyword('generates many images');
    expect(result).toBeUndefined();
  });

  it('should return undefined when no keywords configured', () => {
    setKeywords([]);
    const result = (messageHandler as any).findKeyword('!weather 45403');
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
    const result = (messageHandler as any).findKeyword('!weather 45403');
    expect(result).toBeUndefined();
  });

  it('should match enabled keyword when a different keyword is disabled', () => {
    const disabledChat = { ...chatKw, enabled: false };
    setKeywords([weatherKw, generateKw, disabledChat]);
    const result = (messageHandler as any).findKeyword('!weather 45403');
    expect(result).toBe(weatherKw);
  });

  it('should match standalone help keyword', () => {
    setKeywords([helpKw, generateKw, chatKw]);
    const result = (messageHandler as any).findKeyword('!help');
    expect(result).toBe(helpKw);
  });

  it('should match help keyword case-insensitively', () => {
    setKeywords([helpKw, generateKw, chatKw]);
    expect((messageHandler as any).findKeyword('!Help')).toBe(helpKw);
    expect((messageHandler as any).findKeyword('!HELP')).toBe(helpKw);
  });

  it('should NOT match help keyword when followed by more text', () => {
    setKeywords([helpKw, generateKw, chatKw]);
    const result = (messageHandler as any).findKeyword('!help me with this');
    expect(result).toBeUndefined();
  });
});

describe('MessageHandler buildHelpResponse', () => {
  function setKeywords(keywords: any[]) {
    (config.getKeywords as jest.Mock).mockReturnValue(keywords);
  }

  afterEach(() => jest.restoreAllMocks());

  it('should include enabled capabilities and their descriptions', () => {
    setKeywords([
      { keyword: '!help', api: 'ollama', timeout: 30, description: 'Show help', builtin: true },
      { keyword: '!generate', api: 'comfyui', timeout: 600, description: 'Generate image using ComfyUI' },
      { keyword: '!weather', api: 'accuweather', timeout: 60, description: 'Get weather' },
    ]);

    const result = (messageHandler as any).buildHelpResponse();
    expect(result).toContain('**Available Commands**');
    expect(result).toContain('`!generate`');
    expect(result).toContain('Generate image using ComfyUI');
    expect(result).toContain('`!weather`');
    expect(result).toContain('Get weather');
    expect(result).not.toContain('!help');
  });

  it('should exclude disabled keywords', () => {
    setKeywords([
      { keyword: '!help', api: 'ollama', timeout: 30, description: 'Show help', builtin: true },
      { keyword: '!generate', api: 'comfyui', timeout: 600, description: 'Generate image', enabled: false },
      { keyword: '!weather', api: 'accuweather', timeout: 60, description: 'Get weather' },
    ]);

    const result = (messageHandler as any).buildHelpResponse();
    expect(result).not.toContain('!generate');
    expect(result).toContain('`!weather`');
  });

  it('should include fallback line when no non-help keywords are configured', () => {
    setKeywords([
      { keyword: '!help', api: 'ollama', timeout: 30, description: 'Show help', builtin: true },
    ]);

    const result = (messageHandler as any).buildHelpResponse();
    expect(result).toContain('No commands are currently configured');
  });
});

describe('MessageHandler help keyword handling (model path)', () => {
  function createMentionedMessage(content: string): any {
    const botUserId = 'bot-123';
    return {
      author: { bot: false, id: 'user-1', username: 'testuser' },
      client: { user: { id: botUserId, username: 'BotUser' } },
      channel: {
        type: 0,
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
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

  const helpKw = {
    keyword: '!help',
    api: 'ollama' as const,
    timeout: 30,
    description: 'Show help',
    builtin: true,
    allowEmptyContent: true,
  };
  const generateKw = { keyword: '!generate', api: 'comfyui' as const, timeout: 600, description: 'Generate image' };

  beforeEach(() => {
    jest.clearAllMocks();
    (config.getKeywords as jest.Mock).mockReturnValue([helpKw, generateKw]);
    (classifyIntent as jest.MockedFunction<typeof classifyIntent>)
      .mockResolvedValue({ keywordConfig: null, wasClassified: false });
    (parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>)
      .mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });
  });

  it('should short-circuit with a direct help reply without calling Ollama', async () => {
    const msg = createMentionedMessage('<@bot-123> !help');
    await messageHandler.handleMessage(msg);

    expect(msg.reply).toHaveBeenCalledWith(
      expect.stringContaining('**Available Commands**')
    );
    // Should NOT call assemblePrompt / Ollama at all
    expect(assemblePrompt as jest.MockedFunction<typeof assemblePrompt>).not.toHaveBeenCalled();
  });

  it('should not treat "help me" as help keyword and should keep original content', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValue({
      success: true,
      data: { text: 'regular response' },
    });

    const msg = createMentionedMessage('<@bot-123> help me find square roots');
    await messageHandler.handleMessage(msg);

    expect(assemblePrompt as jest.MockedFunction<typeof assemblePrompt>).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: 'help me find square roots',
      })
    );
  });
});

describe('MessageHandler built-in help keyword handling', () => {
  function createMentionedMessage(content: string): any {
    const botUserId = 'bot-123';
    return {
      author: { bot: false, id: 'user-1', username: 'testuser' },
      client: { user: { id: botUserId, username: 'BotUser' } },
      channel: {
        type: 0,
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
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

  const helpKw = { keyword: '!help', api: 'ollama' as const, timeout: 30, description: 'Show help', builtin: true, allowEmptyContent: true };
  const generateKw = { keyword: '!generate', api: 'comfyui' as const, timeout: 600, description: 'Generate image' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should route bare "help" without prefix through normal chat path', async () => {
    (config.getKeywords as jest.Mock).mockReturnValue([helpKw, generateKw]);

    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValue({
      success: true,
      data: { text: 'regular response' },
    });

    (classifyIntent as jest.MockedFunction<typeof classifyIntent>)
      .mockResolvedValue({ keywordConfig: null, wasClassified: false });
    (parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>)
      .mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });

    const msg = createMentionedMessage('<@bot-123> help');
    await messageHandler.handleMessage(msg);

    // Without the ! prefix, "help" goes through normal chat — not the short-circuit
    expect(msg.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'regular response' })
    );
    expect(msg.reply).not.toHaveBeenCalledWith(
      expect.stringContaining('**Available Commands**')
    );
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
    (parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>)
      .mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });

    const msg = createMentionedMessage('<@bot-123> help');
    await messageHandler.handleMessage(msg);

    // Should go through normal chat flow, not the help handler
    expect(msg.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'I can help you!' })
    );
    // Confirm it did NOT get tagged as a help short-circuit
    expect(msg.reply).not.toHaveBeenCalledWith(
      expect.stringContaining('**Available Commands**')
    );
  });
});

describe('MessageHandler standalone allowEmptyContent keywords', () => {
  function createMentionedMessage(content: string): any {
    const botUserId = 'bot-123';
    return {
      author: { bot: false, id: 'user-1', username: 'testuser' },
      client: { user: { id: botUserId, username: 'BotUser' } },
      channel: {
        type: 0,
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
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

  const nflScoresKw = {
    keyword: '!nfl scores',
    api: 'nfl' as const,
    timeout: 30,
    description: 'Get current NFL game scores',
    abilityText: 'Get current NFL game scores',
    finalOllamaPass: true,
    allowEmptyContent: true,
  };
  const nflNewsKw = {
    keyword: '!nfl news',
    api: 'nfl' as const,
    timeout: 30,
    description: 'Get latest NFL news headlines',
    abilityText: 'Get latest NFL news headlines',
    finalOllamaPass: true,
    allowEmptyContent: true,
  };
  const memeTemplatesKw = {
    keyword: '!meme_templates',
    api: 'meme' as const,
    timeout: 30,
    description: 'Return meme templates',
    allowEmptyContent: true,
  };
  const chatKw = { keyword: '!chat', api: 'ollama' as const, timeout: 300, description: 'Chat' };

  beforeEach(() => {
    jest.clearAllMocks();
    (config.getKeywords as jest.Mock).mockReturnValue([nflScoresKw, nflNewsKw, memeTemplatesKw, chatKw]);
    (classifyIntent as jest.MockedFunction<typeof classifyIntent>)
      .mockResolvedValue({ keywordConfig: null, wasClassified: false });
    (parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>)
      .mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });
  });

  it('should route standalone "nfl scores" without prompting for content (guild mention)', async () => {
    const mockRouted = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;
    mockRouted.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Cowboys 24, Eagles 17' } },
      finalApi: 'nfl',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> !nfl scores');
    await messageHandler.handleMessage(msg);

    expect(msg.reply).not.toHaveBeenCalledWith(
      'Please include a prompt or question after the keyword!'
    );
    expect(mockRouted).toHaveBeenCalled();
  });

  it('should route standalone "nfl news" without prompting for content (guild mention)', async () => {
    const mockRouted = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;
    mockRouted.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Trade deadline approaches...' } },
      finalApi: 'nfl',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> !nfl news');
    await messageHandler.handleMessage(msg);

    expect(msg.reply).not.toHaveBeenCalledWith(
      'Please include a prompt or question after the keyword!'
    );
    expect(mockRouted).toHaveBeenCalled();
  });

  it('should prompt for content when allowEmptyContent is absent', async () => {
    const noEmptyKw = {
      keyword: '!nfl scores',
      api: 'nfl' as const,
      timeout: 30,
      description: 'Get current NFL game scores',
    };
    (config.getKeywords as jest.Mock).mockReturnValue([noEmptyKw, chatKw]);

    const msg = createMentionedMessage('<@bot-123> !nfl scores');
    await messageHandler.handleMessage(msg);

    expect(msg.reply).toHaveBeenCalledWith(
      'Please include a prompt or question after the keyword!'
    );
  });

  it('should route standalone "meme_templates" without prompting for content', async () => {
    const mockRouted = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;
    mockRouted.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'drake, aag, doge' } },
      finalApi: 'meme',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> !meme_templates');
    await messageHandler.handleMessage(msg);

    expect(msg.reply).not.toHaveBeenCalledWith(
      'Please include a prompt or question after the keyword!'
    );
    expect(mockRouted).toHaveBeenCalledWith(
      memeTemplatesKw,
      '!meme_templates',
      'testuser',
      [{ role: 'user', content: 'testuser: !meme_templates', contextSource: 'trigger', hasNamePrefix: true }],
      'BotUser'
    );
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
      client: { user: { id: 'bot-id', username: 'BotUser' } },
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
      client: { user: { id: 'bot-id', username: 'BotUser' } },
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

  function createSourceMessage() {
    return {
      reply: jest.fn().mockResolvedValue(undefined),
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

    const source = createSourceMessage();
    const apiResult = {
      success: true,
      data: { images: ['http://comfyui/img.png'] },
    };

    await (messageHandler as any).handleComfyUIResponse(apiResult, source, 'testuser');

    expect(source.reply).toHaveBeenCalledWith(
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

    const source = createSourceMessage();
    const apiResult = {
      success: true,
      data: { images: ['http://comfyui/img.png'] },
    };

    await (messageHandler as any).handleComfyUIResponse(apiResult, source, 'testuser');

    expect(source.reply).toHaveBeenCalledWith(
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

    const source = createSourceMessage();
    const apiResult = {
      success: true,
      data: { images: ['http://comfyui/img.png'] },
    };

    await (messageHandler as any).handleComfyUIResponse(apiResult, source, 'testuser');

    expect(source.reply).toHaveBeenCalledWith(
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
      client: { user: { id: botUserId, username: 'BotUser' } },
      channel: {
        type: 0, // GuildText
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
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
      react: jest.fn().mockResolvedValue(undefined),
      reactions: { resolve: jest.fn(() => ({ users: { remove: jest.fn().mockResolvedValue(undefined) } })) },
    };
  }

  it('should use quoted content when user replies with only the keyword', async () => {
    (config.getKeywords as jest.Mock).mockReturnValue([
      { keyword: '!generate', api: 'comfyui', timeout: 300, description: 'Image gen' },
    ]);
    const mockExecuteRoutedRequest = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;
    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: {
        success: true,
        data: { images: ['http://comfyui/img.png'] },
      },
      finalApi: 'comfyui',
      stages: [],
    });

    const msg = createComfyUIReplyMessage(
      '<@bot-123> !generate',
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
      client: { user: { id: botUserId, username: 'BotUser' } },
      channel: {
        type: 0,
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
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
      react: jest.fn().mockResolvedValue(undefined),
      reactions: { resolve: jest.fn(() => ({ users: { remove: jest.fn().mockResolvedValue(undefined) } })) },
    };
  }

  const weatherKw = { keyword: '!weather', api: 'accuweather' as const, timeout: 60, description: 'Weather' };
  const nflKw = { keyword: '!nfl' as const, api: 'nfl' as const, timeout: 30, description: 'NFL generic' };
  const nflScoresKw = { keyword: '!nfl scores' as const, api: 'nfl' as const, timeout: 30, description: 'NFL scores' };
  const generateKw = { keyword: '!generate', api: 'comfyui' as const, timeout: 300, description: 'Image gen' };

  beforeEach(() => {
    jest.clearAllMocks();
    (config.getKeywords as jest.Mock).mockReturnValue([weatherKw, nflKw, nflScoresKw, generateKw]);
  });

  it('should route to API when keyword is at message start', async () => {
    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Sunny' } },
      finalApi: 'accuweather',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> !weather 45403');
    await messageHandler.handleMessage(msg);

    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      weatherKw,
      '45403',
      'testuser',
      [{ role: 'user', content: 'testuser: 45403', contextSource: 'trigger', hasNamePrefix: true }],
      'BotUser'
    );
  });

  it('should prefer longer keyword when both match at start', async () => {
    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Scores' } },
      finalApi: 'nfl',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> !nfl scores 20251116');
    await messageHandler.handleMessage(msg);

    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      nflScoresKw,
      '20251116',
      'testuser',
      [{ role: 'user', content: 'testuser: 20251116', contextSource: 'trigger', hasNamePrefix: true }],
      'BotUser'
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

  it('should handle routed pipeline error with reaction only (no text reply)', async () => {
    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: false, error: 'Pipeline failed' },
      finalApi: 'comfyui',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> !generate something');
    await messageHandler.handleMessage(msg);

    // Should add error reaction
    expect(msg.react).toHaveBeenCalledWith('❌');
    // Should NOT send a text reply with the error
    expect(msg.reply).not.toHaveBeenCalledWith(
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

  // ── SerpAPI "second opinion" routing regression ─────────────

  it('should route "second opinion" keyword to SerpAPI via executeRoutedRequest', async () => {
    const searchKw = { keyword: '!search', api: 'serpapi' as const, timeout: 60, description: 'Search the web' };
    const secondOpinionKw = { keyword: '!second opinion', api: 'serpapi' as const, timeout: 60, description: 'Get a second opinion via Google' };
    (config.getKeywords as jest.Mock).mockReturnValue([searchKw, secondOpinionKw, weatherKw, generateKw]);

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: '🔎 **Second opinion for:** *is water wet*\n\n🤖 **Google AI Overview:**\n> Water is wet.' } },
      finalApi: 'serpapi',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> !second opinion is water wet');
    await messageHandler.handleMessage(msg);

    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      secondOpinionKw,
      'is water wet',
      'testuser',
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', contextSource: 'trigger' }),
      ]),
      'BotUser'
    );
  });

  it('should prefer "second opinion" (longer) over "search" when both match at start', async () => {
    const searchKw = { keyword: '!search', api: 'serpapi' as const, timeout: 60, description: 'Search the web' };
    const secondOpinionKw = { keyword: '!second opinion', api: 'serpapi' as const, timeout: 60, description: 'Get a second opinion via Google' };
    (config.getKeywords as jest.Mock).mockReturnValue([searchKw, secondOpinionKw]);

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'overview text' } },
      finalApi: 'serpapi',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> !second opinion about AI');
    await messageHandler.handleMessage(msg);

    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      secondOpinionKw,
      'about AI',
      'testuser',
      expect.any(Array),
      'BotUser'
    );
  });

  it('should NOT route to SerpAPI when "second opinion" appears in the middle of the message', async () => {
    const searchKw = { keyword: '!search', api: 'serpapi' as const, timeout: 60, description: 'Search the web' };
    const secondOpinionKw = { keyword: '!second opinion', api: 'serpapi' as const, timeout: 60, description: 'Get a second opinion via Google' };
    (config.getKeywords as jest.Mock).mockReturnValue([searchKw, secondOpinionKw, weatherKw, generateKw]);

    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValue({
      success: true,
      data: { text: 'chat response' },
    });

    const mockClassifyIntent = classifyIntent as jest.MockedFunction<typeof classifyIntent>;
    mockClassifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: true });

    const msg = createMentionedMessage('<@bot-123> I want a second opinion on this');
    await messageHandler.handleMessage(msg);

    // Should NOT have used the routed pipeline — keyword was not at message start
    expect(mockExecuteRoutedRequest).not.toHaveBeenCalled();
    expect(requestQueue.execute).toHaveBeenCalled();
  });
});

describe('MessageHandler SerpAPI second opinion — AIO fallback behavior', () => {
  const mockExecuteRoutedRequest = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;

  const secondOpinionKw = { keyword: '!second opinion', api: 'serpapi' as const, timeout: 60, description: 'Get a second opinion via Google' };

  function createMentionedMessage(content: string): any {
    const botUserId = 'bot-123';
    return {
      author: { bot: false, id: 'user-1', username: 'testuser' },
      client: { user: { id: botUserId, username: 'BotUser' } },
      channel: {
        type: 0,
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
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
      react: jest.fn().mockResolvedValue(undefined),
      reactions: { resolve: jest.fn(() => ({ users: { remove: jest.fn().mockResolvedValue(undefined) } })) },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (config.getKeywords as jest.Mock).mockReturnValue([secondOpinionKw]);
  });

  it('should show user-facing fallback text when AIO is absent — not a generic error', async () => {
    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: {
        success: true,
        data: {
          text: '🔎 **Second opinion for:** *niche topic*\n\n⚠️ Google did not return an AI Overview for this query.\nThis can happen when the topic is too niche, ambiguous, or not well-suited for an AI-generated summary.\n💡 *Tip: Try rephrasing your query or using the **search** keyword for full results.*',
          raw: {},
        },
      },
      finalApi: 'serpapi',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> !second opinion niche topic');
    await messageHandler.handleMessage(msg);

    expect(msg.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('⚠️ Google did not return an AI Overview'),
      })
    );
    expect(msg.reply).not.toHaveBeenCalledWith(
      expect.stringContaining('Pipeline failed')
    );
  });

  it('should show AIO error message when ai_overview.error propagates through handler', async () => {
    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: {
        success: true,
        data: {
          text: '🔎 **Second opinion for:** *restricted*\n\n⚠️ Google AI Overview returned an error: Content restriction\nThis can happen when the topic is too niche, ambiguous, or not well-suited for an AI-generated summary.\n💡 *Tip: Try rephrasing your query or using the **search** keyword for full results.*',
          raw: {},
        },
      },
      finalApi: 'serpapi',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> !second opinion restricted');
    await messageHandler.handleMessage(msg);

    expect(msg.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('⚠️ Google AI Overview returned an error'),
      })
    );
  });

  it('should show generic pipeline error reaction when SerpAPI request itself fails', async () => {
    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: false, error: 'SerpAPI key is not configured' },
      finalApi: 'serpapi',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> !second opinion test');
    await messageHandler.handleMessage(msg);

    expect(msg.react).toHaveBeenCalledWith('❌');
    expect(msg.reply).not.toHaveBeenCalledWith(
      expect.stringContaining('⚠️')
    );
  });
});

describe('MessageHandler SerpAPI find content keyword routing', () => {
  const mockExecuteRoutedRequest = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;

  const findContentKw = { keyword: '!find content', api: 'serpapi' as const, timeout: 60, description: 'Find pertinent web content', contextFilterMaxDepth: 1 };

  function createMentionedMessage(content: string): any {
    const botUserId = 'bot-123';
    return {
      author: { bot: false, id: 'user-1', username: 'testuser' },
      client: { user: { id: botUserId, username: 'BotUser' } },
      channel: {
        type: 0,
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
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
    (config.getKeywords as jest.Mock).mockReturnValue([findContentKw]);
    (classifyIntent as jest.MockedFunction<typeof classifyIntent>)
      .mockResolvedValue({ keywordConfig: null, wasClassified: false });
    (parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>)
      .mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });
  });

  it('should route "find content <topic>" through serpapi pipeline', async () => {
    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: {
        success: true,
        data: {
          text: '🔎 **Search results for:** *TypeScript generics*\n\nResult 1...',
          raw: {},
        },
      },
      finalApi: 'serpapi',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> !find content TypeScript generics');
    await messageHandler.handleMessage(msg);

    expect(msg.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Search results for'),
      })
    );
    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: '!find content', api: 'serpapi' }),
      'TypeScript generics',
      'testuser',
      expect.any(Array),
      'BotUser'
    );
  });

  it('should reject "find content" with no extra text (allowEmptyContent absent)', async () => {
    const { logger } = require('../src/utils/logger');
    const msg = createMentionedMessage('<@bot-123> !find content');
    await messageHandler.handleMessage(msg);

    expect(msg.reply).toHaveBeenCalledWith(
      'Please include a prompt or question after the keyword!'
    );
    expect(logger.logIgnored).toHaveBeenCalled();
  });
});

describe('MessageHandler standalone help keyword uses actual config flag', () => {
  const mockExecuteRoutedRequest = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;

  const helpKw = { keyword: '!help', api: 'ollama' as const, timeout: 120, description: 'Show help', builtin: true, allowEmptyContent: true };

  function createDmMessage(content: string): any {
    const sharedGuild = {
      id: 'guild-shared',
      members: { cache: new Map([['user-1', { user: { id: 'user-1' } }]]), fetch: jest.fn() },
    };
    return {
      author: { bot: false, id: 'user-1', username: 'testuser' },
      client: { user: { id: 'bot-123', username: 'BotUser' }, guilds: { cache: new Map([['guild-shared', sharedGuild]]) } },
      channel: {
        type: 1,
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
        send: jest.fn(),
      },
      guild: null,
      mentions: { has: jest.fn(() => false) },
      reference: null,
      content,
      id: 'dm-help-1',
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
      }),
      fetchReference: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (config.getKeywords as jest.Mock).mockReturnValue([helpKw]);
    (classifyIntent as jest.MockedFunction<typeof classifyIntent>)
      .mockResolvedValue({ keywordConfig: null, wasClassified: false });
    (parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>)
      .mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });
  });

  it('should NOT reject standalone "help" when allowEmptyContent is true', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValue({
      success: true,
      data: { text: 'Here is what I can help with.' },
    });

    const msg = createDmMessage('help');
    await messageHandler.handleMessage(msg);

    expect(msg.reply).not.toHaveBeenCalledWith(
      'Please include a prompt or question after the keyword!'
    );
    expect(msg.reply).toHaveBeenCalled();
  });

  it('should reject standalone "help" when allowEmptyContent is absent', async () => {
    const { logger } = require('../src/utils/logger');
    const helpNoEmpty = { keyword: '!help', api: 'ollama' as const, timeout: 120, description: 'Show help', builtin: true };
    (config.getKeywords as jest.Mock).mockReturnValue([helpNoEmpty]);

    const msg = createDmMessage('!help');
    await messageHandler.handleMessage(msg);

    expect(msg.reply).toHaveBeenCalledWith(
      'Please include a prompt or question after the keyword!'
    );
    expect(logger.logIgnored).toHaveBeenCalled();
  });
});

describe('MessageHandler two-stage evaluation', () => {
  const mockClassifyIntent = classifyIntent as jest.MockedFunction<typeof classifyIntent>;
  const mockExecuteRoutedRequest = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;
  const mockParseFirstLineKeyword = parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>;

  function createMentionedMessage(content: string): any {
    const botUserId = 'bot-123';
    return {
      author: { bot: false, id: 'user-1', username: 'testuser' },
      client: { user: { id: botUserId, username: 'BotUser' } },
      channel: {
        type: 0,
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
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
    mockParseFirstLineKeyword.mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });
  });

  it('should return Ollama response as direct chat when model does not include keyword directive', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');

    // Ollama response — no keyword directive on first line
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'I can check the weather for you!' },
    });

    // parseFirstLineKeyword does NOT match (no directive on first line)
    mockParseFirstLineKeyword.mockReturnValueOnce({
      keywordConfig: null,
      parsedLine: '',
      matched: false,
    });

    const msg = createMentionedMessage('<@bot-123> is it going to rain in Seattle');
    await messageHandler.handleMessage(msg);

    // classifyIntent should NOT be called (classifier second-pass removed)
    expect(mockClassifyIntent).not.toHaveBeenCalled();

    // No API routing — Ollama response returned as direct chat
    expect(mockExecuteRoutedRequest).not.toHaveBeenCalled();

    expect(msg.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'I can check the weather for you!' })
    );
  });

  it('should route using inferred first-line parameters when provided by parser', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');

    const weatherKeyword = {
      keyword: '!weather',
      api: 'accuweather' as const,
      timeout: 60,
      description: 'Get weather',
    };

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'weather: Seattle, WA\nLet me check that.' },
    });

    mockParseFirstLineKeyword.mockReturnValueOnce({
      keywordConfig: weatherKeyword,
      parsedLine: 'weather seattle wa',
      matched: true,
      inferredInput: 'Seattle, WA',
    });

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Sunny in Seattle' } },
      finalApi: 'accuweather',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> is it going to rain in Seattle');
    await messageHandler.handleMessage(msg);

    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ ...weatherKeyword, finalOllamaPass: true }),
      'Seattle, WA',
      'testuser',
      [{ role: 'user', content: 'testuser: is it going to rain in Seattle', contextSource: 'trigger', hasNamePrefix: true }],
      'BotUser'
    );
  });

  it('should send commentary prelude and inline-replace directive keyword before routed response', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');

    const weatherKeyword = {
      keyword: '!weather',
      api: 'accuweather' as const,
      timeout: 60,
      description: 'Get weather',
    };

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Commentary + directive' },
    });

    mockParseFirstLineKeyword.mockReturnValueOnce({
      keywordConfig: weatherKeyword,
      parsedLine: 'weather seattle wa',
      matched: true,
      inferredInput: 'Seattle, WA',
      commentaryText: 'Sure — running !weather now.',
    });

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Sunny in Seattle' } },
      finalApi: 'accuweather',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> weather seattle');
    await messageHandler.handleMessage(msg);

    expect(msg.reply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ content: 'Sure — running Seattle, WA now.' })
    );
    expect(msg.reply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ content: 'Sunny in Seattle' })
    );
  });

  it('should preserve inline inferred params for keyword-only implicit ability invocation', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');

    const imagineKeyword = {
      keyword: 'imagine',
      api: 'comfyui' as const,
      timeout: 120,
      description: 'Generate image using alternate keyword',
      abilityInputs: {
        mode: 'implicit' as const,
        inferFrom: ['current_message', 'reply_target'],
      },
    };

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: '!imagine alien guy saying "whoa, aliens"' },
    });

    mockParseFirstLineKeyword.mockReturnValueOnce({
      keywordConfig: imagineKeyword,
      parsedLine: '!imagine alien guy saying "whoa, aliens"',
      matched: true,
      inferredInput: 'alien guy saying "whoa, aliens"',
    });

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { images: ['http://localhost/image.png'] } },
      finalApi: 'comfyui',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> imagine');
    await messageHandler.handleMessage(msg);

    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ ...imagineKeyword, finalOllamaPass: false }),
      'alien guy saying "whoa, aliens"',
      'testuser',
      [{ role: 'user', content: 'testuser: imagine', contextSource: 'trigger', hasNamePrefix: true }],
      'BotUser'
    );
  });

  it('should force finalOllamaPass true for model-inferred abilities even when keyword config omits it', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');

    const searchKeyword = {
      keyword: '!search',
      api: 'serpapi' as const,
      timeout: 60,
      description: 'Search web',
      // finalOllamaPass deliberately omitted (defaults to undefined/false)
    };

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'search: latest AI news\nLet me look that up.' },
    });

    mockParseFirstLineKeyword.mockReturnValueOnce({
      keywordConfig: searchKeyword,
      parsedLine: 'search latest ai news',
      matched: true,
      inferredInput: 'latest AI news',
    });

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Top results...' } },
      finalApi: 'serpapi',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> find latest AI news');
    await messageHandler.handleMessage(msg);

    // Model-inferred abilities must always set finalOllamaPass: true
    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ ...searchKeyword, finalOllamaPass: true }),
      'latest AI news',
      'testuser',
      expect.anything(),
      'BotUser'
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

    expect(msg.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'The meaning of life is 42.' })
    );
  });

  it('should not route fallback API when user input is an unknown command-style message', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Which meme template (and any top/bottom text) should I use?' },
    });

    const memeKeyword = {
      keyword: '!meme',
      api: 'meme' as const,
      timeout: 60,
      description: 'Create meme images',
    };

    mockClassifyIntent.mockResolvedValueOnce({
      keywordConfig: memeKeyword,
      wasClassified: true,
    });

    const msg = createMentionedMessage('<@bot-123> !meme_template');
    await messageHandler.handleMessage(msg);

    expect(mockExecuteRoutedRequest).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Which meme template (and any top/bottom text) should I use?' })
    );
  });

  it('should suppress fallback meme routing when original user content is not meme intent', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'The square root is 16.' },
    });

    const memeKeyword = {
      keyword: '!meme',
      api: 'meme' as const,
      timeout: 60,
      description: 'Create meme images',
    };

    mockClassifyIntent.mockResolvedValueOnce({
      keywordConfig: memeKeyword,
      wasClassified: true,
    });

    const msg = createMentionedMessage('<@bot-123> what is the square root of 256');
    await messageHandler.handleMessage(msg);

    expect(mockExecuteRoutedRequest).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'The square root is 16.' })
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
      keywordConfig: { keyword: '!chat', api: 'ollama' as const, timeout: 300, description: 'Chat' },
      wasClassified: true,
    });

    const msg = createMentionedMessage('<@bot-123> tell me a joke');
    await messageHandler.handleMessage(msg);

    // Should NOT route to API since the keyword is ollama
    expect(mockExecuteRoutedRequest).not.toHaveBeenCalled();
  });

  it('should use XML prompt via assemblePrompt for Ollama call', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    const { apiManager } = require('../src/api');

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

    // assemblePrompt should have been called
    const mockAssemblePrompt = assemblePrompt as jest.MockedFunction<typeof assemblePrompt>;
    expect(mockAssemblePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: 'hello',
      })
    );

    // apiManager.executeRequest should have been called with system content
    // from the assembled prompt, and includeSystemPrompt: false
    expect(apiManager.executeRequest).toHaveBeenCalledWith(
      'ollama',
      'testuser',
      expect.stringContaining('<current_question>'),
      expect.any(Number),
      undefined,
      expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.any(String),
        }),
      ]),
      expect.anything(),
      undefined,
      { includeSystemPrompt: false }
    );
  });
});

describe('MessageHandler trigger message attribution', () => {
  const mockClassifyIntent = classifyIntent as jest.MockedFunction<typeof classifyIntent>;
  const mockExecuteRoutedRequest = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;
  const mockParseFirstLineKeyword = parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>;

  function createMentionedMessage(content: string, username = 'testuser'): any {
    const botUserId = 'bot-123';
    return {
      author: { bot: false, id: 'user-1', username },
      client: { user: { id: botUserId, username: 'BotUser' } },
      channel: {
        type: 0,
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
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
    mockClassifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: false });
    mockParseFirstLineKeyword.mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });
  });

  it('should append trigger message with contextSource for direct keyword path', async () => {
    const weatherKw = { keyword: '!weather', api: 'accuweather' as const, timeout: 60, description: 'Weather' };
    (config.getKeywords as jest.Mock).mockReturnValue([weatherKw]);

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Sunny' } },
      finalApi: 'accuweather',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> !weather Seattle');
    await messageHandler.handleMessage(msg);

    // Should have trigger message with contextSource: 'trigger'
    expect(mockExecuteRoutedRequest).toHaveBeenCalledWith(
      weatherKw,
      'Seattle',
      'testuser',
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'testuser: Seattle',
          contextSource: 'trigger',
        }),
      ]),
      'BotUser'
    );
  });

  it('should not duplicate trigger message when two-stage path routes to API with finalOllamaPass', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');

    const weatherKwWithFinalPass = {
      keyword: '!weather',
      api: 'accuweather' as const,
      timeout: 120,
      description: 'Weather',
      finalOllamaPass: true,
    };
    (config.getKeywords as jest.Mock).mockReturnValue([]);

    // Stage 1: Ollama response
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'weather\nLet me check the weather for you.' },
    });

    // parseFirstLineKeyword matches "weather"
    mockParseFirstLineKeyword.mockReturnValueOnce({
      keywordConfig: weatherKwWithFinalPass,
      parsedLine: 'weather',
      matched: true,
    });

    // executeRoutedRequest call
    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Beautiful day in Seattle!' } },
      finalApi: 'ollama',
      stages: [],
    });

    const msg = createMentionedMessage('<@bot-123> is it going to rain in Seattle');
    await messageHandler.handleMessage(msg);

    // Verify executeRoutedRequest receives history with trigger message
    const callArgs = mockExecuteRoutedRequest.mock.calls[0];
    const history = callArgs[3] as Array<{ role: string; content: string; contextSource?: string }>;

    // The trigger message should appear exactly ONCE
    const triggerMessages = history.filter(m => m.contextSource === 'trigger');
    expect(triggerMessages).toHaveLength(1);
    expect(triggerMessages[0]).toEqual({
      role: 'user',
      content: 'testuser: is it going to rain in Seattle',
      contextSource: 'trigger',
      hasNamePrefix: true,
    });
  });

  it('should properly form trigger message when content has special characters', async () => {
    const weatherKw = { keyword: '!weather', api: 'accuweather' as const, timeout: 60, description: 'Weather' };
    (config.getKeywords as jest.Mock).mockReturnValue([weatherKw]);

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Sunny' } },
      finalApi: 'accuweather',
      stages: [],
    });

    const specialContent = 'São Paulo <script>alert("xss")</script> & "quotes" \'apostrophes\'';
    const msg = createMentionedMessage(`<@bot-123> !weather ${specialContent}`);
    await messageHandler.handleMessage(msg);

    const callArgs = mockExecuteRoutedRequest.mock.calls[0];
    const history = callArgs[3] as Array<{ role: string; content: string; contextSource?: string }>;
    const triggerMsg = history.find(m => m.contextSource === 'trigger');

    expect(triggerMsg).toBeDefined();
    expect(triggerMsg!.content).toBe(`testuser: ${specialContent}`);
  });
});

describe('MessageHandler DM handling', () => {
  function createDmMessage(content: string): any {
    const botUserId = 'bot-123';
    const sharedGuild = {
      id: 'guild-shared',
      members: { cache: new Map([['user-1', { user: { id: 'user-1' } }]]), fetch: jest.fn() },
    };
    return {
      author: { bot: false, id: 'user-1', username: 'dmuser' },
      client: { user: { id: botUserId, username: 'BotUser' }, guilds: { cache: new Map([['guild-shared', sharedGuild]]) } },
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
    (parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>)
      .mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });
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
    const sharedGuild = {
      id: 'guild-shared',
      members: { cache: new Map([['user-1', { user: { id: 'user-1' } }]]), fetch: jest.fn() },
    };
    return {
      author: { bot: false, id: 'user-1', username: 'nfluser' },
      client: { user: { id: botUserId, username: 'BotUser' }, guilds: { cache: new Map([['guild-shared', sharedGuild]]) } },
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
      { keyword: '!nfl scores', api: 'nfl', timeout: 30, description: 'All scores', allowEmptyContent: true },
      { keyword: '!nfl news', api: 'nfl', timeout: 30, description: 'NFL news', allowEmptyContent: true },
      { keyword: '!generate', api: 'comfyui', timeout: 60, description: 'Generate image' },
    ]);
    (classifyIntent as jest.MockedFunction<typeof classifyIntent>)
      .mockResolvedValue({ keywordConfig: null, wasClassified: false });
    (parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>)
      .mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });
  });

  it('should NOT reply with empty-content error for "nfl scores" with no extra text', async () => {
    const mockRouted = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;
    mockRouted.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: '🏈 **NFL Scores**\n\n✅ Some game' } },
      finalApi: 'nfl',
      stages: [],
    });

    const msg = createDmMessage('!nfl scores');
    await messageHandler.handleMessage(msg);

    // Should NOT show the "please include a prompt" message
    expect(msg.reply).not.toHaveBeenCalledWith(
      'Please include a prompt or question after the keyword!'
    );
    // Should have called executeRoutedRequest
    expect(mockRouted).toHaveBeenCalled();
  });

  it('should still reject empty content for keywords without allowEmptyContent', async () => {
    const { logger } = require('../src/utils/logger');
    const msg = createDmMessage('!generate');
    await messageHandler.handleMessage(msg);

    // Should show the "please include a prompt" message
    expect(msg.reply).toHaveBeenCalledWith(
      'Please include a prompt or question after the keyword!'
    );
    expect(logger.logIgnored).toHaveBeenCalled();
  });

  it('should NOT reply with empty-content error for "nfl news" with no extra text', async () => {
    const mockRouted = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;
    mockRouted.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: '📰 **NFL News**\n\nStory 1' } },
      finalApi: 'nfl',
      stages: [],
    });

    const msg = createDmMessage('!nfl news');
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

  const ctxEvalKw = {
    keyword: '!chat',
    api: 'ollama' as const,
    timeout: 300,
    description: 'Chat',
    contextFilterEnabled: true,
    contextFilterMinDepth: 1,
    contextFilterMaxDepth: 5,
  };

  function createMentionedMsg(content: string, hasReference = false) {
    return {
      author: { id: 'user-1', bot: false, username: 'ctxuser', displayName: 'CtxUser' },
      content,
      mentions: { has: () => true },
      channel: {
        type: 0,
        isThread: () => false,
        messages: {
          cache: new Map(),
          fetch: jest.fn().mockResolvedValue(new Map()),
        },
      },
      client: { user: { id: 'bot-123', username: 'BotUser' } },
      reference: hasReference ? { messageId: 'ref-1' } : null,
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn(),
        attachments: { size: 0 },
        embeds: [],
      }),
      attachments: { size: 0 },
      id: 'ctx-msg-1',
      fetchReference: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (config.getKeywords as jest.Mock).mockReturnValue([ctxEvalKw]);
    (config.getReplyChainEnabled as jest.Mock).mockReturnValue(true);
    mockEvaluate.mockImplementation((history: any) => Promise.resolve(history));
  });

  it('should not call evaluateContextWindow when channel history is empty and no reply', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    const { classifyIntent } = require('../src/utils/keywordClassifier');
    const { parseFirstLineKeyword } = require('../src/utils/promptBuilder');

    classifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: false });
    parseFirstLineKeyword.mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });

    // Ollama direct chat response
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Just chatting!' },
    });

    const msg = createMentionedMsg('<@bot-123> chat hello there');
    // channel.messages.fetch returns empty — no channel context
    await messageHandler.handleMessage(msg as any);

    // Empty channel history means no history — evaluator should not be called
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('should call evaluateContextWindow when channel history is non-empty (guild mention, no reply)', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    const { classifyIntent } = require('../src/utils/keywordClassifier');
    const { parseFirstLineKeyword } = require('../src/utils/promptBuilder');

    classifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: false });
    parseFirstLineKeyword.mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Chatting with context!' },
    });

    const msg = createMentionedMsg('<@bot-123> !chat hello there');

    // Channel has prior messages
    const channelHistory = new Map([
      ['ch-1', {
        id: 'ch-1',
        content: 'Earlier channel message',
        author: { id: 'user-2', bot: false, username: 'other' },
        member: null,
        createdTimestamp: 1000,
      }],
    ]);
    msg.channel.messages.fetch.mockResolvedValue(channelHistory);

    await messageHandler.handleMessage(msg as any);

    // Channel history was collected → evaluator should be called
    expect(mockEvaluate).toHaveBeenCalled();
  });

  it('should apply configured chat context filter for no-keyword default chat fallback', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    const { classifyIntent } = require('../src/utils/keywordClassifier');
    const { parseFirstLineKeyword } = require('../src/utils/promptBuilder');

    classifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: false });
    parseFirstLineKeyword.mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Default chat with context eval.' },
    });

    const msg = createMentionedMsg('<@bot-123> tell me more');

    const channelHistory = new Map([
      ['ch-1', {
        id: 'ch-1',
        content: 'Earlier context message',
        author: { id: 'user-2', bot: false, username: 'other' },
        member: null,
        createdTimestamp: 1000,
      }],
    ]);
    msg.channel.messages.fetch.mockResolvedValue(channelHistory);

    await messageHandler.handleMessage(msg as any);

    expect(mockEvaluate).toHaveBeenCalled();
  });

  it('should skip evaluateContextWindow when contextFilterEnabled is false', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    const { classifyIntent } = require('../src/utils/keywordClassifier');
    const { parseFirstLineKeyword } = require('../src/utils/promptBuilder');

    // Override with keyword that has contextFilterEnabled omitted (defaults to false)
    const noEvalKw = {
      keyword: '!weather',
      api: 'accuweather' as const,
      timeout: 60,
      description: 'Weather',
      contextFilterMinDepth: 1,
      contextFilterMaxDepth: 5,
      // contextFilterEnabled intentionally omitted → defaults to false
    };
    (config.getKeywords as jest.Mock).mockReturnValue([noEvalKw]);

    classifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: false });
    parseFirstLineKeyword.mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Chatting without eval!' },
    });

    const msg = createMentionedMsg('<@bot-123> hello there');

    // Channel has prior messages
    const channelHistory = new Map([
      ['ch-1', {
        id: 'ch-1',
        content: 'Earlier channel message',
        author: { id: 'user-2', bot: false, username: 'other' },
        member: null,
        createdTimestamp: 1000,
      }],
    ]);
    msg.channel.messages.fetch.mockResolvedValue(channelHistory);

    await messageHandler.handleMessage(msg as any);

    // contextFilterEnabled is off → evaluator should NOT be called even with history
    expect(mockEvaluate).not.toHaveBeenCalled();
  });
});

describe('MessageHandler collectChannelHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (config.getReplyChainMaxDepth as jest.Mock).mockReturnValue(30);
    (config.getReplyChainMaxTokens as jest.Mock).mockReturnValue(16000);
  });

  function createGuildMsg(
    channelMessages: Map<string, any>,
    isThread = false
  ): any {
    return {
      id: 'current-msg',
      content: 'test',
      author: { id: 'user-1', bot: false, username: 'testuser' },
      client: { user: { id: 'bot-id', username: 'BotUser' } },
      channel: {
        type: 0,
        isThread: () => isThread,
        messages: {
          cache: new Map(),
          fetch: jest.fn().mockResolvedValue(channelMessages),
        },
      },
      member: null,
    };
  }

  it('should collect channel messages with source context', async () => {
    // Discord returns messages newest-first
    const messages = new Map([
      ['msg-2', {
        id: 'msg-2',
        content: 'Bot reply',
        author: { id: 'bot-id', bot: true, username: 'bot' },
        member: null,
        createdTimestamp: 2000,
      }],
      ['msg-1', {
        id: 'msg-1',
        content: 'Hello from user',
        author: { id: 'user-2', bot: false, username: 'alice' },
        member: { displayName: 'Alice' },
        createdTimestamp: 1000,
      }],
    ]);

    const msg = createGuildMsg(messages);
    const result = await messageHandler.collectChannelHistory(msg);

    expect(result).toHaveLength(2);
    expect(result[0].contextSource).toBe('channel');
    expect(result[0].discordMessageId).toBe('msg-1');
    expect(result[1].role).toBe('assistant');
  });

  it('should tag thread messages with contextSource "thread"', async () => {
    const messages = new Map([
      ['msg-1', {
        id: 'msg-1',
        content: 'Thread msg',
        author: { id: 'user-2', bot: false, username: 'alice' },
        member: null,
        createdTimestamp: 1000,
      }],
    ]);

    const msg = createGuildMsg(messages, true);
    const result = await messageHandler.collectChannelHistory(msg);

    expect(result[0].contextSource).toBe('thread');
  });

  it('should skip processing messages', async () => {
    const messages = new Map([
      ['msg-1', {
        id: 'msg-1',
        content: '⏳ Processing your request...',
        author: { id: 'bot-id', bot: true, username: 'bot' },
        member: null,
        createdTimestamp: 1000,
      }],
      ['msg-2', {
        id: 'msg-2',
        content: 'Real message',
        author: { id: 'user-2', bot: false, username: 'alice' },
        member: null,
        createdTimestamp: 2000,
      }],
    ]);

    const msg = createGuildMsg(messages);
    const result = await messageHandler.collectChannelHistory(msg);

    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('Real message');
  });

  it('should prefix display names for multi-user channels', async () => {
    // Discord returns messages newest-first
    const messages = new Map([
      ['msg-2', {
        id: 'msg-2',
        content: 'Second user msg',
        author: { id: 'user-3', bot: false, username: 'charlie' },
        member: { displayName: 'Charlie' },
        createdTimestamp: 2000,
      }],
      ['msg-1', {
        id: 'msg-1',
        content: 'First user msg',
        author: { id: 'user-2', bot: false, username: 'alice' },
        member: { displayName: 'Alice' },
        createdTimestamp: 1000,
      }],
    ]);

    const msg = createGuildMsg(messages);
    const result = await messageHandler.collectChannelHistory(msg);

    expect(result[0].content).toBe('Alice: First user msg');
    expect(result[1].content).toBe('Charlie: Second user msg');
  });

  it('should return empty array when fetch fails', async () => {
    const msg = createGuildMsg(new Map());
    msg.channel.messages.fetch.mockRejectedValue(new Error('No permission'));

    const result = await messageHandler.collectChannelHistory(msg);
    expect(result).toEqual([]);
  });

  it('should respect character budget, keeping newest messages', async () => {
    (config.getReplyChainMaxTokens as jest.Mock).mockReturnValue(20);
    // Discord returns messages newest-first in the Map
    const messages = new Map([
      ['msg-2', {
        id: 'msg-2',
        content: 'Short',
        author: { id: 'user-2', bot: false, username: 'alice' },
        member: null,
        createdTimestamp: 2000,
      }],
      ['msg-1', {
        id: 'msg-1',
        content: 'This message is way too long to fit in the budget',
        author: { id: 'user-2', bot: false, username: 'alice' },
        member: null,
        createdTimestamp: 1000,
      }],
    ]);

    const msg = createGuildMsg(messages);
    const result = await messageHandler.collectChannelHistory(msg);

    // Newest message (msg-2) should survive; oldest (msg-1) dropped to fit budget
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('alice: Short');
    expect(result[0].discordMessageId).toBe('msg-2');
  });
});

describe('MessageHandler collateGuildContext', () => {
  it('should merge reply and channel context, deduplicating by messageId', () => {
    const replyContext = [
      { role: 'user' as const, content: 'reply msg', contextSource: 'reply' as const, discordMessageId: 'msg-1', createdAtMs: 1000 },
    ];
    const channelContext = [
      { role: 'user' as const, content: 'reply msg dupe', contextSource: 'channel' as const, discordMessageId: 'msg-1', createdAtMs: 1000 },
      { role: 'assistant' as const, content: 'bot reply', contextSource: 'channel' as const, discordMessageId: 'msg-2', createdAtMs: 2000 },
    ];

    const result = messageHandler.collateGuildContext(replyContext, channelContext, 30, 16000);

    // msg-1 should appear only once (from reply context)
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('reply msg');
    expect(result[0].contextSource).toBe('reply');
    expect(result[1].discordMessageId).toBe('msg-2');
  });

  it('should enforce maxDepth, prioritizing reply/thread context', () => {
    const replyContext = [
      { role: 'user' as const, content: 'p1', contextSource: 'reply' as const, discordMessageId: 'p1', createdAtMs: 1000 },
      { role: 'user' as const, content: 'p2', contextSource: 'reply' as const, discordMessageId: 'p2', createdAtMs: 2000 },
    ];
    const channelContext = [
      { role: 'user' as const, content: 's1', contextSource: 'channel' as const, discordMessageId: 's1', createdAtMs: 500 },
      { role: 'user' as const, content: 's2', contextSource: 'channel' as const, discordMessageId: 's2', createdAtMs: 3000 },
    ];

    // maxDepth = 3: all 2 reply + 1 channel
    const result = messageHandler.collateGuildContext(replyContext, channelContext, 3, 16000);

    expect(result).toHaveLength(3);
    // All reply context should be present
    expect(result.filter(m => m.contextSource === 'reply')).toHaveLength(2);
  });

  it('should sort collated result chronologically', () => {
    const replyContext = [
      { role: 'user' as const, content: 'p1', contextSource: 'reply' as const, discordMessageId: 'p1', createdAtMs: 3000 },
    ];
    const channelContext = [
      { role: 'user' as const, content: 's1', contextSource: 'channel' as const, discordMessageId: 's1', createdAtMs: 1000 },
      { role: 'user' as const, content: 's2', contextSource: 'channel' as const, discordMessageId: 's2', createdAtMs: 5000 },
    ];

    const result = messageHandler.collateGuildContext(replyContext, channelContext, 30, 16000);

    expect(result[0].createdAtMs).toBe(1000);
    expect(result[1].createdAtMs).toBe(3000);
    expect(result[2].createdAtMs).toBe(5000);
  });

  it('should work with only channel context (no reply chain)', () => {
    const channelContext = [
      { role: 'user' as const, content: 's1', contextSource: 'channel' as const, discordMessageId: 's1', createdAtMs: 1000 },
      { role: 'assistant' as const, content: 's2', contextSource: 'channel' as const, discordMessageId: 's2', createdAtMs: 2000 },
    ];

    const result = messageHandler.collateGuildContext([], channelContext, 30, 16000);

    expect(result).toHaveLength(2);
    expect(result.every(m => m.contextSource === 'channel')).toBe(true);
  });
});

describe('MessageHandler collectChannelHistory — parameterized depth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (config.getReplyChainMaxDepth as jest.Mock).mockReturnValue(30);
    (config.getReplyChainMaxTokens as jest.Mock).mockReturnValue(16000);
  });

  function createGuildMsg(
    channelMessages: Map<string, any>,
    isThread = false
  ): any {
    return {
      id: 'current-msg',
      content: 'test',
      author: { id: 'user-1', bot: false, username: 'testuser' },
      client: { user: { id: 'bot-id', username: 'BotUser' } },
      channel: {
        type: 0,
        isThread: () => isThread,
        messages: {
          cache: new Map(),
          fetch: jest.fn().mockResolvedValue(channelMessages),
        },
      },
      member: null,
    };
  }

  it('should use passed maxDepth instead of global config', async () => {
    const messages = new Map([
      ['msg-1', {
        id: 'msg-1',
        content: 'Hello',
        author: { id: 'user-2', bot: false, username: 'alice' },
        member: null,
        createdTimestamp: 1000,
      }],
    ]);

    const msg = createGuildMsg(messages);
    await messageHandler.collectChannelHistory(msg, 5, 16000);

    // fetch should use the passed maxDepth (5 + 1 = 6), not global (30 + 1 = 31)
    expect(msg.channel.messages.fetch).toHaveBeenCalledWith({
      limit: 6,
      before: 'current-msg',
    });
  });

  it('should fall back to global config when no params passed', async () => {
    const messages = new Map();
    const msg = createGuildMsg(messages);
    await messageHandler.collectChannelHistory(msg);

    expect(msg.channel.messages.fetch).toHaveBeenCalledWith({
      limit: 31, // global 30 + 1
      before: 'current-msg',
    });
  });
});

describe('MessageHandler guild context — maxContextDepth = min(keyword, global)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (config.getReplyChainEnabled as jest.Mock).mockReturnValue(true);
    (config.getReplyChainMaxDepth as jest.Mock).mockReturnValue(30);
    (config.getReplyChainMaxTokens as jest.Mock).mockReturnValue(16000);
  });

  it('should cap collated context at min(keywordMax, globalMax)', async () => {
    // Keyword has contextFilterMaxDepth = 5, global = 30 → effective = 5
    const kw = {
      keyword: '!chat',
      api: 'ollama' as const,
      timeout: 300,
      description: 'Chat',
      contextFilterEnabled: true,
      contextFilterMaxDepth: 5,
    };
    (config.getKeywords as jest.Mock).mockReturnValue([kw]);

    const { requestQueue } = require('../src/utils/requestQueue');
    const { classifyIntent } = require('../src/utils/keywordClassifier');
    const { parseFirstLineKeyword } = require('../src/utils/promptBuilder');
    const { evaluateContextWindow } = require('../src/utils/contextEvaluator');
    const mockEvaluate = evaluateContextWindow as jest.MockedFunction<typeof evaluateContextWindow>;

    classifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: false });
    parseFirstLineKeyword.mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });
    mockEvaluate.mockImplementation((history: any) => Promise.resolve(history));

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Response!' },
    });

    // Create 10 channel messages — more than the keyword max of 5
    const channelMessages = new Map(
      Array.from({ length: 10 }, (_, i) => [
        `ch-${i}`,
        {
          id: `ch-${i}`,
          content: `Channel message ${i}`,
          author: { id: 'user-2', bot: false, username: 'other' },
          member: null,
          createdTimestamp: (i + 1) * 1000,
        },
      ])
    );

    const msg = {
      author: { id: 'user-1', bot: false, username: 'testuser', displayName: 'TestUser' },
      content: '<@bot-123> !chat hello',
      mentions: { has: () => true },
      channel: {
        type: 0,
        isThread: () => false,
        messages: {
          cache: new Map(),
          fetch: jest.fn().mockResolvedValue(channelMessages),
        },
        send: jest.fn(),
      },
      client: { user: { id: 'bot-123', username: 'BotUser' } },
      reference: null,
      id: 'trigger-msg',
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
        attachments: { size: 0 },
        embeds: [],
      }),
      attachments: { size: 0 },
      fetchReference: jest.fn(),
      guild: { name: 'TestGuild' },
    };

    await messageHandler.handleMessage(msg as any);

    // The evaluator should have been called with at most 5 messages
    if (mockEvaluate.mock.calls.length > 0) {
      const historyArg = mockEvaluate.mock.calls[0][0];
      expect(historyArg.length).toBeLessThanOrEqual(5);
    }

    // channel.messages.fetch should use keyword max (5+1=6), not global (30+1=31)
    expect(msg.channel.messages.fetch).toHaveBeenCalledWith({
      limit: 6,
      before: 'trigger-msg',
    });
  });
});

describe('MessageHandler thread source promotion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (config.getReplyChainEnabled as jest.Mock).mockReturnValue(true);
    (config.getReplyChainMaxDepth as jest.Mock).mockReturnValue(30);
    (config.getReplyChainMaxTokens as jest.Mock).mockReturnValue(16000);
  });

  it('should promote thread history to primary when no reply chain exists', async () => {
    const kw = {
      keyword: '!chat',
      api: 'ollama' as const,
      timeout: 300,
      description: 'Chat',
      contextFilterEnabled: true,
    };
    (config.getKeywords as jest.Mock).mockReturnValue([kw]);

    const { requestQueue } = require('../src/utils/requestQueue');
    const { classifyIntent } = require('../src/utils/keywordClassifier');
    const { parseFirstLineKeyword } = require('../src/utils/promptBuilder');
    const { evaluateContextWindow } = require('../src/utils/contextEvaluator');
    const mockEvaluate = evaluateContextWindow as jest.MockedFunction<typeof evaluateContextWindow>;

    classifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: false });
    parseFirstLineKeyword.mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });
    mockEvaluate.mockImplementation((history: any) => Promise.resolve(history));

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Thread reply!' },
    });

    const threadMessages = new Map([
      ['t-1', {
        id: 't-1',
        content: 'Thread message one',
        author: { id: 'user-2', bot: false, username: 'alice' },
        member: null,
        createdTimestamp: 1000,
      }],
      ['t-2', {
        id: 't-2',
        content: 'Thread message two',
        author: { id: 'bot-123', bot: true, username: 'bot' },
        member: null,
        createdTimestamp: 2000,
      }],
    ]);

    const msg = {
      author: { id: 'user-1', bot: false, username: 'testuser', displayName: 'TestUser' },
      content: '<@bot-123> !chat hello thread',
      mentions: { has: () => true },
      channel: {
        type: 0,
        isThread: () => true,
        messages: {
          cache: new Map(),
          fetch: jest.fn().mockResolvedValue(threadMessages),
        },
        send: jest.fn(),
      },
      client: { user: { id: 'bot-123', username: 'BotUser' } },
      reference: null, // No reply chain
      id: 'thread-trigger',
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
        attachments: { size: 0 },
        embeds: [],
      }),
      attachments: { size: 0 },
      fetchReference: jest.fn(),
      guild: { name: 'TestGuild' },
    };

    await messageHandler.handleMessage(msg as any);

    // Evaluator should have been called with thread-promoted messages
    expect(mockEvaluate).toHaveBeenCalled();
    const historyArg = mockEvaluate.mock.calls[0][0];
    expect(historyArg.length).toBeGreaterThan(0);

    // All messages should have thread source (thread promotion)
    const allThread = historyArg.every((m: any) => m.contextSource === 'thread');
    expect(allThread).toBe(true);
  });

  it('should NOT promote channel history to primary when in a non-thread channel', async () => {
    const kw = {
      keyword: '!chat',
      api: 'ollama' as const,
      timeout: 300,
      description: 'Chat',
      contextFilterEnabled: true,
    };
    (config.getKeywords as jest.Mock).mockReturnValue([kw]);

    const { requestQueue } = require('../src/utils/requestQueue');
    const { classifyIntent } = require('../src/utils/keywordClassifier');
    const { parseFirstLineKeyword } = require('../src/utils/promptBuilder');
    const { evaluateContextWindow } = require('../src/utils/contextEvaluator');
    const mockEvaluate = evaluateContextWindow as jest.MockedFunction<typeof evaluateContextWindow>;

    classifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: false });
    parseFirstLineKeyword.mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });
    mockEvaluate.mockImplementation((history: any) => Promise.resolve(history));

    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Channel reply!' },
    });

    const channelMessages = new Map([
      ['c-1', {
        id: 'c-1',
        content: 'Channel message',
        author: { id: 'user-2', bot: false, username: 'alice' },
        member: null,
        createdTimestamp: 1000,
      }],
    ]);

    const msg = {
      author: { id: 'user-1', bot: false, username: 'testuser', displayName: 'TestUser' },
      content: '<@bot-123> !chat hello channel',
      mentions: { has: () => true },
      channel: {
        type: 0,
        isThread: () => false,
        messages: {
          cache: new Map(),
          fetch: jest.fn().mockResolvedValue(channelMessages),
        },
        send: jest.fn(),
      },
      client: { user: { id: 'bot-123', username: 'BotUser' } },
      reference: null,
      id: 'channel-trigger',
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
        attachments: { size: 0 },
        embeds: [],
      }),
      attachments: { size: 0 },
      fetchReference: jest.fn(),
      guild: { name: 'TestGuild' },
    };

    await messageHandler.handleMessage(msg as any);

    expect(mockEvaluate).toHaveBeenCalled();
    const historyArg = mockEvaluate.mock.calls[0][0];
    expect(historyArg.length).toBeGreaterThan(0);

    // All messages should remain channel source (not a thread)
    const allChannel = historyArg.every((m: any) => m.contextSource === 'channel');
    expect(allChannel).toBe(true);
  });
});

// ── New tests: keep-newest truncation, bot-interaction gating, DM metadata ──

describe('MessageHandler collateGuildContext — keep-newest under depth budget', () => {
  it('should keep newest reply messages when reply context exceeds maxDepth', () => {
    const replyContext = Array.from({ length: 5 }, (_, i) => ({
      role: 'user' as const,
      content: `p${i}`,
      contextSource: 'reply' as const,
      discordMessageId: `p${i}`,
      createdAtMs: (i + 1) * 1000,
    }));
    const channelContext: any[] = [];

    // maxDepth = 3 — should keep p2, p3, p4 (newest)
    const result = messageHandler.collateGuildContext(replyContext, channelContext, 3, 16000);

    expect(result).toHaveLength(3);
    expect(result[0].discordMessageId).toBe('p2');
    expect(result[1].discordMessageId).toBe('p3');
    expect(result[2].discordMessageId).toBe('p4');
  });

  it('should keep newest channel messages when channel exceeds remaining depth', () => {
    const replyContext = [
      { role: 'user' as const, content: 'p0', contextSource: 'reply' as const, discordMessageId: 'p0', createdAtMs: 1000 },
    ];
    const channelContext = Array.from({ length: 5 }, (_, i) => ({
      role: 'user' as const,
      content: `s${i}`,
      contextSource: 'channel' as const,
      discordMessageId: `s${i}`,
      createdAtMs: (i + 2) * 1000,
    }));

    // maxDepth = 3 → 1 reply + 2 channel (newest: s3, s4)
    const result = messageHandler.collateGuildContext(replyContext, channelContext, 3, 16000);

    expect(result).toHaveLength(3);
    expect(result.filter(m => m.contextSource === 'reply')).toHaveLength(1);
    const chIds = result.filter(m => m.contextSource === 'channel').map(m => m.discordMessageId);
    expect(chIds).toEqual(['s3', 's4']);
  });

  it('should keep newest reply context when char budget is exceeded', () => {
    const replyContext = [
      { role: 'user' as const, content: 'A'.repeat(100), contextSource: 'reply' as const, discordMessageId: 'p0', createdAtMs: 1000 },
      { role: 'user' as const, content: 'B'.repeat(100), contextSource: 'reply' as const, discordMessageId: 'p1', createdAtMs: 2000 },
      { role: 'user' as const, content: 'C'.repeat(100), contextSource: 'reply' as const, discordMessageId: 'p2', createdAtMs: 3000 },
    ];

    // char budget 200 → only newest 2 fit (B + C = 200)
    const result = messageHandler.collateGuildContext(replyContext, [], 30, 200);

    expect(result).toHaveLength(2);
    expect(result[0].discordMessageId).toBe('p1');
    expect(result[1].discordMessageId).toBe('p2');
  });
});

describe('MessageHandler collectDmHistory — keep-newest and dm metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (config.getReplyChainMaxDepth as jest.Mock).mockReturnValue(10);
    (config.getReplyChainMaxTokens as jest.Mock).mockReturnValue(16000);
  });

  function createDmMsg(channelMessages: Map<string, any>): any {
    return {
      id: 'current-dm',
      content: 'test dm',
      author: { id: 'user-1', bot: false, username: 'testuser' },
      client: { user: { id: 'bot-id', username: 'BotUser' } },
      channel: {
        type: 1,
        messages: {
          fetch: jest.fn().mockResolvedValue(channelMessages),
        },
      },
    };
  }

  it('should tag DM messages with contextSource "dm"', async () => {
    const messages = new Map([
      ['dm-1', {
        id: 'dm-1',
        content: 'Hello bot',
        author: { id: 'user-1', bot: false, username: 'testuser' },
        createdTimestamp: 1000,
      }],
    ]);

    const msg = createDmMsg(messages);
    const result = await messageHandler.collectDmHistory(msg);

    expect(result).toHaveLength(1);
    expect(result[0].contextSource).toBe('dm');
  });

  it('should keep newest messages when char budget is exceeded', async () => {
    (config.getReplyChainMaxTokens as jest.Mock).mockReturnValue(40);

    // oldest-first after reverse: dm-1 (20 chars), dm-2 (20 chars) — budget 40
    // After username prefix "testuser: " (10 chars), each becomes 30 chars
    const messages = new Map([
      ['dm-2', {
        id: 'dm-2',
        content: 'B'.repeat(20),
        author: { id: 'user-1', bot: false, username: 'testuser' },
        createdTimestamp: 2000,
      }],
      ['dm-1', {
        id: 'dm-1',
        content: 'A'.repeat(20),
        author: { id: 'user-1', bot: false, username: 'testuser' },
        createdTimestamp: 1000,
      }],
    ]);

    const msg = createDmMsg(messages);
    const result = await messageHandler.collectDmHistory(msg);

    // Only the newest (dm-2) should survive — prefixed content fits within budget
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe(`testuser: ${'B'.repeat(20)}`);
  });
});

describe('MessageHandler collectDmHistory — ALLOW_BOT_INTERACTIONS filtering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (config.getReplyChainMaxDepth as jest.Mock).mockReturnValue(10);
    (config.getReplyChainMaxTokens as jest.Mock).mockReturnValue(16000);
  });

  function createDmMsg(channelMessages: Map<string, any>): any {
    return {
      id: 'current-dm',
      content: 'test dm',
      author: { id: 'user-1', bot: false, username: 'testuser' },
      client: { user: { id: 'bot-id', username: 'BotUser' } },
      channel: {
        type: 1,
        messages: {
          fetch: jest.fn().mockResolvedValue(channelMessages),
        },
      },
    };
  }

  it('should skip other bot messages in DM history when ALLOW_BOT_INTERACTIONS is false', async () => {
    (config.getAllowBotInteractions as jest.Mock).mockReturnValue(false);

    const messages = new Map([
      ['dm-2', {
        id: 'dm-2',
        content: 'Other bot says hi',
        author: { id: 'other-bot', bot: true, username: 'otherbot' },
        createdTimestamp: 2000,
      }],
      ['dm-1', {
        id: 'dm-1',
        content: 'Human message',
        author: { id: 'user-1', bot: false, username: 'testuser' },
        createdTimestamp: 1000,
      }],
    ]);

    const msg = createDmMsg(messages);
    const result = await messageHandler.collectDmHistory(msg);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('testuser: Human message');
  });

  it('should include other bot messages in DM history when ALLOW_BOT_INTERACTIONS is true', async () => {
    (config.getAllowBotInteractions as jest.Mock).mockReturnValue(true);

    const messages = new Map([
      ['dm-2', {
        id: 'dm-2',
        content: 'Other bot says hi',
        author: { id: 'other-bot', bot: true, username: 'otherbot' },
        createdTimestamp: 2000,
      }],
      ['dm-1', {
        id: 'dm-1',
        content: 'Human message',
        author: { id: 'user-1', bot: false, username: 'testuser' },
        createdTimestamp: 1000,
      }],
    ]);

    const msg = createDmMsg(messages);
    const result = await messageHandler.collectDmHistory(msg);

    expect(result).toHaveLength(2);
  });

  it('should always include this bot messages in DM history regardless of ALLOW_BOT_INTERACTIONS', async () => {
    (config.getAllowBotInteractions as jest.Mock).mockReturnValue(false);

    const messages = new Map([
      ['dm-1', {
        id: 'dm-1',
        content: 'Bot own reply',
        author: { id: 'bot-id', bot: true, username: 'bot' },
        createdTimestamp: 1000,
      }],
    ]);

    const msg = createDmMsg(messages);
    const result = await messageHandler.collectDmHistory(msg);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
  });
});

describe('MessageHandler collectChannelHistory — keep-newest under char budget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (config.getReplyChainMaxDepth as jest.Mock).mockReturnValue(30);
    (config.getReplyChainMaxTokens as jest.Mock).mockReturnValue(16000);
    (config.getAllowBotInteractions as jest.Mock).mockReturnValue(false);
  });

  function createGuildMsg(
    channelMessages: Map<string, any>,
    isThread = false
  ): any {
    return {
      id: 'current-msg',
      content: 'test',
      author: { id: 'user-1', bot: false, username: 'testuser' },
      client: { user: { id: 'bot-id', username: 'BotUser' } },
      channel: {
        type: 0,
        isThread: () => isThread,
        messages: {
          cache: new Map(),
          fetch: jest.fn().mockResolvedValue(channelMessages),
        },
      },
      member: null,
    };
  }

  it('should keep newest messages when char budget is exceeded (drop oldest)', async () => {
    // Budget: 30 chars. Two messages: 'A'.repeat(20) oldest, 'B'.repeat(20) newest.
    // Total 40 > 30, so oldest should be dropped.
    const messages = new Map([
      ['msg-2', {
        id: 'msg-2',
        content: 'B'.repeat(20),
        author: { id: 'user-1', bot: false, username: 'testuser' },
        member: null,
        createdTimestamp: 2000,
      }],
      ['msg-1', {
        id: 'msg-1',
        content: 'A'.repeat(20),
        author: { id: 'user-1', bot: false, username: 'testuser' },
        member: null,
        createdTimestamp: 1000,
      }],
    ]);

    const msg = createGuildMsg(messages);
    const result = await messageHandler.collectChannelHistory(msg, 30, 30);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('B'.repeat(20));
    expect(result[0].discordMessageId).toBe('msg-2');
  });
});

describe('MessageHandler collectChannelHistory — bot message filtering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (config.getReplyChainMaxDepth as jest.Mock).mockReturnValue(30);
    (config.getReplyChainMaxTokens as jest.Mock).mockReturnValue(16000);
  });

  function createGuildMsg(channelMessages: Map<string, any>): any {
    return {
      id: 'current-msg',
      content: 'test',
      author: { id: 'user-1', bot: false, username: 'testuser' },
      client: { user: { id: 'bot-id', username: 'BotUser' } },
      channel: {
        type: 0,
        isThread: () => false,
        messages: {
          cache: new Map(),
          fetch: jest.fn().mockResolvedValue(channelMessages),
        },
      },
      member: null,
    };
  }

  it('should skip other bot messages when ALLOW_BOT_INTERACTIONS is false', async () => {
    (config.getAllowBotInteractions as jest.Mock).mockReturnValue(false);

    const messages = new Map([
      ['msg-2', {
        id: 'msg-2',
        content: 'Other bot says hi',
        author: { id: 'other-bot', bot: true, username: 'otherbot' },
        member: null,
        createdTimestamp: 2000,
      }],
      ['msg-1', {
        id: 'msg-1',
        content: 'Human message',
        author: { id: 'user-2', bot: false, username: 'alice' },
        member: null,
        createdTimestamp: 1000,
      }],
    ]);

    const msg = createGuildMsg(messages);
    const result = await messageHandler.collectChannelHistory(msg);

    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('Human message');
  });

  it('should include other bot messages when ALLOW_BOT_INTERACTIONS is true', async () => {
    (config.getAllowBotInteractions as jest.Mock).mockReturnValue(true);

    const messages = new Map([
      ['msg-2', {
        id: 'msg-2',
        content: 'Other bot says hi',
        author: { id: 'other-bot', bot: true, username: 'otherbot' },
        member: null,
        createdTimestamp: 2000,
      }],
      ['msg-1', {
        id: 'msg-1',
        content: 'Human message',
        author: { id: 'user-2', bot: false, username: 'alice' },
        member: null,
        createdTimestamp: 1000,
      }],
    ]);

    const msg = createGuildMsg(messages);
    const result = await messageHandler.collectChannelHistory(msg);

    expect(result).toHaveLength(2);
  });

  it('should always include this bot messages regardless of ALLOW_BOT_INTERACTIONS', async () => {
    (config.getAllowBotInteractions as jest.Mock).mockReturnValue(false);

    const messages = new Map([
      ['msg-1', {
        id: 'msg-1',
        content: 'Bot own reply',
        author: { id: 'bot-id', bot: true, username: 'bot' },
        member: null,
        createdTimestamp: 1000,
      }],
    ]);

    const msg = createGuildMsg(messages);
    const result = await messageHandler.collectChannelHistory(msg);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
  });
});

describe('MessageHandler handleMessage — ALLOW_BOT_INTERACTIONS gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (config.getReplyChainEnabled as jest.Mock).mockReturnValue(true);
    (config.getReplyChainMaxDepth as jest.Mock).mockReturnValue(10);
    (config.getReplyChainMaxTokens as jest.Mock).mockReturnValue(16000);
  });

  it('should ignore other bot messages when ALLOW_BOT_INTERACTIONS is false', async () => {
    (config.getAllowBotInteractions as jest.Mock).mockReturnValue(false);

    const msg = {
      author: { id: 'other-bot', bot: true, username: 'otherbot' },
      content: '<@bot-123> hello',
      mentions: { has: () => true },
      channel: { type: 0, isThread: () => false, messages: { cache: new Map(), fetch: jest.fn() } },
      client: { user: { id: 'bot-123', username: 'BotUser' } },
      reference: null,
      id: 'bot-msg',
      reply: jest.fn(),
      guild: { name: 'TestGuild' },
    };

    await messageHandler.handleMessage(msg as any);

    // Should not have replied (message ignored)
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it('should process other bot messages when ALLOW_BOT_INTERACTIONS is true', async () => {
    (config.getAllowBotInteractions as jest.Mock).mockReturnValue(true);
    (config.getKeywords as jest.Mock).mockReturnValue([]);

    const { requestQueue } = require('../src/utils/requestQueue');
    const { classifyIntent } = require('../src/utils/keywordClassifier');
    const { parseFirstLineKeyword } = require('../src/utils/promptBuilder');

    classifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: false });
    parseFirstLineKeyword.mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Reply to bot!' },
    });

    const msg = {
      author: { id: 'other-bot', bot: true, username: 'otherbot' },
      content: '<@bot-123> hello from bot',
      mentions: { has: () => true },
      channel: {
        type: 0,
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
        send: jest.fn(),
      },
      client: { user: { id: 'bot-123', username: 'BotUser' } },
      reference: null,
      id: 'bot-msg',
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
      }),
      guild: { name: 'TestGuild' },
    };

    await messageHandler.handleMessage(msg as any);

    // Should have processed the message (reply called for processing indicator)
    expect(msg.reply).toHaveBeenCalled();
  });

  it('should never respond to own messages even when ALLOW_BOT_INTERACTIONS is true', async () => {
    (config.getAllowBotInteractions as jest.Mock).mockReturnValue(true);

    const msg = {
      author: { id: 'bot-123', bot: true, username: 'self-bot' },
      content: 'My own message',
      mentions: { has: () => true },
      channel: { type: 0, isThread: () => false },
      client: { user: { id: 'bot-123', username: 'BotUser' } },
      reference: null,
      id: 'self-msg',
      reply: jest.fn(),
      guild: { name: 'TestGuild' },
    };

    await messageHandler.handleMessage(msg as any);

    expect(msg.reply).not.toHaveBeenCalled();
  });
});

// ── Activity event emission tests ────────────────────────────────

describe('MessageHandler activity event emission', () => {
  const mockExecuteRoutedRequest = executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>;
  const mockClassifyIntent = classifyIntent as jest.MockedFunction<typeof classifyIntent>;
  const mockParseFirstLineKeyword = parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>;

  function createMsg(content: string, isDM = false): any {
    const botUserId = 'bot-123';
    const sharedGuild = {
      id: 'guild-shared',
      members: { cache: new Map([['user-1', { user: { id: 'user-1' } }]]), fetch: jest.fn() },
    };
    return {
      author: { bot: false, id: 'user-1', username: 'testuser', displayName: 'testuser' },
      member: isDM ? null : { displayName: 'testuser' },
      client: { user: { id: botUserId, username: 'BotUser' }, guilds: { cache: new Map([['guild-shared', sharedGuild]]) } },
      channel: {
        type: isDM ? 1 : 0,
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
        send: jest.fn(),
      },
      guild: isDM ? null : { name: 'TestGuild' },
      mentions: { has: jest.fn(() => !isDM) },
      reference: null,
      content: isDM ? content : `<@bot-123> ${content}`,
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
      }),
      fetchReference: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (messageHandler as any).lastErrorMessageTime = 0;
    (config.getKeywords as jest.Mock).mockReturnValue([]);
    mockClassifyIntent.mockResolvedValue({ keywordConfig: null, wasClassified: false });
    mockParseFirstLineKeyword.mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });
  });

  it('emits message_received for DM', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Hello there!' },
    });
    mockClassifyIntent.mockResolvedValueOnce({ keywordConfig: null, wasClassified: false });

    const msg = createMsg('hello', true);
    await messageHandler.handleMessage(msg);

    expect(activityEvents.emitMessageReceived).toHaveBeenCalledWith(true, 'hello');
  });

  it('emits message_received for server mention', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Hi!' },
    });
    mockClassifyIntent.mockResolvedValueOnce({ keywordConfig: null, wasClassified: false });

    const msg = createMsg('hi');
    await messageHandler.handleMessage(msg);

    expect(activityEvents.emitMessageReceived).toHaveBeenCalledWith(false, 'hi');
  });

  it('emits routing_decision on keyword match path', async () => {
    const weatherKeyword = {
      keyword: '!weather',
      api: 'accuweather' as const,
      timeout: 60,
      description: 'Get weather',
    };
    (config.getKeywords as jest.Mock).mockReturnValue([weatherKeyword]);

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Sunny, 72°F' } },
      finalApi: 'accuweather',
      stages: [],
    });

    const msg = createMsg('!weather Seattle');
    await messageHandler.handleMessage(msg);

    expect(activityEvents.emitRoutingDecision).toHaveBeenCalledWith(
      'accuweather', '!weather', 'keyword'
    );
  });

  it('emits routing_decision on two-stage keyword parse', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    const weatherKeyword = {
      keyword: '!weather',
      api: 'accuweather' as const,
      timeout: 60,
      description: 'Get weather',
    };

    // Ollama first-pass
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'weather\nLet me check that' },
    });

    // parseFirstLineKeyword matches
    mockParseFirstLineKeyword.mockReturnValueOnce({
      keywordConfig: weatherKeyword,
      parsedLine: 'weather',
      matched: true,
    });

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: true, data: { text: 'Sunny' } },
      finalApi: 'accuweather',
      stages: [],
    });

    const msg = createMsg('is it going to rain');
    await messageHandler.handleMessage(msg);

    expect(activityEvents.emitRoutingDecision).toHaveBeenCalledWith(
      'accuweather', '!weather', 'two-stage-parse'
    );
  });

  it('emits bot_reply for text responses', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'The answer is 42.' },
    });
    mockClassifyIntent.mockResolvedValueOnce({ keywordConfig: null, wasClassified: false });

    const msg = createMsg('meaning of life');
    await messageHandler.handleMessage(msg);

    expect(activityEvents.emitBotReply).toHaveBeenCalledWith('ollama', 'The answer is 42.', false);
  });

  it('emits error when exception occurs in handleMessage', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockRejectedValueOnce(new Error('Connection refused'));

    const msg = createMsg('hello');
    await messageHandler.handleMessage(msg);

    expect(activityEvents.emitError).toHaveBeenCalledWith(
      'I couldn\'t complete that request'
    );
  });

  it('emits error when dispatch receives failed response', async () => {
    const weatherKeyword = {
      keyword: '!weather',
      api: 'accuweather' as const,
      timeout: 60,
      description: 'Get weather',
    };
    (config.getKeywords as jest.Mock).mockReturnValue([weatherKeyword]);

    mockExecuteRoutedRequest.mockResolvedValueOnce({
      finalResponse: { success: false, error: 'Location not found' },
      finalApi: 'accuweather',
      stages: [],
    });

    const msg = createMsg('!weather asdfasdf');
    await messageHandler.handleMessage(msg);

    expect(activityEvents.emitError).toHaveBeenCalledWith(
      'I couldn\'t get a response from the API'
    );
  });

  it('does not leak user IDs or guild names in events', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Hi!' },
    });
    mockClassifyIntent.mockResolvedValueOnce({ keywordConfig: null, wasClassified: false });

    const msg = createMsg('secret password 12345');
    await messageHandler.handleMessage(msg);

    // Verify none of the activity calls include user ID or guild name
    const mockEmitMessageReceived = activityEvents.emitMessageReceived as jest.MockedFunction<typeof activityEvents.emitMessageReceived>;
    const mockEmitBotReply = activityEvents.emitBotReply as jest.MockedFunction<typeof activityEvents.emitBotReply>;
    const allCalls = [
      ...mockEmitMessageReceived.mock.calls,
      ...mockEmitBotReply.mock.calls,
    ];
    const serialized = JSON.stringify(allCalls);
    expect(serialized).not.toContain('user-1');
    expect(serialized).not.toContain('TestGuild');
  });
});

describe('MessageHandler DM guild-membership gate', () => {
  const { logger } = require('../src/utils/logger');

  function createDmMessage(opts: {
    authorId?: string;
    username?: string;
    sharedGuilds?: Array<{ id: string; memberCached: boolean }>;
    content?: string;
  }): any {
    const authorId = opts.authorId ?? 'dm-user-1';
    const guilds = (opts.sharedGuilds ?? []).map(g => {
      const memberCache = new Map<string, any>();
      if (g.memberCached) {
        memberCache.set(authorId, { user: { id: authorId } });
      }
      return [
        g.id,
        {
          id: g.id,
          members: {
            cache: memberCache,
            fetch: g.memberCached
              ? jest.fn().mockResolvedValue({ user: { id: authorId } })
              : jest.fn().mockRejectedValue(new Error('Unknown Member')),
          },
        },
      ] as const;
    });

    const guildCache = new Map(guilds);

    return {
      author: { bot: false, id: authorId, username: opts.username ?? 'dmuser', displayName: opts.username ?? 'dmuser' },
      client: {
        user: { id: 'bot-123' },
        guilds: { cache: guildCache },
      },
      channel: {
        type: 1, // DM
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
        send: jest.fn(),
      },
      guild: null,
      member: null,
      mentions: { has: jest.fn(() => false) },
      reference: null,
      content: opts.content ?? 'hello',
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
    (config.getAllowBotInteractions as jest.Mock).mockReturnValue(false);
    (config.getReplyChainEnabled as jest.Mock).mockReturnValue(false);
  });

  it('should allow DM from user who shares a guild (cached member)', async () => {
    const msg = createDmMessage({
      sharedGuilds: [{ id: 'guild-1', memberCached: true }],
      content: 'hello',
    });

    await messageHandler.handleMessage(msg);

    // DM was accepted — reply was called (processing message)
    expect(msg.reply).toHaveBeenCalled();
  });

  it('should allow DM from user found via fetch (not cached)', async () => {
    const authorId = 'dm-user-2';
    // Guild where member is NOT cached but fetch succeeds
    const guildCache = new Map([
      ['guild-1', {
        id: 'guild-1',
        members: {
          cache: new Map(), // not cached
          fetch: jest.fn().mockResolvedValue({ user: { id: authorId } }),
        },
      }],
    ]);

    const msg = createDmMessage({ authorId, content: 'hi there' });
    msg.client.guilds.cache = guildCache;

    await messageHandler.handleMessage(msg);

    expect(msg.reply).toHaveBeenCalled();
  });

  it('should reject DM from user who shares no guild', async () => {
    const msg = createDmMessage({
      sharedGuilds: [{ id: 'guild-1', memberCached: false }],
      content: 'sneaky message',
    });

    await messageHandler.handleMessage(msg);

    // DM was rejected — reply should NOT be called
    expect(msg.reply).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      'warn', 'system',
      expect.stringContaining('no shared guild')
    );
  });

  it('should reject DM when bot is in no guilds at all', async () => {
    const msg = createDmMessage({ sharedGuilds: [] });

    await messageHandler.handleMessage(msg);

    expect(msg.reply).not.toHaveBeenCalled();
  });

  it('should still process guild @mention messages normally (no DM gate)', async () => {
    // A guild mention should bypass the DM gate entirely
    const msg: any = {
      author: { bot: false, id: 'user-1', username: 'guilduser', displayName: 'guilduser' },
      client: { user: { id: 'bot-123', username: 'BotUser' }, guilds: { cache: new Map() } },
      channel: {
        type: 0, // GuildText
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
        send: jest.fn(),
      },
      guild: { name: 'TestGuild' },
      member: { displayName: 'guilduser' },
      mentions: { has: jest.fn(() => true) },
      reference: null,
      content: '<@bot-123> hello',
      id: 'guild-msg-1',
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
      }),
      fetchReference: jest.fn(),
    };

    await messageHandler.handleMessage(msg);

    // Guild mention should proceed normally
    expect(msg.reply).toHaveBeenCalled();
  });
});

describe('MessageHandler activity_key keyword', () => {
  const { logger } = require('../src/utils/logger');
  const { activityKeyManager } = require('../src/utils/activityKeyManager');

  const activityKeyKw = {
    keyword: '!activity_key',
    api: 'ollama' as const,
    timeout: 10,
    description: 'Request a temporary access key for the activity monitor',
    builtin: true,
    allowEmptyContent: true,
  };

  function createDmMsg(content: string): any {
    const sharedGuild = {
      id: 'guild-shared',
      members: { cache: new Map([['user-1', { user: { id: 'user-1' } }]]), fetch: jest.fn() },
    };
    return {
      author: { bot: false, id: 'user-1', username: 'keyuser', displayName: 'keyuser' },
      client: { user: { id: 'bot-123', username: 'BotUser' }, guilds: { cache: new Map([['guild-shared', sharedGuild]]) } },
      channel: {
        type: 1, // DM
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
        send: jest.fn(),
      },
      guild: null,
      member: null,
      mentions: { has: jest.fn(() => false) },
      reference: null,
      content,
      id: 'dm-key-1',
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
      }),
      fetchReference: jest.fn(),
    };
  }

  function createMentionMsg(content: string): any {
    return {
      author: { bot: false, id: 'user-1', username: 'keyuser', displayName: 'keyuser' },
      client: { user: { id: 'bot-123', username: 'BotUser' }, guilds: { cache: new Map() } },
      channel: {
        type: 0, // GuildText
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
        send: jest.fn(),
      },
      guild: { name: 'TestGuild' },
      member: { displayName: 'keyuser' },
      mentions: { has: jest.fn(() => true) },
      reference: null,
      content,
      id: 'guild-key-1',
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
      }),
      fetchReference: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (config.getKeywords as jest.Mock).mockReturnValue([activityKeyKw]);
    (config.getAllowBotInteractions as jest.Mock).mockReturnValue(false);
    (config.getReplyChainEnabled as jest.Mock).mockReturnValue(false);
    (config.getActivityKeyTtl as jest.Mock).mockReturnValue(300);
    (config.getOutputBaseUrl as jest.Mock).mockReturnValue('http://localhost:3003');
    activityKeyManager.issueKey.mockReturnValue('mock-activity-key-abc');
  });

  it('should issue a key and reply when standalone "activity_key" is sent via DM', async () => {
    const msg = createDmMsg('!activity_key');
    await messageHandler.handleMessage(msg);

    expect(activityKeyManager.issueKey).toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(
      expect.stringContaining('mock-activity-key-abc')
    );
    expect(msg.reply).toHaveBeenCalledWith(
      expect.stringContaining('300 seconds')
    );
  });

  it('should issue a key via guild @mention', async () => {
    const msg = createMentionMsg('<@bot-123> !activity_key');
    await messageHandler.handleMessage(msg);

    expect(activityKeyManager.issueKey).toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(
      expect.stringContaining('mock-activity-key-abc')
    );
  });

  it('should NOT match "activity_key something" (standalone only)', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'I do not know what that means.' },
    });

    const msg = createDmMsg('!activity_key something');
    await messageHandler.handleMessage(msg);

    // It should NOT have issued a key — it doesn't match the standalone keyword
    expect(activityKeyManager.issueKey).not.toHaveBeenCalled();
  });

  it('should include the activity URL in the reply', async () => {
    const msg = createDmMsg('!activity_key');
    await messageHandler.handleMessage(msg);

    expect(msg.reply).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost:3003/activity')
    );
  });

  it('should log the key issuance', async () => {
    const msg = createDmMsg('!activity_key');
    await messageHandler.handleMessage(msg);

    expect(logger.log).toHaveBeenCalledWith(
      'success', 'system',
      expect.stringContaining('ACTIVITY-KEY: Key issued to')
    );
  });

  it('should NOT emit message_received activity event for activity_key', async () => {
    const msg = createDmMsg('!activity_key');
    await messageHandler.handleMessage(msg);

    expect(activityEvents.emitMessageReceived).not.toHaveBeenCalled();
  });

  it('should match when config stores keyword without ! prefix (prefix normalisation)', async () => {
    // Override the keyword config to use unprefixed keyword, matching runtime config/keywords.json
    const unprefixedKw = {
      keyword: 'activity_key',
      api: 'ollama' as const,
      timeout: 10,
      description: 'Request key',
      builtin: true,
      allowEmptyContent: true,
    };
    (config.getKeywords as jest.Mock).mockReturnValue([unprefixedKw]);

    const msg = createDmMsg('!activity_key');
    await messageHandler.handleMessage(msg);

    // Even though config stores "activity_key" without "!", !activity_key should match
    expect(activityKeyManager.issueKey).toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(
      expect.stringContaining('mock-activity-key-abc')
    );
  });
});

describe('MessageHandler meme two-stage routing fallback', () => {
  function createMentionedMessage(content: string): any {
    const botUserId = 'bot-123';
    return {
      author: { bot: false, id: 'user-1', username: 'testuser', displayName: 'testuser' },
      client: { user: { id: botUserId, username: 'BotUser' }, guilds: { cache: new Map() } },
      channel: {
        type: 0,
        isThread: () => false,
        messages: { cache: new Map(), fetch: jest.fn().mockResolvedValue(new Map()) },
        send: jest.fn(),
      },
      guild: { name: 'TestGuild' },
      member: { displayName: 'testuser' },
      mentions: { has: jest.fn(() => true) },
      reference: null,
      content,
      id: 'msg-1',
      reply: jest.fn().mockResolvedValue({
        edit: jest.fn().mockResolvedValue(undefined),
        channel: { send: jest.fn() },
      }),
      fetchReference: jest.fn(),
      react: jest.fn().mockResolvedValue(undefined),
      reactions: { resolve: jest.fn(() => ({ users: { remove: jest.fn().mockResolvedValue(undefined) } })) },
    };
  }

  const memeKw = {
    keyword: '!meme',
    api: 'meme' as const,
    timeout: 60,
    description: 'Create funny meme images',
    abilityInputs: { mode: 'implicit' as const, inferFrom: ['current_message' as const] },
  };
  const chatKw = { keyword: '!chat', api: 'ollama' as const, timeout: 60, description: 'Chat' };

  beforeEach(() => {
    jest.clearAllMocks();
    (config.getKeywords as jest.Mock).mockReturnValue([memeKw, chatKw]);
    (config.getReplyChainEnabled as jest.Mock).mockReturnValue(false);
    (parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>)
      .mockReturnValue({ keywordConfig: null, parsedLine: '', matched: false });
  });

  it('routes likely meme requests through meme API when first-line directive is missing', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: 'Here is a meme idea with template and captions.' },
    });

    (inferAbilityParameters as jest.MockedFunction<typeof inferAbilityParameters>)
      .mockResolvedValueOnce('fwp | Just got my license | Now every road is a final boss');

    (executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>)
      .mockResolvedValueOnce({
        finalResponse: {
          success: true,
          data: { imageUrl: 'https://api.memegen.link/images/fwp/test.png', text: '**First World Problems** meme' },
        },
        finalApi: 'meme',
        stages: [],
      });

    const msg = createMentionedMessage('<@bot-123> can you make a meme about a kid learning to drive');
    await messageHandler.handleMessage(msg);

    expect(inferAbilityParameters).toHaveBeenCalledWith(
      memeKw,
      'can you make a meme about a kid learning to drive',
      'testuser'
    );

    expect(executeRoutedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: '!meme', api: 'meme', finalOllamaPass: false }),
      'fwp | Just got my license | Now every road is a final boss',
      'testuser',
      [{ role: 'user', content: 'testuser: can you make a meme about a kid learning to drive', contextSource: 'trigger', hasNamePrefix: true }],
      'BotUser'
    );

    expect(msg.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'https://api.memegen.link/images/fwp/test.png',
      })
    );
  });

  it('prefers original user content over inline parsed input for implicit meme directives, with inference fallback to inline', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: '!meme fwp | line 1 | line 2' },
    });

    (parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>)
      .mockReturnValueOnce({
        matched: true,
        parsedLine: '!meme fwp | line 1 | line 2',
        keywordConfig: memeKw,
        inferredInput: 'fwp | line 1 | line 2',
      });

    // Context-based inference succeeds — should use its result
    (inferAbilityParameters as jest.MockedFunction<typeof inferAbilityParameters>)
      .mockResolvedValueOnce('bm | top inferred | bottom inferred');

    (executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>)
      .mockResolvedValueOnce({
        finalResponse: {
          success: true,
          data: { imageUrl: 'https://api.memegen.link/images/bm/inferred.png', text: '**Bad Luck Brian** meme' },
        },
        finalApi: 'meme',
        stages: [],
      });

    const msg = createMentionedMessage('<@bot-123> make a meme about driving class');
    await messageHandler.handleMessage(msg);

    // Should have attempted context-based inference
    expect(inferAbilityParameters).toHaveBeenCalledWith(
      memeKw,
      'make a meme about driving class',
      'testuser'
    );

    // Should use the inferred result, not original content
    expect(executeRoutedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: '!meme', api: 'meme', finalOllamaPass: false }),
      'bm | top inferred | bottom inferred',
      'testuser',
      [{ role: 'user', content: 'testuser: make a meme about driving class', contextSource: 'trigger', hasNamePrefix: true }],
      'BotUser'
    );
  });

  it('falls back to inline inferred params when context-based inference returns null', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: '!meme fwp | line 1 | line 2' },
    });

    (parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>)
      .mockReturnValueOnce({
        matched: true,
        parsedLine: '!meme fwp | line 1 | line 2',
        keywordConfig: memeKw,
        inferredInput: 'fwp | line 1 | line 2',
      });

    // Context-based inference fails — should fall back to inline inferred input
    (inferAbilityParameters as jest.MockedFunction<typeof inferAbilityParameters>)
      .mockResolvedValueOnce(null);

    (executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>)
      .mockResolvedValueOnce({
        finalResponse: {
          success: true,
          data: { imageUrl: 'https://api.memegen.link/images/fwp/fallback.png', text: '**First World Problems** meme' },
        },
        finalApi: 'meme',
        stages: [],
      });

    const msg = createMentionedMessage('<@bot-123> make a meme about driving class');
    await messageHandler.handleMessage(msg);

    // Should fall back to the inline inferred input from the model directive
    expect(executeRoutedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: '!meme', api: 'meme', finalOllamaPass: false }),
      'fwp | line 1 | line 2',
      'testuser',
      [{ role: 'user', content: 'testuser: make a meme about driving class', contextSource: 'trigger', hasNamePrefix: true }],
      'BotUser'
    );
  });

  it('adds shrug reaction alongside error reaction on meme API failure', async () => {
    const { requestQueue } = require('../src/utils/requestQueue');
    requestQueue.execute.mockResolvedValueOnce({
      success: true,
      data: { text: '!meme fwp | line 1 | line 2' },
    });

    (parseFirstLineKeyword as jest.MockedFunction<typeof parseFirstLineKeyword>)
      .mockReturnValueOnce({
        matched: true,
        parsedLine: '!meme fwp | line 1 | line 2',
        keywordConfig: memeKw,
        inferredInput: 'fwp | line 1 | line 2',
      });

    (inferAbilityParameters as jest.MockedFunction<typeof inferAbilityParameters>)
      .mockResolvedValueOnce(null);

    // Meme API request fails (template lookup failure)
    (executeRoutedRequest as jest.MockedFunction<typeof executeRoutedRequest>)
      .mockResolvedValueOnce({
        finalResponse: {
          success: false,
          error: 'Could not identify a meme template from your prompt.',
        },
        finalApi: 'meme',
        stages: [],
      });

    const msg = createMentionedMessage('<@bot-123> make a meme about driving class');
    await messageHandler.handleMessage(msg);

    // Should get both error and shrug reactions
    expect(msg.react).toHaveBeenCalledWith('❌');
    expect(msg.react).toHaveBeenCalledWith('🤷');
    // Should NOT send a text reply
    expect(msg.reply).not.toHaveBeenCalledWith(
      expect.stringContaining('⚠️')
    );
  });
});

describe('MessageHandler image prompt context derivation', () => {
  it('uses direct user text when imagine includes concrete prompt', () => {
    const result = (messageHandler as any).deriveImagePromptFromContext(
      'can you imagine a neon city skyline at night',
      []
    );

    expect(result).toBe('a neon city skyline at night');
  });

  it('uses prior user context when message is only imagine', () => {
    const history = [
      { role: 'assistant', content: 'What do you want me to imagine?', contextSource: 'dm' as const },
      { role: 'user', content: 'oeb: then how could i wash my car?', contextSource: 'dm' as const, hasNamePrefix: true },
      { role: 'user', content: 'oeb: imagine', contextSource: 'trigger' as const, hasNamePrefix: true },
    ];

    const result = (messageHandler as any).deriveImagePromptFromContext('imagine', history);

    expect(result).toBe('then how could i wash my car?');
  });

  it('falls back to assistant context when user context is generic', () => {
    const history = [
      { role: 'assistant', content: 'The Eiffel Tower grows taller in summer due to thermal expansion.', contextSource: 'dm' as const },
      { role: 'user', content: 'oeb: create a meme about this', contextSource: 'dm' as const, hasNamePrefix: true },
      { role: 'user', content: 'oeb: imagine', contextSource: 'trigger' as const, hasNamePrefix: true },
    ];

    const result = (messageHandler as any).deriveImagePromptFromContext('can you imagine this', history);

    expect(result).toBe('The Eiffel Tower grows taller in summer due to thermal expansion.');
  });
});