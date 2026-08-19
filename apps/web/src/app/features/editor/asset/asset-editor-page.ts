/**
 * The asset editor.
 *
 * It edits the **resources a world is drawn from**. Tiles are the first kind it
 * can open — a browser on the left, a preview and the pixel tools in the
 * middle, the definition on the right — and the shape is deliberately not a
 * tile screen: a category is a row in {@link ASSET_CATEGORIES}, and objects,
 * decorations and effects arrive as entries rather than as new pages
 * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
 *
 * Three things this screen is careful about.
 *
 * **The preview is not a mock-up.** It draws with `HexLayout`, `Projection` and
 * the same resolver the map renderer uses, so a tile that looks right here
 * looks right on a map (`docs/adr/ADR-0014-hex-coordinate-model.md`,
 * `docs/adr/ADR-0016-isometric-projection.md`).
 *
 * **There is one copy of every image.** The pixel editor writes into a
 * {@link SpriteDocument}, and the preview draws from that same buffer — so a
 * stroke shows up in the hexagon as it is painted, with no round trip through
 * a file (`docs/adr/ADR-0030-the-editor-paints-its-sprites.md`).
 *
 * **A tile edited here is a tile the map editor has.** Saving replaces the
 * loaded tile set and rebuilds the open maps, so the palette next door grows
 * the moment this screen writes (`docs/adr/ADR-0009-assets-tilesets.md`).
 *
 * Labels are keys, like everywhere else
 * (`docs/adr/ADR-0023-localised-content-keys.md`).
 */

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import {
  ElevationRepeat,
  MAX_ELEVATION_LEVELS,
  MAX_TILE_IMAGE_SIZE,
  MAX_TILE_VARIANTS,
  TILE_SET_SCHEMA_VERSION,
  TileArtGeometry,
  TileDefinition,
  TileSetDefinition,
  tileArtGeometry,
  faceHeight,
  shoulderDepth,
} from '../../../../content/content-types';
import { SpriteDocument } from '../../../../content/sprite-document';
import { serializeTileSet } from '../../../../content/tile-set-serializer';
import { ValidationReport } from '../../../../engine/engine.types';
import { SpriteCache, SpriteSource } from '../../../../renderer/character-renderer';
import { PreviewCell, drawPreview, fitPreview } from '../../../../renderer/tile-preview';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import { ContentWorkspaceService } from '../../../services/content-workspace.service';
import { EngineService } from '../../../services/engine.service';
import { CONTENT_ROOT, ProjectStoreService, contentUrl } from '../../../services/project-store.service';
import {
  ASSET_CATEGORIES,
  ImageTarget,
  RepeatMode,
  SURFACE_LEVEL,
  TILE_EDITOR_TABS,
  TileEditorTab,
  artOf,
  blankTile,
  duplicateTile,
  freeId,
  imagePath,
  isUsableId,
  variantLetter,
  matching,
  pruneArt,
  repeatModeOf,
  sameTarget,
  variantAt,
  variantsOf,
} from './asset-editor.types';
import { TilePixelEditor } from './tile-pixel-editor';

/** The board the multi-tile preview lays out, in offset coordinates. */
const BOARD_WIDTH = 3;
const BOARD_HEIGHT = 3;

/** Highest elevation the preview will step to; enough to prove a repeat rule. */
const MAX_PREVIEW_ELEVATION = 24;

