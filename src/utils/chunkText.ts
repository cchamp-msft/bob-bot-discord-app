/**
 * Split text into chunks respecting Discord's 2000-character message limit.
 * Prefers splitting on newline boundaries to avoid breaking formatting
 * (e.g. code blocks, lists). Falls back to hard splits when a single line
 * exceeds the limit.
 */
export function chunkText(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find the last newline within the limit
    const slice = remaining.substring(0, maxLength);
    let splitIndex = slice.lastIndexOf('\n');

    if (splitIndex <= 0) {
      // No newline found — try a space break
      splitIndex = slice.lastIndexOf(' ');
    }

    if (splitIndex <= 0) {
      // No good break point — hard split
      splitIndex = maxLength;
    } else {
      // Include the newline/space in the current chunk
      splitIndex += 1;
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex);
  }

  return chunks;
}
