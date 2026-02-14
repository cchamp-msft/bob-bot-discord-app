/**
 * Activity Events — privacy-first, public-facing event stream.
 *
 * Provides an in-memory ring buffer of sanitized narrative events that
 * describe the bot's decision-making from a first-person perspective.
 * No raw message content, user IDs, guild IDs, API keys, or endpoint
 * URLs are ever stored.
 *
 * Consumers: GET /api/activity (outputsServer), activity.html (polling UI).
 */

// ── Types ────────────────────────────────────────────────────────

export type ActivityEventType =
  | 'message_received'
  | 'routing_decision'
  | 'bot_reply'
  | 'error'
  | 'warning';

export interface ActivityEvent {
  /** Unique event identifier (monotonic counter). */
  id: number;
  /** ISO-8601 timestamp of when the event was created. */
  timestamp: string;
  /** Categorises the event for colour-coding and filtering. */
  type: ActivityEventType;
  /** First-person narrative text shown on the activity page. */
  narrative: string;
  /** Optional structured metadata (never contains sensitive data). */
  metadata: Record<string, string | number | boolean>;
  /** Optional image URLs served by the outputs server. */
  imageUrls: string[];
}

// ── Narrative templates ──────────────────────────────────────────

type LocationKind = 'dm' | 'server';

const LOCATION_LABELS: Record<LocationKind, string> = {
  dm: 'a direct message',
  server: 'a server channel',
};

/**
 * Map an API name to a human-friendly phrase for routing narratives.
 * Unknown APIs get a generic fallback.
 */
function apiNarrative(api: string): string {
  switch (api) {
    case 'accuweather': return 'check the weather';
    case 'comfyui': return 'create some images';
    case 'nfl': return 'look up NFL data';
    case 'serpapi': return 'search the web';
    case 'ollama': return 'think about that';
    default: return `use ${api}`;
  }
}

// ── Sanitisation helpers ─────────────────────────────────────────

/**
 * Classify a Discord channel interaction as DM or server without
 * exposing channel IDs or guild names.
 */
export function sanitizeLocation(isDM: boolean): LocationKind {
  return isDM ? 'dm' : 'server';
}

/**
 * Strip anything that looks like an API key, URL, user ID, or other
 * sensitive token from a free-form string.  Used as a safety net on
 * any text that might flow into event narratives.
 */
export function redactSensitive(text: string): string {
  let result = text;
  // Remove URLs
  result = result.replace(/https?:\/\/[^\s"')]+/gi, '[redacted-url]');
  // Remove Discord-style snowflake IDs (17-20 digit numbers)
  result = result.replace(/\b\d{17,20}\b/g, '[redacted-id]');
  // Remove API-key-like tokens (long hex/base64 strings)
  result = result.replace(/\b[A-Za-z0-9_\-]{32,}\b/g, '[redacted-token]');
  return result;
}

// ── Ring buffer ───────────────────────────────────────────────────

const DEFAULT_BUFFER_CAPACITY = 100;
const DEFAULT_RECENT_COUNT = 50;

class ActivityEventStore {
  private buffer: ActivityEvent[] = [];
  private nextId = 1;
  private capacity: number;

  constructor(capacity = DEFAULT_BUFFER_CAPACITY) {
    this.capacity = capacity;
  }

  /**
   * Record a new activity event.
   * The narrative is always run through the redaction safety net.
   */
  emit(
    type: ActivityEventType,
    narrative: string,
    metadata: Record<string, string | number | boolean> = {},
    imageUrls: string[] = []
  ): ActivityEvent {
    const event: ActivityEvent = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      type,
      narrative: redactSensitive(narrative),
      metadata,
      imageUrls,
    };
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    return event;
  }

  /**
   * Return the most recent `count` events, optionally filtered to only
   * those occurring after `sinceTimestamp` (ISO-8601).
   */
  getRecent(count = DEFAULT_RECENT_COUNT, sinceTimestamp?: string): ActivityEvent[] {
    let events = this.buffer;
    if (sinceTimestamp) {
      events = events.filter(e => e.timestamp > sinceTimestamp);
    }
    return events.slice(-count);
  }

  /** Remove all stored events (useful for tests). */
  clear(): void {
    this.buffer = [];
    this.nextId = 1;
  }

  /** Current number of stored events. */
  get size(): number {
    return this.buffer.length;
  }

  // ── Convenience emitters with narrative templates ────────────

  /** Someone sent a DM or @mentioned the bot. */
  emitMessageReceived(isDM: boolean): ActivityEvent {
    const loc = sanitizeLocation(isDM);
    return this.emit('message_received', `Someone wants my attention in ${LOCATION_LABELS[loc]}`, { location: loc });
  }

  /** A routing / API decision was made. */
  emitRoutingDecision(api: string, keyword: string, stage?: string): ActivityEvent {
    const meta: Record<string, string> = { api, keyword };
    if (stage) meta.stage = stage;
    return this.emit('routing_decision', `I need to ${apiNarrative(api)}`, meta);
  }

  /** The bot sent a text reply. */
  emitBotReply(api: string, characterCount: number): ActivityEvent {
    return this.emit('bot_reply', 'Done! Here\'s what I found', { api, characterCount });
  }

  /** The bot sent an image reply. */
  emitBotImageReply(imageCount: number, imageUrls: string[]): ActivityEvent {
    const plural = imageCount === 1 ? 'image' : 'images';
    return this.emit(
      'bot_reply',
      `I created ${imageCount} ${plural} for you`,
      { api: 'comfyui', imageCount },
      imageUrls
    );
  }

  /** A user-visible error occurred. */
  emitError(context?: string): ActivityEvent {
    const narrative = context
      ? `Oops, something went wrong — ${redactSensitive(context)}`
      : 'Oops, something went wrong — I couldn\'t complete that';
    return this.emit('error', narrative);
  }

  /** Something took longer than expected or produced a partial result. */
  emitWarning(context?: string): ActivityEvent {
    const narrative = context
      ? `Hmm, ${redactSensitive(context)}`
      : 'Hmm, that took longer than expected';
    return this.emit('warning', narrative);
  }
}

// ── Singleton export ─────────────────────────────────────────────

export const activityEvents = new ActivityEventStore();
