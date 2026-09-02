/**
 * The decode half of a {@link SpriteStore}: turn a path or a dropped file into
 * pixels.
 *
 * Every asset workspace decoded its images the same way — `new Image()`, wait
 * for `load`, read the bytes off a canvas — behind its own private `loadImage`.
 * That decode is the one DOM edge {@link SpriteSessions} is kept away from, so
 * it lives here and the four workspaces share it.
 */

import { SpriteDocument } from '../../../../content/sprite-document';
import { DecodedSprite } from '../../../editing/sprite-sessions';
import { contentUrl } from '../../../services/project-store.service';

/** Decodes the image a content path names into raw pixels, or `null`. */
export function decodeContentSprite(path: string): Promise<DecodedSprite | null> {
  return decodeUrl(contentUrl(path));
}

/**
 * Decodes a file the author dropped into a variant, or `null` when it will not
 * decode.
 *
 * A `SpriteDocument` rather than {@link DecodedSprite}: the caller checks its
 * size against the set's grid and then holds it, undo history and all.
 */
export async function decodeSpriteFile(file: Blob): Promise<SpriteDocument | null> {
  const url = URL.createObjectURL(file);
  try {
    const decoded = await decodeUrl(url);
    return decoded === null
      ? null
      : new SpriteDocument(decoded.width, decoded.height, decoded.pixels);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeUrl(url: string): Promise<DecodedSprite | null> {
  const image = await loadImage(url);
  if (image === null) {
    return null;
  }
  const document = SpriteDocument.fromImage(image);
  return document === null
    ? null
    : { width: document.width, height: document.height, pixels: document.pixels };
}

/** Loads one image, resolving to `null` when it is not there or will not decode. */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', () => resolve(null));
    image.src = url;
  });
}
