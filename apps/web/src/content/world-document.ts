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
  PlacedTile,
  TileDefinition,
  TileSetDefinition,
  WorldDefinition,
  WorldMetadata,
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

export interface WorldDocumentInit {
  id: string;
  name: string;
  width: number;
  height: number;
  tileSet: TileSetDefinition;
  defaultTile?: string;
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
    private entities: DocumentEntity[],
    private locations: DocumentLocation[],
    public metadata: WorldMetadata,
  ) {}

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
      [],
      [],
      {},
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
    document.metadata = { ...(definition.metadata ?? {}) };

    return document;
  }

  // ------------------------------------------------------------------ tiles

  /** The packed palette indices; the renderer reads this directly. */
  get terrain(): Uint8Array {
    return this.cells;
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

  private nextEntityId(templateId: string): string {
    const taken = new Set(this.entities.map((entity) => entity.id));
    for (let n = 1; ; n += 1) {
      const candidate = `${templateId}_${n}`;
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
   * map's file small and its diffs meaningful.
   */
  toDefinition(now: () => Date = () => new Date()): WorldDefinition {
    const tiles: PlacedTile[] = [];
    for (let index = 0; index < this.cells.length; index += 1) {
      const paletteIndex = this.cells[index] as number;
      if (paletteIndex === this.defaultTileIndex) {
        continue;
      }
      const tile = this.palette[paletteIndex];
      if (tile === undefined) {
        continue;
      }
      tiles.push({
        at: [index % this.width, Math.floor(index / this.width)],
        tile: tile.id,
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

    return {
      id: this.id,
      schemaVersion: WORLD_SCHEMA_VERSION,
      name: this.name,
      width: this.width,
      height: this.height,
      orientation: 'pointy',
      tileSetId: this.tileSetId,
      defaultTile: this.defaultTile.id,
      tiles,
      entities,
      locations,
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
