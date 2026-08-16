/**
 * The editor's authored document.
 *
 * # Why this exists separately from the engine's state
 *
 * `CLAUDE.md` requires that editor state and runtime state stay apart. A world
 * being *authored* is not a world being *played*: it has no tick, no RNG and no
 * entity handles, and every cell is freely mutable. So the editor owns this
 * document in TypeScript, and the engine owns `GameState` in Rust. The only
 * thing that crosses between them is a {@link WorldDefinition} — a file.
 *
 * Note that this is a *content* model, not a rules model: no adjacency, no
 * passability, no movement. Validity is decided by the Rust validator through
 * WASM, never re-implemented here.
 *
 * # Storage shape
 *
 * Cells are held as a dense `Uint8Array` of palette indices — the same layout
 * the engine's packed terrain buffer and the renderer use, so painting a hex is
 * one array write and rendering needs no conversion. Export re-sparsifies:
 * only cells differing from `defaultTile` are written out.
 */

import { Offset, indexIn } from '../core/hex/hex-coords';
import {
  EntityDefinition,
  LocationDefinition,
  MapLink,
  PlacedTile,
  ProjectionMode,
  TileDefinition,
  TileSetDefinition,
  WorldDefinition,
  WorldMetadata,
  MAX_ELEVATION,
  MIN_ELEVATION,
  WORLD_SCHEMA_VERSION,
} from './content-types';

/** A palette entry resolved from the tile set, indexed by position. */
export interface DocumentTile {
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

/** An entity placed by the author. */
export interface DocumentEntity {
  id: string;
  templateId: string;
  at: Offset;
  tags: string[];
}

/** A point of interest placed by the author. */
export interface DocumentLocation {
  id: string;
  at: Offset;
  name: string;
  tags: string[];
}

/**
 * A door placed by the author: step on `at`, arrive at `targetAt` in
 * `targetWorld`.
 *
 * The document deliberately does *not* check that `targetWorld` exists — a map
 * knows nothing about its siblings. Resolving the target is the project's job,
 * and the verdict comes from the Rust validator through
 * `EngineService.validateLinks` (`docs/adr/ADR-0017-map-links.md`).
 */
export interface DocumentLink {
  id: string;
  at: Offset;
  targetWorld: string;
  targetAt: Offset;
  name: string;
  tags: string[];
}

export interface WorldDocumentInit {
  id: string;
  name: string;
  width: number;
  height: number;
  tileSet: TileSetDefinition;
  defaultTile?: string;
  projection?: ProjectionMode;
}

/** Thrown when a document cannot be built from the given content. */
export class WorldDocumentError extends Error {}

export class WorldDocument {
  private constructor(
    public id: string,
    public name: string,
    readonly width: number,
    readonly height: number,
    readonly tileSetId: string,
    readonly palette: readonly DocumentTile[],
    private defaultTileIndex: number,
    private readonly cells: Uint8Array,
    /** One elevation per cell, in the same layout as {@link cells}. */
    private readonly elevations: Int8Array,
    private entities: DocumentEntity[],
    private locations: DocumentLocation[],
    private links: DocumentLink[],
    public metadata: WorldMetadata,
    /** How the runtime and the editor render this world. */
    public projection: ProjectionMode,
  ) {}

  private minElevation = 0;
  private maxElevation = 0;

  // ---------------------------------------------------------------- creation

  /** Creates an empty world filled with `defaultTile` (or the first tile). */
  static create(init: WorldDocumentInit): WorldDocument {
    const palette = buildPalette(init.tileSet);
    if (palette.length === 0) {
      throw new WorldDocumentError(`tile set "${init.tileSet.id}" defines no tiles`);
    }
    if (init.width <= 0 || init.height <= 0) {
      throw new WorldDocumentError(`world dimensions must be positive, got ${init.width}x${init.height}`);
    }

    const first = palette[0] as DocumentTile;
    const defaultTile = init.defaultTile ?? first.id;
    const defaultIndex = palette.findIndex((tile) => tile.id === defaultTile);
    if (defaultIndex < 0) {
      throw new WorldDocumentError(`default tile "${defaultTile}" is not in tile set "${init.tileSet.id}"`);
    }

    const cells = new Uint8Array(init.width * init.height).fill(defaultIndex);
    return new WorldDocument(
      init.id,
      init.name,
      init.width,
      init.height,
      init.tileSet.id,
      palette,
      defaultIndex,
      cells,
      new Int8Array(init.width * init.height),
      [],
      [],
      [],
      {},
      init.projection ?? 'topDown',
    );
  }

