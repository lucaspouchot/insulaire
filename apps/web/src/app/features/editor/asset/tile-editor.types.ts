/**
 * The vocabulary of the **tile** workspace, kept out of the component.
 *
 * Same split as `character-editor.types.ts` next door: pure data and pure
 * functions here, signals and the DOM there. Everything in this file is
 * testable without Angular, and the component is thinner for it.
 *
 * Tiles are one category of the asset editor
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`); what a tile *is*
 * and how its art resolves by level is
 * `docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`.
 */

import {
  ElevationLevel,
  ElevationRepeat,
  TileArt,
  TileArtGeometry,
  TileArtVariant,
  TileDefinition,
  TileSetDefinition,
} from '../../../../content/generated/tile-set';
import { bandLevels } from '../../../../content/tile-set-geometry';

/** Which panel of the tile editor is open. */
export type TileEditorTab = 'definition' | 'flat' | 'surface' | 'elevation' | 'geometry';

/** The tabs, in the order they are shown. */
export const TILE_EDITOR_TABS: readonly TileEditorTab[] = [
  'definition',
  'flat',
  'surface',
  'elevation',
  'geometry',
];

/** Which rule draws the levels above the last explicit one. */
export type RepeatMode = 'last' | 'level' | 'pattern';

/** The mode a stored repeat rule is in. */
export function repeatModeOf(repeat: ElevationRepeat | null | undefined): RepeatMode {
  if (repeat === null || repeat === undefined) {
    return 'last';
  }
  return 'pattern' in repeat ? 'pattern' : 'level';
}

/** What the editor opens in the pixel tools: one image of one tile. */
export interface ImageTarget {
  /**
   * {@link SURFACE_LEVEL}, {@link FLAT_LEVEL}, or the 1-based elevation level.
   */
  readonly level: number;
  /** Index of the variant within its own list. */
  readonly variant: number;
}

/** The surface's pseudo-level, so one target type covers every list. */
export const SURFACE_LEVEL = -1;

/**
 * The flat view's pseudo-level.
 *
 * A flat image belongs to no level: a top-down world draws one image per cell
 * and no relief at all
 * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`). It gets a
 * pseudo-level for the same reason the surface has one — so a target is two
 * numbers rather than a tagged union.
 */
export const FLAT_LEVEL = -2;

/** `true` when two targets point at the same image. */
export function sameTarget(left: ImageTarget | null, right: ImageTarget | null): boolean {
  return (
    left !== null && right !== null && left.level === right.level && left.variant === right.variant
  );
}

/** The variants of a target's list, or an empty list when it has none. */
export function variantsOf(tile: TileDefinition, level: number): readonly TileArtVariant[] {
  if (level === FLAT_LEVEL) {
    return tile.art?.flat ?? [];
  }
  if (level === SURFACE_LEVEL) {
    return tile.art?.surface ?? [];
  }
  return tile.art?.elevation?.levels[level - 1]?.variants ?? [];
}

/** The variant a target points at, if it is still there. */
export function variantAt(tile: TileDefinition, target: ImageTarget | null): TileArtVariant | null {
  if (target === null) {
    return null;
  }
  return variantsOf(tile, target.level)[target.variant] ?? null;
}

/** A tile's art, filled in so callers may write to it. */
export function artOf(tile: TileDefinition): Required<Omit<TileArt, 'elevation'>> & {
  elevation: { levels: ElevationLevel[]; repeat?: ElevationRepeat | null };
} {
  tile.art ??= {};
  tile.art.flat ??= [];
  tile.art.surface ??= [];
  tile.art.elevation ??= { levels: [] };
  tile.art.elevation.levels ??= [];
  return tile.art as never;
}

/** Drops `art` back to `undefined` when nothing is left in it. */
export function pruneArt(tile: TileDefinition): void {
  const art = tile.art;
  if (art === undefined) {
    return;
  }
  if ((art.elevation?.levels?.length ?? 0) === 0 && (art.elevation?.repeat ?? null) === null) {
    delete art.elevation;
  }
  if ((art.flat?.length ?? 0) === 0) {
    delete art.flat;
  }
  if ((art.surface?.length ?? 0) === 0) {
    delete art.surface;
  }
  if (art.flat === undefined && art.surface === undefined && art.elevation === undefined) {
    delete tile.art;
  }
}

/** `true` when `id` is one a content file may carry. */
export function isUsableId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(id);
}

/** A new tile, drawn as a flat colour until it is given art. */
export function blankTile(id: string, name: string): TileDefinition {
  return {
    id,
    name,
    terrain: id,
    movementCost: 1,
    tags: [],
    visual: { visualId: `terrain.${id}`, fallbackColor: '#4a7c3f' },
  };
}

/** A copy of `tile` under a new id and name, art references included. */
export function duplicateTile(tile: TileDefinition, id: string, name: string): TileDefinition {
  return {
    ...structuredClone(tile),
    id,
    name,
    visual: { ...tile.visual, visualId: `terrain.${id}` },
  };
}

