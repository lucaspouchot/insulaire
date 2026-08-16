/**
 * The data the renderer draws.
 *
 * The renderer owns no state of its own beyond the camera: it is handed a
 * {@link RenderModel} and paints it. Both the play mode (whose model is derived
 * from engine snapshots) and the editor (whose model is derived from the
 * authored document being edited) produce this same shape, which is why one
 * renderer serves both.
 */

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
  readonly entities: readonly RenderEntity[];
  readonly locations: readonly RenderLocation[];
  readonly overlays: readonly RenderOverlay[];
  readonly hover: Offset | null;
  readonly selected: Offset | null;
  readonly showGrid: boolean;
  readonly showCoordinates: boolean;
}

/** An empty model, used before content has loaded. */
export function emptyRenderModel(): RenderModel {
  return {
    width: 0,
    height: 0,
    projection: 'topDown',
    palette: [],
    terrain: new Uint8Array(0),
    elevation: new Int8Array(0),
    elevationRange: { min: 0, max: 0 },
    entities: [],
    locations: [],
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