  /** Rebuilds a document from an authored world file. */
  static fromDefinition(definition: WorldDefinition, tileSet: TileSetDefinition): WorldDocument {
    if (definition.tileSetId !== tileSet.id) {
      throw new WorldDocumentError(
        `world "${definition.id}" needs tile set "${definition.tileSetId}", got "${tileSet.id}"`,
      );
    }

    const document = WorldDocument.create({
      id: definition.id,
      name: definition.name ?? definition.id,
      width: definition.width,
      height: definition.height,
      tileSet,
      defaultTile: definition.defaultTile,
      projection: definition.projection,
    });

    for (const placed of definition.tiles ?? []) {
      const index = document.paletteIndexOf(placed.tile);
      if (index < 0) {
        throw new WorldDocumentError(`tile "${placed.tile}" is not defined by tile set "${tileSet.id}"`);
      }
      const cell = indexIn({ col: placed.at[0], row: placed.at[1] }, document.width, document.height);
      if (cell < 0) {
        throw new WorldDocumentError(
          `tile at [${placed.at[0]}, ${placed.at[1]}] is outside the ${definition.width}x${definition.height} map`,
        );
      }
      document.cells[cell] = index;
      // Through `raise` rather than the buffer, so the elevation range tracks.
      document.raise({ col: placed.at[0], row: placed.at[1] }, placed.elevation ?? 0);
    }

    document.entities = (definition.entities ?? []).map((entity) => ({
      id: entity.id,
      templateId: entity.templateId,
      at: { col: entity.at[0], row: entity.at[1] },
      tags: [...(entity.tags ?? [])],
    }));
    document.locations = (definition.locations ?? []).map((location) => ({
      id: location.id,
      at: { col: location.at[0], row: location.at[1] },
      name: location.name ?? location.id,
      tags: [...(location.tags ?? [])],
    }));
    document.links = (definition.links ?? []).map((link) => ({
      id: link.id,
      at: { col: link.at[0], row: link.at[1] },
      targetWorld: link.targetWorld,
      targetAt: { col: link.targetAt[0], row: link.targetAt[1] },
      name: link.name ?? '',
      tags: [...(link.tags ?? [])],
    }));
    document.metadata = { ...(definition.metadata ?? {}) };

    return document;
  }

  // ------------------------------------------------------------------ tiles

  /** The packed palette indices; the renderer reads this directly. */
  get terrain(): Uint8Array {
    return this.cells;
  }

  /** The packed elevations; the renderer reads this directly. */
  get elevation(): Int8Array {
    return this.elevations;
  }

  /**
   * Bounds on the packed elevations — widened on every edit, never narrowed.
   *
   * Narrowing would mean rescanning the buffer on each stroke; the renderer only
   * needs a bound, and a stale-but-wider one costs a few extra hit tests.
   */
  get elevationRange(): { min: number; max: number } {
    return { min: this.minElevation, max: this.maxElevation };
  }

  /** Authored elevation at a cell, or `0` when out of bounds. */
  elevationAt(cell: Offset): number {
    const index = indexIn(cell, this.width, this.height);
    return index < 0 ? 0 : (this.elevations[index] ?? 0);
  }

  /**
   * Raises (or lowers) a cell by `delta` steps, clamped to the schema range.
   *
   * @returns `true` when the cell changed.
   */
  raise(cell: Offset, delta: number): boolean {
    const index = indexIn(cell, this.width, this.height);
    if (index < 0) {
      return false;
    }
    const next = clampElevation((this.elevations[index] ?? 0) + delta);
    if (next === this.elevations[index]) {
      return false;
    }
    this.elevations[index] = next;
    this.minElevation = Math.min(this.minElevation, next);
    this.maxElevation = Math.max(this.maxElevation, next);
    return true;
  }

  /** The tile every unpainted cell falls back to on export. */
  get defaultTile(): DocumentTile {
    return this.palette[this.defaultTileIndex] as DocumentTile;
  }

  /** Palette position of a tile id, or `-1`. */
  paletteIndexOf(tileId: string): number {
    return this.palette.findIndex((tile) => tile.id === tileId);
  }

