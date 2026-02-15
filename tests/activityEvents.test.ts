/**
 * ActivityEvents tests — exercises the in-memory ring buffer, narrative
 * templates, since-filtering, capacity enforcement, sanitisation guards,
 * and convenience emitters.
 */

import {
  activityEvents,
  normalizeNarrative,
  redactSensitive,
  sanitizeLocation,
  type ActivityEvent,
  type ActivityEventType,
} from '../src/utils/activityEvents';

// ── Helpers ──────────────────────────────────────────────────────

/** Tiny sleep for timestamp separation in ordering tests. */
const tick = () => new Promise(r => setTimeout(r, 5));

// ── Tests ────────────────────────────────────────────────────────

describe('ActivityEventStore', () => {
  beforeEach(() => {
    activityEvents.clear();
  });

  // ── emit / getRecent basics ──────────────────────────────────

  describe('emit', () => {
    it('creates an event with correct fields', () => {
      const ev = activityEvents.emit('message_received', 'Hello');
      expect(ev).toMatchObject({
        id: 1,
        type: 'message_received',
        narrative: 'Hello',
        metadata: {},
        imageUrls: [],
      });
      expect(ev.timestamp).toBeDefined();
      expect(new Date(ev.timestamp).toISOString()).toBe(ev.timestamp);
    });

    it('assigns monotonically increasing ids', () => {
      const a = activityEvents.emit('message_received', 'a');
      const b = activityEvents.emit('routing_decision', 'b');
      const c = activityEvents.emit('bot_reply', 'c');
      expect(b.id).toBe(a.id + 1);
      expect(c.id).toBe(b.id + 1);
    });

    it('stores metadata and imageUrls', () => {
      const ev = activityEvents.emit(
        'bot_reply',
        'Done',
        { api: 'comfyui', count: 2 },
        ['http://localhost:3003/img1.png']
      );
      expect(ev.metadata).toEqual({ api: 'comfyui', count: 2 });
      expect(ev.imageUrls).toEqual(['http://localhost:3003/img1.png']);
    });
  });

  describe('getRecent', () => {
    it('returns empty array when no events', () => {
      expect(activityEvents.getRecent()).toEqual([]);
    });

    it('returns events in chronological order', () => {
      activityEvents.emit('message_received', 'first');
      activityEvents.emit('routing_decision', 'second');
      activityEvents.emit('bot_reply', 'third');

      const events = activityEvents.getRecent();
      expect(events.map(e => e.narrative)).toEqual(['first', 'second', 'third']);
    });

    it('limits results to requested count', () => {
      for (let i = 0; i < 10; i++) {
        activityEvents.emit('message_received', `event-${i}`);
      }
      const events = activityEvents.getRecent(3);
      expect(events).toHaveLength(3);
      expect(events[0].narrative).toBe('event-7');
      expect(events[2].narrative).toBe('event-9');
    });
  });

  // ── since filtering ──────────────────────────────────────────

  describe('since filtering', () => {
    it('returns only events after sinceTimestamp', async () => {
      activityEvents.emit('message_received', 'old');
      await tick();
      const cutoff = new Date().toISOString();
      await tick();
      activityEvents.emit('bot_reply', 'new');

      const events = activityEvents.getRecent(50, cutoff);
      expect(events).toHaveLength(1);
      expect(events[0].narrative).toBe('new');
    });

    it('returns all events when sinceTimestamp is in the past', () => {
      activityEvents.emit('message_received', 'a');
      activityEvents.emit('bot_reply', 'b');

      const events = activityEvents.getRecent(50, '2000-01-01T00:00:00.000Z');
      expect(events).toHaveLength(2);
    });

    it('returns empty when sinceTimestamp is in the future', () => {
      activityEvents.emit('message_received', 'a');

      const events = activityEvents.getRecent(50, '2099-01-01T00:00:00.000Z');
      expect(events).toHaveLength(0);
    });
  });

  // ── Ring buffer capacity ─────────────────────────────────────

  describe('capacity enforcement', () => {
    it('grooms buffer to 30 events (plus the newly pushed event)', () => {
      // Grooming limit is 30; emit trims before pushing each new event.
      // After 50 emits the buffer stays at 31 (30 after groom + 1 new push).
      for (let i = 0; i < 50; i++) {
        activityEvents.emit('message_received', `event-${i}`);
      }
      expect(activityEvents.size).toBe(31);

      const events = activityEvents.getRecent(200);
      // The newest event is event-49, and the oldest retained is 30 back
      expect(events[events.length - 1].narrative).toBe('event-49');
      expect(events[0].narrative).toBe('event-19');
    });
  });

  // ── clear ────────────────────────────────────────────────────

  describe('clear', () => {
    it('removes all events and resets id counter', () => {
      activityEvents.emit('message_received', 'a');
      activityEvents.emit('bot_reply', 'b');
      expect(activityEvents.size).toBe(2);

      activityEvents.clear();
      expect(activityEvents.size).toBe(0);
      expect(activityEvents.getRecent()).toEqual([]);

      const next = activityEvents.emit('message_received', 'fresh');
      expect(next.id).toBe(1);
    });
  });

  // ── Convenience emitters ─────────────────────────────────────

  describe('emitMessageReceived', () => {
    it('creates DM narrative with message content', () => {
      const ev = activityEvents.emitMessageReceived(true, 'hello bot');
      expect(ev.type).toBe('message_received');
      expect(ev.narrative).toContain('direct message');
      expect(ev.narrative).toContain('hello bot');
      expect(ev.metadata.location).toBe('dm');
    });

    it('creates server narrative with message content', () => {
      const ev = activityEvents.emitMessageReceived(false, 'what is the weather');
      expect(ev.narrative).toContain('server channel');
      expect(ev.narrative).toContain('what is the weather');
      expect(ev.metadata.location).toBe('server');
    });

    it('does not include usernames in narrative', () => {
      const ev = activityEvents.emitMessageReceived(false, 'hi there');
      expect(ev.narrative).not.toContain('user');
    });

    it('preserves URLs in message content', () => {
      const ev = activityEvents.emitMessageReceived(true, 'check https://secret.api/v1 please');
      expect(ev.narrative).toContain('https://secret.api/v1');
      expect(ev.narrative).toContain('check');
    });
  });

  describe('emitRoutingDecision', () => {
    it.each([
      ['accuweather', 'check the weather'],
      ['comfyui', 'create some images'],
      ['nfl', 'look up NFL data'],
      ['serpapi', 'search the web'],
      ['ollama', 'think about that'],
    ])('generates correct narrative for %s', (api, expected) => {
      const ev = activityEvents.emitRoutingDecision(api, 'test-keyword');
      expect(ev.type).toBe('routing_decision');
      expect(ev.narrative).toContain(expected);
      expect(ev.metadata.api).toBe(api);
      expect(ev.metadata.keyword).toBe('test-keyword');
    });

    it('includes stage metadata when provided', () => {
      const ev = activityEvents.emitRoutingDecision('comfyui', 'generate', 'two-stage');
      expect(ev.metadata.stage).toBe('two-stage');
    });

    it('handles unknown API gracefully', () => {
      const ev = activityEvents.emitRoutingDecision('unknown-api', 'kw');
      expect(ev.narrative).toContain('use unknown-api');
    });

    it('suppresses duplicate routing for same api+keyword within dedupe window', () => {
      const first = activityEvents.emitRoutingDecision('comfyui', 'imagine', 'keyword');
      const second = activityEvents.emitRoutingDecision('comfyui', 'imagine', 'api-route');
      // Second call returns the same event — no new entry created
      expect(second.id).toBe(first.id);
      expect(activityEvents.size).toBe(1);
    });

    it('allows routing for different api+keyword', () => {
      activityEvents.emitRoutingDecision('comfyui', 'imagine');
      activityEvents.emitRoutingDecision('accuweather', 'weather');
      expect(activityEvents.size).toBe(2);
    });
  });

  describe('emitBotReply', () => {
    it('produces text reply event for a DM', () => {
      const ev = activityEvents.emitBotReply('ollama', 'The answer is 42.', true);
      expect(ev.type).toBe('bot_reply');
      expect(ev.narrative).toContain('Replied via a direct message');
      expect(ev.narrative).toContain('The answer is 42.');
      expect(ev.metadata).toEqual({ api: 'ollama', location: 'dm', characterCount: 17 });
    });

    it('produces text reply event for a channel message', () => {
      const ev = activityEvents.emitBotReply('ollama', 'Hello world.', false);
      expect(ev.type).toBe('bot_reply');
      expect(ev.narrative).toContain('Replied via a server channel');
      expect(ev.narrative).toContain('Hello world.');
      expect(ev.metadata).toEqual({ api: 'ollama', location: 'server', characterCount: 12 });
    });

    it('preserves URLs in response text', () => {
      const ev = activityEvents.emitBotReply('serpapi', 'Visit https://example.com for details', false);
      expect(ev.narrative).toContain('https://example.com');
    });
  });

  describe('emitBotImageReply', () => {
    it('singular image phrasing', () => {
      const ev = activityEvents.emitBotImageReply(1, ['http://localhost:3003/img.png']);
      expect(ev.narrative).toContain('1 image');
      expect(ev.narrative).not.toContain('images');
      expect(ev.imageUrls).toHaveLength(1);
    });

    it('plural image phrasing', () => {
      const ev = activityEvents.emitBotImageReply(3, ['a', 'b', 'c']);
      expect(ev.narrative).toContain('3 images');
      expect(ev.metadata.imageCount).toBe(3);
    });

    it('uses third-person phrasing (for them, not for you)', () => {
      const ev = activityEvents.emitBotImageReply(2, ['a', 'b']);
      expect(ev.narrative).toContain('for them');
      expect(ev.narrative).not.toContain('for you');
    });
  });

  describe('emitError', () => {
    it('default error narrative', () => {
      const ev = activityEvents.emitError();
      expect(ev.type).toBe('error');
      expect(ev.narrative).toContain('something went wrong');
    });

    it('custom context is included with URLs preserved', () => {
      const ev = activityEvents.emitError('API timeout at https://secret.api/v1');
      expect(ev.narrative).toContain('API timeout');
      expect(ev.narrative).toContain('https://secret.api/v1');
    });
  });

  describe('emitWarning', () => {
    it('default warning narrative', () => {
      const ev = activityEvents.emitWarning();
      expect(ev.type).toBe('warning');
      expect(ev.narrative).toContain('took longer than expected');
    });

    it('custom context is included', () => {
      const ev = activityEvents.emitWarning('that took a while');
      expect(ev.narrative).toContain('that took a while');
    });
  });
});

