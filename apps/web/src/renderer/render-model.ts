/**
 * The data the renderer draws.
 *
 * The renderer owns no state of its own beyond the camera: it is handed a
 * {@link RenderModel} and paints it. Both the play mode (whose model is derived
 * from engine snapshots) and the editor (whose model is derived from the
 * authored document being edited) produce this same shape, which is why one
 * renderer serves both.
 */

import {
  DEFAULT_CHARACTER_HEIGHT_TILES,
  DEFAULT_GRID_ALPHA,
  DEFAULT_GRID_COLOR,
  DEFAULT_GRID_LINE_WIDTH,
  DEFAULT_REVEAL_STYLE,
  ResolvedCharacter,
  RevealStyle,
  TileArt,
  TileArtGeometry,
  tileArtGeometry,
} from '../content/content-types';
import { EMPTY_BOUNDS, MapBounds, Offset } from '../core/hex/hex-coords';
import { ProjectionMode } from './projection';

/** A tile palette entry; mirrors the engine's `PaletteEntry`. */
export interface RenderPaletteEntry {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly terrain: string;
  readonly movementCost: number;
  readonly passable: boolean;
  readonly visualId: string;
  readonly fallbackColor: string;
  readonly tags: readonly string[];
  /**
   * The images this tile is drawn from; absent draws {@link fallbackColor}.
   *
   * Carried on the palette entry rather than fetched per cell: the renderer
   * already indexes the palette once per cell, and that is the budget
   * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
   */
  readonly art?: TileArt;
}

/** Something standing on a hex. */
export interface RenderEntity {
  readonly id: string;
  readonly at: Offset;
  readonly visualId: string;
  readonly fallbackColor: string;
  /** Authored character to draw instead of the fallback marker and glyph. */
  readonly character?: ResolvedCharacter | null;
  /** Presentation-only glide from an accepted movement event. */
  readonly motion?: {
    readonly from: Offset;
    /** Linear `0..1` progress from {@link from} to {@link at}. */
    readonly progress: number;
  };
  /** One or two characters drawn inside the marker. */
  readonly glyph: string;
  /** Drawn with a heavier outline. */
  readonly emphasised: boolean;
}

/** An authored point of interest. */
export interface RenderLocation {
  readonly id: string;
  readonly at: Offset;
  readonly name: string;
}

/**
 * A door: a cell that sends the player to another map.
 *
 * Drawn as its own marker rather than as a location, because it is not a place
 * — it is a way out (`docs/adr/ADR-0017-map-links.md`).
 */
export interface RenderLink {
  readonly id: string;
  readonly at: Offset;
  /** What to write under the marker; usually the door's name or its target. */
  readonly label: string;
}

/**
 * One cell's art choice, with every authored id already resolved to an index.
 *
 * Mirrors the engine's `CellArtChoice`. The renderer never searches a variant
 * list by name: Rust did that once when it flattened the map, and a `null`
 * field is simply a choice the author did not make — or one whose id stopped
 * meaning anything, which validation reports separately
 * (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
 */
export interface CellArtChoice {
  /** Index into the cell's own tile's surface variants. */
  readonly surface: number | null;
  /** Palette index of the tile whose elevation ladder cuts the faces. */
  readonly elevationTile: number | null;
  /** Index into the variants of whichever level ends up drawing. */
  readonly elevation: number | null;
}

/** A set of hexes drawn with a coloured overlay. */
export interface RenderOverlay {
  readonly cells: readonly Offset[];
  readonly fill: string;
  readonly stroke: string;
}

/** Everything needed to paint one frame. */
export interface RenderModel {
  /**
   * The rectangle the packed buffers cover.
   *
   * Storage, not the shape of the world: which of those cells the map has is
   * {@link presence} (`docs/adr/ADR-0046-a-map-is-a-set-of-hexes.md`).
   */
  readonly bounds: MapBounds;
  /** How the hex plane is projected; authored per world. */
  readonly projection: ProjectionMode;
  /** Tile-face heights occupied by a 128-pixel character canvas. */
  readonly characterHeightTiles: number;
  /**
   * The pixel grid the tile set's images are authored on.
   *
   * The renderer derives its tilt and its elevation step from this, so a tile
   * drawn from sprites and one filled with colour agree about how tall a step
   * is (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
   */
  readonly tileArt: TileArtGeometry;
  readonly palette: readonly RenderPaletteEntry[];
  /** One palette index per cell, row-major in offset coordinates. */
  readonly terrain: Uint8Array;
  /**
   * `1` where the map has a hex, `0` where it has a hole, same layout again.
   *
   * Always the full length of {@link bounds}, unlike {@link elevation}: the
   * renderer reads it once per cell in its innermost loop, and an
   * empty-means-everything convention would put a branch there.
   */
  readonly presence: Uint8Array;
  /**
   * One elevation per cell, in the same layout as {@link terrain}.
   *
   * Empty means "flat everywhere", which is what a world without authored
   * elevation produces. Only read in isometric mode.
   */
  readonly elevation: Int8Array;
  /**
   * Bounds on the values in {@link elevation} — not necessarily tight.
   *
   * The renderer uses them to size the culling margin and the band it searches
   * when hit-testing, so a loose bound costs a little work and a wrong one drops
   * cells. Producers that cannot track the range exactly should widen it.
   */
  readonly elevationRange: { readonly min: number; readonly max: number };
  /**
   * The cells that chose their art, keyed by row-major cell index.
   *
   * Sparse, and normally empty: choosing is an authored exception, so this is a
   * map rather than three more buffers of nulls. The renderer looks a cell up
   * once, next to the palette lookup it already does
   * (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
   */
  readonly artChoices: ReadonlyMap<number, CellArtChoice>;
  readonly entities: readonly RenderEntity[];
  readonly locations: readonly RenderLocation[];
  readonly links: readonly RenderLink[];
  readonly overlays: readonly RenderOverlay[];
  /**
   * The selected hex.
   *
   * The *hovered* hex is deliberately not here. It changes with the pointer
   * rather than with the world, and putting it in the model made every hex the
   * cursor crossed rebuild a model and schedule an Angular pass to move two
   * strokes. The renderer owns it, and {@link CanvasView} — which is what knows
   * the pointer moved — tells it directly through `setHover`.
   */
  readonly selected: Offset | null;
  /**
   * Whether the cells the extent covers but the map lacks are hinted at.
   *
   * The editor draws them as a faint ghost so an author can see — and click —
   * the canvas they may extend into. Play draws nothing there: a hole is
   * simply not part of the world
   * (`docs/adr/ADR-0046-a-map-is-a-set-of-hexes.md`).
   */
  readonly showExtent: boolean;
  readonly showGrid: boolean;
  /** Grid stroke width in screen pixels, kept stable while the camera zooms. */
  readonly gridLineWidth: number;
  /** Grid stroke RGB colour. */
  readonly gridLineColor: string;
  /** Grid stroke opacity from transparent (`0`) to opaque (`1`). */
  readonly gridLineAlpha: number;
  readonly showCoordinates: boolean;
  /**
   * How far relief may be seen through around the pointer.
   *
   * Authored per map because how tall a map's relief is decides how much of it
   * hides its own hexes (`docs/adr/ADR-0047-relief-never-hides-a-hex.md`).
   */
  readonly reveal: RevealStyle;
}