  /** The tile at a cell, or `null` when out of bounds. */
  tileAt(cell: Offset): DocumentTile | null {
    const index = indexIn(cell, this.width, this.height);
    if (index < 0) {
      return null;
    }
    return this.palette[this.cells[index] as number] ?? null;
  }

  /**
   * Paints a cell.
   *
   * @returns `true` when the cell changed, so callers can skip redundant work.
   */
  paint(cell: Offset, tileId: string): boolean {
    const index = indexIn(cell, this.width, this.height);
    const paletteIndex = this.paletteIndexOf(tileId);
    if (index < 0 || paletteIndex < 0 || this.cells[index] === paletteIndex) {
      return false;
    }
    this.cells[index] = paletteIndex;
    return true;
  }

  // --------------------------------------------------------------- entities

  /** Every placed entity. */
  get placedEntities(): readonly DocumentEntity[] {
    return this.entities;
  }

  /** Every placed point of interest. */
  get placedLocations(): readonly DocumentLocation[] {
    return this.locations;
  }

  /** The entity standing on a cell, if any. */
  entityAt(cell: Offset): DocumentEntity | null {
    return this.entities.find((entity) => entity.at.col === cell.col && entity.at.row === cell.row) ?? null;
  }

  /**
   * Places an entity of `templateId` on `cell`.
   *
   * Placement rules that belong to *authoring* live here: one player at a time,
   * one entity per hex. Whether the resulting world is playable is still decided
   * by the Rust validator.
   *
   * @returns the placed entity, or `null` when the cell is out of bounds.
   */
  placeEntity(cell: Offset, templateId: string, singleton: boolean): DocumentEntity | null {
    if (indexIn(cell, this.width, this.height) < 0) {
      return null;
    }

    this.removeEntityAt(cell);
    if (singleton) {
      this.entities = this.entities.filter((entity) => entity.templateId !== templateId);
    }

    const entity: DocumentEntity = {
      id: this.nextEntityId(templateId),
      templateId,
      at: { col: cell.col, row: cell.row },
      tags: [],
    };
    this.entities.push(entity);
    return entity;
  }

  /** Removes whatever entity stands on `cell`. */
  removeEntityAt(cell: Offset): boolean {
    const before = this.entities.length;
    this.entities = this.entities.filter(
      (entity) => !(entity.at.col === cell.col && entity.at.row === cell.row),
    );
    return this.entities.length !== before;
  }

  /** Removes whatever location sits on `cell`. */
  removeLocationAt(cell: Offset): boolean {
    const before = this.locations.length;
    this.locations = this.locations.filter(
      (location) => !(location.at.col === cell.col && location.at.row === cell.row),
    );
    return this.locations.length !== before;
  }

  // ------------------------------------------------------------------ links

  /** Every door leaving this map. */
  get placedLinks(): readonly DocumentLink[] {
    return this.links;
  }

  /** The link on a cell, if any. */
  linkAt(cell: Offset): DocumentLink | null {
    return this.links.find((link) => link.at.col === cell.col && link.at.row === cell.row) ?? null;
  }

  /**
   * Puts a door on `cell`, or returns the one already there.
   *
   * A new link points at `targetWorld` with an arrival of `[0, 0]`; the editor
   * asks the author where it actually lands. One link per cell, because two
   * doors on one hex have no defined winner — the validator rejects it too
   * (`link.duplicatePosition`).
   *
   * @returns the link, or `null` when the cell is out of bounds.
   */
  placeLink(cell: Offset, targetWorld: string): DocumentLink | null {
    if (indexIn(cell, this.width, this.height) < 0) {
      return null;
    }
    const existing = this.linkAt(cell);
    if (existing !== null) {
      return existing;
    }

    const link: DocumentLink = {
      id: this.nextId(this.links, 'link'),
      at: { col: cell.col, row: cell.row },
      targetWorld,
      targetAt: { col: 0, row: 0 },
      name: '',
      tags: [],
    };
    this.links.push(link);
    return link;
  }

  /** Applies an edit to the link on `cell`. */
  updateLink(cell: Offset, patch: Partial<Omit<DocumentLink, 'id' | 'at'>>): boolean {
    const link = this.linkAt(cell);
    if (link === null) {
      return false;
    }
    Object.assign(link, patch);
    return true;
  }

