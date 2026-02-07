import * as fs from 'fs';

/**
 * Decode backslash-escape sequences produced by ConfigWriter.encodeEnvValue().
 *
 * Handles:  \\  →  \
 *           \"  →  "
 *           \n  →  newline
 *           \r  →  carriage return
 *
 * Any other \X sequence is left as-is so intentional backslashes
 * that aren't part of a known escape survive untouched.
 */
export function decodeDotenvEscapes(value: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < value.length) {
    if (value[i] === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      switch (next) {
        case '\\': out.push('\\'); i += 2; break;
        case '"':  out.push('"');  i += 2; break;
        case 'n':  out.push('\n'); i += 2; break;
        case 'r':  out.push('\r'); i += 2; break;
        default:
          // Unknown escape — preserve literally
          out.push(value[i]);
          i += 1;
          break;
      }
    } else {
      out.push(value[i]);
      i += 1;
    }
  }
  return out.join('');
}

/**
 * Read a single key from a .env file and return its decoded value.
 *
 * If the value is wrapped in double quotes, backslash escapes are
 * decoded (inverting ConfigWriter.encodeEnvValue).  Unquoted values
 * are returned as-is.
 *
 * Returns undefined when the key isn't present in the file.
 */
export function readEnvVar(envPath: string, key: string): string | undefined {
  if (!fs.existsSync(envPath)) return undefined;

  const content = fs.readFileSync(envPath, 'utf-8');
  return readEnvVarFromString(content, key);
}

/**
 * Same as readEnvVar but operates on a string instead of a file path.
 * Useful for testing without touching the filesystem.
 */
export function readEnvVarFromString(content: string, key: string): string | undefined {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const lineKey = trimmed.substring(0, eqIdx).trim();
    if (lineKey !== key) continue;

    let raw = trimmed.substring(eqIdx + 1);

    // Double-quoted value → decode escapes
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      raw = raw.slice(1, -1);
      return decodeDotenvEscapes(raw);
    }

    // Single-quoted value → return verbatim (no escape processing)
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      return raw.slice(1, -1);
    }

    // Unquoted → return as-is
    return raw;
  }

  return undefined;
}
