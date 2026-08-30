/**
 * The pixels of one sprite, editable in memory.
 *
 * A character is drawn from small PNGs — a body, a cape, hair, boots — placed
 * on a declared pixel canvas (`docs/adr/ADR-0029-characters-are-composed-
 * sprites.md`). This is the other half of authoring one: the image itself,
 * opened as a buffer, painted a pixel at a time, and written back as a PNG
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 *
 * It is framework-free, like the serialisers next to it, and its core is plain
 * arithmetic on an RGBA buffer: painting, erasing, undo, the palette and the
 * colour under a pixel need no canvas at all. Only the three edges that must
 * touch the DOM — decoding an image, showing the buffer, encoding a PNG — do.
 *
 * # Whole pixels, whole alpha — by default
 *
 * A painted pixel is opaque and an erased one is fully clear. Pixel art has no
 * use for a half-transparent pencil, and a buffer full of alpha in the fifties
 * is a sprite nobody can clean up later.
 *
 * It is a default, not a rule: {@link SpriteDocument.plot} takes an alpha, and
 * every editing surface offers it. A tile is blitted as it stands, so a
 * shoreline that fades is a thing an artist may want
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`); a
 * character is tinted, and the tint multiplies the RGB per pixel and carries
 * the alpha through untouched, so a soft edge stays the shade it was drawn as
 * (`character-renderer.ts`,
 * `docs/adr/ADR-0028-one-editor-for-everything-drawn.md`). ADR-0028 forbade
 * the second of those until the tint stopped turning it into a halo.
 */

/** How many strokes the history keeps. */
const UNDO_DEPTH = 32;

/**
 * Below this alpha a pixel reads as transparent.
 *
 * Not zero: an image that came from a tool with antialiasing carries a fringe
 * of nearly-clear pixels, and neither the palette nor the eyedropper should
 * offer the colour of something nobody can see.
 */
const OPAQUE = 8;

/** How many swatches {@link SpriteDocument.palette} returns by default. */
export const PALETTE_SIZE = 24;

/** An erased pixel: clear, and carrying no colour to bleed out of it. */
const CLEARED: readonly [number, number, number, number] = [0, 0, 0, 0];

export class SpriteDocument {
  private data: Uint8ClampedArray;
  private readonly past: Uint8ClampedArray[] = [];
  private readonly future: Uint8ClampedArray[] = [];

  /** The buffer as it was when the open stroke started, or `null`. */
  private opening: Uint8ClampedArray | null = null;
  private strokeChanged = false;

  private surfaceCanvas: HTMLCanvasElement | null = null;
  private surfaceRevision = -1;

  private changes = 0;
  private saved = true;

  constructor(
    readonly width: number,
    readonly height: number,
    data?: Uint8ClampedArray,
  ) {
    const length = width * height * 4;
    this.data = data !== undefined && data.length === length ? data : new Uint8ClampedArray(length);
  }

  /** A fully transparent sprite of this size. */
  static blank(width: number, height: number): SpriteDocument {
    return new SpriteDocument(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  }

  /**
   * A sprite read off a loaded image.
   *
   * Returns `null` when there is no 2D context to decode with, which is the
   * same answer as "this image cannot be edited" — the caller shows the file
   * rather than pretending it opened.
   */
  static fromImage(image: HTMLImageElement): SpriteDocument | null {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (width <= 0 || height <= 0) {
      return null;
    }
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const context = scratch.getContext('2d', { willReadFrequently: true });
    if (context === null) {
      return null;
    }
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0);
    return new SpriteDocument(width, height, context.getImageData(0, 0, width, height).data);
  }

  /** Bumped by every change, so a view can tell it is looking at stale pixels. */
  get revision(): number {
    return this.changes;
  }