  /** Removes whatever link sits on `cell`. */
  removeLinkAt(cell: Offset): boolean {
    const before = this.links.length;
    this.links = this.links.filter(
      (link) => !(link.at.col === cell.col && link.at.row === cell.row),
    );
    return this.links.length !== before;
  }

  /** Rewrites every link that pointed at `previousId`, after a map is renamed. */
  retargetLinks(previousId: string, nextId: string): boolean {
    let changed = false;
    for (const link of this.links) {
      if (link.targetWorld === previousId) {
        link.targetWorld = nextId;
        changed = true;
      }
    }
    return changed;
  }

  private nextEntityId(templateId: string): string {
    return this.nextId(this.entities, templateId);
  }

  /** The first free `<prefix>_<n>` id among `existing`. */
  private nextId(existing: readonly { id: string }[], prefix: string): string {
    const taken = new Set(existing.map((item) => item.id));
    for (let n = 1; ; n += 1) {
      const candidate = `${prefix}_${n}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
  }

  // ----------------------------------------------------------------- export

  /**
   * Produces the authored world file.
   *
   * Cells matching {@link defaultTile} are omitted, which is what keeps a large
   * map's file small and its diffs meaningful — unless they carry elevation,
   * which has nowhere else to be written.
   */
  toDefinition(now: () => Date = () => new Date()): WorldDefinition {
    const tiles: PlacedTile[] = [];
    for (let index = 0; index < this.cells.length; index += 1) {
      const paletteIndex = this.cells[index] as number;
      const elevation = this.elevations[index] ?? 0;
      if (paletteIndex === this.defaultTileIndex && elevation === 0) {
        continue;
      }
      const tile = this.palette[paletteIndex];
      if (tile === undefined) {
        continue;
      }
      tiles.push({
        at: [index % this.width, Math.floor(index / this.width)],
        tile: tile.id,
        ...(elevation === 0 ? {} : { elevation }),
      });
    }

    const entities: EntityDefinition[] = this.entities.map((entity) => ({
      id: entity.id,
      templateId: entity.templateId,
      at: [entity.at.col, entity.at.row],
      ...(entity.tags.length > 0 ? { tags: [...entity.tags] } : {}),
    }));

    const locations: LocationDefinition[] = this.locations.map((location) => ({
      id: location.id,
      at: [location.at.col, location.at.row],
      name: location.name,
      ...(location.tags.length > 0 ? { tags: [...location.tags] } : {}),
    }));

    const links: MapLink[] = this.links.map((link) => ({
      id: link.id,
      at: [link.at.col, link.at.row],
      targetWorld: link.targetWorld,
      targetAt: [link.targetAt.col, link.targetAt.row],
      ...(link.name.length > 0 ? { name: link.name } : {}),
      ...(link.tags.length > 0 ? { tags: [...link.tags] } : {}),
    }));

    return {
      id: this.id,
      schemaVersion: WORLD_SCHEMA_VERSION,
      name: this.name,
      width: this.width,
      height: this.height,
      orientation: 'pointy',
      projection: this.projection,
      tileSetId: this.tileSetId,
      defaultTile: this.defaultTile.id,
      tiles,
      entities,
      locations,
      links,
      metadata: { ...this.metadata, updatedAt: now().toISOString() },
    };
  }

  /** A count of each tile currently painted, for the editor's status bar. */
  tileHistogram(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const index of this.cells) {
      const tile = this.palette[index];
      if (tile !== undefined) {
        counts.set(tile.id, (counts.get(tile.id) ?? 0) + 1);
      }
    }
    return counts;
  }
}

/** Keeps an authored elevation inside what the packed buffer can hold. */
function clampElevation(value: number): number {
  return Math.max(MIN_ELEVATION, Math.min(MAX_ELEVATION, Math.trunc(value)));
}

function buildPalette(tileSet: TileSetDefinition): DocumentTile[] {
  return tileSet.tiles.map((tile: TileDefinition, index: number) => ({
    index,
    id: tile.id,
    name: tile.name ?? tile.id,
    terrain: tile.terrain,
    movementCost: tile.movementCost,
    passable: tile.movementCost > 0,
    visualId: tile.visual.visualId,
    fallbackColor: tile.visual.fallbackColor,
    tags: [...(tile.tags ?? [])],
  }));
}
