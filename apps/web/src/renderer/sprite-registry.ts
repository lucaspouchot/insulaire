/**
 * Resolves a stable `visualId` to something the canvas can fill with.
 *
 * This is the indirection that keeps rendering out of the world data
 * (`docs/adr/ADR-0009-assets-tilesets.md`): content says
 * `"visualId": "terrain.grass"`, and the renderer decides what that looks like.
 *
 * # MVP behaviour
 *
 * Nothing is registered, so every id falls back to the tile's `fallbackColor`.
 * That is the "placeholder coloured tiles" the MVP calls for.
 *
 * # How real assets slot in later
 *
 * A fill style may be a `CanvasPattern`, so an image-backed tileset needs no
 * change to the drawing code at all:
 *
 * ```ts
 * const pattern = ctx.createPattern(await loadImage('grass.png'), 'repeat');
 * registry.register('terrain.grass', pattern);
 * ```
 *
 * Batched filling keeps working, because the batch groups by palette index and
 * sets `fillStyle` once per group either way.
 */
export type FillStyle = string | CanvasPattern | CanvasGradient;

export class SpriteRegistry {
  private readonly styles = new Map<string, FillStyle>();

  /** Registers a fill style for a visual id, replacing any previous one. */
  register(visualId: string, style: FillStyle): void {
    this.styles.set(visualId, style);
  }

  /** Forgets a registration. */
  unregister(visualId: string): void {
    this.styles.delete(visualId);
  }

  /** `true` when `visualId` has a registered style. */
  has(visualId: string): boolean {
    return this.styles.has(visualId);
  }

  /** The registered style for `visualId`, or `fallbackColor`. */
  resolve(visualId: string, fallbackColor: string): FillStyle {
    return this.styles.get(visualId) ?? fallbackColor;
  }

  /** Drops every registration. */
  clear(): void {
    this.styles.clear();
  }
}
