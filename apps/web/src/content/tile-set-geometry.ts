/**
 * The pixel grid a tile set's images are authored on, in the renderer's hands.
 *
 * A deliberate second implementation of `TileArtGeometry`'s methods in
 * `crates/world/src/tile_art.rs`, for the same reason ADR-0011 keeps the hex
 * maths twice: the renderer answers these for every visible cell of every
 * frame, and a WASM call per cell is not affordable. The shapes and the bounds
 * they read are generated (`generated/tile-set.ts`); only the arithmetic is
 * here, and `apps/web/src/renderer/tile-art.spec.ts` mirrors the Rust suite
 * that guards it.
 */
import {
  DEFAULT_ELEVATION_HEIGHT,
  DEFAULT_ELEVATION_STEP,
  DEFAULT_FLAT_HEIGHT,
  DEFAULT_SURFACE_HEIGHT,
  DEFAULT_TILE_WIDTH,
  type TileArtGeometry,
  type TileSetDefinition,
} from './generated/tile-set';

/** The geometry a set declares, or the shipped defaults. */
export function tileArtGeometry(tileSet: Pick<TileSetDefinition, 'art'>): TileArtGeometry {
  return {
    width: tileSet.art?.width ?? DEFAULT_TILE_WIDTH,
    flatHeight: tileSet.art?.flatHeight ?? DEFAULT_FLAT_HEIGHT,
    surfaceHeight: tileSet.art?.surfaceHeight ?? DEFAULT_SURFACE_HEIGHT,
    elevationHeight: tileSet.art?.elevationHeight ?? DEFAULT_ELEVATION_HEIGHT,
    elevationStep: tileSet.art?.elevationStep ?? DEFAULT_ELEVATION_STEP,
  };
}

/**
 * How far the hexagon's lower edges fall, from its shoulders to its south
 * vertex.
 *
 * A quarter of the top face's height, exactly: a pointy-top hexagon puts its
 * `±30°` corners half a radius off centre and the projection scales both by the
 * same tilt. This is the depth of the `V` an elevation image leaves above its
 * faces — **not** how far down that image sits; see {@link shoulderLine}.
 */
export function shoulderDepth(geometry: TileArtGeometry): number {
  return Math.floor(geometry.surfaceHeight / 4);
}

/**
 * The row of a surface image the hexagon's **lower** shoulders sit on, which is
 * where an elevation image is blitted.
 *
 * A pointy-top hexagon reaches its full width a quarter of the way down and
 * narrows again a quarter from the bottom, so the lower shoulders are three
 * quarters down: `surfaceHeight - shoulderDepth`. An elevation image's own row
 * `0` is that line, and its `V` then falls exactly onto the two lower edges
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
 */
export function shoulderLine(geometry: TileArtGeometry): number {
  return geometry.surfaceHeight - shoulderDepth(geometry);
}

/** Height of the faces themselves, below the `V`. */
export function faceHeight(geometry: TileArtGeometry): number {
  return Math.max(0, geometry.elevationHeight - shoulderDepth(geometry));
}

/**
 * How many levels of elevation one drawn band of faces spans.
 *
 * A band is as thick as the canvas leaves room for — {@link faceHeight} — and a
 * level lifts `elevationStep`, so a set whose step is a whole band answers `1`:
 * one image per level, edge to edge, which is what every set said before the
 * two were told apart. A **shorter** step means one image covers several
 * levels, which is how the same art draws a lower cliff without being sliced
 * into a repeating strip
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
 *
 * Rounds down and never to zero, so a band that does not divide evenly overlaps
 * its neighbour by the remainder rather than leaving a gap.
 */
export function bandLevels(geometry: TileArtGeometry): number {
  const step = Math.max(1, geometry.elevationStep);
  return Math.max(1, Math.floor(faceHeight(geometry) / step));
}