  /** `true` when the buffer differs from the file it came from. */
  get unsaved(): boolean {
    return !this.saved;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Records that the buffer has been written to disk as it stands. */
  markSaved(): void {
    this.saved = true;
  }

  /** Marks a sprite that exists only here as still owing the disk a write. */
  markUnsaved(): void {
    this.saved = false;
  }

  // ------------------------------------------------------------------ strokes

  /**
   * Opens a stroke: everything painted until {@link end} undoes as one step.
   *
   * A drag across forty pixels is one thing the author did, and forty undos to
   * take it back is not an undo history, it is a punishment.
   */
  begin(): void {
    if (this.opening !== null) {
      return;
    }
    this.opening = new Uint8ClampedArray(this.data);
    this.strokeChanged = false;
  }

  /** Closes a stroke, keeping it in the history only if it changed a pixel. */
  end(): void {
    const opening = this.opening;
    this.opening = null;
    if (opening === null || !this.strokeChanged) {
      return;
    }
    this.past.push(opening);
    if (this.past.length > UNDO_DEPTH) {
      this.past.shift();
    }
    // A new stroke is a new branch: what was undone is no longer ahead of us.
    this.future.length = 0;
    this.saved = false;
  }

  /**
   * Paints one pixel, or erases it when given `null`.
   *
   * `alpha` is `0..255` and defaults to opaque, which is what a pencil does
   * unless the author asks otherwise. Both kinds of art may ask: a tile is
   * blitted as it stands (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-
   * by-level.md`), and a character's tint multiplies the colour per pixel and
   * leaves the alpha alone (`docs/adr/ADR-0028-one-editor-for-everything-
   * drawn.md`, amending `docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
   *
   * @returns whether the pixel actually changed
   */
  plot(x: number, y: number, color: string | null, alpha = 255): boolean {
    if (!this.holds(x, y)) {
      return false;
    }
    const parsed = color === null ? CLEARED : parseHex(color);
    if (parsed === null) {
      return false;
    }
    const rgba: readonly [number, number, number, number] =
      color === null
        ? CLEARED
        : [parsed[0], parsed[1], parsed[2], Math.max(0, Math.min(255, Math.round(alpha)))];
    const at = (y * this.width + x) * 4;
    if (
      this.data[at] === rgba[0] &&
      this.data[at + 1] === rgba[1] &&
      this.data[at + 2] === rgba[2] &&
      this.data[at + 3] === rgba[3]
    ) {
      return false;
    }
    this.data[at] = rgba[0];
    this.data[at + 1] = rgba[1];
    this.data[at + 2] = rgba[2];
    this.data[at + 3] = rgba[3];
    this.strokeChanged = true;
    this.saved = false;
    this.changes += 1;
    return true;
  }

  /**
   * Paints every pixel on the segment between two points.
   *
   * A pointer moving fast reports one position every frame and skips whatever
   * was between them, so a line is what makes a drag draw a line rather than a
   * dotted one.
   *
   * @returns whether any pixel changed
   */
  stroke(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    color: string | null,
    alpha = 255,
  ): boolean {
    let x = Math.round(fromX);
    let y = Math.round(fromY);
    const endX = Math.round(toX);
    const endY = Math.round(toY);
    const stepX = Math.abs(endX - x);
    const stepY = -Math.abs(endY - y);
    const signX = x < endX ? 1 : -1;
    const signY = y < endY ? 1 : -1;
    let error = stepX + stepY;
    let changed = false;

    for (;;) {
      changed = this.plot(x, y, color, alpha) || changed;
      if (x === endX && y === endY) {
        return changed;
      }
      const doubled = 2 * error;
      if (doubled >= stepY) {
        error += stepY;
        x += signX;
      }
      if (doubled <= stepX) {
        error += stepX;
        y += signY;
      }
    }
  }

  undo(): boolean {
    const previous = this.past.pop();
    if (previous === undefined) {
      return false;
    }
    this.future.push(this.data);
    this.data = previous;
    this.saved = false;
    this.changes += 1;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) {
      return false;
    }
    this.past.push(this.data);
    this.data = next;
    this.saved = false;
    this.changes += 1;
    return true;
  }

