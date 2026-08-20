/**
 * One shared picture per distinct tile appearance — the map's flyweight.
 *
 * A map is thousands of cells and a handful of *looks*. Grass rolled variant
 * `f`, standing one step above the cell in front of it, is the same picture on
 * cell (3, 4) as on cell (57, 12): the only thing those two cells do not share
 * is where they are drawn. This module is the factory that hands out that
 * shared picture, and `docs/adr/ADR-0038-a-map-is-drawn-from-shared-pictures.md`
 * is why it exists.
 *
 * # What is intrinsic, and what is not
 *
 * | Intrinsic — shared, cached here | Extrinsic — the cell's own |
 * |---|---|
 * | which images draw this look | where on the canvas it goes |
 * | how they stack | the camera, the zoom |
 * | the composed picture itself | nothing else |
 *
 * A cell's *coordinates* decide which look it rolls ({@link variantRoll}), and
 * then stop mattering: two cells that roll the same variant at the same height
 * over the same drop get the same object back, byte for byte.
 *
 * # What that buys
 *
 * Before, every visible cell re-resolved its art on every frame — a hash of the
 * tile id, a fresh `ResolvedTileRender`, one object per stacked layer, and a
 * `drawImage` per layer. A viewport of four hundred cells was thousands of
 * short-lived objects per frame, sixty times a second, which is exactly what
 * `CLAUDE.md` forbids ("one JS object per simulated entity", "one WASM/JS call
 * per tile").
 *
 * Now a cell costs one arithmetic key and one map lookup, and — where the
 * pictures could be composed — one `drawImage` however tall the cliff under it
 * is. Cost follows the number of *looks* on screen, which is bounded by the
 * palette, not by the size of the map.
 *
 * # Composition is an optimisation, never a rule
 *
 * {@link TileAppearance.picture} is one image for the whole cell, composed at
 * the tile set's authored resolution so nothing is resampled twice. When there
 * is no canvas to compose on — a test in jsdom, an exhausted budget — it stays
 * `null` and the renderer blits the layers one by one, which draws exactly the
 * same picture. Nothing here decides what a cell looks like; that is
 * `tile-art.ts`, mirrored from Rust.
 */

import {
  MAX_TILE_VARIANTS,
  TileArt,
  TileArtGeometry,
  shoulderLine,
} from '../content/content-types';
import { Offset } from '../core/hex/hex-coords';
import { SpriteSource } from './character-renderer';
import { RenderModel, emptyRenderModel } from './render-model';
import {
  CellArt,
  MAX_STACKED_LEVELS,
  ResolvedTileRender,
  isEmptyRender,
  resolveTileRender,
  variantIndex,
  variantRoll,
} from './tile-art';

/**
 * What every cell wearing one look shares.
 *
 * Immutable to its readers: the renderer holds one of these for as long as the
 * model stands, and must never write to it.
 */
export interface TileAppearance {
  /** Which images draw this look, and how they stack. */
  readonly render: ResolvedTileRender;
  /**
   * `true` once every image the look needs has loaded.
   *
   * Until then the renderer falls back to the tile's `fallbackColor`, exactly
   * as it did before this cache existed
   * (`docs/adr/ADR-0009-assets-tilesets.md`).
   */
  readonly ready: boolean;
  /**
   * The whole look as a single image, or `null` to blit the layers instead.
   *
   * `null` is not a failure — it is "compose nothing", which the renderer
   * answers by drawing the same layers in the same order.
   */
  readonly picture: CanvasImageSource | null;
  /** Height of {@link picture} in *authored* pixels, for the renderer to scale. */
  readonly pictureHeight: number;
}

/**
 * Where a picture is composed: a canvas, or whatever a test hands in.
 *
 * Narrow on purpose — composing uses `drawImage` and nothing else, so a spec
 * can record the calls without a canvas implementation in sight.
 */
export interface Composition {
  /** The composed image itself, for the renderer to blit. */
  readonly target: CanvasImageSource;
  readonly context: {
    imageSmoothingEnabled: boolean;
    drawImage(
      image: CanvasImageSource,
      dx: number,
      dy: number,
      dWidth: number,
      dHeight: number,
    ): void;
  };
}

/** Makes a surface `width x height` authored pixels, or `null` if it cannot. */
export type CompositionFactory = (width: number, height: number) => Composition | null;

/**
 * How many authored pixels of composed picture the cache may hold.
 *
 * Four million is sixteen megabytes of backing store, and — at the shipped
 * grid's 64 pixels a side — several hundred distinct looks, which is more than
 * a viewport can show. Past it, looks are still shared and still resolved once;
 * only the composition stops, and the renderer blits their layers instead.
 */
export const MAX_COMPOSED_PIXELS = 4 * 1024 * 1024;

