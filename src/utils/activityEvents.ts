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

// ── Narrative normalisation ───────────────────────────────────────

/**
 * Rewrite second-person audience language to first→third-person style.
 * The bot speaks about the people it is talking to as "them / their",
 * never addressing the reader as "you / your".
 */
export function normalizeNarrative(text: string): string {
  let result = text;
  // Whole-word replacements, case-insensitive — order matters
  result = result.replace(/\bfor you\b/gi, 'for them');
  result = result.replace(/\byour\b/gi, 'their');
  result = result.replace(/\byou\b/gi, 'them');
  return result;
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
  // Remove Discord-style snowflake IDs (17-20 digit numbers)
  result = result.replace(/\b\d{17,20}\b/g, '[redacted-id]');
  // Remove API-key-like tokens (long hex/base64 strings)
  result = result.replace(/\b[A-Za-z0-9_\-]{32,}\b/g, '[redacted-token]');
  return result;
}

// ── Ring buffer ───────────────────────────────────────────────────

const DEFAULT_BUFFER_CAPACITY = 100;
const DEFAULT_RECENT_COUNT = 50;

/** Maximum age of an event before it is groomed from the buffer. */
const MAX_EVENT_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Soft grooming threshold — oldest events are trimmed when count exceeds this. */
const GROOMING_EVENT_LIMIT = 30;

/** Milliseconds within which identical routing decisions are suppressed. */
const ROUTING_DEDUPE_WINDOW_MS = 5_000;

class ActivityEventStore {
  private buffer: ActivityEvent[] = [];
  private nextId = 1;
  private capacity: number;

  /** Fingerprint + timestamp of the last routing_decision event. */
  private lastRoutingKey = '';
  private lastRoutingTime = 0;

  constructor(capacity = DEFAULT_BUFFER_CAPACITY) {
    this.capacity = capacity;
  }

  /**
   * Remove events older than `MAX_EVENT_AGE_MS` and trim to
   * `GROOMING_EVENT_LIMIT`, whichever is more aggressive.
   * Called automatically inside `emit()` so the buffer stays tidy
   * without requiring external scheduling.
   */
  private groom(): void {
    const cutoff = Date.now() - MAX_EVENT_AGE_MS;
    this.buffer = this.buffer.filter(
      e => new Date(e.timestamp).getTime() >= cutoff
    );
    if (this.buffer.length > GROOMING_EVENT_LIMIT) {
      this.buffer = this.buffer.slice(-GROOMING_EVENT_LIMIT);
    }
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
    // Groom stale / excess events before adding the new one
    this.groom();

    const event: ActivityEvent = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      type,
      narrative: normalizeNarrative(redactSensitive(narrative)),
      metadata,
      imageUrls,
    };
    this.buffer.push(event);

    // Hard cap — safety net in case grooming thresholds are relaxed later
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
    this.lastRoutingKey = '';
    this.lastRoutingTime = 0;
  }

  /** Current number of stored events. */
  get size(): number {
    return this.buffer.length;
  }

  // ── Convenience emitters with narrative templates ────────────

  /** Someone sent a DM or @mentioned the bot. */
  emitMessageReceived(isDM: boolean, messageContent: string): ActivityEvent {
    const loc = sanitizeLocation(isDM);
    return this.emit(
      'message_received',
      `Received in ${LOCATION_LABELS[loc]}: ${messageContent}`,
      { location: loc }
    );
  }

  /**
   * A routing / API decision was made.
   * Duplicate routing decisions for the same api+keyword within the
   * dedupe window are suppressed and return the previously emitted event.
   */
  emitRoutingDecision(api: string, keyword: string, stage?: string): ActivityEvent {
    const meta: Record<string, string> = { api, keyword };
    if (stage) meta.stage = stage;

    // ── dedupe: suppress identical api+keyword within the window ──
    const fingerprint = `${api}:${keyword}`;
    const now = Date.now();
    if (
      fingerprint === this.lastRoutingKey &&
      now - this.lastRoutingTime < ROUTING_DEDUPE_WINDOW_MS
    ) {
      // Return the most recent routing_decision already in the buffer
      const existing = [...this.buffer].reverse().find(e => e.type === 'routing_decision');
      if (existing) return existing;
    }
    this.lastRoutingKey = fingerprint;
    this.lastRoutingTime = now;

    return this.emit('routing_decision', `I need to ${apiNarrative(api)}`, meta);
  }

  /** The bot sent a text reply. */
  emitBotReply(api: string, responseText: string, isDM: boolean): ActivityEvent {
    const loc = sanitizeLocation(isDM);
    return this.emit(
      'bot_reply',
      `Replied via ${LOCATION_LABELS[loc]}: ${responseText}`,
      { api, location: loc, characterCount: responseText.length }
    );
  }

  /** The bot sent an image reply. */
  emitBotImageReply(imageCount: number, imageUrls: string[]): ActivityEvent {
    const plural = imageCount === 1 ? 'image' : 'images';
    return this.emit(
      'bot_reply',
      `I created ${imageCount} ${plural} for them`,
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

  // ── Final-pass thought ──────────────────────────────────────

  /**
   * Emit a thought indicating the bot is performing a final Ollama
   * refinement pass on an API result.
   */
  emitFinalPassThought(keyword: string): ActivityEvent {
    return this.emit('routing_decision', 'I am considering my response', {
      subtype: 'final_pass',
      keyword,
    });
  }

  // ── Context evaluation thought ──────────────────────────────

  /**
   * Emit a thought about context-window evaluation decisions.
   * Surfaced so observers can understand how context was filtered.
   */
  emitContextDecision(
    kept: number,
    total: number,
    keyword: string,
    indices?: number[]
  ): ActivityEvent {
    const pct = total > 0 ? Math.round((kept / total) * 100) : 100;
    const narrative = indices && indices.length > 0
      ? `I reviewed ${total} messages and kept ${kept} (${pct}%) as context for ${keyword} [indices: ${indices.join(', ')}]`
      : `I reviewed ${total} messages and kept ${kept} (${pct}%) as context for ${keyword}`;
    return this.emit('routing_decision', narrative, {
      subtype: 'context_eval',
      keyword,
      kept,
      total,
    });
  }
}

// ── Singleton export ─────────────────────────────────────────────

export const activityEvents = new ActivityEventStore();
