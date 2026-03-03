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
});
