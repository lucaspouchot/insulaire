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
 * The map renderer keeps this contract by drawing a native resolved canvas
 * here, then applying one outer transform to the whole character. That
 * map-only scale is measured in tile faces and may be fractional
 * (`docs/adr/ADR-0044-map-entity-presentation.md`); layer coordinates never are.
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
import { unpackSpriteBundle } from '../content/sprite-bundle';

/** What a cache holds for one asset: a fetched file, or a slice of a bundle. */
type SpriteImage = HTMLImageElement | ImageBitmap;

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
  /**
   * Starts loading `assets`, resolving once every one of them has settled.
   *
   * "Settled" rather than "loaded": an asset that 404s resolves like any other,
   * because a caller waiting on this is waiting to *stop waiting*, and a
   * missing file is an answer. Asking for what will be needed before it is
   * needed is what keeps a map from being watched as it fills in
   * (`docs/adr/ADR-0038-a-map-is-drawn-from-shared-pictures.md`).
   */
  preload(assets: Iterable<string>): Promise<void>;
  /**
   * Fills the source from **one** file carrying many sprites, if it can.
   *
   * Optional, because a source over open editing buffers has nothing to fetch:
   * the map's cache implements it, the asset workspaces do not. A source that
   * offers it is expected to reject rather than half-fill when the bundle
   * cannot be read, so the caller falls back to {@link preload}
   * (`docs/adr/ADR-0040-tile-art-travels-as-one-bundle.md`).
   */
  loadBundle?(url: string): Promise<void>;
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
 * Multiplying keeps the drawing's own shading: a near-white sprite becomes the
 * tint, its darker pixels darker shades of it. That is what lets one greyscale
 * hair sprite serve every hair colour.
 *
 * # Why this is a pixel loop and not a composite operation
 *
 * This used to be `multiply` over the whole scratch canvas followed by
 * `destination-in` to put the alpha back, which is right for every fully opaque
 * pixel and wrong for every other one. A canvas blend mode composites as well
 * as blends: where the destination is only *partly* there, the opaque fill
 * arrives at full strength over the gap it leaves, so a pixel at alpha `a` came
 * out at `tint x (1 - a + a x shade)` — the more transparent, the closer to flat
 * tint. A soft edge came back as a pale halo in the tint's own colour, and
 * `docs/adr/ADR-0030-the-editor-paints-its-sprites.md` forbade partial alpha on
 * a character *because of this function*.
 *
 * `ImageData` is non-premultiplied, so the honest version is the arithmetic the
 * blend mode was standing in for: multiply the RGB, carry the alpha through
 * untouched. A pixel at half alpha is now the shade it was drawn as, at half
 * alpha, and ADR-0039 lifted the prohibition on the strength of it.
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

  const tint = resolveColor(context, color);
  if (tint === null) {
    return scratch;
  }
  const pixels = context.getImageData(0, 0, width, height);
  const data = pixels.data;
  for (let at = 0; at < data.length; at += 4) {
    if (data[at + 3] === 0) {
      continue;
    }
    data[at] = Math.round((data[at] * tint[0]) / 255);
    data[at + 1] = Math.round((data[at + 1] * tint[1]) / 255);
    data[at + 2] = Math.round((data[at + 2] * tint[2]) / 255);
  }
  context.putImageData(pixels, 0, 0);
  return scratch;
}

/**
 * A CSS colour as `[r, g, b]`, or `null` when the canvas cannot make sense of
 * it.
 *
 * The canvas is asked rather than a parser written: assigning to `fillStyle`
 * and reading it back is the specified way to normalise *any* colour a
 * stylesheet accepts — a name, `#rgb`, `hsl()` — into a serialised form, and
 * that form is `#rrggbb` unless the colour carries an alpha of its own.
 * A tint's own alpha is ignored: what a layer is transparent by is its pixels
 * (ADR-0039), not its colour.
 */
