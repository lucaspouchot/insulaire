/**
 * Draws a {@link ResolvedCharacter} into a 2D canvas.
 *
 * Framework-free, like the map renderer: an Angular component hands it a
 * context and a box, and it draws. It is also the *whole* of character
 * rendering on this side of the boundary — every decision about what a
 * character looks like was made by the Rust resolver, and what arrives here is
 * an ordered list of sprites with their boxes and tints already resolved
 * (`docs/adr/ADR-0028-character-definitions.md`).
 *
 * # Pixels stay pixels
 *
 * A character is authored on a canvas of a few dozen pixels a side and drawn
 * much larger, so everything here exists to keep that honest: smoothing off,
 * a **whole-number** zoom, and integer destination coordinates. Half a pixel of
 * drift is a seam between two layers that were drawn to touch
 * (`docs/adr/ADR-0029-characters-are-composed-sprites.md`).
 *
 * # Mirroring
 *
 * The one decision this file makes is *where* to draw, and a mirrored
 * character is the one case where that is not simply the box it was given: the
 * whole canvas is flipped about its own vertical centre, layers and pixels
 * together. That is what lets one authored walk cycle serve both directions
 * (`docs/adr/ADR-0031-characters-animate-by-hierarchy-and-offsets.md`). It is
 * still not an appearance decision — the resolver said `mirrored`, and this
 * only obeys it.
 */

import { ResolvedCharacter, ResolvedLayer, SpriteResolution } from '../content/content-types';

/** Where on the canvas a character is drawn, in CSS pixels. */
export interface CharacterBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Resolves an asset path to something `drawImage` accepts. */
export interface SpriteSource {
  /** The image for this path, or `null` while it is still loading or missing. */
  image(asset: string): CanvasImageSource | null;
}

/** The canvas element's rendered box, as `getBoundingClientRect()` gives it. */
export interface StageBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Outline drawn where a sprite should be but is not loaded. */
const MISSING_SPRITE_COLOR = '#f0736a';

/**
 * How the character's canvas sits inside the box it is drawn in.
 *
 * The zoom is a whole number so one authored pixel is a square block of screen
 * pixels; the remainder becomes a margin, and the character is centred in it
 * and sat on the bottom of the box — a character stands on the ground rather
 * than floating in the middle of it.
 */
export function placement(
  resolution: SpriteResolution,
  box: CharacterBox,
): { zoom: number; originX: number; originY: number } {
  const zoom = Math.max(
    1,
    Math.floor(Math.min(box.width / resolution.width, box.height / resolution.height)),
  );
  return {
    zoom,
    originX: Math.round(box.x + (box.width - resolution.width * zoom) / 2),
    originY: Math.round(box.y + box.height - resolution.height * zoom),
  };
}

/**
 * The canvas pixel a pointer is over, given where the stage was drawn.
 *
 * The inverse of {@link placement}, and it lives beside it deliberately: an
 * editor's click lands on the pixel it points at only for as long as the two
 * agree, so they are read together or not at all
 * (`docs/adr/ADR-0030-the-editor-paints-its-sprites.md`).
 *
 * `bounds` is the canvas element's **rendered** box and `box` is the box it was
 * **drawn** in. Those are different units the moment anything scales the page —
 * the interface scale zooms the whole shell (`app/app.css`) — and dividing one
 * by the other is what keeps a pointer honest without having to know what did
 * the scaling, or that anything did.
 *
 * @returns the canvas pixel, which may be outside the canvas
 */
export function pixelUnder(
  point: { readonly x: number; readonly y: number },
  bounds: StageBounds,
  box: CharacterBox,
  view: { readonly zoom: number; readonly originX: number; readonly originY: number },
): { x: number; y: number } | null {
  if (bounds.width <= 0 || bounds.height <= 0 || view.zoom <= 0) {
    return null;
  }
  const localX = ((point.x - bounds.left) * box.width) / bounds.width;
  const localY = ((point.y - bounds.top) * box.height) / bounds.height;
  return {
    x: Math.floor((localX - view.originX) / view.zoom),
    y: Math.floor((localY - view.originY) / view.zoom),
  };
}

/**
 * Draws a resolved character into `box`.
 *
 * Layers are drawn in the order the resolver produced, which is back to front.
 * A sprite whose image is not available yet leaves a dashed outline rather than
 * nothing: an author placing a layer they cannot see is worse off than one
 * looking at a placeholder, and it is also how a definition is blocked out
 * before there is any art.
 */