// ── Sanitisation unit tests ──────────────────────────────────────

describe('redactSensitive', () => {
  it('preserves URLs', () => {
    expect(redactSensitive('see https://api.example.com/v1/key?x=1 for details'))
      .toBe('see https://api.example.com/v1/key?x=1 for details');
  });

  it('removes Discord snowflake IDs', () => {
    expect(redactSensitive('user 123456789012345678 said hello'))
      .toBe('user [redacted-id] said hello');
  });

  it('removes long token-like strings', () => {
    const token = 'a'.repeat(40);
    expect(redactSensitive(`key=${token}`))
      .toBe('key=[redacted-token]');
  });

  it('leaves short normal text alone', () => {
    const text = 'I need to check the weather in Paris';
    expect(redactSensitive(text)).toBe(text);
  });

  it('handles multiple sensitive items but preserves URLs', () => {
    const input = 'user 12345678901234567890 at https://evil.com with token ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12';
    const result = redactSensitive(input);
    expect(result).not.toContain('12345678901234567890');
    expect(result).toContain('https://evil.com');
    expect(result).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12');
  });
});

describe('sanitizeLocation', () => {
  it('returns dm for isDM=true', () => {
    expect(sanitizeLocation(true)).toBe('dm');
  });

  it('returns server for isDM=false', () => {
    expect(sanitizeLocation(false)).toBe('server');
  });
});

