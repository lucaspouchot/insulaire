/**
 * TypeScript mirror of the authored content schema.
 *
 * Kept in step with `crates/world/src/definition.rs` and
 * `crates/world/src/tileset.rs`; `docs/content-format.md` is the shared
 * specification. These types describe files on disk — they are not runtime
 * state, and the editor never mutates a definition in place.
 */

/** `[col, row]` in odd-r offset coordinates. */
export type OffsetPair = [number, number];

export const WORLD_SCHEMA_VERSION = 1;
export const TILE_SET_SCHEMA_VERSION = 1;

export interface TileVisual {
  visualId: string;
  fallbackColor: string;
  hints?: Record<string, string>;
}

export interface TileDefinition {
  id: string;
  name?: string;
  terrain: string;
  /** `0` means impassable. */
  movementCost: number;
  tags?: string[];
  visual: TileVisual;
}

export interface TileSetDefinition {
  id: string;
  schemaVersion: number;
  name?: string;
  tiles: TileDefinition[];
}

/** How the renderer projects a world; mirrors the engine's `ProjectionMode`. */
export type ProjectionMode = 'topDown' | 'isometric';

/** Authored elevation is packed as one signed byte per cell for the renderer. */
export const MIN_ELEVATION = -128;
export const MAX_ELEVATION = 127;

/** A cell whose tile differs from {@link WorldDefinition.defaultTile}. */
export interface PlacedTile {
  at: OffsetPair;
  tile: string;
  /** Whole steps of relief, `MIN_ELEVATION`..`MAX_ELEVATION`. Omitted when `0`. */
  elevation?: number;
  tags?: string[];
}

export interface EntityDefinition {
  id: string;
  templateId: string;
  at: OffsetPair;
  tags?: string[];
  properties?: Record<string, unknown>;
}

export interface LocationDefinition {
  id: string;
  at: OffsetPair;
  name?: string;
  tags?: string[];
}

export interface WorldMetadata {
  author?: string;
  description?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface WorldDefinition {
  id: string;
  schemaVersion: number;
  name?: string;
  width: number;
  height: number;
  orientation?: 'pointy' | 'flat';
  /** Presentation only; defaults to `topDown` when absent. */
  projection?: ProjectionMode;
  tileSetId: string;
  defaultTile: string;
  tiles?: PlacedTile[];
  entities?: EntityDefinition[];
  locations?: LocationDefinition[];
  metadata?: WorldMetadata;
}