/**
 * Where a tile's images are written: a convention, not a rule.
 *
 * One directory per tile: its flat images together, its surfaces together, and
 * its elevation levels each in their own folder, so a listing reads as the
 * ladder it is:
 *
 * ```text
 *   assets/tiles/dirt/flat/dirt_a.png
 *   assets/tiles/dirt/surfaces/dirt_a.png
 *   assets/tiles/dirt/elevation/level_1/dirt_a.png
 *   assets/tiles/dirt/elevation/level_2/dirt_a.png
 * ```
 *
 * Nothing reads the path back — a variant's `asset` is whatever the file says,
 * and an imported image keeps its own name. This is only what the editor
 * *proposes* when it makes a new image.
 */
export function imagePath(tileId: string, level: number, variantId: string): string {
  const folder = folderFor(level);
  return `assets/tiles/${tileId}/${folder}/${tileId}_${variantId}.png`;
}

function folderFor(level: number): string {
  if (level === FLAT_LEVEL) {
    return 'flat';
  }
  return level === SURFACE_LEVEL ? 'surfaces' : `elevation/level_${level}`;
}

/** `a`, `b`, … `z`, then `aa`: the variant ids the editor proposes. */
export function variantLetter(index: number): string {
  let id = '';
  let n = index;
  do {
    id = String.fromCharCode(97 + (n % 26)) + id;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return id;
}

/** The tiles of `set` matching a search box's text, in author order. */
export function matching(set: TileSetDefinition | null, search: string): readonly TileDefinition[] {
  const needle = search.trim().toLowerCase();
  const tiles = set?.tiles ?? [];
  if (needle.length === 0) {
    return tiles;
  }
  return tiles.filter((tile) =>
    [tile.id, tile.name ?? '', tile.terrain, ...(tile.tags ?? [])]
      .join(' ')
      .toLowerCase()
      .includes(needle),
  );
}

/**
 * The list of variants a pseudo-level or an elevation level names.
 *
 * Takes the *filled* art {@link artOf} returns, because a caller adding a
 * variant needs a list to push into and an absent one is not that.
 */
export function listFor(
  art: ReturnType<typeof artOf>,
  level: number,
): TileArtVariant[] | undefined {
  if (level === FLAT_LEVEL) {
    return art.flat;
  }
  return level === SURFACE_LEVEL ? art.surface : art.elevation.levels[level - 1]?.variants;
}

/**
 * `true` when a tile already has the list this level names.
 *
 * Asked before a variant is added, so that adding one to a level nobody
 * declared is refused rather than filling `art` in on the way past: the two
 * pseudo-levels always exist, an elevation level only once it is declared.
 */
export function hasLevel(tile: TileDefinition, level: number): boolean {
  if (level === FLAT_LEVEL || level === SURFACE_LEVEL) {
    return true;
  }
  return level >= 1 && level <= (tile.art?.elevation?.levels.length ?? 0);
}

/** How tall an image of this level is, on the set's own grid. */
export function imageHeight(geometry: TileArtGeometry, level: number): number {
  if (level === FLAT_LEVEL) {
    return geometry.flatHeight;
  }
  return level === SURFACE_LEVEL ? geometry.surfaceHeight : geometry.elevationHeight;
}

/**
 * Where the band drawing `level` sits on a preview cell of this height.
 *
 * In steps under the top face, the same number `resolveTileRender` gives the
 * renderer: a band spans `bandLevels` levels, so level `n` starts `n` bands
 * above the cell's foot. Negative once the band overshoots the top face, which
 * is drawn last and covers it — the pixels stay clickable either way, because
 * the box the pointer is measured against is this same number.
 */
export function dropOf(elevation: number, level: number, geometry: TileArtGeometry): number {
  return level >= 1 ? elevation - level * bandLevels(geometry) : 0;
}

/**
 * The image level a panel edits, or `null` for the ones that edit no image.
 *
 * `elevation` opens level 1: the ladder's first rung is the one every raised
 * cell shows, whatever its height.
 */
export function levelOfTab(tab: TileEditorTab): number | null {
  if (tab === 'flat') {
    return FLAT_LEVEL;
  }
  if (tab === 'surface') {
    return SURFACE_LEVEL;
  }
  return tab === 'elevation' ? 1 : null;
}

/**
 * Every image a set names, once each, in the order its tiles name them.
 *
 * What the editing session asks when it wants to know which painted buffers
 * belong to *this* set — which is half of what makes a draft dirty
 * (`app/editing/draft-source.ts`). Deduplicated because two tiles are allowed
 * to point at one file, and it would otherwise be written twice.
 */
export function assetsOf(set: TileSetDefinition): readonly string[] {
  const assets = new Set<string>();
  for (const tile of set.tiles) {
    for (const level of [FLAT_LEVEL, SURFACE_LEVEL]) {
      for (const variant of variantsOf(tile, level)) {
        assets.add(variant.asset);
      }
    }
    for (const level of tile.art?.elevation?.levels ?? []) {
      for (const variant of level.variants ?? []) {
        assets.add(variant.asset);
      }
    }
  }
  return [...assets];
}