// ── Narrative normalisation unit tests ───────────────────────────

describe('normalizeNarrative', () => {
  it('replaces "for you" with "for them"', () => {
    expect(normalizeNarrative('I made this for you')).toBe('I made this for them');
  });

  it('replaces "your" with "their"', () => {
    expect(normalizeNarrative('Here is your answer')).toBe('Here is their answer');
  });

  it('replaces standalone "you" with "them"', () => {
    expect(normalizeNarrative('I told you already')).toBe('I told them already');
  });

  it('is case-insensitive', () => {
    expect(normalizeNarrative('For You, Your request')).toBe('for them, their request');
  });

  it('leaves first-person text unchanged', () => {
    const text = 'I need to check the weather';
    expect(normalizeNarrative(text)).toBe(text);
  });
});

// ── Context decision emitter ────────────────────────────────────

describe('emitContextDecision', () => {
  beforeEach(() => {
    activityEvents.clear();
  });

  it('emits a routing_decision with context_eval subtype', () => {
    const ev = activityEvents.emitContextDecision(3, 8, 'weather', [1, 2, 5]);
    expect(ev.type).toBe('routing_decision');
    expect(ev.metadata.subtype).toBe('context_eval');
    expect(ev.metadata.kept).toBe(3);
    expect(ev.metadata.total).toBe(8);
    expect(ev.narrative).toContain('reviewed 8 messages');
    expect(ev.narrative).toContain('kept 3');
    expect(ev.narrative).toContain('indices: 1, 2, 5');
  });

  it('omits indices clause when not provided', () => {
    const ev = activityEvents.emitContextDecision(2, 5, 'chat');
    expect(ev.narrative).not.toContain('indices');
    expect(ev.narrative).toContain('kept 2');
  });

  it('calculates percentage correctly', () => {
    const ev = activityEvents.emitContextDecision(1, 4, 'search');
    expect(ev.narrative).toContain('25%');
  });
});

