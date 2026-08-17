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

/** What makes a {@link MapLink} fire. Only `enter` is implemented. */
export type LinkTrigger = 'enter' | 'interact';

/**
 * A cell that sends the player to another map.
 *
 * The only cross-file reference in the world schema: `targetWorld` names a
 * world that lives in another file, so the editor can only check it once the
 * whole project is loaded (`docs/adr/ADR-0017-map-links.md`).
 */
export interface MapLink {
  id: string;
  at: OffsetPair;
  targetWorld: string;
  targetAt: OffsetPair;
  /** Omitted when `enter`, which is the default. */
  trigger?: LinkTrigger;
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
  /**
   * Id of the {@link ZoneDefinition} this map belongs to.
   *
   * Every map has a zone; absent or empty names the project's default one
   * rather than *no* zone. A zone id only resolves against the project that
   * declares it, so the Rust validator is what checks it
   * (`docs/adr/ADR-0021-map-zones.md`).
   */
  zone?: string;
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
  links?: MapLink[];
  metadata?: WorldMetadata;
}

export const PROJECT_SCHEMA_VERSION = 1;

/** One content file a project ships, by id and path under the content root. */
export interface ContentRef {
  id: string;
  path: string;
}

/**
 * The manifest of one game: which content files it is made of, and where a
 * session starts.
 *
 * It is what lets a client build boot with no editor and no backend — it reads
 * this file and loads exactly what it lists
 * (`docs/adr/ADR-0018-client-delivery-build.md`).
 */
/**
 * Id of the zone a project falls back on when it declares none.
 *
 * Mirrors `insulaire_world::DEFAULT_ZONE_ID`.
 */
export const DEFAULT_ZONE_ID = 'default';

/**
 * A group of maps that belong together.
 *
 * The unit of simulated scope: a tick advances the maps of one zone, not only
 * the map the player stands on (`docs/adr/ADR-0021-map-zones.md`). Zones are
 * declared by the project, and every map names exactly one.
 */
export interface ZoneDefinition {
  id: string;
  name?: string;
}

export interface ProjectDefinition {
  id: string;
  schemaVersion: number;
  name?: string;
  startWorld: string;
  /** Zones, in author order. The first is the default; absent means one implicit
   * {@link DEFAULT_ZONE_ID} zone. */
  zones?: ZoneDefinition[];
  tileSets: ContentRef[];
  worlds: ContentRef[];
}