export function drawCharacter(
  context: CanvasRenderingContext2D,
  character: ResolvedCharacter,
  box: CharacterBox,
  sprites?: SpriteSource,
): void {
  const { zoom, originX, originY } = placement(character.resolution, box);
  context.imageSmoothingEnabled = false;

  // Flipped about the canvas's own centre line, so a mirrored character stands
  // exactly where an unmirrored one would. Reflecting about the *box* instead
  // would slide the figure sideways whenever the box is wider than the canvas,
  // which is most of the time.
  const flipped = character.mirrored === true;
  if (flipped) {
    context.save();
    context.translate(originX * 2 + character.resolution.width * zoom, 0);
    context.scale(-1, 1);
    // `scale(-1, 1)` re-enables smoothing on some engines; it is a per-context
    // flag and has to be set after the transform, not before.
    context.imageSmoothingEnabled = false;
  }

  for (const layer of character.layers) {
    drawLayer(context, layer, zoom, originX, originY, sprites);
  }

  if (flipped) {
    context.restore();
  }
}

function drawLayer(
  context: CanvasRenderingContext2D,
  layer: ResolvedLayer,
  zoom: number,
  originX: number,
  originY: number,
  sprites?: SpriteSource,
): void {
  const [rectX, rectY, rectWidth, rectHeight] = layer.rect;
  if (rectWidth <= 0 || rectHeight <= 0) {
    return;
  }

  const x = originX + rectX * zoom;
  const y = originY + rectY * zoom;
  const width = rectWidth * zoom;
  const height = rectHeight * zoom;

  const image = sprites?.image(layer.asset) ?? null;
  if (image === null) {
    outlineMissing(context, x, y, width, height);
    return;
  }

  if (layer.tint.length === 0) {
    context.drawImage(image, x, y, width, height);
    return;
  }
  context.drawImage(tinted(image, layer.tint, rectWidth, rectHeight), x, y, width, height);
}

/**
 * The sprite recoloured, at its authored size.
 *
 * `multiply` keeps the drawing's own shading — a near-white sprite becomes the
 * tint, its darker pixels become darker shades of it — and `destination-in`
 * puts the original alpha back, so the fill does not spill into the
 * transparent margin. This is what lets one greyscale hair sprite serve every
 * hair colour.
 */
function tinted(
  image: CanvasImageSource,
  color: string,
  width: number,
  height: number,
): CanvasImageSource {
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const context = scratch.getContext('2d');
  if (context === null) {
    return image;
  }

  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, width, height);
  context.globalCompositeOperation = 'multiply';
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  context.globalCompositeOperation = 'destination-in';
  context.drawImage(image, 0, 0, width, height);
  return scratch;
}

function outlineMissing(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  context.save();
  context.strokeStyle = MISSING_SPRITE_COLOR;
  context.setLineDash([4, 3]);
  context.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  context.restore();
}

/**
 * Loads and caches the images a character needs.
 *
 * Loading is asynchronous and drawing is not, so a first draw shows outlines
 * and `onLoad` asks for another once an image has arrived. Nothing here knows
 * about Angular; the component decides what "another draw" means.
 */
export class SpriteCache implements SpriteSource {
  private readonly images = new Map<string, HTMLImageElement | null>();

  /**
   * @param resolveUrl turns a content path into a URL the document can fetch
   * @param onLoad called once per image that finishes loading
   */
  constructor(
    private readonly resolveUrl: (asset: string) => string,
    private readonly onLoad: () => void = () => {},
  ) {}

  /** The image for `asset`, starting its load the first time it is asked for. */
  image(asset: string): CanvasImageSource | null {
    if (asset.length === 0) {
      return null;
    }
    const cached = this.images.get(asset);
    if (cached !== undefined) {
      return cached;
    }
    // Recorded as "loading" straight away, so a redraw does not queue the same
    // image again on every frame.
    this.images.set(asset, null);

    const image = new Image();
    image.addEventListener('load', () => {
      this.images.set(asset, image);
      this.onLoad();
    });
    image.addEventListener('error', () => {
      // Left as `null`: it draws as a missing-sprite outline, which is the
      // truth, and it is not retried on every frame.
      this.onLoad();
    });
    image.src = this.resolveUrl(asset);
    return null;
  }

  /** The natural size of a loaded image, for the editor to fit a box to it. */
  naturalSize(asset: string): { width: number; height: number } | null {
    const image = this.images.get(asset);
    return image == null ? null : { width: image.naturalWidth, height: image.naturalHeight };
  }

  /** Forgets every image, so edited assets are fetched again. */
  clear(): void {
    this.images.clear();
  }
}