function resolveColor(
  context: CanvasRenderingContext2D,
  color: string,
): [number, number, number] | null {
  // Two sentinels, because an unreadable colour is *ignored* by the setter
  // rather than reported: assigning over two different starting values and
  // getting two different answers back is what says the assignment did nothing.
  context.fillStyle = '#000000';
  context.fillStyle = color;
  const serialised = String(context.fillStyle).trim();
  context.fillStyle = '#ffffff';
  context.fillStyle = color;
  if (String(context.fillStyle).trim() !== serialised) {
    return null;
  }

  const hex = /^#([0-9a-f]{6})$/i.exec(serialised);
  if (hex !== null) {
    const value = Number.parseInt(hex[1], 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  }
  const parts = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(serialised);
  if (parts !== null) {
    return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  }
  return null;
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
 * Loads and caches the images a character — or a map — needs.
 *
 * Loading is asynchronous and drawing is not, so a first draw shows outlines
 * and `onLoad` asks for another once an image has arrived. Nothing here knows
 * about Angular; the component decides what "another draw" means.
 *
 * # One image per asset, one redraw per frame
 *
 * Two things make this a cache rather than a loader, and both matter once a
 * map asks it for a hundred tile images at once:
 *
 * * an asset is fetched **once**, however many cells, layers or characters ask
 *   for it — the map's flyweight pictures are built out of these shared images
 *   (`docs/adr/ADR-0038-a-map-is-drawn-from-shared-pictures.md`);
 * * `onLoad` fires at most **once per animation frame**, not once per image. A
 *   hundred images arriving in a burst used to be a hundred model rebuilds and
 *   a hundred redraws; it is now one.
 */
export class SpriteCache implements SpriteSource {
  /** Settled assets: the image, or `null` when the fetch failed. */
  private readonly images = new Map<string, SpriteImage | null>();
  /** Assets currently in flight, so nothing is fetched twice. */
  private readonly loading = new Map<string, Promise<void>>();
  /** Set while a redraw notification is already booked for this frame. */
  private notifying = false;
  /**
   * Bumped by {@link clear}, so a fetch started before it cannot land after it.
   *
   * The editor clears this cache precisely when an asset has been repainted; an
   * in-flight request for the old file finishing afterwards would put the
   * version the author just replaced back in front of them (ADR-0030).
   */
  private era = 0;
  /**
   * The bundle fetch, once started, so a second caller waits on the first.
   *
   * Reset by {@link clear}: an author who has just repainted a tile must get
   * the new file, and the bundle is where the old one would hide.
   */
  private bundle: Promise<void> | null = null;

  /**
   * @param resolveUrl turns a content path into a URL the document can fetch
   * @param onLoad called at most once per frame in which an image arrived
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
    void this.load(asset);
    return null;
  }

  /** Starts every load in `assets` at once and resolves when all have settled. */
  preload(assets: Iterable<string>): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const asset of assets) {
      if (asset.length > 0) {
        waits.push(this.load(asset));
      }
    }
    return Promise.all(waits).then(() => undefined);
  }

  /**
   * Fills the cache from **one** bundle instead of one request per asset.
   *
   * A map is painted from a hundred and eighty-odd sprites of about 1.4 kB.
   * Fetched individually the browser queues them six at a time and the map
   * waits on the queue, not on the bytes; fetched as a bundle it is one request
   * and one wait (`docs/adr/ADR-0040-tile-art-travels-as-one-bundle.md`).
   *
   * This is an **optimisation, never a rule**. It rejects when there is no
   * bundle to be had — an unknown URL, a corrupt file, a browser without
   * `createImageBitmap` — and a caller that catches it simply falls back to
   * {@link preload}, which fetches the same pixels one file at a time. That is
   * the same bargain composition strikes in ADR-0038: faster when it works,
   * identical when it does not.
   *
   * An asset already settled or in flight keeps what it has: an open editing
   * session must never be overwritten by the file it was started from.
   */
  loadBundle(url: string): Promise<void> {
    if (this.bundle !== null) {
      return this.bundle;
    }
    const era = this.era;
    const promise = (async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`no sprite bundle at ${url} (${response.status})`);
      }
      const sprites = unpackSpriteBundle(await response.arrayBuffer());
      const decoded = await Promise.all(
        sprites.map(
          async (sprite) =>
            [
              sprite.path,
              await createImageBitmap(new Blob([sprite.bytes], { type: sprite.type })),
            ] as const,
        ),
      );
      if (era !== this.era) {
        // Cleared while this was in flight: these are the files the author has
        // just replaced, and putting them back is exactly what `era` prevents.
        return;
      }
      for (const [path, bitmap] of decoded) {
        if (!this.images.has(path)) {
          this.images.set(path, bitmap);
        }
      }
      this.notify();
    })();
    this.bundle = promise;
    return promise;
  }

  /** The natural size of a loaded image, for the editor to fit a box to it. */
  naturalSize(asset: string): { width: number; height: number } | null {
    const image = this.images.get(asset);
    if (image == null) {
      return null;
    }
    // An `<img>` reports its intrinsic size as `natural*`; an `ImageBitmap` out
    // of a bundle has no intrinsic/rendered distinction to draw, and reports
    // the only size it has. Asked by shape rather than by `instanceof`, because
    // `HTMLImageElement` is not a global everywhere this code runs — the specs
    // exercise it outside a DOM, and so would a worker.
    return 'naturalWidth' in image
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : { width: image.width, height: image.height };
  }

  /** Forgets every image, so edited assets are fetched again. */
  clear(): void {
    this.images.clear();
    this.loading.clear();
    this.bundle = null;
    this.era += 1;
  }

  /**
   * Fetches one asset, once.
   *
   * The promise never rejects: a missing file is a fact about the content, not
   * an error for a renderer to handle, and every caller of {@link preload} is
   * waiting to find out that it has stopped waiting.
   */
  private load(asset: string): Promise<void> {
    const inFlight = this.loading.get(asset);
    if (inFlight !== undefined) {
      return inFlight;
    }
    if (this.images.has(asset)) {
      // Already settled, including a failure: it is not retried on every frame.
      return Promise.resolve();
    }
    // Recorded as "loading" straight away, so a redraw does not queue the same
    // image again on every frame.
    this.images.set(asset, null);

    const era = this.era;
    const promise = new Promise<void>((settled) => {
      const image = new Image();
      const finish = (loaded: boolean): void => {
        // Whoever waited on this fetch stops waiting either way; what a fetch
        // from before a `clear` may no longer do is *answer* for the asset.
        if (era === this.era) {
          if (loaded) {
            this.images.set(asset, image);
          }
          // Left as `null` when it failed: it draws as a missing-sprite outline
          // or as the tile's colour, which is the truth.
          this.loading.delete(asset);
          this.notify();
        }
        settled();
      };
      image.addEventListener('load', () => finish(true));
      image.addEventListener('error', () => finish(false));
      image.src = this.resolveUrl(asset);
    });
    this.loading.set(asset, promise);
    return promise;
  }

  /**
   * Books one redraw for the frame an image arrived in.
   *
   * A frame is the right unit: nothing the consumer does with the news can be
   * seen before the next one, so telling it a hundred times is a hundred model
   * rebuilds nobody looks at.
   */
  private notify(): void {
    if (this.notifying) {
      return;
    }
    this.notifying = true;
    const announce = (): void => {
      this.notifying = false;
      this.onLoad();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(announce);
    } else {
      queueMicrotask(announce);
    }
  }
}
