/**
 * The data the renderer draws.
 *
 * The renderer owns no state of its own beyond the camera: it is handed a
 * {@link RenderModel} and paints it. Both the play mode (whose model is derived
 * from engine snapshots) and the editor (whose model is derived from the
 * authored document being edited) produce this same shape, which is why one
 * renderer serves both.
 */

import { TileArt, TileArtGeometry, tileArtGeometry } from '../content/content-types';
import { Offset } from '../core/hex/hex-coords';
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
  readonly width: number;
  readonly height: number;
  /** How the hex plane is projected; authored per world. */
  readonly projection: ProjectionMode;
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
  readonly hover: Offset | null;
  readonly selected: Offset | null;
  readonly showGrid: boolean;
  readonly showCoordinates: boolean;
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
    width: 0,
    height: 0,
    projection: 'topDown',
    tileArt: tileArtGeometry({}),
    palette: [],
    terrain: new Uint8Array(0),
    elevation: new Int8Array(0),
    elevationRange: { min: 0, max: 0 },
    artChoices: new Map(),
    entities: [],
    locations: [],
    links: [],
    overlays: [],
    hover: null,
    selected: null,
    showGrid: true,
    showCoordinates: false,
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