// ── Final-pass thought emitter ──────────────────────────────────

describe('emitFinalPassThought', () => {
  beforeEach(() => {
    activityEvents.clear();
  });

  it('emits a routing_decision with final_pass subtype', () => {
    const ev = activityEvents.emitFinalPassThought('weather');
    expect(ev.type).toBe('routing_decision');
    expect(ev.metadata.subtype).toBe('final_pass');
    expect(ev.metadata.keyword).toBe('weather');
    expect(ev.narrative).toBe('I am considering my response');
  });
});

// ── Auto-grooming ───────────────────────────────────────────────

describe('Auto-grooming', () => {
  beforeEach(() => {
    activityEvents.clear();
  });

  it('trims events older than 4 hours on next emit', () => {
    // Manually emit an event and back-date its timestamp via the buffer.
    // We use the fact that emit returns the event and it lives in the buffer.
    const old = activityEvents.emit('message_received', 'stale');

    // Back-date the event to 5 hours ago
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    (old as any).timestamp = fiveHoursAgo;

    // Emit another event — grooming should remove the stale one
    activityEvents.emit('message_received', 'fresh');

    const events = activityEvents.getRecent(200);
    expect(events).toHaveLength(1);
    expect(events[0].narrative).toBe('fresh');
  });

  it('keeps events younger than 4 hours', () => {
    const recent = activityEvents.emit('message_received', 'recent');

    // Back-date to 3 hours ago (within window)
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    (recent as any).timestamp = threeHoursAgo;

    activityEvents.emit('message_received', 'new');

    const events = activityEvents.getRecent(200);
    expect(events).toHaveLength(2);
  });

  it('trims to 30 events when count exceeds limit', () => {
    // Emit 35 events — after grooming the buffer should hold at most 31
    // (30 after groom + 1 new push)
    for (let i = 0; i < 35; i++) {
      activityEvents.emit('message_received', `ev-${i}`);
    }
    expect(activityEvents.size).toBeLessThanOrEqual(31);

    const events = activityEvents.getRecent(200);
    // Most recent event is always retained
    expect(events[events.length - 1].narrative).toBe('ev-34');
  });
});
