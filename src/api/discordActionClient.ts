import {
  Client,
  Message,
  TextChannel,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { DiscordActionResponse } from '../types';

const MAX_CONTENT_LENGTH = 2000;

// ── sendToGuildChannel ─────────────────────────────────────────

interface SendToGuildChannelArgs {
  guild: string;
  channel: string;
  content: string;
}

export async function sendToGuildChannel(
  client: Client,
  args: SendToGuildChannelArgs,
  requester: string,
): Promise<DiscordActionResponse> {
  const { guild: guildQuery, channel: channelQuery, content } = args;

  if (!content?.trim()) {
    return { success: false, error: 'Content is required.' };
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return { success: false, error: `Content exceeds ${MAX_CONTENT_LENGTH} character limit.` };
  }

  // Resolve guild by name (case-insensitive) or ID
  const resolved = client.guilds.cache.find(
    (g) => g.id === guildQuery || g.name.toLowerCase() === guildQuery.toLowerCase(),
  );
  if (!resolved) {
    return { success: false, error: `Guild "${guildQuery}" not found or bot is not a member.` };
  }

  // Resolve text channel by name or ID within the guild
  const ch = resolved.channels.cache.find(
    (c) =>
      (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
      (c.id === channelQuery || c.name.toLowerCase() === channelQuery.toLowerCase().replace(/^#/, '')),
  ) as TextChannel | undefined;

  if (!ch) {
    return { success: false, error: `Text channel "${channelQuery}" not found in guild "${resolved.name}".` };
  }

  // Verify bot has SendMessages permission
  const botMember = resolved.members.me;
  if (botMember && !ch.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages)) {
    return { success: false, error: `Bot lacks SendMessages permission in #${ch.name}.` };
  }

  try {
    const sent = await ch.send(content);
    logger.log('success', 'system',
      `DISCORD-ACTION: ${requester} sent message to #${ch.name} in ${resolved.name} (${sent.id})`);
    return {
      success: true,
      data: { text: `Message sent to #${ch.name} in ${resolved.name}.` },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to send message: ${msg}` };
  }
}

// ── sendToUser ─────────────────────────────────────────────────

interface SendToUserArgs {
  user: string;
  content: string;
}

export async function sendToUser(
  client: Client,
  args: SendToUserArgs,
  requester: string,
): Promise<DiscordActionResponse> {
  const { user: userQuery, content } = args;

  if (!content?.trim()) {
    return { success: false, error: 'Content is required.' };
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return { success: false, error: `Content exceeds ${MAX_CONTENT_LENGTH} character limit.` };
  }

  // Resolve user: <@id> mention, raw ID, or username
  let targetId: string | undefined;
  const mentionMatch = userQuery.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    targetId = mentionMatch[1];
  } else if (/^\d{17,20}$/.test(userQuery)) {
    targetId = userQuery;
  } else {
    // Search by username across shared guilds
    for (const guild of client.guilds.cache.values()) {
      const member = guild.members.cache.find(
        (m) => m.user.username.toLowerCase() === userQuery.toLowerCase()
          || m.displayName.toLowerCase() === userQuery.toLowerCase(),
      );
      if (member) {
        targetId = member.id;
        break;
      }
    }
  }

  if (!targetId) {
    return { success: false, error: `User "${userQuery}" not found. Try using their @mention or ID.` };
  }

  // Fetch user object
  let targetUser;
  try {
    targetUser = await client.users.fetch(targetId);
  } catch {
    return { success: false, error: `Could not fetch user with ID ${targetId}.` };
  }

  if (targetUser.bot) {
    return { success: false, error: 'Cannot send DMs to other bots.' };
  }

  // Verify target shares a guild with the bot
  const sharesGuild = client.guilds.cache.some(
    (g) => g.members.cache.has(targetId!),
  );
  if (!sharesGuild) {
    return { success: false, error: `User "${targetUser.username}" does not share a guild with the bot.` };
  }

  try {
    await targetUser.send(content);
    logger.log('success', 'system',
      `DISCORD-ACTION: ${requester} sent DM to ${targetUser.username} (${targetUser.id})`);
    return {
      success: true,
      data: { text: `DM sent to ${targetUser.username}.` },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Common: user has DMs disabled
    if (msg.includes('Cannot send messages to this user')) {
      return { success: false, error: `${targetUser.username} has DMs disabled or the bot is blocked.` };
    }
    return { success: false, error: `Failed to send DM: ${msg}` };
  }
}

// ── getArtifact ────────────────────────────────────────────────

interface GetArtifactArgs {
  channel?: string;
  message_id?: string;
  search?: string;
}

export async function getArtifact(
  client: Client,
  args: GetArtifactArgs,
  requester: string,
  sourceMessage: Message,
): Promise<DiscordActionResponse> {
  const { channel: channelQuery, message_id: messageId, search } = args;

  // Resolve channel: provided name/ID, or default to source channel
  let targetChannel = sourceMessage.channel;
  if (channelQuery) {
    const guild = sourceMessage.guild;
    if (guild) {
      const found = guild.channels.cache.find(
        (c) =>
          (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
          (c.id === channelQuery || c.name.toLowerCase() === channelQuery.toLowerCase().replace(/^#/, '')),
      );
      if (found) {
        targetChannel = found as TextChannel;
      } else {
        return { success: false, error: `Channel "${channelQuery}" not found.` };
      }
    }
  }

  // DM channel security: only allow retrieval from requester's own DM
  if (targetChannel.type === ChannelType.DM) {
    const dmRecipient = targetChannel.recipient ?? (await targetChannel.fetch()).recipient;
    if (dmRecipient?.id !== sourceMessage.author.id && sourceMessage.author.id !== client.user?.id) {
      return { success: false, error: 'Cannot retrieve messages from another user\'s DM channel.' };
    }
  }

  if (!targetChannel.isTextBased()) {
    return { success: false, error: 'Target channel is not text-based.' };
  }

  try {
    let targetMessage: Message | undefined;

    if (messageId) {
      // Fetch specific message by ID
      targetMessage = await targetChannel.messages.fetch(messageId);
    } else if (search) {
      // Search recent 50 messages for case-insensitive substring match
      const messages = await targetChannel.messages.fetch({ limit: 50 });
      const needle = search.toLowerCase();
      targetMessage = messages.find(
        (m) => m.content.toLowerCase().includes(needle),
      );
      if (!targetMessage) {
        return { success: false, error: `No message found matching "${search}" in recent history.` };
      }
    } else {
      // Channel-only: return a bounded summary of recent messages
      const maxMessages = config.getDiscordArtifactMaxMessages();
      const maxImages = config.getDiscordArtifactMaxImages();
      const messages = await targetChannel.messages.fetch({ limit: maxMessages });
      const sorted = [...messages.values()].sort(
        (a, b) => a.createdTimestamp - b.createdTimestamp,
      );

      const messageParts: string[] = [];
      let imageCount = 0;
      const collectedImages: string[] = [];

      for (const m of sorted) {
        const line = `[${m.createdAt.toISOString()}] [id:${m.id}] ${m.author.username}: ${m.content || '(no text content)'}`;
        messageParts.push(line);

        if (imageCount < maxImages) {
          for (const att of m.attachments.values()) {
            if (imageCount >= maxImages) break;
            if (att.contentType?.startsWith('image/')) {
              collectedImages.push(att.url);
              imageCount++;
            }
          }
        }
      }

      const summary = [
        `Channel: #${(targetChannel as TextChannel).name ?? targetChannel.id}`,
        `Messages returned: ${sorted.length}`,
        '',
        ...messageParts,
      ];

      if (collectedImages.length > 0) {
        summary.push('', `Images (${collectedImages.length}): ${collectedImages.join(', ')}`);
      }

      return {
        success: true,
        data: { text: summary.join('\n') },
      };
    }

    const attachments = targetMessage.attachments.map((a) => a.url);
    const parts = [
      `Message ID: ${targetMessage.id}`,
      `Author: ${targetMessage.author.username}`,
      `Timestamp: ${targetMessage.createdAt.toISOString()}`,
      `Content: ${targetMessage.content || '(no text content)'}`,
    ];
    if (attachments.length > 0) {
      parts.push(`Attachments: ${attachments.join(', ')}`);
    }

    return {
      success: true,
      data: { text: parts.join('\n') },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to retrieve message: ${msg}` };
  }
}

// ── reactToMessage ─────────────────────────────────────────────

interface ReactToMessageArgs {
  emoji: string;
  target?: string;
  message_id?: string;
}

export async function reactToMessage(
  client: Client,
  args: ReactToMessageArgs,
  requester: string,
  sourceMessage: Message,
): Promise<DiscordActionResponse> {
  const { emoji, target, message_id: messageId } = args;

  if (!emoji?.trim()) {
    return { success: false, error: 'Emoji is required.' };
  }

  const channel = sourceMessage.channel;
  if (!channel.isTextBased()) {
    return { success: false, error: 'Channel is not text-based.' };
  }

  try {
    let targetMessage: Message | undefined;

    if (messageId) {
      // Fetch by explicit message ID
      targetMessage = await channel.messages.fetch(messageId);
    } else if (target && target.toLowerCase() !== 'last') {
      // Search for exact text match in recent messages
      const messages = await channel.messages.fetch({ limit: 50 });
      const needle = target.toLowerCase();
      targetMessage = messages.find(
        (m) => m.content.toLowerCase().includes(needle),
      );
      if (!targetMessage) {
        return { success: false, error: `No message found matching "${target}".` };
      }
    } else {
      // Default: most recent non-bot message in channel (excluding the trigger)
      const messages = await channel.messages.fetch({ limit: 10 });
      targetMessage = messages.find(
        (m) => !m.author.bot && m.id !== sourceMessage.id,
      );
      if (!targetMessage) {
        return { success: false, error: 'No recent non-bot message found to react to.' };
      }
    }

    // Parse emoji: custom format <:name:id> or name:id, otherwise unicode
    let emojiInput = emoji.trim();
    const customMatch = emojiInput.match(/^<?:?(\w+):(\d+)>?$/);
    if (customMatch) {
      emojiInput = `${customMatch[1]}:${customMatch[2]}`;
    }

    await targetMessage.react(emojiInput);
    logger.log('success', 'system',
      `DISCORD-ACTION: ${requester} reacted with ${emojiInput} to message ${targetMessage.id}`);
    return {
      success: true,
      data: { text: `Reacted with ${emoji} to message from ${targetMessage.author.username}.` },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Unknown Emoji')) {
      return { success: false, error: `Unknown emoji "${emoji}". Check the emoji name or use a unicode emoji.` };
    }
    return { success: false, error: `Failed to react: ${msg}` };
  }
}