@Component({
  selector: 'app-asset-editor-page',
  imports: [TranslatePipe, TilePixelEditor],
  templateUrl: './asset-editor-page.html',
  styleUrl: './asset-editor-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssetEditorPage implements AfterViewInit, OnDestroy {
  private readonly store = inject(ProjectStoreService);
  private readonly workspace = inject(ContentWorkspaceService);
  private readonly engine = inject(EngineService);

  private readonly previewRef = viewChild<ElementRef<HTMLCanvasElement>>('preview');

  protected readonly categories = ASSET_CATEGORIES;
  protected readonly tabs = TILE_EDITOR_TABS;
  protected readonly maxLevels = MAX_ELEVATION_LEVELS;
  protected readonly maxVariants = MAX_TILE_VARIANTS;
  protected readonly maxImageSize = MAX_TILE_IMAGE_SIZE;
  protected readonly contentRoot = CONTENT_ROOT;

  protected readonly category = signal('tiles');
  protected readonly tab = signal<TileEditorTab>('definition');
  protected readonly search = signal('');
  protected readonly tileSetId = signal<string | null>(null);
  protected readonly selectedTileId = signal<string | null>(null);
  protected readonly previewElevation = signal(2);
  protected readonly previewBoard = signal(false);
  protected readonly openImage = signal<ImageTarget | null>(null);
  protected readonly status = signal<string | null>(null);
  protected readonly failure = signal<string | null>(null);
  protected readonly dirty = signal(false);
  /** Bumped by every edit, so the computeds above re-read the working copy. */
  protected readonly revision = signal(0);

  /** The working copies, by tile set id: what this screen is editing. */
  private readonly working = new Map<string, TileSetDefinition>();
  /** The buffers the pixel editor writes into, by asset path. */
  private readonly sessions = new Map<string, SpriteDocument>();
  /** Files loaded from the content directory, for everything not being edited. */
  private readonly cache = new SpriteCache(
    (asset) => contentUrl(asset),
    () => this.schedulePreview(),
  );
  private frame = 0;

  /**
   * What the preview draws with: the session buffer where there is one.
   *
   * The single most important line on this screen. Without it the hexagon shows
   * the file while the pencil edits the buffer, and the author is looking at
   * the previous version of their own stroke (ADR-0030).
   */
  private readonly source: SpriteSource = {
    image: (asset: string) => this.sessions.get(asset)?.surface() ?? this.cache.image(asset),
  };

  constructor() {
    void this.store.ensureLoaded().then(() => {
      this.tileSetId.set(this.store.tileSetDefinitions()[0]?.id ?? null);
      this.selectedTileId.set(this.tileSet()?.tiles[0]?.id ?? null);
      this.revision.update((value) => value + 1);
    });
    void this.workspace.ensureProbed().catch(() => undefined);

    effect(() => {
      // Everything the preview reads, so a change to any of it repaints.
      this.revision();
      this.selectedTileId();
      this.previewElevation();
      this.previewBoard();
      this.tileSetId();
      this.schedulePreview();
    });
  }

  ngAfterViewInit(): void {
    this.schedulePreview();
    window.addEventListener('resize', this.onResize);
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    cancelAnimationFrame(this.frame);
  }

  private readonly onResize = (): void => this.schedulePreview();

  // ------------------------------------------------------------------ browse

  /** `true` once a writable authoring server has answered. */
  protected readonly writable = computed(() => this.workspace.status() !== null);

  /** Ids of every tile set the project loaded. */
  protected readonly tileSetIds = computed(() => {
    this.revision();
    return this.store.tileSetDefinitions().map((set) => set.id);
  });

  /**
   * The set being edited: the working copy if there is one, else the loaded file.
   *
   * `equal: () => false` because the working copy is edited **in place**, so its
   * reference never changes and a signal comparing references would decide
   * nothing had happened — the list of variants would stay empty on screen
   * while the file gained one. {@link revision} is what actually identifies the
   * state here, and everything derived from this set says the same, for the
   * same reason.
   */
  protected readonly tileSet = computed<TileSetDefinition | null>(
    () => {
      this.revision();
      const id = this.tileSetId();
      if (id === null) {
        return null;
      }
      const working = this.working.get(id);
      if (working !== undefined) {
        return working;
      }
      return this.store.tileSetDefinitions().find((set) => set.id === id) ?? null;
    },
    { equal: () => false },
  );

  /** The pixel grid the set's images are authored on. */
  protected readonly geometry = computed<TileArtGeometry>(() =>
    tileArtGeometry(this.tileSet() ?? {}),
  );

  /** Height of the faces themselves, below the `V` an elevation image starts on. */
  protected readonly faceHeight = computed(() => faceHeight(this.geometry()));

  /** Depth of that `V`: how far the hexagon's lower edges fall. */
  protected readonly shoulderDepth = computed(() => shoulderDepth(this.geometry()));

  /** The tiles the browser lists, filtered by the search box. */
  protected readonly tiles = computed(() => matching(this.tileSet(), this.search()));

  /** The tile being edited. Always-changed, like {@link tileSet}. */
  protected readonly tile = computed<TileDefinition | null>(
    () => {
      const id = this.selectedTileId();
      return this.tileSet()?.tiles.find((tile) => tile.id === id) ?? null;
    },
    { equal: () => false },
  );

  /** `false` when the id in the field is not one a content file may carry. */
  protected readonly idUsable = computed(() => {
    const tile = this.tile();
    return tile === null || isUsableId(tile.id);
  });

  // Fresh arrays, so `@for` sees a new list rather than the one it is already
  // rendering: these are the in-place arrays the editor pushes into.
  protected readonly surfaceVariants = computed(() => {
    const tile = this.tile();
    return tile === null ? [] : [...variantsOf(tile, SURFACE_LEVEL)];
  });

  protected readonly levels = computed(() => [...(this.tile()?.art?.elevation?.levels ?? [])]);

  protected readonly repeatMode = computed<RepeatMode>(() =>
    repeatModeOf(this.tile()?.art?.elevation?.repeat),
  );

  /** The level a `level` repeat rule names, for the picker. */
  protected readonly repeatLevel = computed(() => {
    const repeat = this.tile()?.art?.elevation?.repeat;
    return repeat !== null && repeat !== undefined && 'level' in repeat ? repeat.level : 1;
  });

  /** The levels a `pattern` rule cycles through. */
  protected readonly repeatPattern = computed<readonly number[]>(() => {
    const repeat = this.tile()?.art?.elevation?.repeat;
    return repeat !== null && repeat !== undefined && 'pattern' in repeat ? repeat.pattern : [];
  });

  /** The 1-based numbers of the explicit levels, for the pickers. */
  protected readonly levelNumbers = computed(() =>
    this.levels().map((_level, index) => index + 1),
  );

  protected selectCategory(id: string): void {
    if (ASSET_CATEGORIES.find((entry) => entry.id === id)?.status === 'available') {
      this.category.set(id);
    }
  }

  protected selectTileSet(event: Event): void {
    this.tileSetId.set((event.target as HTMLSelectElement).value);
    this.selectedTileId.set(this.tileSet()?.tiles[0]?.id ?? null);
    this.openImage.set(null);
  }

  protected selectTile(id: string): void {
    this.selectedTileId.set(id);
    this.openImage.set(null);
  }

  protected onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  protected setTab(tab: TileEditorTab): void {
    this.tab.set(tab);
  }

  // ---------------------------------------------------------------- mutation

  /**
   * The set as this screen may write to it.
   *
   * A deep copy the first time, so nothing edits the object the store handed
   * out and half-finished work never reaches a map (the editor never mutates a
   * loaded definition in place — `content-types.ts`).
   */
  private editable(): TileSetDefinition | null {
    const id = this.tileSetId();
    const current = this.tileSet();
    if (id === null || current === null) {
      return null;
    }
    let working = this.working.get(id);
    if (working === undefined) {
      working = structuredClone(current);
      working.schemaVersion = TILE_SET_SCHEMA_VERSION;
      this.working.set(id, working);
    }
    return working;
  }

  /** The tile being edited, as a writable copy, or `null`. */
  private editableTile(): TileDefinition | null {
    const id = this.selectedTileId();
    return this.editable()?.tiles.find((tile) => tile.id === id) ?? null;
  }

  /** Records a change: the working copy moved, so redraw and re-validate. */
  private touch(): void {
    this.dirty.set(true);
    this.status.set(null);
    this.revision.update((value) => value + 1);
  }

  protected createTile(): void {
    const set = this.editable();
    if (set === null) {
      return;
    }
    const id = freeId('tile', set.tiles.map((tile) => tile.id));
    set.tiles.push(blankTile(id, id));
    this.selectedTileId.set(id);
    this.tab.set('definition');
    this.touch();
  }

  protected duplicateSelected(): void {
    const set = this.editable();
    const tile = this.editableTile();
    if (set === null || tile === null) {
      return;
    }
    const id = freeId(`${tile.id}_copy`, set.tiles.map((entry) => entry.id));
    set.tiles.push(duplicateTile(tile, id, `${tile.name ?? tile.id} copy`));
    this.selectedTileId.set(id);
    this.touch();
  }

  protected removeSelected(): void {
    const set = this.editable();
    const id = this.selectedTileId();
    if (set === null || id === null || set.tiles.length <= 1) {
      return;
    }
    set.tiles = set.tiles.filter((tile) => tile.id !== id);
    this.selectedTileId.set(set.tiles[0]?.id ?? null);
    this.openImage.set(null);
    this.touch();
  }

  protected renameTile(event: Event): void {
    const tile = this.editableTile();
    if (tile !== null) {
      tile.name = (event.target as HTMLInputElement).value;
      this.touch();
    }
  }

  /**
   * Changes a tile's id.
   *
   * The id is the reference every map holds (ADR-0009), so this is the one
   * field that can break content. It is offered anyway — a tile authored as
   * `tile_2` has to be renameable — and validation reports the maps that no
   * longer resolve, which is the honest answer.
   */
  protected changeTileId(event: Event): void {
    const set = this.editable();
    const tile = this.editableTile();
    const next = (event.target as HTMLInputElement).value.trim();
    if (set === null || tile === null || next.length === 0 || next === tile.id) {
      return;
    }
    if (set.tiles.some((entry) => entry.id === next)) {
      this.failure.set(null);
      return;
    }
    tile.id = next;
    this.selectedTileId.set(next);
    this.touch();
  }

  protected changeField(field: 'terrain' | 'visualId' | 'fallbackColor', event: Event): void {
    const tile = this.editableTile();
    if (tile === null) {
      return;
    }
    const value = (event.target as HTMLInputElement).value;
    if (field === 'terrain') {
      tile.terrain = value;
    } else if (field === 'visualId') {
      tile.visual.visualId = value;
    } else {
      tile.visual.fallbackColor = value;
    }
    this.touch();
  }

  protected changeMovementCost(event: Event): void {
    const tile = this.editableTile();
    if (tile !== null) {
      tile.movementCost = Math.max(0, Number((event.target as HTMLInputElement).value) || 0);
      this.touch();
    }
  }

  protected changeTags(event: Event): void {
    const tile = this.editableTile();
    if (tile !== null) {
      tile.tags = (event.target as HTMLInputElement).value
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
      this.touch();
    }
  }

  protected changeGeometry(field: keyof TileArtGeometry, event: Event): void {
    const set = this.editable();
    if (set === null) {
      return;
    }
    const value = Math.max(1, Math.round(Number((event.target as HTMLInputElement).value) || 1));
    set.art = { ...tileArtGeometry(set), [field]: Math.min(MAX_TILE_IMAGE_SIZE, value) };
    this.touch();
  }

  // ----------------------------------------------------------------- variants

  /** Adds a variant with a blank, transparent image the right size for it. */
  protected addVariant(level: number): void {
    const tile = this.editableTile();
    if (tile === null) {
      return;
    }
    const art = artOf(tile);
    const list = level === SURFACE_LEVEL ? art.surface : art.elevation.levels[level - 1]?.variants;
    if (list === undefined || list.length >= MAX_TILE_VARIANTS) {
      return;
    }
    const id = freeId(
      variantLetter(list.length),
      list.map((entry) => entry.id),
    );
    const asset = imagePath(tile.id, level, id);
    list.push({ id, asset });

    const geometry = this.geometry();
    const sprite = SpriteDocument.blank(
      geometry.width,
      level === SURFACE_LEVEL ? geometry.surfaceHeight : geometry.elevationHeight,
    );
    sprite.markUnsaved();
    this.sessions.set(asset, sprite);
    this.openImage.set({ level, variant: list.length - 1 });
    this.touch();
  }

  protected removeVariant(level: number, index: number): void {
    const tile = this.editableTile();
    if (tile === null) {
      return;
    }
    const art = artOf(tile);
    const list = level === SURFACE_LEVEL ? art.surface : art.elevation.levels[level - 1]?.variants;
    if (list === undefined) {
      return;
    }
    list.splice(index, 1);
    pruneArt(tile);
    if (sameTarget(this.openImage(), { level, variant: index })) {
      this.openImage.set(null);
    }
    this.touch();
  }

  protected openVariant(level: number, variant: number): void {
    this.openImage.set({ level, variant });
    void this.ensureSession(level, variant);
  }

  /** `true` when this variant is the one the pixel editor has open. */
  protected isOpen(level: number, variant: number): boolean {
    return sameTarget(this.openImage(), { level, variant });
  }

  /**
   * The buffer for a variant, decoding the file the first time it is asked for.
   *
   * A file that cannot be decoded leaves the pixel editor empty and says so,
   * rather than opening a blank image over art that exists.
   */
  private async ensureSession(level: number, variant: number): Promise<void> {
    const tile = this.tile();
    const entry = tile === null ? null : (variantsOf(tile, level)[variant] ?? null);
    if (entry === null || this.sessions.has(entry.asset)) {
      this.revision.update((value) => value + 1);
      return;
    }
    const image = await loadImage(contentUrl(entry.asset));
    const sprite = image === null ? null : SpriteDocument.fromImage(image);
    if (sprite === null) {
      this.failure.set(entry.asset);
      return;
    }
    this.sessions.set(entry.asset, sprite);
    this.revision.update((value) => value + 1);
  }

  /** The image the pixel editor is holding. */
  protected readonly openSprite = computed<SpriteDocument | null>(() => {
    this.revision();
    const tile = this.tile();
    const target = this.openImage();
    if (tile === null || target === null) {
      return null;
    }
    const asset = variantAt(tile, target)?.asset;
    return asset === undefined ? null : (this.sessions.get(asset) ?? null);
  });

  /** Which guides the pixel editor draws: a surface image has no faces. */
  protected readonly openKind = computed<'surface' | 'elevation'>(() =>
    this.openImage()?.level === SURFACE_LEVEL ? 'surface' : 'elevation',
  );

  protected readonly openLabel = computed(() => {
    const tile = this.tile();
    const target = this.openImage();
    if (tile === null || target === null) {
      return '';
    }
    return variantAt(tile, target)?.asset ?? '';
  });

  /** Every colour the set's open images use, so its tiles keep one palette. */
  protected readonly sharedPalette = computed<readonly string[]>(() => {
    this.revision();
    const counts = new Map<string, number>();
    for (const sprite of this.sessions.values()) {
      for (const color of sprite.palette(8)) {
        counts.set(color, (counts.get(color) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([color]) => color);
  });

  protected onPainted(): void {
    this.dirty.set(true);
    this.revision.update((value) => value + 1);
  }

  // ----------------------------------------------------------------- levels

  protected addLevel(): void {
    const tile = this.editableTile();
    if (tile === null) {
      return;
    }
    const art = artOf(tile);
    if (art.elevation.levels.length >= MAX_ELEVATION_LEVELS) {
      return;
    }
    art.elevation.levels.push({ variants: [] });
    this.addVariant(art.elevation.levels.length);
  }

  protected removeLevel(level: number): void {
    const tile = this.editableTile();
    if (tile === null) {
      return;
    }
    const art = artOf(tile);
    art.elevation.levels.splice(level - 1, 1);
    // A rule naming a level that is gone is a rule the author has to revisit;
    // dropping it is less surprising than silently repointing it.
    const repeat = art.elevation.repeat;
    if (repeat !== null && repeat !== undefined) {
      const names = 'level' in repeat ? [repeat.level] : repeat.pattern;
      if (names.some((named) => named > art.elevation.levels.length)) {
        delete art.elevation.repeat;
      }
    }
    pruneArt(tile);
    this.openImage.set(null);
    this.touch();
  }

  protected renameLevel(level: number, event: Event): void {
    const tile = this.editableTile();
    if (tile === null) {
      return;
    }
    const entry = artOf(tile).elevation.levels[level - 1];
    if (entry !== undefined) {
      entry.name = (event.target as HTMLInputElement).value;
      this.touch();
    }
  }

  protected setRepeatMode(mode: RepeatMode): void {
    const tile = this.editableTile();
    if (tile === null) {
      return;
    }
    const art = artOf(tile);
    const count = art.elevation.levels.length;
    if (mode === 'last') {
      delete art.elevation.repeat;
    } else if (mode === 'level') {
      art.elevation.repeat = { level: Math.max(1, count) };
    } else {
      art.elevation.repeat = { pattern: count > 1 ? [count - 1, count] : [1] };
    }
    this.touch();
  }

  protected setRepeatLevel(event: Event): void {
    const tile = this.editableTile();
    if (tile === null) {
      return;
    }
    artOf(tile).elevation.repeat = { level: Number((event.target as HTMLSelectElement).value) };
    this.touch();
  }

  /** Adds or removes a level from the repeating pattern, keeping it ordered. */
  protected togglePatternLevel(level: number): void {
    const tile = this.editableTile();
    if (tile === null) {
      return;
    }
    const art = artOf(tile);
    const current = art.elevation.repeat;
    const pattern =
      current !== null && current !== undefined && 'pattern' in current ? [...current.pattern] : [];
    const at = pattern.indexOf(level);
    if (at >= 0) {
      pattern.splice(at, 1);
    } else {
      pattern.push(level);
      pattern.sort((left, right) => left - right);
    }
    art.elevation.repeat = { pattern } satisfies ElevationRepeat;
    this.touch();
  }

  protected inPattern(level: number): boolean {
    return this.repeatPattern().includes(level);
  }

  // ------------------------------------------------------------------ import

  /**
   * Imports an image file into a variant.
   *
   * Dimensions are checked against the set's grid and a mismatch is **refused**
   * rather than resized: silently resampling pixel art is how it stops being
   * pixel art, and the author is the only one who can decide what to do about
   * a 48-pixel tile in a 32-pixel set.
   */
  protected async importImage(level: number, index: number, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const tile = this.editableTile();
    if (file === undefined || tile === null) {
      return;
    }

    const image = await loadImage(URL.createObjectURL(file));
    const sprite = image === null ? null : SpriteDocument.fromImage(image);
    if (sprite === null) {
      this.failure.set(file.name);
      return;
    }

    const geometry = this.geometry();
    const expected = {
      width: geometry.width,
      height: level === SURFACE_LEVEL ? geometry.surfaceHeight : geometry.elevationHeight,
    };
    if (sprite.width !== expected.width || sprite.height !== expected.height) {
      this.failure.set(
        `${file.name}: ${sprite.width}×${sprite.height} ≠ ${expected.width}×${expected.height}`,
      );
      return;
    }

    const entry = variantsOf(tile, level)[index];
    if (entry === undefined) {
      return;
    }
    sprite.markUnsaved();
    this.sessions.set(entry.asset, sprite);
    this.cache.clear();
    this.failure.set(null);
    this.openImage.set({ level, variant: index });
    this.touch();
  }

  // ------------------------------------------------------------------ saving

  /** What the engine says about the set as it stands. */
  protected readonly report = computed<ValidationReport | null>(() => {
    this.revision();
    const set = this.tileSet();
    if (set === null || !this.engine.isReady) {
      return null;
    }
    try {
      return this.engine.validateTileSet(serializeTileSet(set));
    } catch {
      return null;
    }
  });

  protected readonly issues = computed(() => this.report()?.issues ?? []);
  protected readonly valid = computed(() => this.report()?.valid !== false);

  /** Images edited here that the content directory does not have yet. */
  protected readonly unsavedImages = computed(() => {
    this.revision();
    return [...this.sessions.entries()].filter(([, sprite]) => sprite.unsaved).length;
  });

  /**
   * Writes the images, then the tile set, then hands both to the rest of the
   * editor.
   *
   * Art and definition are one act of authoring, so they are written together
   * (ADR-0030). The set is replaced in the store *after* the write, which is
   * what makes the map editor's palette grow without a reload.
   */
  protected async save(): Promise<void> {
    const set = this.tileSet();
    if (set === null || !this.valid()) {
      this.failure.set(null);
      return;
    }
    try {
      let written = 0;
      for (const [asset, sprite] of this.sessions) {
        if (!sprite.unsaved) {
          continue;
        }
        await this.workspace.write(asset, await sprite.toBlob());
        sprite.markSaved();
        written += 1;
      }
      const path = this.store.tileSetPath(set.id);
      await this.workspace.writeJson(path, serializeTileSet(set));

      this.store.replaceTileSet(structuredClone(set));
      this.engine.loadTileSet(serializeTileSet(set));
      this.working.delete(set.id);
      this.cache.clear();
      this.dirty.set(false);
      this.failure.set(null);
      this.status.set(written > 0 ? `${path} · ${written}` : path);
      this.revision.update((value) => value + 1);
    } catch (error) {
      this.failure.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected dismiss(): void {
    this.failure.set(null);
    this.status.set(null);
  }

  // ----------------------------------------------------------------- preview

  protected stepElevation(by: number): void {
    this.previewElevation.update((value) =>
      Math.max(0, Math.min(MAX_PREVIEW_ELEVATION, value + by)),
    );
  }

  protected toggleBoard(): void {
    this.previewBoard.update((on) => !on);
  }

  /**
   * What the preview draws: one tile, or a small board of several.
   *
   * The board is what makes alignment, seams and pixel drift visible — a tile
   * that reads correctly alone can still not meet its neighbour. It mixes the
   * tiles the set actually declares, so it is the set being checked rather than
   * one tile repeated.
   */
  private previewCells(): PreviewCell[] {
    const set = this.tileSet();
    const tile = this.tile();
    if (set === null || tile === null) {
      return [];
    }
    const elevation = this.previewElevation();
    if (!this.previewBoard()) {
      return [
        {
          at: { col: 0, row: 0 },
          tileId: tile.id,
          art: tile.art,
          fallbackColor: tile.visual.fallbackColor,
          elevation,
        },
      ];
    }

    const cells: PreviewCell[] = [];
    for (let row = 0; row < BOARD_HEIGHT; row += 1) {
      for (let col = 0; col < BOARD_WIDTH; col += 1) {
        // The selected tile in the middle column, its neighbours around it, so
        // both "this tile against itself" and "against another" are on screen.
        const neighbour = set.tiles[(row * BOARD_WIDTH + col) % set.tiles.length];
        const drawn = col === 1 ? tile : (neighbour ?? tile);
        cells.push({
          at: { col, row },
          tileId: drawn.id,
          art: drawn.art,
          fallbackColor: drawn.visual.fallbackColor,
          elevation: col === 1 ? elevation : Math.max(0, elevation - 1),
        });
      }
    }
    return cells;
  }

  private schedulePreview(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.paintPreview());
  }

  private paintPreview(): void {
    const canvas = this.previewRef()?.nativeElement;
    if (canvas === undefined) {
      return;
    }
    const box = canvas.parentElement?.getBoundingClientRect();
    const width = Math.max(1, Math.round(box?.width ?? canvas.clientWidth));
    const height = Math.max(1, Math.round(box?.height ?? canvas.clientHeight));
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext('2d');
    if (context === null) {
      return;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const cells = this.previewCells();
    if (cells.length === 0) {
      return;
    }
    const geometry = this.geometry();
    drawPreview(context, cells, geometry, fitPreview(cells, geometry, width, height), this.source);
  }
}

/** Loads an image, resolving to `null` rather than rejecting when it will not. */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', () => resolve(null));
    image.src = url;
  });
}
