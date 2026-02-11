import { ChatMessage } from '../src/types';
import {
  getContextSource,
  groupMessagesBySource,
  formatSourceTag,
} from '../src/utils/contextFormatter';

describe('contextFormatter', () => {
  describe('getContextSource', () => {
    it('should return the contextSource when present', () => {
      const msg: ChatMessage = { role: 'user', content: 'hi', contextSource: 'reply' };
      expect(getContextSource(msg)).toBe('reply');
    });

    it('should return "unknown" when contextSource is absent', () => {
      const msg: ChatMessage = { role: 'user', content: 'hi' };
      expect(getContextSource(msg)).toBe('unknown');
    });
  });

  describe('groupMessagesBySource', () => {
    it('should group messages by their contextSource', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'a', contextSource: 'channel' },
        { role: 'assistant', content: 'b', contextSource: 'reply' },
        { role: 'user', content: 'c', contextSource: 'channel' },
      ];

      const groups = groupMessagesBySource(messages);

      expect(groups.size).toBe(2);
      expect(groups.get('channel')).toHaveLength(2);
      expect(groups.get('reply')).toHaveLength(1);
    });

    it('should preserve order within each group', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'first', contextSource: 'channel' },
        { role: 'user', content: 'second', contextSource: 'channel' },
      ];

      const groups = groupMessagesBySource(messages);
      const channelMsgs = groups.get('channel')!;

      expect(channelMsgs[0].content).toBe('first');
      expect(channelMsgs[1].content).toBe('second');
    });

    it('should use "unknown" for messages without contextSource', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'no source' },
      ];

      const groups = groupMessagesBySource(messages);

      expect(groups.has('unknown')).toBe(true);
      expect(groups.get('unknown')).toHaveLength(1);
    });

    it('should return an empty map for empty input', () => {
      const groups = groupMessagesBySource([]);
      expect(groups.size).toBe(0);
    });
  });

  describe('formatSourceTag', () => {
    it('should return a bracketed source tag when contextSource is present', () => {
      const msg: ChatMessage = { role: 'user', content: 'hi', contextSource: 'thread' };
      expect(formatSourceTag(msg)).toBe(' [thread]');
    });

    it('should return empty string when contextSource is absent', () => {
      const msg: ChatMessage = { role: 'user', content: 'hi' };
      expect(formatSourceTag(msg)).toBe('');
    });
  });
});