/**
 * How many looks the cache holds before it is emptied and refilled.
 *
 * A bound, not a working set: a viewport shows a few hundred looks, and this is
 * an order of magnitude more. It exists so that panning across a map with a
 * hundred authored heights cannot grow the cache forever.
 */
export const MAX_APPEARANCES = 4096;

/** The flyweight's mutable side; readers only ever see {@link TileAppearance}. */
class Look implements TileAppearance {
  ready = false;
  picture: CanvasImageSource | null = null;
  pictureHeight = 0;

  constructor(readonly render: ResolvedTileRender) {}
}

/** Where each field of a look's key starts; see {@link keyOf}. */
const KEY_ELEVATION = 0x100;
const KEY_STEPS = 0x10000;
const KEY_SURFACE = 0x800000;
const KEY_VARIANT = 0x10000000;
const KEY_LADDER = 0x200000000;

/**
 * Packs a look's identity into one number, so keying allocates nothing.
 *
 * A template string would read better and would litter the heap with one
 * string per cell per frame, which is the cost this whole file exists to
 * remove.
 *
 * ```text
 *   bits  0..7   palette index      0..255
 *   bits  8..15  elevation + 128    0..255   (a signed byte, as authored)
 *   bits 16..22  steps of face      0..64    (MAX_STACKED_LEVELS)
 *   bits 23..27  surface + 1        0..16    (MAX_TILE_VARIANTS; 0 = none rolled)
 *   bits 28..32  variant + 1        0..16    (which cut the ladder shows)
 *   bits 33..41  ladder + 1         0..256   (0 = the tile's own ladder)
 * ```
 *
 * Forty-two bits, which a double holds exactly. A look whose fields do not fit
 * answers `null`: it is resolved on the spot and not shared, which is what a
 * cell that rolls its ladder out of a raw hash does — there is nothing to
 * share, because no two cells roll alike.
 */
function keyOf(
  paletteIndex: number,
  elevation: number,
  steps: number,
  surface: number | null,
  variant: number | null,
  ladder: number | null,
): number | null {
  const level = elevation + 128;
  const chosenSurface = surface === null ? 0 : surface + 1;
  const chosenVariant = variant === null ? 0 : variant + 1;
  const chosenLadder = ladder === null ? 0 : ladder + 1;
  const fits =
    paletteIndex >= 0 &&
    paletteIndex <= 0xff &&
    level >= 0 &&
    level <= 0xff &&
    steps >= 0 &&
    steps <= MAX_STACKED_LEVELS &&
    chosenSurface >= 0 &&
    chosenSurface <= MAX_TILE_VARIANTS &&
    chosenVariant >= 0 &&
    chosenVariant <= MAX_TILE_VARIANTS &&
    chosenLadder >= 0 &&
    chosenLadder <= 0x100;
  if (!fits) {
    return null;
  }
  return (
    paletteIndex +
    level * KEY_ELEVATION +
    steps * KEY_STEPS +
    chosenSurface * KEY_SURFACE +
    chosenVariant * KEY_VARIANT +
    chosenLadder * KEY_LADDER
  );
}

/**
 * The default factory: an offscreen canvas, or nothing.
 *
 * `OffscreenCanvas` and no fallback, deliberately. Every browser this ships to
 * has had it for years, and a runtime that does not — an old WebKit, a test in
 * jsdom — loses the composition and nothing else: the renderer blits the same
 * layers one at a time and draws the same picture. Reaching for a DOM canvas
 * instead would put a hidden `<canvas>` per look into a document that has no
 * use for it, and would make a headless test log a page of "not implemented"
 * for an answer that is already known.
 */
