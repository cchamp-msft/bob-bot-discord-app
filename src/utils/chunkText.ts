/**
 * Split text into chunks respecting Discord's 2000-character message limit.
 * Prefers splitting on newline boundaries to avoid breaking formatting
 * (e.g. code blocks, lists). Falls back to hard splits when a single line
 * exceeds the limit.
 *
 * Table-aware: fenced code blocks (``` ... ```) are treated as atomic units.
 * The splitter will never break mid-block; if a block fits it stays whole,
 * if it doesn't fit but the block contains pipe-delimited table rows the
 * split happens between rows (re-opening/closing the fence on each chunk).
 */
export function chunkText(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) return [text];

  // Split text into segments: alternating plain-text and fenced-block segments.
  const segments = splitIntoSegments(text);
  const chunks: string[] = [];
  let current = '';

  for (const seg of segments) {
    if (seg.type === 'text') {
      // Append plain text character-by-character via the old algorithm
      current = appendPlainText(current, seg.content, maxLength, chunks);
    } else {
      // Fenced code block — try to keep atomic
      if (current.length + seg.content.length <= maxLength) {
        current += seg.content;
      } else if (seg.content.length <= maxLength) {
        // Flush current, start new chunk with this block
        if (current.length > 0) chunks.push(current);
        current = seg.content;
      } else {
        // Block itself exceeds maxLength — split between rows
        if (current.length > 0) chunks.push(current);
        current = '';
        splitOversizedBlock(seg.content, seg.lang, maxLength, chunks);
      }
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ── Internal types & helpers ─────────────────────────────────

interface Segment {
  type: 'text' | 'block';
  content: string;
  /** Language tag for fenced blocks (may be empty). */
  lang: string;
}

/**
 * Split the input into alternating plain-text and fenced-code-block segments.
 * Preserves the original text exactly (no characters lost or added).
 */
function splitIntoSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  // Match ``` optionally followed by a language tag, then content, then closing ```
  const fenceRe = /^(```([^\n]*)\n)([\s\S]*?\n)(```)\s*$/gm;
  let lastIndex = 0;

  for (const m of text.matchAll(fenceRe)) {
    const start = m.index!;
    if (start > lastIndex) {
      segments.push({ type: 'text', content: text.substring(lastIndex, start), lang: '' });
    }
    segments.push({ type: 'block', content: m[0], lang: (m[2] || '').trim() });
    lastIndex = start + m[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.substring(lastIndex), lang: '' });
  }

  return segments;
}

/**
 * Append plain text to `current`, flushing completed chunks into `chunks`.
 * Returns the updated `current` buffer.
 */
function appendPlainText(
  current: string,
  text: string,
  maxLength: number,
  chunks: string[],
): string {
  let remaining = text;

  while (remaining.length > 0) {
    const available = maxLength - current.length;
    if (remaining.length <= available) {
      current += remaining;
      remaining = '';
      break;
    }

    // Take up to `available` characters from remaining
    const slice = remaining.substring(0, available);
    let splitIndex = slice.lastIndexOf('\n');

    if (splitIndex <= 0) {
      splitIndex = slice.lastIndexOf(' ');
    }

    if (splitIndex <= 0) {
      if (current.length > 0) {
        // Flush current chunk first, then retry with empty buffer
        chunks.push(current);
        current = '';
        continue;
      }
      // Hard split
      splitIndex = available;
      current += remaining.substring(0, splitIndex);
      remaining = remaining.substring(splitIndex);
      chunks.push(current);
      current = '';
    } else {
      splitIndex += 1; // include the delimiter
      current += remaining.substring(0, splitIndex);
      remaining = remaining.substring(splitIndex);
      chunks.push(current);
      current = '';
    }
  }

  return current;
}

/**
 * Split an oversized fenced code block between rows.
 * Each resulting chunk is a self-contained fenced block.
 */
function splitOversizedBlock(
  block: string,
  lang: string,
  maxLength: number,
  chunks: string[],
): void {
  // Strip opening/closing fences
  const lines = block.split('\n');
  // Remove first line (```lang) and last line (```)
  const openFence = lines[0];
  const inner = lines.slice(1, lines.length - 1);
  // If the last line after split is empty (trailing newline), drop it
  if (inner.length > 0 && inner[inner.length - 1].trim() === '```') {
    inner.pop();
  }

  const fence = openFence + '\n';
  const closeFence = '\n```';
  const overhead = fence.length + closeFence.length;

  let current = fence;
  for (const line of inner) {
    const lineWithNl = line + '\n';
    if (current.length + lineWithNl.length + closeFence.length > maxLength) {
      // Flush current block chunk
      if (current.length > fence.length) {
        chunks.push(current + '```');
        current = fence;
      }
      // If a single line + overhead still exceeds max, hard-split it
      if (lineWithNl.length + overhead > maxLength) {
        let rem = lineWithNl;
        while (rem.length > 0) {
          const take = maxLength - overhead;
          chunks.push(fence + rem.substring(0, take) + '```');
          rem = rem.substring(take);
        }
        continue;
      }
    }
    current += lineWithNl;
  }

  if (current.length > fence.length) {
    chunks.push(current + '```');
  }
}