/**
 * The choices a cell made, keyed by cell index, out of a list keyed by cell.
 *
 * The engine hands them over as a sorted array — the shape a `Vec` serialises
 * to — and the renderer wants a lookup, so the conversion happens once, where
 * the model is built, rather than per frame.
 */
export function cellArtChoicesOf(
  choices: readonly {
    cell: number;
    surface?: number | null;
    elevationTile?: number | null;
    elevation?: number | null;
  }[],
): ReadonlyMap<number, CellArtChoice> {
  const map = new Map<number, CellArtChoice>();
  for (const choice of choices) {
    map.set(choice.cell, {
      surface: choice.surface ?? null,
      elevationTile: choice.elevationTile ?? null,
      elevation: choice.elevation ?? null,
    });
  }
  return map;
}

/**
 * The same thing out of the ids an authored document holds.
 *
 * The editor's half of what `WorldGrid::build` does in Rust: a variant is named
 * in a file and indexed in a renderer, and the search that turns one into the
 * other happens once per edit rather than once per cell per frame. An id
 * nothing defines resolves to nothing — the cell rolls that choice, and the
 * validator is what tells the author
 * (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
 */
export function resolveCellArtChoices(
  palette: readonly { readonly id: string; readonly art?: TileArt }[],
  terrain: Uint8Array,
  overrides: ReadonlyMap<
    number,
    { surface: string | null; elevationTile: string | null; elevation: string | null }
  >,
): ReadonlyMap<number, CellArtChoice> {
  const map = new Map<number, CellArtChoice>();
  for (const [cell, choice] of overrides) {
    const own = palette[terrain[cell] ?? -1];
    const elevationTile =
      choice.elevationTile === null
        ? null
        : indexOrNull(palette.findIndex((tile) => tile.id === choice.elevationTile));
    // The named variant means something in the ladder that will actually draw.
    const ladder = (elevationTile === null ? own : palette[elevationTile])?.art;
    const resolved: CellArtChoice = {
      surface:
        choice.surface === null
          ? null
          : indexOrNull(
              own?.art?.surface?.findIndex((variant) => variant.id === choice.surface) ?? -1,
            ),
      elevationTile,
      elevation:
        choice.elevation === null
          ? null
          : (ladder?.elevation?.levels
              .map((level) => level.variants.findIndex((v) => v.id === choice.elevation))
              .find((index) => index >= 0) ?? null),
    };
    if (
      resolved.surface !== null ||
      resolved.elevationTile !== null ||
      resolved.elevation !== null
    ) {
      map.set(cell, resolved);
    }
  }
  return map;
}

const indexOrNull = (index: number): number | null => (index < 0 ? null : index);

/** An empty model, used before content has loaded. */
export function emptyRenderModel(): RenderModel {
  return {
    bounds: EMPTY_BOUNDS,
    projection: 'topDown',
    characterHeightTiles: DEFAULT_CHARACTER_HEIGHT_TILES,
    tileArt: tileArtGeometry({}),
    palette: [],
    terrain: new Uint8Array(0),
    presence: new Uint8Array(0),
    elevation: new Int8Array(0),
    elevationRange: { min: 0, max: 0 },
    artChoices: new Map(),
    entities: [],
    locations: [],
    links: [],
    overlays: [],
    selected: null,
    showExtent: false,
    showGrid: true,
    gridLineWidth: DEFAULT_GRID_LINE_WIDTH,
    gridLineColor: DEFAULT_GRID_COLOR,
    gridLineAlpha: DEFAULT_GRID_ALPHA,
    showCoordinates: false,
    reveal: { ...DEFAULT_REVEAL_STYLE },
  };
}

/**
 * The exact range of an elevation buffer.
 *
 * One pass over the whole buffer, so callers should do this when the buffer is
 * *produced* — once per loaded world — not once per frame.
 */
export function elevationRangeOf(elevation: Int8Array): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const value of elevation) {
    if (value < min) {
      min = value;
    } else if (value > max) {
      max = value;
    }
  }
  return { min, max };
}