function canvasComposition(width: number, height: number): Composition | null {
  if (typeof OffscreenCanvas !== 'function') {
    return null;
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  return context === null ? null : { target: canvas, context };
}

/**
 * Hands out the shared picture for a cell — the flyweight factory.
 *
 * One per renderer, pointed at a model with {@link use}. It is emptied whenever
 * the thing that decides what a look *is* changes: the palette, the authored
 * pixel grid, or the projection.
 */
export class TileAppearanceCache {
  private model: RenderModel = emptyRenderModel();
  /** `null` means "this cell draws its colour", cached like any other answer. */
  private entries = new Map<number, Look | null>();
  private composedPixels = 0;

  constructor(
    private readonly images: SpriteSource | null,
    private readonly composition: CompositionFactory = canvasComposition,
  ) {}

  /**
   * Points the cache at the model about to be drawn.
   *
   * Called once per `setModel`, which in the editor is once per edit, so the
   * comparison is three identity checks and nothing else. Terrain, elevation,
   * entities and hover all change constantly and none of them changes what a
   * look is made of.
   */
  use(model: RenderModel): void {
    const stale =
      model.palette !== this.model.palette ||
      model.tileArt !== this.model.tileArt ||
      model.projection !== this.model.projection;
    this.model = model;
    if (stale) {
      this.clear();
    }
  }

  /**
   * Every image the cells of *this map* can ask for.
   *
   * One pass over the terrain, which is why this is a per-loaded-world call
   * and never a per-frame one. It is the list worth waiting on before drawing
   * anything: a map painted with four of a set's forty tiles must not be held
   * back for the other thirty-six.
   *
   * A borrowed ladder counts as used even though no cell is painted with the
   * tile that lends it — the faces of a cell that borrowed it are drawn from
   * its art (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
   */
  paintedAssets(): string[] {
    const used = new Set<number>();
    for (const paletteIndex of this.model.terrain) {
      used.add(paletteIndex);
    }
    for (const choice of this.model.artChoices.values()) {
      if (choice.elevationTile !== null) {
        used.add(choice.elevationTile);
      }
    }
    return this.assetsOf((index) => used.has(index));
  }

  /**
   * Every image the current palette can ask for, in the projection in force.
   *
   * The whole palette: what this map *may* be painted with, which is what an
   * editor wants warm so a brush the author has not picked yet is ready when
   * they pick it. A top-down world never fetches a surface or a ladder, and an
   * isometric one never fetches a flat image
   * (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
   */
  assets(): string[] {
    return this.assetsOf(() => true);
  }

  /** The images of every palette entry `wanted` accepts, in this projection. */
  private assetsOf(wanted: (paletteIndex: number) => boolean): string[] {
    const assets = new Set<string>();
    const isometric = this.model.projection === 'isometric';
    for (const [index, tile] of this.model.palette.entries()) {
      const art = tile.art;
      if (art === undefined || !wanted(index)) {
        continue;
      }
      for (const variant of (isometric ? art.surface : art.flat) ?? []) {
        assets.add(variant.asset);
      }
      if (!isometric) {
        continue;
      }
      for (const level of art.elevation?.levels ?? []) {
        for (const variant of level.variants) {
          assets.add(variant.asset);
        }
      }
    }
    return [...assets];
  }

  /** How many distinct looks are held; surfaced in the editor's readout. */
  get size(): number {
    return this.entries.size;
  }

  /** Drops every look, so the next frame resolves and composes again. */
  clear(): void {
    this.entries.clear();
    this.composedPixels = 0;
  }

  /**
   * The shared look for one cell, or `null` when it has none to share.
   *
   * `null` is the colour path, and it means what it has always meant: the tile
   * authors no art, or none for this projection, or the resolver found nothing
   * at this height. An appearance that is not {@link TileAppearance.ready} is
   * the colour path too — its images have not arrived — but it is worth
   * returning, because it is the same object that will be ready next frame.
   *
   * @param index the cell's row-major index, for its authored art choice
   * @param elevation the cell's own height
   * @param base the height its faces reach down to
   */
  of(
    paletteIndex: number,
    index: number,
    cell: Offset,
    elevation: number,
    base: number,
  ): TileAppearance | null {
    const tile = this.model.palette[paletteIndex];
    const art = tile?.art;
    if (this.images === null || tile === undefined || art === undefined) {
      return null;
    }

    const isometric = this.model.projection === 'isometric';
    // The choice is read, never copied: building a `CellArt` per cell per frame
    // is one of the allocations this cache exists to remove
    // (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
    const choice = this.model.artChoices.size === 0 ? undefined : this.model.artChoices.get(index);

    // The roll is the cell's own; reducing it to a variant index is what turns
    // thousands of cells into a handful of looks.
    const roll = variantRoll(cell.col, cell.row, tile.id);
    const surface =
      choice?.surface ?? variantIndex(roll, (isometric ? art.surface : art.flat)?.length ?? 0);
    const ladder = choice?.elevationTile ?? null;
    const steps = isometric ? Math.min(Math.max(0, elevation - base), MAX_STACKED_LEVELS) : 0;
    // Exactly what `resolveTileRender` would choose for the ladder's cut: the
    // author's variant, else the surface's, else the raw roll.
    const variant = choice?.elevation ?? surface ?? roll;

    const key = keyOf(paletteIndex, elevation, steps, surface, variant, ladder);
    if (key !== null) {
      const cached = this.entries.get(key);
      if (cached !== undefined) {
        return cached === null ? null : this.settle(cached);
      }
    }

    const look = this.resolve(tile.id, art, elevation, base, roll, {
      surface,
      // A borrowed ladder is another palette entry's art; the top face is still
      // the cell's own. Absent means "my own", which is what `null` says here.
      elevation: ladder === null ? null : (this.model.palette[ladder]?.art ?? null),
      elevationVariant: variant,
    });

    if (look === null) {
      if (key !== null) {
        this.remember(key, null);
      }
      return null;
    }
    if (key === null) {
      // Nothing to share, so nothing to compose either: a picture built here
      // would be thrown away this frame and rebuilt the next one.
      look.ready = this.loaded(look.render);
      return look;
    }
    this.remember(key, look);
    return this.settle(look);
  }

  /** Stores one answer, emptying the cache first if it has grown too far. */
  private remember(key: number, look: Look | null): void {
    if (this.entries.size >= MAX_APPEARANCES) {
      this.clear();
    }
    this.entries.set(key, look);
  }

  /** Resolves one look, or `null` when the resolver draws nothing at all. */
  private resolve(
    tileId: string,
    art: TileArt,
    elevation: number,
    base: number,
    roll: number,
    cell: CellArt,
  ): Look | null {
    const render = resolveTileRender(
      tileId,
      art,
      this.model.projection,
      elevation,
      base,
      roll,
      cell,
    );
    return isEmptyRender(render) ? null : new Look(render);
  }

  /**
   * Checks a look's images once, and composes it the frame they all arrive.
   *
   * A look that is ready is never asked again: that is the whole point of
   * paying for the composition once.
   */
  private settle(look: Look): Look {
    if (look.ready || !this.loaded(look.render)) {
      return look;
    }
    look.ready = true;
    const composed = this.compose(look.render);
    if (composed !== null) {
      look.picture = composed.picture;
      look.pictureHeight = composed.height;
    }
    return look;
  }

  /** `true` when every image this look draws with has finished loading. */
  private loaded(render: ResolvedTileRender): boolean {
    const images = this.images;
    if (images === null) {
      return false;
    }
    if (render.flat !== null) {
      return images.image(render.flat) !== null;
    }
    if (render.surface !== null && images.image(render.surface) === null) {
      return false;
    }
    for (const layer of render.layers) {
      if (images.image(layer.asset) === null) {
        return false;
      }
    }
    return true;
  }

  /**
   * Stacks a look's images into one, at the tile set's authored resolution.
   *
   * The geometry is the renderer's, moved into the tile's own pixel grid: a
   * layer sits `shoulderLine + drop * elevationStep` rows down, exactly as
   * `drawPaintedCell` places it, and the composed picture is then scaled once
   * instead of every layer being scaled separately
   * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
   *
   * A single-image look — a flat hexagon, or a top face with nothing under it —
   * *is* its own picture, and costs no canvas at all.
   */
  private compose(
    render: ResolvedTileRender,
  ): { picture: CanvasImageSource; height: number } | null {
    const images = this.images;
    const art = this.model.tileArt;
    if (images === null) {
      return null;
    }

    if (render.flat !== null) {
      const image = images.image(render.flat);
      return image === null ? null : { picture: image, height: art.flatHeight };
    }

    const surface = render.surface === null ? null : images.image(render.surface);
    if (render.layers.length === 0) {
      return surface === null ? null : { picture: surface, height: art.surfaceHeight };
    }

    const height = composedHeight(render, art);
    const width = Math.max(1, Math.ceil(art.width));
    const rows = Math.max(1, Math.ceil(height));
    if (this.composedPixels + width * rows > MAX_COMPOSED_PIXELS) {
      return null;
    }
    const composition = this.composition(width, rows);
    if (composition === null) {
      return null;
    }
    this.composedPixels += width * rows;

    const { context } = composition;
    // Authored pixels are blitted one to one here; the single scale happens
    // when the renderer draws the composed picture into the hexagon.
    context.imageSmoothingEnabled = false;
    const line = shoulderLine(art);
    for (const layer of render.layers) {
      const image = images.image(layer.asset);
      if (image !== null) {
        context.drawImage(
          image,
          0,
          line + layer.drop * art.elevationStep,
          art.width,
          art.elevationHeight,
        );
      }
    }
    // Last, so the top face is never the thing a face image happens to cover.
    if (surface !== null) {
      context.drawImage(surface, 0, 0, art.width, art.surfaceHeight);
    }
    return { picture: composition.target, height };
  }
}

/**
 * How tall a stacked look is, in authored pixels.
 *
 * The deepest layer's own bottom, or the top face when nothing hangs below it.
 */
export function composedHeight(render: ResolvedTileRender, art: TileArtGeometry): number {
  let deepest = 0;
  for (const layer of render.layers) {
    deepest = Math.max(deepest, layer.drop);
  }
  return Math.max(
    art.surfaceHeight,
    shoulderLine(art) + deepest * art.elevationStep + art.elevationHeight,
  );
}
