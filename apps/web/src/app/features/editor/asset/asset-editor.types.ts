/**
 * The vocabulary of the asset editor, kept out of the component.
 *
 * Same split as `character-editor.types.ts`: pure data and pure functions here,
 * signals and the DOM there. Everything in this file is testable without
 * Angular, and the component is thinner for it.
 *
 * The editor is an **asset** editor, not a tile editor. Tiles are the first
 * kind it can open; the browser's categories, the routing and the naming are
 * all shaped so that objects, decorations and effects are another entry rather
 * than another screen
 * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
 */

import {
  ElevationLevel,
  ElevationRepeat,
  TileArt,
  TileArtVariant,
  TileDefinition,
  TileSetDefinition,
} from '../../../../content/content-types';

/** A family of assets the editor can browse. */
export interface AssetCategory {
  /** Stable id, also the browser's selection value. */
  readonly id: string;
  /** Key of the label. */
  readonly titleKey: string;
  /** Whether this build can open it. */
  readonly status: 'available' | 'planned';
}

/**
 * What the browser lists.
 *
 * Only `tiles` opens today. The rest are declared rather than hidden, for the
 * reason the editor shell declares its planned modules: the browser is the map
 * of what the tool will hold (`docs/adr/ADR-0019-editor-modules.md`).
 */
export const ASSET_CATEGORIES: readonly AssetCategory[] = [
  { id: 'tiles', titleKey: 'ui.editor.asset.categories.tiles', status: 'available' },
  { id: 'characters', titleKey: 'ui.editor.asset.categories.characters', status: 'planned' },
  { id: 'objects', titleKey: 'ui.editor.asset.categories.objects', status: 'planned' },
  { id: 'decorations', titleKey: 'ui.editor.asset.categories.decorations', status: 'planned' },
  { id: 'effects', titleKey: 'ui.editor.asset.categories.effects', status: 'planned' },
];

/** Which panel of the tile editor is open. */
export type TileEditorTab = 'definition' | 'surface' | 'elevation' | 'geometry';

/** The tabs, in the order they are shown. */
export const TILE_EDITOR_TABS: readonly TileEditorTab[] = [
  'definition',
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
  /** `-1` for a surface variant, otherwise the 1-based elevation level. */
  readonly level: number;
  /** Index of the variant within its surface or level. */
  readonly variant: number;
}

/** The surface's pseudo-level, so one target type covers both lists. */
export const SURFACE_LEVEL = -1;

/** `true` when two targets point at the same image. */
export function sameTarget(left: ImageTarget | null, right: ImageTarget | null): boolean {
  return left !== null && right !== null && left.level === right.level && left.variant === right.variant;
}

/** The variants of a target's list, or an empty list when it has none. */
export function variantsOf(tile: TileDefinition, level: number): readonly TileArtVariant[] {
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
  if ((art.surface?.length ?? 0) === 0) {
    delete art.surface;
  }
  if (art.surface === undefined && art.elevation === undefined) {
    delete tile.art;
  }
}

/**
 * An id derived from `name` that no member of `taken` already uses.
 *
 * Ids are stable and names are not: renaming a tile must never repoint a map
 * (`docs/adr/ADR-0009-assets-tilesets.md`), so this is only ever used to
 * *propose* one when something is created.
 */
export function freeId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'tile';
  if (!used.has(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
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
 * One directory per tile, its surfaces together and its elevation levels each
 * in their own folder, so a listing reads as the ladder it is:
 *
 * ```text
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
  const folder =
    level === SURFACE_LEVEL ? 'surfaces' : `elevation/level_${level}`;
  return `assets/tiles/${tileId}/${folder}/${tileId}_${variantId}.png`;
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
