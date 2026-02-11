import { ChatMessage } from '../types';

/**
 * Get the context source label for a message, defaulting to 'unknown'
 * when no contextSource metadata is present.
 */
export function getContextSource(msg: ChatMessage): string {
  return msg.contextSource ?? 'unknown';
}

/**
 * Group messages by their contextSource, preserving chronological order
 * within each group.  Used by both prompt building and context evaluation
 * to ensure uniform source-based presentation.
 */
export function groupMessagesBySource(messages: ChatMessage[]): Map<string, ChatMessage[]> {
  const groups = new Map<string, ChatMessage[]>();
  for (const msg of messages) {
    const source = getContextSource(msg);
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source)!.push(msg);
  }
  return groups;
}

/**
 * Build an inline source tag string for a message (e.g. ` [reply]`).
 * Returns an empty string when no contextSource metadata is present.
 */
export function formatSourceTag(msg: ChatMessage): string {
  return msg.contextSource ? ` [${msg.contextSource}]` : '';
}