  // ------------------------------------------------------------------ reading

  /** `true` when this pixel is inside the sprite. */
  holds(x: number, y: number): boolean {
    return (
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      x < this.width &&
      y < this.height
    );
  }

  /** The colour of a pixel as `#rrggbb`, or `null` where nothing is drawn. */
  colorAt(x: number, y: number): string | null {
    if (!this.holds(x, y)) {
      return null;
    }
    const at = (y * this.width + x) * 4;
    if ((this.data[at + 3] ?? 0) < OPAQUE) {
      return null;
    }
    return hex(this.data[at] ?? 0, this.data[at + 1] ?? 0, this.data[at + 2] ?? 0);
  }

  /** The alpha of a pixel, `0..255`; `0` outside the sprite. */
  alphaAt(x: number, y: number): number {
    return this.holds(x, y) ? (this.data[(y * this.width + x) * 4 + 3] ?? 0) : 0;
  }

  /**
   * The colours this sprite is drawn with, most used first.
   *
   * This is the palette an author actually wants: not a fixed ramp somebody
   * else chose, but the tones already in the drawing, so the next stroke uses
   * the shade next to it rather than one three values off.
   */
  palette(limit = PALETTE_SIZE): string[] {
    const counts = new Map<string, number>();
    for (let at = 0; at < this.data.length; at += 4) {
      if ((this.data[at + 3] ?? 0) < OPAQUE) {
        continue;
      }
      const key = hex(this.data[at] ?? 0, this.data[at + 1] ?? 0, this.data[at + 2] ?? 0);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // Insertion order breaks ties, so a palette does not reshuffle itself
    // between two colours used the same number of times.
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([color]) => color);
  }

  /** The raw buffer, for a test or an encoder. Not a copy: do not write to it. */
  get pixels(): Uint8ClampedArray {
    return this.data;
  }

  // ------------------------------------------------------------------ the DOM

  /**
   * The buffer as something `drawImage` accepts, refreshed when it has moved.
   *
   * Handing the live canvas to the renderer is what makes the preview show a
   * stroke as it is painted: the composed character is redrawn from the same
   * pixels the author is editing, with no round trip through a file.
   */
  surface(): HTMLCanvasElement | null {
    this.surfaceCanvas ??= createCanvas(this.width, this.height);
    const canvas = this.surfaceCanvas;
    if (canvas === null || this.surfaceRevision === this.changes) {
      return canvas;
    }
    const context = canvas.getContext('2d');
    if (context === null) {
      return null;
    }
    const image = context.createImageData(this.width, this.height);
    image.data.set(this.data);
    context.putImageData(image, 0, 0);
    this.surfaceRevision = this.changes;
    return canvas;
  }

  /** The sprite encoded as a PNG, ready to be written to the content directory. */
  toBlob(): Promise<Blob> {
    const canvas = this.surface();
    if (canvas === null) {
      return Promise.reject(new Error('This browser cannot encode the sprite.'));
    }
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob === null) {
          reject(new Error('This browser cannot encode the sprite.'));
        } else {
          resolve(blob);
        }
      }, 'image/png');
    });
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** `#rrggbb` — the one form `<input type="color">` produces and the palette holds. */
function hex(red: number, green: number, blue: number): string {
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function channel(value: number): string {
  return value.toString(16).padStart(2, '0');
}

/** Reads `#rgb` or `#rrggbb` into opaque RGBA, or `null` when it is neither. */
function parseHex(color: string): [number, number, number, number] | null {
  const digits = color.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(digits)) {
    const [red, green, blue] = [...digits].map((digit) => Number.parseInt(digit + digit, 16));
    return [red ?? 0, green ?? 0, blue ?? 0, 255];
  }
  if (/^[0-9a-fA-F]{6}$/.test(digits)) {
    return [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
      255,
    ];
  }
  return null;
}
