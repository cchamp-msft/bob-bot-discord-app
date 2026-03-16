import * as path from 'path';

/**
 * Sanitize a tool name so it is safe to use as a filename component.
 * Strips path separators and ".." to prevent path-traversal attacks.
 */
export function sanitizeToolName(name: string): string {
  return path.basename(name).replace(/\.\./g, '');
}
