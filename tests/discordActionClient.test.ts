/**
 * discordActionClient — unit tests for getArtifact.
 *
 * Covers channel-only (bounded summary), message_id, and search paths.
 * Uses mocked discord.js primitives; does NOT connect to Discord.
 */

import { ChannelType, Collection } from 'discord.js';
import type { Client, Message, TextChannel } from 'discord.js';
import * as discordActionClient from '../src/api/discordActionClient';

// ── helpers ────────────────────────────────────────────────────

/** Build a minimal fake Message with optional image attachment. */
function fakeMessage(
  overrides: Partial<{
    id: string;
    content: string;
    username: string;
    createdAt: Date;
    createdTimestamp: number;
    attachments: { url: string; contentType: string }[];
  }> = {},
): Message {
  const now = overrides.createdAt ?? new Date('2026-03-03T00:00:00Z');
  const attachmentsColl = new Collection<string, any>();
  for (const att of overrides.attachments ?? []) {
    attachmentsColl.set(att.url, att);
  }
  return {
    id: overrides.id ?? '111',
    content: overrides.content ?? 'hello world',
    author: { username: overrides.username ?? 'alice', id: '100' },
    createdAt: now,
    createdTimestamp: overrides.createdTimestamp ?? now.getTime(),
    attachments: attachmentsColl,
  } as unknown as Message;
}

function buildChannel(
  messages: Message[],
  overrides: Partial<{ name: string; id: string; type: ChannelType }> = {},
): TextChannel {
  const coll = new Collection<string, Message>();
  for (const m of messages) coll.set(m.id, m);

  return {
    id: overrides.id ?? '999',
    name: overrides.name ?? 'general',
    type: overrides.type ?? ChannelType.GuildText,
    isTextBased: () => true,
    messages: {
      fetch: jest.fn().mockImplementation((arg?: string | { limit: number }) => {
        if (typeof arg === 'string') {
          const found = coll.get(arg);
          if (!found) throw new Error('Unknown Message');
          return Promise.resolve(found);
        }
        // limit-based fetch: return up to limit messages
        const limit = (arg as { limit: number })?.limit ?? 50;
        const subset = new Collection<string, Message>();
        let i = 0;
        for (const [k, v] of coll) {
          if (i >= limit) break;
          subset.set(k, v);
          i++;
        }
        return Promise.resolve(subset);
      }),
    },
  } as unknown as TextChannel;
}

function buildSourceMessage(channel: TextChannel): Message {
  return {
    channel,
    guild: {
      channels: {
        cache: new Collection<string, TextChannel>([[channel.id, channel]]),
      },
    },
    author: { id: '100' },
  } as unknown as Message;
}

const fakeClient = { user: { id: '999' } } as unknown as Client;

// ── Tests ──────────────────────────────────────────────────────

