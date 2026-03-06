/**
 * Shared media persistence helper.
 *
 * Normalises heterogeneous media sources (HTTP URLs, data-URIs, raw buffers)
 * and persists them through {@link fileHandler} into the `outputs/` tree.
 *
 * Both xAI and ComfyUI clients use this at generation-completion time so that
 * every generated image/video is saved before it reaches Discord delivery.
 */

import { fileHandler, FileOutput } from './fileHandler';
import { logger } from './logger';

// ── Public types ────────────────────────────────────────────────

/** Descriptor returned for each successfully persisted media file. */
export interface PersistedMedia extends FileOutput {
  /** The original source that was persisted (URL / data-URI / 'buffer'). */
  source: string;
  /** Broad media category. */
  mediaType: 'image' | 'video';
}

/** Input describing a single media item to persist. */
export interface MediaSource {
  /** HTTP URL, data-URI (`data:…;base64,…`), or `'buffer'` when raw bytes are supplied. */
  source: string;
  /** Raw bytes — required when `source` is `'buffer'`. */
  buffer?: Buffer;
  /** Fallback file extension when it cannot be inferred from the source. */
  defaultExtension: string;
  /** Broad media category carried through to the persisted descriptor. */
  mediaType: 'image' | 'video';
}

// ── Helpers ─────────────────────────────────────────────────────

/** Best-effort extension extraction from a URL path segment. */
function extensionFromUrl(url: string, fallback: string): string {
  try {
    // Prefer ComfyUI-style `?filename=foo.png` query param
    const filename = new URL(url).searchParams.get('filename') || '';
    const dotIdx = filename.lastIndexOf('.');
    if (dotIdx >= 0) return filename.slice(dotIdx + 1).toLowerCase();

    // Fallback: last path segment extension
    const pathname = new URL(url).pathname;
    const pathExt = pathname.match(/\.(\w{3,4})$/)?.[1];
    if (pathExt) return pathExt.toLowerCase();
  } catch { /* malformed URL — use fallback */ }
  return fallback;
}

// ── Core API ────────────────────────────────────────────────────

/**
 * Persist one or more media items to the `outputs/` directory.
 *
 * @param requester - Discord username / identifier used in the filename.
 * @param description - Short prompt or label used in the filename.
 * @param sources - Heterogeneous media descriptors to save.
 * @returns Array of successfully persisted media descriptors
 *          (failed items are logged and omitted).
 */
export async function persistMedia(
  requester: string,
  description: string,
  sources: MediaSource[],
  apiSource: string = 'unknown',
): Promise<PersistedMedia[]> {
  const results: PersistedMedia[] = [];

  for (const src of sources) {
    try {
      let output: FileOutput | null = null;

      if (src.source.startsWith('data:')) {
        // ── data-URI ────────────────────────────────────────────
        output = fileHandler.saveFromDataUrl(
          requester,
          description,
          src.source,
          src.defaultExtension,
          apiSource,
        );
      } else if (src.source.startsWith('http://') || src.source.startsWith('https://')) {
        // ── Remote URL ──────────────────────────────────────────
        const ext = extensionFromUrl(src.source, src.defaultExtension);
        output = await fileHandler.saveFromUrl(requester, description, src.source, ext, apiSource);
      } else if (src.source === 'buffer' && src.buffer) {
        // ── Raw buffer ──────────────────────────────────────────
        output = fileHandler.saveFile(requester, description, src.buffer, src.defaultExtension, apiSource);
      } else {
        logger.logError('system', `persistMedia: unrecognised source type: ${src.source.substring(0, 40)}`);
      }

      if (output) {
        results.push({
          ...output,
          source: src.source === 'buffer' ? 'buffer' : src.source,
          mediaType: src.mediaType,
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.logError('system', `persistMedia: failed to save ${src.mediaType}: ${msg}`);
    }
  }

  return results;
}
