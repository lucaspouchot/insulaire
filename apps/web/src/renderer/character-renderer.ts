/**
 * Draws a {@link ResolvedCharacter} into a 2D canvas.
 *
 * Framework-free, like the map renderer: an Angular component hands it a
 * context and a box, and it draws. It is also the *whole* of character
 * rendering on this side of the boundary — every decision about what a
 * character looks like was made by the Rust resolver, and what arrives here is
 * an ordered list of boxes with colours already resolved
 * (`docs/adr/ADR-0028-character-definitions.md`).
 *
 * That is what makes the editor's preview honest: it runs this same function
 * over the same payload the game will draw.
 */

import { ResolvedCharacter, ResolvedLayer, UnitRect } from '../content/content-types';

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

/** Outline drawn where a sprite should be but is not loaded. */
const MISSING_SPRITE_COLOR = '#f0736a';

/**
 * Draws a resolved character into `box`.
 *
 * Layers are drawn in the order the resolver produced, which is back to front.
 * A sprite whose image is not available yet leaves a dashed outline rather than
 * nothing: an author moving a layer they cannot see is worse off than one
 * looking at a placeholder.
 */
export function drawCharacter(
  context: CanvasRenderingContext2D,
  character: ResolvedCharacter,
  box: CharacterBox,
  sprites?: SpriteSource,
): void {
  for (const layer of character.layers) {
    drawLayer(context, layer, box, sprites);
  }
}

function drawLayer(
  context: CanvasRenderingContext2D,
  layer: ResolvedLayer,
  box: CharacterBox,
  sprites?: SpriteSource,
): void {
  const { x, y, width, height } = place(layer.rect, box);
  if (width <= 0 || height <= 0) {
    return;
  }

  if (layer.visual.kind === 'sprite') {
    const image = sprites?.image(layer.visual.asset) ?? null;
    if (image === null) {
      outlineMissing(context, x, y, width, height);
      return;
    }
    context.drawImage(image, x, y, width, height);
    return;
  }

  context.fillStyle = layer.visual.color;
  switch (layer.visual.shape) {
    case 'rect':
      context.fillRect(x, y, width, height);
      return;
    case 'ellipse':
      context.beginPath();
      context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      context.fill();
      return;
    case 'triangle':
      // Standing on the bottom edge of its box, apex at the top centre: the
      // orientation a character is built from — a skirt, a wing, a horn.
      context.beginPath();
      context.moveTo(x, y + height);
      context.lineTo(x + width, y + height);
      context.lineTo(x + width / 2, y);
      context.closePath();
      context.fill();
  }
}

/** A unit box mapped onto the canvas box it is drawn in. */
export function place(rect: UnitRect, box: CharacterBox): CharacterBox {
  const [x, y, width, height] = rect;
  return {
    x: box.x + x * box.width,
    y: box.y + y * box.height,
    width: width * box.width,
    height: height * box.height,
  };
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
  context.strokeRect(x, y, width, height);
  context.restore();
}

/**
 * Loads and caches the images an asset-composed character needs.
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

  /** Forgets every image, so edited assets are fetched again. */
  clear(): void {
    this.images.clear();
  }
}
