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
 *
 * A map is a *set of hexes*, not a rectangle: the `width x height` extent is
 * what the buffers cover, and a third dense buffer says which of those cells
 * the map actually has (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
 * Carving a hex deliberately leaves its paint, its elevation and its art choice
 * alone, so restoring it restores what was there.
 *
 * Per-cell **art choices** are the exception to that density: a cell that picks
 * its own surface or borrows another tile's cliff is an authored oddity, so
 * they live in a `Map` keyed by cell index rather than in three more buffers
 * that would be empty on every map anybody actually draws
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
 */

import {
  MapBounds,
  Offset,
  cellCount,
  fromIndex,
  indexIn,
  isWithin,
  mapBounds,
  maxCol,
  maxRow,
  minCol,
  minRow,
} from '../core/hex/hex-coords';
import {
  CellPresence,
  DEFAULT_CHARACTER_HEIGHT_TILES,
  EntityDefinition,
  GridStyle,
  LocationDefinition,
  MapLinkDefinition,
  MapShape,
  MAX_ELEVATION,
  MIN_ELEVATION,
  PlacedDecoration,
  PlacedTile,
  PlacedTileArt,
  ProjectionMode,
  RevealStyle,
  WORLD_SCHEMA_VERSION,
  WorldDefinition,
  WorldMetadata,
} from './generated/world';
import { DEFAULT_GRID_STYLE, DEFAULT_REVEAL_STYLE, isDefaultRevealStyle } from './world-defaults';
import { PixelOffset } from './generated/shared';
import { TileArt, TileArtGeometry, TileDefinition, TileSetDefinition } from './generated/tile-set';
import { tileArtGeometry } from './tile-set-geometry';

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
  /** The images this tile is drawn from; absent draws {@link fallbackColor}. */
  readonly art?: TileArt;
}

/**
 * What one cell chose to be drawn with, by id.
 *
 * Ids rather than indices, because that is what the file carries and what
 * survives a variant being inserted above another one. `null` is "roll it",
 * which is what every cell says until an author says otherwise.
 */
export interface DocumentCellArt {
  /** Id of a surface variant of the cell's own tile. */
  surface: string | null;
  /** Id of the tile whose elevation ladder cuts the faces. */
  elevationTile: string | null;
  /** Id of the elevation variant; `null` follows {@link surface}. */
  elevation: string | null;
}

/** Nothing chosen: the shape {@link WorldDocument.artAt} answers with. */
export const ROLLED_ART: DocumentCellArt = {
  surface: null,
  elevationTile: null,
  elevation: null,
};

/** An entity placed by the author. */
export interface DocumentEntity {
  id: string;
  templateId: string;
  at: Offset;
  tags: string[];
  properties: Record<string, unknown>;
}

/**
 * Conventional presentation-only entity property used by the map editor.
 *
 * It deliberately lives in the existing opaque property bag: simulation does
 * not read it, and Play resolves the player's appearance from character
 * creation instead.
 */
export const PREVIEW_CHARACTER_PROPERTY = 'previewCharacter';

