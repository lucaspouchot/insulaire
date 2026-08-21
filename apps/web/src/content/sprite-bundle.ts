/**
 * Reads the sprite bundle: one file that carries a whole directory of sprites.
 *
 * A map is painted from a hundred and eighty-four PNGs of about 1.4 kB. The
 * bytes are nothing; the round trips are the wait. The bundle collapses them
 * into one request, and this module turns what comes back into the individual
 * images the renderer already knows how to draw
 * (`docs/adr/ADR-0040-tile-art-travels-as-one-bundle.md`).
 *
 * It is a **transport format, not an atlas**: no grid, no source rectangles,
 * no composition. What the renderer blits after unpacking is byte-identical to
 * what it blitted when every file was fetched on its own.
 *
 * The layout is written down once, in `scripts/sprite-bundle.mjs`, which is
 * what writes these files. This is the other half of that contract, and
 * `sprite-bundle.spec.ts` round-trips the two against each other so they cannot
 * drift apart silently.
 */

/** First four bytes of every bundle: `ISLB`. */
const MAGIC = 0x424c5349; // "ISLB", little-endian
/** The only layout this reader understands. */
const FORMAT_VERSION = 1;
/** Bytes before the JSON header: magic, version, header length. */
const PROLOGUE_BYTES = 12;

/** Where the tile-art bundle lives, relative to the content root. */
export const TILE_ART_BUNDLE = 'tile-art.bundle';

/** One sprite as it comes out of a bundle. */
export interface BundledSprite {
  /** The content path this file had, e.g. `assets/tiles/grass/surfaces/grass_a.png`. */
  readonly path: string;
  /** Its MIME type, so a `Blob` can be built without guessing from the name. */
  readonly type: string;
  /**
   * A view **into the bundle's buffer** — not a copy.
   *
   * Pinned to `ArrayBuffer` rather than the wider `ArrayBufferLike`, so it can
   * be handed straight to a `Blob`: a bundle is always read from one, never
   * from shared memory.
   */
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** What the header carries for each file. */
interface BundleEntry {
  path: string;
  type: string;
  offset: number;
  length: number;
}

/**
 * Unpacks a bundle into its sprites.
 *
 * Every rejection is a `RangeError` naming what was wrong, because the one
 * thing worse than a corrupt bundle is a corrupt bundle that half-loads: a
 * caller that cannot read this file must fall back to fetching the sprites one
 * by one, and it can only do that if it is told.
 *
 * The returned `bytes` are views into `buffer`, so nothing is copied here and
 * the caller must not assume they outlive it.
 */
export function unpackSpriteBundle(buffer: ArrayBuffer): BundledSprite[] {
  if (buffer.byteLength < PROLOGUE_BYTES) {
    throw new RangeError('the sprite bundle is shorter than its own header');
  }

  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) {
    throw new RangeError('this is not a sprite bundle: the magic does not match');
  }

  const version = view.getUint32(4, true);
  if (version !== FORMAT_VERSION) {
    // Pre-1.0, a bundle is generated output that a build or a dev server writes
    // afresh; there is nothing to migrate and nothing to be compatible with.
    throw new RangeError(`sprite bundle version ${version} is not version ${FORMAT_VERSION}`);
  }

  const headerBytes = view.getUint32(8, true);
  const payloadStart = PROLOGUE_BYTES + headerBytes;
  if (payloadStart > buffer.byteLength) {
    throw new RangeError('the sprite bundle header runs past the end of the file');
  }

  const header = decodeHeader(buffer, headerBytes);
  const payloadBytes = buffer.byteLength - payloadStart;

  return header.map((entry) => {
    if (entry.offset < 0 || entry.length < 0 || entry.offset + entry.length > payloadBytes) {
      throw new RangeError(`"${entry.path}" runs past the end of the sprite bundle`);
    }
    return {
      path: entry.path,
      type: entry.type,
      bytes: new Uint8Array(buffer, payloadStart + entry.offset, entry.length),
    };
  });
}

/** Parses and validates the JSON header. */
function decodeHeader(buffer: ArrayBuffer, headerBytes: number): BundleEntry[] {
  const text = new TextDecoder().decode(new Uint8Array(buffer, PROLOGUE_BYTES, headerBytes));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RangeError('the sprite bundle header is not valid JSON');
  }

  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new RangeError('the sprite bundle header has no entry list');
  }

  return entries.map((entry, index) => {
    const { path, type, offset, length } = entry as Partial<BundleEntry>;
    if (
      typeof path !== 'string' ||
      typeof type !== 'string' ||
      typeof offset !== 'number' ||
      typeof length !== 'number'
    ) {
      throw new RangeError(`sprite bundle entry ${index} is missing a field`);
    }
    return { path, type, offset, length };
  });
}