describe('getArtifact', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env to prevent bleed between tests
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  // ── message_id path ─────────────────────────────────────────

  it('should return a specific message when message_id is provided', async () => {
    const msg = fakeMessage({ id: '42', content: 'target message' });
    const channel = buildChannel([msg]);
    const source = buildSourceMessage(channel);

    const result = await discordActionClient.getArtifact(
      fakeClient,
      { message_id: '42' },
      'alice',
      source,
    );

    expect(result.success).toBe(true);
    expect(result.data?.text).toContain('target message');
    expect(result.data?.text).toContain('Author: alice');
    expect(result.data?.text).toContain('Message ID: 42');
  });

  // ── search path ─────────────────────────────────────────────

  it('should find a message matching search text', async () => {
    const msg = fakeMessage({ id: '7', content: 'the secret password is fish' });
    const channel = buildChannel([msg]);
    const source = buildSourceMessage(channel);

    const result = await discordActionClient.getArtifact(
      fakeClient,
      { search: 'secret password' },
      'alice',
      source,
    );

    expect(result.success).toBe(true);
    expect(result.data?.text).toContain('secret password');
  });

  it('should return error when search finds no match', async () => {
    const msg = fakeMessage({ id: '7', content: 'nothing here' });
    const channel = buildChannel([msg]);
    const source = buildSourceMessage(channel);

    const result = await discordActionClient.getArtifact(
      fakeClient,
      { search: 'nonexistent' },
      'alice',
      source,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No message found matching');
  });

  // ── channel-only path ───────────────────────────────────────

  it('should return channel summary when only channel is provided', async () => {
    const msgs = [
      fakeMessage({ id: '1', content: 'first', createdTimestamp: 1000, createdAt: new Date(1000) }),
      fakeMessage({ id: '2', content: 'second', createdTimestamp: 2000, createdAt: new Date(2000) }),
      fakeMessage({ id: '3', content: 'third', createdTimestamp: 3000, createdAt: new Date(3000) }),
    ];
    const channel = buildChannel(msgs, { name: 'general', id: '999' });
    const source = buildSourceMessage(channel);

    const result = await discordActionClient.getArtifact(
      fakeClient,
      { channel: '999' },
      'alice',
      source,
    );

    expect(result.success).toBe(true);
    expect(result.data?.text).toContain('Channel: #general');
    expect(result.data?.text).toContain('Messages returned: 3');
    expect(result.data?.text).toContain('[id:1]');
    expect(result.data?.text).toContain('[id:2]');
    expect(result.data?.text).toContain('[id:3]');
    expect(result.data?.text).toContain('first');
    expect(result.data?.text).toContain('second');
    expect(result.data?.text).toContain('third');
  });

  it('should return channel summary on implicit channel (no args at all)', async () => {
    const msgs = [
      fakeMessage({ id: '1', content: 'only message', createdTimestamp: 1000, createdAt: new Date(1000) }),
    ];
    const channel = buildChannel(msgs, { name: 'test-chan' });
    const source = buildSourceMessage(channel);

    const result = await discordActionClient.getArtifact(
      fakeClient,
      {},
      'alice',
      source,
    );

    expect(result.success).toBe(true);
    expect(result.data?.text).toContain('Channel: #test-chan');
    expect(result.data?.text).toContain('Messages returned: 1');
  });

  it('should respect DISCORD_ARTIFACT_MAX_MESSAGES config', async () => {
    process.env.DISCORD_ARTIFACT_MAX_MESSAGES = '2';
    const msgs = [
      fakeMessage({ id: '1', content: 'a', createdTimestamp: 1000, createdAt: new Date(1000) }),
      fakeMessage({ id: '2', content: 'b', createdTimestamp: 2000, createdAt: new Date(2000) }),
      fakeMessage({ id: '3', content: 'c', createdTimestamp: 3000, createdAt: new Date(3000) }),
    ];
    const channel = buildChannel(msgs, { name: 'limited' });
    const source = buildSourceMessage(channel);

    const result = await discordActionClient.getArtifact(
      fakeClient,
      {},
      'alice',
      source,
    );

    expect(result.success).toBe(true);
    // fetch was called with limit: 2
    expect(channel.messages.fetch).toHaveBeenCalledWith({ limit: 2 });
  });

  it('should collect image attachments up to DISCORD_ARTIFACT_MAX_IMAGES', async () => {
    process.env.DISCORD_ARTIFACT_MAX_IMAGES = '1';
    const msgs = [
      fakeMessage({
        id: '1',
        content: 'pic1',
        createdTimestamp: 1000,
        createdAt: new Date(1000),
        attachments: [
          { url: 'https://cdn.example.com/img1.png', contentType: 'image/png' },
          { url: 'https://cdn.example.com/img2.png', contentType: 'image/png' },
        ],
      }),
    ];
    const channel = buildChannel(msgs, { name: 'images' });
    const source = buildSourceMessage(channel);

    const result = await discordActionClient.getArtifact(
      fakeClient,
      {},
      'alice',
      source,
    );

    expect(result.success).toBe(true);
    expect(result.data?.text).toContain('Images (1):');
    expect(result.data?.text).toContain('img1.png');
    // Second image should NOT appear (capped at 1)
    expect(result.data?.text).not.toContain('img2.png');
  });

  it('should omit images section when DISCORD_ARTIFACT_MAX_IMAGES is 0', async () => {
    process.env.DISCORD_ARTIFACT_MAX_IMAGES = '0';
    const msgs = [
      fakeMessage({
        id: '1',
        content: 'pic1',
        createdTimestamp: 1000,
        createdAt: new Date(1000),
        attachments: [
          { url: 'https://cdn.example.com/img1.png', contentType: 'image/png' },
        ],
      }),
    ];
    const channel = buildChannel(msgs, { name: 'no-images' });
    const source = buildSourceMessage(channel);

    const result = await discordActionClient.getArtifact(
      fakeClient,
      {},
      'alice',
      source,
    );

    expect(result.success).toBe(true);
    expect(result.data?.text).not.toContain('Images');
  });

  // ── error paths ─────────────────────────────────────────────

  it('should return error for non-text channel', async () => {
    const channel = buildChannel([]);
    (channel as any).isTextBased = () => false;
    const source = buildSourceMessage(channel);

    const result = await discordActionClient.getArtifact(
      fakeClient,
      {},
      'alice',
      source,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not text-based');
  });

  it('should return error when channel is not found', async () => {
    const channel = buildChannel([]);
    const source = buildSourceMessage(channel);

    const result = await discordActionClient.getArtifact(
      fakeClient,
      { channel: 'nonexistent-channel' },
      'alice',
      source,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  // ── DM context: explicit channel resolution ─────────────────

  it('should resolve explicit channel ID globally from DM context', async () => {
    const targetMsgs = [
      fakeMessage({ id: '50', content: 'cross-channel msg', createdTimestamp: 5000, createdAt: new Date(5000) }),
    ];
    const targetChannel = buildChannel(targetMsgs, { name: 'other-server', id: '876879065162858566' });

    // DM source message: no guild
    const dmChannel = buildChannel([], { name: 'dm-chan', id: '1469386495881249023', type: ChannelType.DM });
    (dmChannel as any).recipient = { id: '100' };
    const dmSource = {
      channel: dmChannel,
      guild: null,
      author: { id: '100' },
    } as unknown as Message;

    // Client that resolves channel globally by ID
    const clientWithFetch = {
      user: { id: '999' },
      channels: {
        fetch: jest.fn().mockImplementation(async (id: string) => {
          if (id === '876879065162858566') return targetChannel;
          throw new Error('Unknown Channel');
        }),
      },
      guilds: { cache: new Collection() },
    } as unknown as Client;

    const result = await discordActionClient.getArtifact(
      clientWithFetch,
      { channel: '876879065162858566' },
      'alice',
      dmSource,
    );

    expect(result.success).toBe(true);
    expect(result.data?.text).toContain('Channel: #other-server');
    expect(result.data?.text).toContain('cross-channel msg');
  });

  it('should resolve explicit channel name globally from DM context', async () => {
    const targetMsgs = [
      fakeMessage({ id: '60', content: 'found by name', createdTimestamp: 6000, createdAt: new Date(6000) }),
    ];
    const targetChannel = buildChannel(targetMsgs, { name: 'irc-gateway', id: '876879065162858566' });

    const dmChannel = buildChannel([], { name: 'dm-chan', id: '123', type: ChannelType.DM });
    (dmChannel as any).recipient = { id: '100' };
    const dmSource = {
      channel: dmChannel,
      guild: null,
      author: { id: '100' },
    } as unknown as Message;

    const guildCache = new Collection<string, any>();
    const fakeGuild = {
      channels: {
        cache: new Collection<string, any>([['876879065162858566', targetChannel]]),
      },
    };
    guildCache.set('guild1', fakeGuild);

    const clientWithGuilds = {
      user: { id: '999' },
      channels: {
        fetch: jest.fn().mockRejectedValue(new Error('Not a snowflake')),
      },
      guilds: { cache: guildCache },
    } as unknown as Client;

    const result = await discordActionClient.getArtifact(
      clientWithGuilds,
      { channel: 'irc-gateway' },
      'alice',
      dmSource,
    );

    expect(result.success).toBe(true);
    expect(result.data?.text).toContain('Channel: #irc-gateway');
    expect(result.data?.text).toContain('found by name');
  });

  it('should return error when channel not found globally from DM context', async () => {
    const dmChannel = buildChannel([], { name: 'dm-chan', id: '123', type: ChannelType.DM });
    (dmChannel as any).recipient = { id: '100' };
    const dmSource = {
      channel: dmChannel,
      guild: null,
      author: { id: '100' },
    } as unknown as Message;

    const clientEmpty = {
      user: { id: '999' },
      channels: {
        fetch: jest.fn().mockRejectedValue(new Error('Unknown Channel')),
      },
      guilds: { cache: new Collection() },
    } as unknown as Client;

    const result = await discordActionClient.getArtifact(
      clientEmpty,
      { channel: 'nonexistent' },
      'alice',
      dmSource,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should fall back to DM channel when no channel arg is provided', async () => {
    const msgs = [
      fakeMessage({ id: '70', content: 'dm message', createdTimestamp: 7000, createdAt: new Date(7000) }),
    ];
    const dmChannel = buildChannel(msgs, { name: 'dm-chan', id: '123', type: ChannelType.DM });
    (dmChannel as any).recipient = { id: '100' };
    const dmSource = {
      channel: dmChannel,
      guild: null,
      author: { id: '100' },
    } as unknown as Message;

    const result = await discordActionClient.getArtifact(
      fakeClient,
      {},
      'alice',
      dmSource,
    );

    expect(result.success).toBe(true);
    expect(result.data?.text).toContain('dm message');
  });

  // ── type guard tests ────────────────────────────────────────

  it('should reject non-string channel argument', async () => {
    const channel = buildChannel([]);
    const source = buildSourceMessage(channel);

    const result = await discordActionClient.getArtifact(
      fakeClient,
      { channel: 12345 as unknown as string },
      'alice',
      source,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Channel argument must be a string');
  });

  it('should reject non-string message_id argument', async () => {
    const channel = buildChannel([]);
    const source = buildSourceMessage(channel);

    const result = await discordActionClient.getArtifact(
      fakeClient,
      { message_id: 42 as unknown as string },
      'alice',
      source,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('message_id argument must be a string');
  });
});

// ── deleteMessage ─────────────────────────────────────────────

describe('deleteMessage', () => {
  const BOT_ID = '999';

  /** Build a fake message with a configurable author. */
  function fakeDeleteTarget(
    overrides: Partial<{
      id: string;
      content: string;
      authorId: string;
      authorBot: boolean;
      deleted: boolean;
    }> = {},
  ): Message {
    const msg = fakeMessage({
      id: overrides.id ?? '500',
      content: overrides.content ?? 'bot reply',
      username: 'BobBot',
    });
    (msg.author as any).id = overrides.authorId ?? BOT_ID;
    (msg.author as any).bot = overrides.authorBot ?? true;
    (msg as any).delete = jest.fn().mockResolvedValue(undefined);
    return msg;
  }

  function buildSourceWithRef(
    channel: TextChannel,
    refMessageId?: string,
  ): Message {
    const source = buildSourceMessage(channel);
    (source as any).id = '600';
    if (refMessageId) {
      (source as any).reference = { messageId: refMessageId };
    }
    return source;
  }

  // ── Priority 1: explicit message_id ─────────────────────────

  it('should delete a bot message by explicit message_id', async () => {
    const botMsg = fakeDeleteTarget({ id: '500' });
    const channel = buildChannel([botMsg]);
    const source = buildSourceWithRef(channel);

    const result = await discordActionClient.deleteMessage(
      fakeClient,
      { message_id: '500' },
      'alice',
      source,
    );

    expect(result.success).toBe(true);
    expect(result.data?.text).toContain('Deleted bot message');
    expect(result.data?.text).toContain('500');
    expect(botMsg.delete).toHaveBeenCalled();
  });

  it('should refuse to delete a non-bot message by explicit message_id', async () => {
    const userMsg = fakeDeleteTarget({ id: '501', authorId: '100' });
    const channel = buildChannel([userMsg]);
    const source = buildSourceWithRef(channel);

    const result = await discordActionClient.deleteMessage(
      fakeClient,
      { message_id: '501' },
      'alice',
      source,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not sent by the bot');
    expect(userMsg.delete).not.toHaveBeenCalled();
  });

  // ── Priority 2: reply target ────────────────────────────────

  it('should delete the reply target when no explicit selector is given', async () => {
    const botMsg = fakeDeleteTarget({ id: '502' });
    const channel = buildChannel([botMsg]);
    const source = buildSourceWithRef(channel, '502');

    const result = await discordActionClient.deleteMessage(
      fakeClient,
      {},
      'alice',
      source,
    );

    expect(result.success).toBe(true);
    expect(result.data?.text).toContain('502');
    expect(botMsg.delete).toHaveBeenCalled();
  });

  it('should fall through to last bot message when reply target is not found', async () => {
    const botMsg = fakeDeleteTarget({ id: '503' });
    const channel = buildChannel([botMsg]);
    // Reply points to a deleted message (not in channel)
    const source = buildSourceWithRef(channel, '999999');

    const result = await discordActionClient.deleteMessage(
      fakeClient,
      {},
      'alice',
      source,
    );

    expect(result.success).toBe(true);
    expect(result.data?.text).toContain('503');
  });

  // ── Priority 3: last bot message in scope ───────────────────

  it('should delete the most recent bot message when no selectors are given', async () => {
    const userMsg = fakeMessage({ id: '510' });
    (userMsg.author as any).id = '100';
    const botMsg = fakeDeleteTarget({ id: '511' });
    const channel = buildChannel([userMsg, botMsg]);
    const source = buildSourceWithRef(channel);

    const result = await discordActionClient.deleteMessage(
      fakeClient,
      {},
      'alice',
      source,
    );

    expect(result.success).toBe(true);
    expect(botMsg.delete).toHaveBeenCalled();
  });

  it('should not delete the source message itself when searching for last bot message', async () => {
    // Only message is the source message issued by the bot (the "working" message)
    const botMsg = fakeDeleteTarget({ id: '600' });
    const channel = buildChannel([botMsg]);
    const source = buildSourceWithRef(channel);
    // source.id === '600' matches the bot message id, so it should be skipped

    const result = await discordActionClient.deleteMessage(
      fakeClient,
      {},
      'alice',
      source,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No recent bot message found');
  });

  it('should return error when no bot message is found at all', async () => {
    const userMsg = fakeMessage({ id: '520' });
    (userMsg.author as any).id = '100';
    const channel = buildChannel([userMsg]);
    const source = buildSourceWithRef(channel);

    const result = await discordActionClient.deleteMessage(
      fakeClient,
      {},
      'alice',
      source,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No recent bot message found');
  });

  // ── Channel selector ────────────────────────────────────────

  it('should resolve channel by name within the guild', async () => {
    const botMsg = fakeDeleteTarget({ id: '530' });
    const targetChannel = buildChannel([botMsg], { name: 'announcements', id: '888' });
    const sourceChannel = buildChannel([], { name: 'general', id: '777' });

    const source = {
      id: '600',
      channel: sourceChannel,
      guild: {
        channels: {
          cache: new Collection<string, TextChannel>([
            ['777', sourceChannel],
            ['888', targetChannel],
          ]),
        },
      },
      author: { id: '100' },
    } as unknown as Message;

    const result = await discordActionClient.deleteMessage(
      fakeClient,
      { channel: 'announcements' },
      'alice',
      source,
    );

    expect(result.success).toBe(true);
    expect(botMsg.delete).toHaveBeenCalled();
  });

  it('should return error for unknown channel name', async () => {
    const channel = buildChannel([]);
    const source = buildSourceWithRef(channel);

    const result = await discordActionClient.deleteMessage(
      fakeClient,
      { channel: 'nonexistent' },
      'alice',
      source,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should return disambiguation error for ambiguous channel name', async () => {
    const ch1 = buildChannel([], { name: 'general', id: '111' });
    const ch2 = buildChannel([], { name: 'general', id: '222' });
    const sourceChannel = buildChannel([], { name: 'other', id: '333' });

    const source = {
      id: '600',
      channel: sourceChannel,
      guild: {
        channels: {
          cache: new Collection<string, TextChannel>([
            ['111', ch1],
            ['222', ch2],
            ['333', sourceChannel],
          ]),
        },
      },
      author: { id: '100' },
    } as unknown as Message;

    const result = await discordActionClient.deleteMessage(
      fakeClient,
      { channel: 'general' },
      'alice',
      source,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Ambiguous channel');
    expect(result.error).toContain('111');
    expect(result.error).toContain('222');
  });

  // ── Username (DM) selector ──────────────────────────────────

  it('should resolve DM channel by username and delete bot message', async () => {
    const botMsg = fakeDeleteTarget({ id: '540' });
    const dmChannel = buildChannel([botMsg], { name: 'dm-chan', id: '444', type: ChannelType.DM });

    const targetUser = {
      id: '200',
      createDM: jest.fn().mockResolvedValue(dmChannel),
    };

    const memberCache = new Collection<string, any>();
    memberCache.set('200', {
      id: '200',
      user: { username: 'dave', id: '200' },
      displayName: 'Dave',
    });

    const guildCache = new Collection<string, any>();
    guildCache.set('guild1', { members: { cache: memberCache } });

    const clientWithDM = {
      user: { id: BOT_ID },
      guilds: { cache: guildCache },
      users: { fetch: jest.fn().mockResolvedValue(targetUser) },
    } as unknown as Client;

    const sourceChannel = buildChannel([], { name: 'general', id: '999' });
    const source = {
      id: '600',
      channel: sourceChannel,
      guild: null,
      author: { id: '100' },
    } as unknown as Message;

    const result = await discordActionClient.deleteMessage(
      clientWithDM,
      { username: 'dave' },
      'alice',
      source,
    );

    expect(result.success).toBe(true);
    expect(botMsg.delete).toHaveBeenCalled();
  });

  it('should return error for unknown username', async () => {
    const guildCache = new Collection<string, any>();
    guildCache.set('guild1', { members: { cache: new Collection() } });

    const clientEmpty = {
      user: { id: BOT_ID },
      guilds: { cache: guildCache },
    } as unknown as Client;

    const channel = buildChannel([]);
    const source = buildSourceWithRef(channel);

    const result = await discordActionClient.deleteMessage(
      clientEmpty,
      { username: 'ghost' },
      'alice',
      source,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('User "ghost" not found');
  });

  // ── Thread channel support ──────────────────────────────────

  it('should resolve thread channels by name', async () => {
    const botMsg = fakeDeleteTarget({ id: '550' });
    const threadChannel = buildChannel([botMsg], {
      name: 'help-thread',
      id: '555',
      type: ChannelType.PublicThread,
    });
    const sourceChannel = buildChannel([], { name: 'general', id: '777' });

    const source = {
      id: '600',
      channel: sourceChannel,
      guild: {
        channels: {
          cache: new Collection<string, TextChannel>([
            ['777', sourceChannel],
            ['555', threadChannel],
          ]),
        },
      },
      author: { id: '100' },
    } as unknown as Message;

    const result = await discordActionClient.deleteMessage(
      fakeClient,
      { channel: 'help-thread' },
      'alice',
      source,
    );

    expect(result.success).toBe(true);
    expect(botMsg.delete).toHaveBeenCalled();
  });

  // ── Error handling ──────────────────────────────────────────

  it('should handle Unknown Message error gracefully', async () => {
    const channel = buildChannel([]);
    // Override fetch to throw Unknown Message
    (channel.messages.fetch as jest.Mock).mockImplementation(async (arg: any) => {
      if (typeof arg === 'string') throw new Error('Unknown Message');
      return new Collection();
    });
    const source = buildSourceWithRef(channel);

    const result = await discordActionClient.deleteMessage(
      fakeClient,
      { message_id: '999999' },
      'alice',
      source,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('may have already been deleted');
  });

  it('should handle generic delete failure', async () => {
    const botMsg = fakeDeleteTarget({ id: '560' });
    (botMsg.delete as jest.Mock).mockRejectedValue(new Error('Missing Permissions'));
    const channel = buildChannel([botMsg]);
    const source = buildSourceWithRef(channel);

    const result = await discordActionClient.deleteMessage(
      fakeClient,
      { message_id: '560' },
      'alice',
      source,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to delete message');
    expect(result.error).toContain('Missing Permissions');
  });
});