/** Character definition selected for an entity's editor preview, if any. */
export function previewCharacterOf(entity: DocumentEntity): string | null {
  const value = entity.properties[PREVIEW_CHARACTER_PROPERTY];
  return typeof value === 'string' && value.length > 0 ? value : null;
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
 * `EngineService.validateLinks` (`docs/adr/ADR-0014-map-links.md`).
 */
export interface DocumentLink {
  id: string;
  at: Offset;
  targetWorld: string;
  targetAt: Offset;
  name: string;
  tags: string[];
}

/**
 * One decoration the author put on a cell.
 *
 * Several may share a hex — that is the point of a decoration — so unlike an
 * entity or a door this is never "the one at this cell"
 * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
 */
export interface DocumentDecoration {
  id: string;
  /** Id of the {@link DecorationDefinition} it is drawn from. */
  decoration: string;
  at: Offset;
  /**
   * Whole-pixel nudge from where the definition's anchor puts it.
   *
   * `[0, 0]` is exactly what the decoration editor authored; a few pixels off
   * is what keeps a row of the same fence post from reading as a stamp.
   */
  offset: PixelOffset;
  /** Whether a player may interact with **this** one. */
  interactive: boolean;
  tags: string[];
}

/**
 * Something authored that stands on a hex.
 *
 * Carving a cell out from under an entity, a point of interest or a door would
 * destroy authored content or leave it dangling in the void, so the document
 * refuses and hands back what is in the way for the editor to name
 * (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
 */
export interface CellOccupant {
  readonly kind: 'entity' | 'location' | 'link' | 'decoration';
  readonly id: string;
}

export interface WorldDocumentInit {
  id: string;
  name: string;
  width: number;
  height: number;
  /** North-west corner of the extent; defaults to `[0, 0]`. */
  origin?: Offset;
  /** `absent` starts the map as an empty canvas to draw an island on. */
  presence?: CellPresence;
  tileSet: TileSetDefinition;
  defaultTile?: string;
  projection?: ProjectionMode;
  characterHeightTiles?: number;
  grid?: GridStyle;
  /** How far relief may be seen through around the pointer. */
  reveal?: RevealStyle;
  /** Authoring zone; empty leaves the map unzoned. */
  zone?: string;
}

/** Thrown when a document cannot be built from the given content. */
export class WorldDocumentError extends Error {}

export class WorldDocument {
  private constructor(
    public id: string,
    public name: string,
    private extent: MapBounds,
    readonly tileSetId: string,
    /** The pixel grid the tile set's images are authored on. */
    readonly tileArt: TileArtGeometry,
    readonly palette: readonly DocumentTile[],
    private defaultTileIndex: number,
    private cells: Uint8Array,
    /** One elevation per cell, in the same layout as {@link cells}. */
    private elevations: Int8Array,
    /**
     * `1` where the map has a hex, `0` where it has a hole, same layout again.
     *
     * The buffer that makes the extent storage rather than shape
     * (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
     */
    private presenceFlags: Uint8Array,
    /** The cells that chose their art, keyed by their index in {@link cells}. */
    private artChoices: Map<number, DocumentCellArt>,
    private entities: DocumentEntity[],
    private locations: DocumentLocation[],
    private links: DocumentLink[],
    /** The trees, houses and chests standing on this map, in author order. */
    private decorations: DocumentDecoration[],
    public metadata: WorldMetadata,
    /** How the runtime and the editor render this world. */
    public projection: ProjectionMode,
    /** Projected tile-face heights occupied by a 128-pixel character. */
    public characterHeightTiles: number,
    /** Authored grid appearance shared by editor preview and gameplay. */
    public grid: GridStyle,
    /**
     * How far relief may be seen through when the pointer rests on a hex it
     * hides (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
     */
    public reveal: RevealStyle,
    /** Authoring zone; `''` means unzoned. Grouping only, never a rule. */
    public zone: string,
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
      throw new WorldDocumentError(
        `world dimensions must be positive, got ${init.width}x${init.height}`,
      );
    }

    const first = palette[0] as DocumentTile;
    const defaultTile = init.defaultTile ?? first.id;
    const defaultIndex = palette.findIndex((tile) => tile.id === defaultTile);
    if (defaultIndex < 0) {
      throw new WorldDocumentError(
        `default tile "${defaultTile}" is not in tile set "${init.tileSet.id}"`,
      );
    }

    const extent = mapBounds(init.width, init.height, init.origin ?? { col: 0, row: 0 });
    const size = cellCount(extent);
    const cells = new Uint8Array(size).fill(defaultIndex);
    return new WorldDocument(
      init.id,
      init.name,
      extent,
      init.tileSet.id,
      tileArtGeometry(init.tileSet),
      palette,
      defaultIndex,
      cells,
      new Int8Array(size),
      new Uint8Array(size).fill(init.presence === 'absent' ? 0 : 1),
      new Map(),
      [],
      [],
      [],
      [],
      {},
      init.projection ?? 'topDown',
      init.characterHeightTiles ?? DEFAULT_CHARACTER_HEIGHT_TILES,
      { ...DEFAULT_GRID_STYLE, ...(init.grid ?? {}) },
      { ...DEFAULT_REVEAL_STYLE, ...(init.reveal ?? {}) },
      init.zone ?? '',
    );
  }

  /** Rebuilds a document from an authored world file. */
  static fromDefinition(definition: WorldDefinition, tileSet: TileSetDefinition): WorldDocument {
    if (definition.tileSetId !== tileSet.id) {
      throw new WorldDocumentError(
        `world "${definition.id}" needs tile set "${definition.tileSetId}", got "${tileSet.id}"`,
      );
    }

    const shape = definition.shape ?? {};
    const document = WorldDocument.create({
      id: definition.id,
      name: definition.name ?? definition.id,
      width: definition.width,
      height: definition.height,
      origin:
        definition.origin === undefined
          ? { col: 0, row: 0 }
          : { col: definition.origin[0], row: definition.origin[1] },
      presence: shape.default ?? 'present',
      tileSet,
      defaultTile: definition.defaultTile,
      projection: definition.projection,
      characterHeightTiles: definition.characterHeightTiles,
      grid: definition.grid,
      reveal: definition.reveal,
      zone: definition.zone,
    });

    // The exceptions flip whatever the default filled in, exactly as
    // `WorldGrid::build` does on the Rust side. One outside the extent names no
    // cell; the validator is what reports it.
    for (const [col, row] of shape.exceptions ?? []) {
      const cell = indexIn({ col, row }, document.extent);
      if (cell >= 0) {
        document.presenceFlags[cell] = shape.default === 'absent' ? 1 : 0;
      }
    }

    for (const placed of definition.tiles ?? []) {
      const index = document.paletteIndexOf(placed.tile);
      if (index < 0) {
        throw new WorldDocumentError(
          `tile "${placed.tile}" is not defined by tile set "${tileSet.id}"`,
        );
      }
      const cell = indexIn({ col: placed.at[0], row: placed.at[1] }, document.extent);
      if (cell < 0) {
        throw new WorldDocumentError(
          `tile at [${placed.at[0]}, ${placed.at[1]}] is outside the ${definition.width}x${definition.height} extent`,
        );
      }
      document.cells[cell] = index;
      // Through `raise` rather than the buffer, so the elevation range tracks.
      document.raise({ col: placed.at[0], row: placed.at[1] }, placed.elevation ?? 0);
      const art = readCellArt(placed.art);
      if (art !== null) {
        document.artChoices.set(cell, art);
      }
    }

    document.entities = (definition.entities ?? []).map((entity) => ({
      id: entity.id,
      templateId: entity.templateId,
      at: { col: entity.at[0], row: entity.at[1] },
      tags: [...(entity.tags ?? [])],
      properties: { ...(entity.properties ?? {}) },
    }));
    document.locations = (definition.locations ?? []).map((location) => ({
      id: location.id,
      at: { col: location.at[0], row: location.at[1] },
      name: location.name ?? location.id,
      tags: [...(location.tags ?? [])],
    }));
    document.decorations = (definition.decorations ?? []).map((placed) => ({
      id: placed.id,
      decoration: placed.decoration,
      at: { col: placed.at[0], row: placed.at[1] },
      offset: [...(placed.offset ?? [0, 0])] as PixelOffset,
      interactive: placed.interactive === true,
      tags: [...(placed.tags ?? [])],
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

  // ------------------------------------------------------------------ shape

  /** The rectangle the packed buffers cover. Storage, not the world's shape. */
  get bounds(): MapBounds {
    return this.extent;
  }

  /** Extent width in columns. */
  get width(): number {
    return this.extent.width;
  }

  /** Extent height in rows. */
  get height(): number {
    return this.extent.height;
  }

  /** The packed presence flags; the renderer reads this directly. */
  get presence(): Uint8Array {
    return this.presenceFlags;
  }

  /** How many hexes the map actually has, as opposed to how many it stores. */
  get presentCellCount(): number {
    let count = 0;
    for (const flag of this.presenceFlags) {
      count += flag;
    }
    return count;
  }

  /** Whether the map has the hex at `cell`. */
  isPresent(cell: Offset): boolean {
    const index = indexIn(cell, this.bounds);
    return index >= 0 && this.presenceFlags[index] === 1;
  }

  /** Everything authored that stands on `cell`. */
  occupantsAt(cell: Offset): CellOccupant[] {
    const here = (at: Offset): boolean => at.col === cell.col && at.row === cell.row;
    return [
      ...this.entities.filter((entity) => here(entity.at)).map(entityOccupant),
      ...this.locations.filter((location) => here(location.at)).map(locationOccupant),
      ...this.links.filter((link) => here(link.at)).map(linkOccupant),
      ...this.decorations.filter((decoration) => here(decoration.at)).map(decorationOccupant),
    ];
  }

  /**
   * Adds a hex to the map, or carves one out of it.
   *
   * Carving refuses while anything stands on the cell: the author moves the
   * entity, the door or the point of interest first, rather than losing it
   * (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`). Paint, elevation and art
   * choices are deliberately left alone, so putting the hex back puts back what
   * was on it.
   *
   * @returns `true` when the map changed.
   */
  setPresent(cell: Offset, present: boolean): boolean {
    const index = indexIn(cell, this.bounds);
    if (index < 0 || this.presenceFlags[index] === (present ? 1 : 0)) {
      return false;
    }
    if (!present && this.occupantsAt(cell).length > 0) {
      return false;
    }
    this.presenceFlags[index] = present ? 1 : 0;
    return true;
  }

  /**
   * Everything authored that a new extent would leave outside the map.
   *
   * Empty means the trim is safe. Growing an extent never returns anything.
   */
  occupantsOutside(next: MapBounds): CellOccupant[] {
    const lost = (at: Offset): boolean => !isWithin(at, next);
    return [
      ...this.entities.filter((entity) => lost(entity.at)).map(entityOccupant),
      ...this.locations.filter((location) => lost(location.at)).map(locationOccupant),
      ...this.links.filter((link) => lost(link.at)).map(linkOccupant),
      ...this.decorations.filter((decoration) => lost(decoration.at)).map(decorationOccupant),
    ];
  }

  /**
   * How many hexes the map has that a new extent would leave outside it.
   *
   * `0` means the trim only discards empty canvas. Growing never returns
   * anything.
   */
  presentOutside(next: MapBounds): number {
    let lost = 0;
    for (let index = 0; index < this.presenceFlags.length; index += 1) {
      if (this.presenceFlags[index] === 1 && !isWithin(fromIndex(index, this.bounds), next)) {
        lost += 1;
      }
    }
    return lost;
  }

  /**
   * Moves and resizes the extent, keeping every cell that both extents cover.
   *
   * Cells the new extent adds arrive absent, so extending a map gives an author
   * blank canvas to draw on rather than a slab of terrain nobody asked for.
   * Refuses a trim that would strand authored content — {@link occupantsOutside}
   * is what names it.
   *
   * @returns `true` when the extent changed.
   */
  resize(next: MapBounds): boolean {
    if (next.width <= 0 || next.height <= 0) {
      return false;
    }
    const previous = this.extent;
    if (
      next.width === previous.width &&
      next.height === previous.height &&
      next.origin.col === previous.origin.col &&
      next.origin.row === previous.origin.row
    ) {
      return false;
    }
    // Trimming discards buffer, and a hex the map has is not buffer: an author
    // carves it first, so the extent never quietly eats the island
    // (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
    if (this.occupantsOutside(next).length > 0 || this.presentOutside(next) > 0) {
      return false;
    }

    const size = cellCount(next);
    const cells = new Uint8Array(size).fill(this.defaultTileIndex);
    const elevations = new Int8Array(size);
    const presence = new Uint8Array(size);
    const artChoices = new Map<number, DocumentCellArt>();

    // Copied cell by cell over the overlap rather than row-slice by row-slice:
    // the two extents may differ in both origin and width, so no run of the old
    // buffer lines up with a run of the new one.
    for (
      let row = Math.max(minRow(previous), minRow(next));
      row <= Math.min(maxRow(previous), maxRow(next));
      row += 1
    ) {
      for (
        let col = Math.max(minCol(previous), minCol(next));
        col <= Math.min(maxCol(previous), maxCol(next));
        col += 1
      ) {
        const from = indexIn({ col, row }, previous);
        const to = indexIn({ col, row }, next);
        cells[to] = this.cells[from] as number;
        elevations[to] = this.elevations[from] as number;
        presence[to] = this.presenceFlags[from] as number;
        const art = this.artChoices.get(from);
        if (art !== undefined) {
          artChoices.set(to, art);
        }
      }
    }

    this.extent = next;
    this.cells = cells;
    this.elevations = elevations;
    this.presenceFlags = presence;
    this.artChoices = artChoices;
    return true;
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

  /** Changes how both editor preview and gameplay draw the grid. */
  setGridStyle(patch: Partial<GridStyle>): boolean {
    const next = { ...this.grid, ...patch };
    if (
      next.lineWidth === this.grid.lineWidth &&
      next.color === this.grid.color &&
      next.alpha === this.grid.alpha
    ) {
      return false;
    }
    this.grid = next;
    return true;
  }

  /** Authored elevation at a cell, or `0` when out of bounds. */
  elevationAt(cell: Offset): number {
    const index = indexIn(cell, this.bounds);
    return index < 0 ? 0 : (this.elevations[index] ?? 0);
  }

  /**
   * Raises (or lowers) a cell by `delta` steps, clamped to the schema range.
   *
   * @returns `true` when the cell changed.
   */
  raise(cell: Offset, delta: number): boolean {
    const index = indexIn(cell, this.bounds);
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
    const index = indexIn(cell, this.bounds);
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
    const index = indexIn(cell, this.bounds);
    const paletteIndex = this.paletteIndexOf(tileId);
    if (index < 0 || paletteIndex < 0 || this.cells[index] === paletteIndex) {
      return false;
    }
    this.cells[index] = paletteIndex;
    // A hand-picked surface belongs to the tile that was there: `grass_f` means
    // nothing on sand. Painting over a cell therefore drops its choice and puts
    // it back on the roll, which is also what the author almost always wants
    // (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
    this.artChoices.delete(index);
    return true;
  }

  // -------------------------------------------------------------- cell art

  /** Every cell that chose its art, keyed by its index in the packed buffer. */
  get artOverrides(): ReadonlyMap<number, DocumentCellArt> {
    return this.artChoices;
  }

  /** What a cell chose, or {@link ROLLED_ART} when it chose nothing. */
  artAt(cell: Offset): DocumentCellArt {
    const index = indexIn(cell, this.bounds);
    return (index < 0 ? undefined : this.artChoices.get(index)) ?? ROLLED_ART;
  }

  /**
   * Sets what a cell is drawn with. `null` on a field puts it back on the roll.
   *
   * Nothing here checks that the ids exist: the tile set is the authority on
   * that and the Rust validator is the one that says so, exactly as with a
   * door's target (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
   *
   * @returns `true` when the cell changed.
   */
  setArt(cell: Offset, patch: Partial<DocumentCellArt>): boolean {
    const index = indexIn(cell, this.bounds);
    if (index < 0) {
      return false;
    }
    const before = this.artChoices.get(index) ?? ROLLED_ART;
    const after: DocumentCellArt = {
      surface: patch.surface === undefined ? before.surface : patch.surface,
      elevationTile: patch.elevationTile === undefined ? before.elevationTile : patch.elevationTile,
      elevation: patch.elevation === undefined ? before.elevation : patch.elevation,
    };
    if (
      after.surface === before.surface &&
      after.elevationTile === before.elevationTile &&
      after.elevation === before.elevation
    ) {
      return false;
    }
    // A cell that chose nothing is not an entry: an empty record would be
    // written to the file and read as an authored decision.
    if (after.surface === null && after.elevationTile === null && after.elevation === null) {
      this.artChoices.delete(index);
    } else {
      this.artChoices.set(index, after);
    }
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
    return (
      this.entities.find((entity) => entity.at.col === cell.col && entity.at.row === cell.row) ??
      null
    );
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
  placeEntity(
    cell: Offset,
    templateId: string,
    singleton: boolean,
    previewCharacter: string | null = null,
  ): DocumentEntity | null {
    if (indexIn(cell, this.bounds) < 0) {
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
      properties:
        previewCharacter === null ? {} : { [PREVIEW_CHARACTER_PROPERTY]: previewCharacter },
    };
    this.entities.push(entity);
    return entity;
  }

  /** Chooses the character drawn for one entity in the map editor only. */
  setEntityPreviewCharacter(id: string, character: string | null): boolean {
    const entity = this.entities.find((candidate) => candidate.id === id);
    if (entity === undefined || previewCharacterOf(entity) === character) {
      return false;
    }

    if (character === null) {
      delete entity.properties[PREVIEW_CHARACTER_PROPERTY];
    } else {
      entity.properties[PREVIEW_CHARACTER_PROPERTY] = character;
    }
    return true;
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

  // ------------------------------------------------------------ decorations

  /** Every decoration standing on this map, in author order. */
  get placedDecorations(): readonly DocumentDecoration[] {
    return this.decorations;
  }

  /** The decorations standing on a cell, in author order; several may. */
  decorationsAt(cell: Offset): DocumentDecoration[] {
    return this.decorations.filter(
      (decoration) => decoration.at.col === cell.col && decoration.at.row === cell.row,
    );
  }

  /**
   * Puts a decoration drawn from `definitionId` on `cell`.
   *
   * Unlike an entity or a door, this **appends**: a cell may hold a tree, a
   * bush and a signpost, and author order is what settles which is drawn over
   * which (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   *
   * The new placement is not interactive. Whether a player may open *this*
   * chest is a decision the author makes afterwards, in the inspector
   * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   *
   * @returns the placement, or `null` when the cell is out of bounds.
   */
  placeDecoration(cell: Offset, definitionId: string): DocumentDecoration | null {
    if (indexIn(cell, this.bounds) < 0 || definitionId.length === 0) {
      return null;
    }
    const placed: DocumentDecoration = {
      id: this.nextId(this.decorations, definitionId),
      decoration: definitionId,
      at: { col: cell.col, row: cell.row },
      offset: [0, 0],
      interactive: false,
      tags: [],
    };
    this.decorations.push(placed);
    return placed;
  }

  /**
   * Renames one placement.
   *
   * The id is what a scenario addresses, so an author has to be able to write
   * it — `chest_with_the_letter` rather than `chest_3`
   * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   *
   * Refused rather than allowed-and-reported when the name is empty or already
   * taken: a duplicate id is not a state worth passing through, because while
   * it lasts two placements answer to one name.
   *
   * @returns `false` when nothing was renamed.
   */
  renameDecoration(id: string, nextId: string): boolean {
    const next = nextId.trim();
    const placed = this.decorations.find((candidate) => candidate.id === id);
    if (placed === undefined || next.length === 0 || next === id) {
      return false;
    }
    if (this.decorations.some((candidate) => candidate.id === next)) {
      return false;
    }
    placed.id = next;
    return true;
  }

  /** Applies an edit to one placement, by its id. */
  updateDecoration(id: string, patch: Partial<Omit<DocumentDecoration, 'id' | 'at'>>): boolean {
    const placed = this.decorations.find((candidate) => candidate.id === id);
    if (placed === undefined) {
      return false;
    }
    Object.assign(placed, patch);
    return true;
  }

  /** Removes one placement by its id. */
  removeDecoration(id: string): boolean {
    const before = this.decorations.length;
    this.decorations = this.decorations.filter((decoration) => decoration.id !== id);
    return this.decorations.length !== before;
  }

  /**
   * Removes the decoration drawn **last** on `cell`.
   *
   * The one on top, which is the one an author clicking the eraser sees.
   */
  removeTopDecorationAt(cell: Offset): boolean {
    for (let index = this.decorations.length - 1; index >= 0; index -= 1) {
      const placed = this.decorations[index] as DocumentDecoration;
      if (placed.at.col === cell.col && placed.at.row === cell.row) {
        this.decorations.splice(index, 1);
        return true;
      }
    }
    return false;
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
    if (indexIn(cell, this.bounds) < 0) {
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
      const art = writeCellArt(this.artChoices.get(index));
      if (paletteIndex === this.defaultTileIndex && elevation === 0 && art === null) {
        continue;
      }
      const tile = this.palette[paletteIndex];
      if (tile === undefined) {
        continue;
      }
      const at = fromIndex(index, this.bounds);
      tiles.push({
        at: [at.col, at.row],
        tile: tile.id,
        ...(elevation === 0 ? {} : { elevation }),
        ...(art === null ? {} : { art }),
      });
    }

    const entities: EntityDefinition[] = this.entities.map((entity) => ({
      id: entity.id,
      templateId: entity.templateId,
      at: [entity.at.col, entity.at.row],
      ...(entity.tags.length > 0 ? { tags: [...entity.tags] } : {}),
      ...(Object.keys(entity.properties).length > 0
        ? { properties: { ...entity.properties } }
        : {}),
    }));

    const locations: LocationDefinition[] = this.locations.map((location) => ({
      id: location.id,
      at: [location.at.col, location.at.row],
      name: location.name,
      ...(location.tags.length > 0 ? { tags: [...location.tags] } : {}),
    }));

    const decorations: PlacedDecoration[] = this.decorations.map((placed) => ({
      id: placed.id,
      decoration: placed.decoration,
      at: [placed.at.col, placed.at.row],
      ...(placed.offset[0] === 0 && placed.offset[1] === 0
        ? {}
        : { offset: [...placed.offset] as PixelOffset }),
      ...(placed.interactive ? { interactive: true } : {}),
      ...(placed.tags.length > 0 ? { tags: [...placed.tags] } : {}),
    }));

    const links: MapLinkDefinition[] = this.links.map((link) => ({
      id: link.id,
      at: [link.at.col, link.at.row],
      targetWorld: link.targetWorld,
      targetAt: [link.targetAt.col, link.targetAt.row],
      ...(link.name.length > 0 ? { name: link.name } : {}),
      ...(link.tags.length > 0 ? { tags: [...link.tags] } : {}),
    }));

    const shape = this.writeShape();

    return {
      id: this.id,
      schemaVersion: WORLD_SCHEMA_VERSION,
      name: this.name,
      // Omitted when unzoned, so a map that never had a zone is re-exported
      // exactly as it was authored.
      ...(this.zone.length > 0 ? { zone: this.zone } : {}),
      // Omitted at [0, 0], so a map that was never extended is re-exported
      // exactly as it was authored.
      ...(this.extent.origin.col === 0 && this.extent.origin.row === 0
        ? {}
        : { origin: [this.extent.origin.col, this.extent.origin.row] as [number, number] }),
      width: this.width,
      height: this.height,
      ...(shape === null ? {} : { shape }),
      orientation: 'pointy',
      projection: this.projection,
      ...(this.characterHeightTiles === DEFAULT_CHARACTER_HEIGHT_TILES
        ? {}
        : { characterHeightTiles: this.characterHeightTiles }),
      ...(sameGridStyle(this.grid, DEFAULT_GRID_STYLE) ? {} : { grid: { ...this.grid } }),
      ...(isDefaultRevealStyle(this.reveal) ? {} : { reveal: { ...this.reveal } }),
      tileSetId: this.tileSetId,
      defaultTile: this.defaultTile.id,
      tiles,
      entities,
      decorations,
      locations,
      links,
      metadata: { ...this.metadata, updatedAt: now().toISOString() },
    };
  }

  /**
   * The shape block, written whichever way round is shorter — or `null` when
   * the map is the full rectangle and the file may leave it out.
   *
   * A carved coastline lists its holes; an archipelago drawn on an empty canvas
   * lists its hexes. Picking the shorter list is what keeps both cheap
   * (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
   */
  private writeShape(): MapShape | null {
    const present: [number, number][] = [];
    const absent: [number, number][] = [];
    for (let index = 0; index < this.presenceFlags.length; index += 1) {
      const at = fromIndex(index, this.bounds);
      (this.presenceFlags[index] === 1 ? present : absent).push([at.col, at.row]);
    }

    if (absent.length === 0) {
      return null;
    }
    return absent.length <= present.length
      ? { exceptions: absent }
      : { default: 'absent', exceptions: present };
  }

  /**
   * A count of each tile currently painted, for the editor's status bar.
   *
   * Holes are skipped: paint under a hole is kept, but it is not part of the
   * map an author is looking at.
   */
  tileHistogram(): Map<string, number> {
    const counts = new Map<string, number>();
    for (let index = 0; index < this.cells.length; index += 1) {
      if (this.presenceFlags[index] !== 1) {
        continue;
      }
      const tile = this.palette[this.cells[index] as number];
      if (tile !== undefined) {
        counts.set(tile.id, (counts.get(tile.id) ?? 0) + 1);
      }
    }
    return counts;
  }
}

const entityOccupant = (entity: DocumentEntity): CellOccupant => ({
  kind: 'entity',
  id: entity.id,
});
const locationOccupant = (location: DocumentLocation): CellOccupant => ({
  kind: 'location',
  id: location.id,
});
const linkOccupant = (link: DocumentLink): CellOccupant => ({ kind: 'link', id: link.id });

const decorationOccupant = (decoration: DocumentDecoration): CellOccupant => ({
  kind: 'decoration',
  id: decoration.id,
});

function sameGridStyle(left: GridStyle, right: Readonly<GridStyle>): boolean {
  return (
    left.lineWidth === right.lineWidth && left.color === right.color && left.alpha === right.alpha
  );
}

/** A file's `art` block as the document holds it, or `null` when it chose nothing. */
function readCellArt(art: PlacedTileArt | undefined): DocumentCellArt | null {
  const surface = art?.surface ?? '';
  const elevationTile = art?.elevationTile ?? '';
  const elevation = art?.elevation ?? '';
  if (surface.length === 0 && elevationTile.length === 0 && elevation.length === 0) {
    return null;
  }
  return {
    surface: surface.length === 0 ? null : surface,
    elevationTile: elevationTile.length === 0 ? null : elevationTile,
    elevation: elevation.length === 0 ? null : elevation,
  };
}

/**
 * The document's choice as the file writes it, or `null` when there is nothing
 * to write.
 *
 * Fields left on the roll are **omitted**, not written as empty strings, so a
 * cell that only picks its surface produces `{ "surface": "f" }` and a map that
 * picks nothing gains no `art` keys at all.
 */
function writeCellArt(art: DocumentCellArt | undefined): PlacedTileArt | null {
  if (art === undefined) {
    return null;
  }
  const written: PlacedTileArt = {
    ...(art.surface === null ? {} : { surface: art.surface }),
    ...(art.elevationTile === null ? {} : { elevationTile: art.elevationTile }),
    ...(art.elevation === null ? {} : { elevation: art.elevation }),
  };
  return Object.keys(written).length === 0 ? null : written;
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
    art: tile.art,
  }));
}
