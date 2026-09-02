/**
 * The **tiles** category of the asset editor.
 *
 * One of the workspaces `asset-editor-page.ts` routes to, wearing the frame
 * every category wears: the tile list on the left, the pixels in the middle,
 * the definition on the right, and the hexagon in the dock
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`). What a tile *is*
 * and how its art resolves by level is
 * `docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`.
 *
 * Three things this screen is careful about.
 *
 * **The preview is not a mock-up.** It draws with `HexLayout`, `Projection` and
 * the same resolver the map renderer uses, so a tile that looks right here
 * looks right on a map (`docs/adr/ADR-0011-hex-coordinate-model.md`,
 * `docs/adr/ADR-0013-isometric-projection.md`). It sits in the dock because it
 * is *context* rather than the thing being edited — and because sharing a
 * column with the pixel tools is what used to leave it clipped.
 *
 * **There is one copy of every image.** The pixel editor writes into a
 * {@link SpriteDocument}, and the preview draws from that same buffer — so a
 * stroke shows up in the hexagon as it is painted, with no round trip through
 * a file (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 *
 * **A tile edited here is a tile the map editor has.** Saving replaces the
 * loaded tile set and rebuilds the open maps, so the palette next door grows
 * the moment this screen writes (`docs/adr/ADR-0006-assets-tilesets.md`).
 *
 * The draft it edits is the *set*, and the tile within it is this screen's own
 * business — one set holding many tiles is nesting the editing session does not
 * have to know about. What it did carry, and no longer does, was a fourth copy
 * of load and save: it held its own working overlay, its own `dirty` boolean and
 * its own thirty mutate-then-touch sites, and the copies had drifted
 * (`app/editing/draft-set.ts`,
 * `.scratch/module-depth/issues/09-tile-and-locale-do-not-fit-the-draft-set.md`).
 *
 * Labels are keys, like everywhere else
 * (`docs/adr/ADR-0020-localised-content-keys.md`).
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
} from '../../../../content/generated/tile-set';
import { ProjectionMode } from '../../../../content/generated/world';
import {
  bandLevels,
  faceHeight,
  shoulderDepth,
  tileArtGeometry,
} from '../../../../content/tile-set-geometry';
import { SpriteDocument } from '../../../../content/sprite-document';
import { serializeTileSet } from '../../../../content/tile-set-serializer';
import { routeUndoRedo } from '../../../../core/keyboard-shortcuts';
import { prepareSurface, zoomBy } from '../../../../renderer/canvas-surface';
import { SpriteCache, SpriteSource } from '../../../../renderer/character-renderer';
import { CellArt } from '../../../../renderer/tile-art';
import {
  ImageKind,
  PreviewCell,
  PreviewLayout,
  drawPreview,
  fitPreview,
  previewImageBox,
  previewPointOf,
} from '../../../../renderer/tile-preview';
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import { ContentWorkspaceService } from '../../../services/content-workspace.service';
import { EngineService } from '../../../services/engine.service';
import { LocaleAuthoringService } from '../../../services/locale-authoring.service';
import { ProjectManifest } from '../../../project/project-manifest';
import { TileSetLibrary } from '../../../project/tile-set-library';
import { WriteLedger } from '../../../project/write-ledger';
import {
  CONTENT_ROOT,
  ProjectStoreService,
  contentUrl,
} from '../../../services/project-store.service';
import { AssetWorkspace } from './asset-workspace';
import { PixelTool, PixelTools } from './pixel-tools';
import {
  ImageTarget,
  RepeatMode,
  FLAT_LEVEL,
  SURFACE_LEVEL,
  TILE_EDITOR_TABS,
  TileEditorTab,
  artOf,
  assetsOf,
  blankTile,
  dropOf,
  duplicateTile,
  hasLevel,
  imageHeight,
  imagePath,
  isUsableId,
  levelOfTab,
  listFor,
  variantLetter,
  matching,
  pruneArt,
  repeatModeOf,
  sameTarget,
  variantAt,
  variantsOf,
} from './tile-editor.types';
import { DraftSet } from '../../../editing/draft-set';
import { DraftSource } from '../../../editing/draft-source';
import { SpriteSessions, SpriteStore } from '../../../editing/sprite-sessions';
import { slugId } from '../../../editing/ids';
import { decodeContentSprite, decodeSpriteFile } from './sprite-decode';

/** The board the multi-tile preview lays out, in offset coordinates. */
const BOARD_WIDTH = 3;
const BOARD_HEIGHT = 3;

/** Room left around the board, in CSS pixels. */
const PREVIEW_PADDING = 12;

/** Below this many screen pixels a square, a pixel grid is noise. */
const GRID_ZOOM = 6;

/** Highest elevation the preview will step to; enough to prove a repeat rule. */
const MAX_PREVIEW_ELEVATION = 24;

@Component({
  selector: 'app-tile-workspace',
  imports: [TranslatePipe, AssetWorkspace, PixelTools],
  templateUrl: './tile-workspace.html',
  styleUrl: './tile-workspace.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Undo is a keystroke wherever the pointer happens to be. This screen had
  // toolbar buttons and no listener at all, so Ctrl+Z did nothing on it while
  // it did something on every other painting surface in the editor
  // (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
  host: { '(document:keydown)': 'onKeyDown($event)' },
})
export class TileWorkspace implements AfterViewInit, OnDestroy {
  private readonly store = inject(ProjectStoreService);
  private readonly manifest = inject(ProjectManifest);
  private readonly ledger = inject(WriteLedger);
  private readonly tileSets = inject(TileSetLibrary);
  private readonly workspace = inject(ContentWorkspaceService);
  private readonly engine = inject(EngineService);
  private readonly i18n = inject(I18nService);
  private readonly locales = inject(LocaleAuthoringService);

  private readonly previewRef = viewChild<ElementRef<HTMLCanvasElement>>('preview');

  protected readonly tabs = TILE_EDITOR_TABS;
  protected readonly maxLevels = MAX_ELEVATION_LEVELS;
  protected readonly maxVariants = MAX_TILE_VARIANTS;
  protected readonly maxImageSize = MAX_TILE_IMAGE_SIZE;
  protected readonly contentRoot = CONTENT_ROOT;

  protected readonly tab = signal<TileEditorTab>('definition');
  protected readonly search = signal('');
  protected readonly selectedTileId = signal<string | null>(null);
  /**
   * How tall the painted cell stands.
   *
   * Flat on the ground by default: the hexagon is the drawing surface now
   * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`), and a cell raised
   * two steps spends most of the scene on a cliff nobody is painting. Opening a
   * level raises it to that level, because a face has to exist to be drawn on.
   */
  protected readonly previewElevation = signal(0);
  protected readonly previewBoard = signal(false);
  /**
   * Which projection the preview draws in.
   *
   * The two views are different images of the same tile, so the artist needs to
   * be able to look at either
   * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`). It follows the
   * open tab rather than being a separate control: opening `flat` is asking to
   * see the flat view.
   */
  protected readonly previewMode = computed<ProjectionMode>(() =>
    this.tab() === 'flat' ? 'topDown' : 'isometric',
  );
  protected readonly openImage = signal<ImageTarget | null>(null);

  /**
   * Screen pixels per authored pixel; `null` fits the board to the panel.
   *
   * A tile is painted on its hexagon, so it needs the zoom a drawing surface
   * needs — the same ladder the character stage and the flat view step through
   * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
   */
  protected readonly previewZoom = signal<number | null>(null);
  /**
   * The hexagon is a drawing surface, always.
   *
   * There is no mode: this screen exists to draw tiles, and a button that has
   * to be pressed before the pencil works is a button in the way
   * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
   */
  /** Whether the pixel grid is drawn over the image being painted. */
  protected readonly showGrid = signal(true);
  protected readonly tool = signal<PixelTool>('pencil');
  protected readonly color = signal('#8ec07c');
  /** Opacity of the pencil, `0..255`: a tile is blitted as it stands. */
  protected readonly alpha = signal(255);
  /** Where the pointer was when it last painted, in the image's own pixels. */
  private stroking: { x: number; y: number } | null = null;
  /**
   * What the last draw put on the canvas.
   *
   * Kept so a click can be turned back into a pixel of the image under it: the
   * framing is decided at draw time and there is no second copy of it
   * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
   */
  private view: { layout: PreviewLayout; width: number; height: number } | null = null;

  /** The buffers the pixel editor writes into, the unsaved set, and the save. */
  private readonly sessions = new SpriteSessions(this.spriteStore());
  /** Files loaded from the content directory, for everything not being edited. */
  private readonly cache = new SpriteCache(
    (asset) => contentUrl(asset),
    () => this.schedulePreview(),
  );
  private frame = 0;

  /**
   * The editing session: what is held, what is open, what is unwritten.
   *
   * The whole of load and save, which this screen only supplies the tile set's
   * half of (`app/editing/draft-set.ts`).
   */
  private readonly drafts = new DraftSet<TileSetDefinition>(this.draftSource(), {
    i18n: this.i18n,
    workspace: this.workspace,
    ledger: this.ledger,
    locales: this.locales,
  });

  /**
   * What the preview draws with: the session buffer where there is one.
   *
   * The single most important line on this screen. Without it the hexagon shows
   * the file while the pencil edits the buffer, and the author is looking at
   * the previous version of their own stroke (ADR-0028).
   */
  private readonly source: SpriteSource = {
    image: (asset: string) => this.sessions.get(asset)?.surface() ?? this.cache.image(asset),
    // An open sprite is already in memory; everything else is the cache's.
    preload: (assets: Iterable<string>) => this.cache.preload(assets),
  };

  constructor() {
    void this.drafts.load();

    effect(() => {
      // Everything the preview reads, so a change to any of it repaints. The
      // open set is read by identity: an edit is a copy, so the draft that
      // comes back is a different object from the one before it.
      this.tileSet();
      this.sessions.revision();
      this.selectedTileId();
      this.previewElevation();
      this.previewBoard();
      this.previewMode();
      this.schedulePreview();
    });
  }

  ngAfterViewInit(): void {
    this.schedulePreview();
    window.addEventListener('resize', this.onResize);
    // The window is not the only thing that resizes this canvas: the divider
    // between the scene and the inspector does, and so does the pixel editor
    // growing under it. The canvas is sized from its parent's box in `paint`,
    // so a parent that changes without a repaint leaves a canvas at the old
    // size — drawn *past* its own frame
    // (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
    const box = this.previewRef()?.nativeElement.parentElement;
    if (box !== null && box !== undefined && typeof ResizeObserver !== 'undefined') {
      this.watching = new ResizeObserver(() => this.schedulePreview());
      this.watching.observe(box);
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.watching?.disconnect();
    cancelAnimationFrame(this.frame);
  }

  private readonly onResize = (): void => this.schedulePreview();

  /** Watches the preview's own box, which the layout may resize on its own. */
  private watching: ResizeObserver | null = null;

  // ------------------------------------------------------------------ source

  /** How this screen's images are read and written: the content directory. */
  private spriteStore(): SpriteStore {
    return {
      load: (path) => decodeContentSprite(path),
      write: (path, blob) => this.workspace.write(path, blob),
    };
  }

  /**
   * What a *tile set* means by reading, validating, writing and declaring.
   *
   * Everything else about the session — the order of the steps, the bail-out on
   * a failing verdict, one definition of unsaved — is `DraftSet`'s.
   *
   * The list is {@link TileSetLibrary}'s, not a file read of this screen's own:
   * the project already loaded every declared set, and which module owns that
   * read is what
   * `.scratch/module-depth/issues/05-close-the-project-store-read-side.md`
   * settled. A copy is taken per draft, because nothing may edit the definition
   * the library handed out — half-finished work must never reach a map.
   */
  private draftSource(): DraftSource<TileSetDefinition> {
    return {
      // A tile set *is* listed in `project.json`, but this screen edits the sets
      // a project declares and creates or removes none — so nothing it does can
      // move the manifest, and it must not flush one the map editor next door
      // has left half-edited. The same fact is why `declare`, `undeclare`,
      // `forget` and `removed` have nothing to do.
      declaredInManifest: false,
      // A list: a project shipping no tile set opens on an empty picker.
      blank: () => null,
      messages: {
        invalid: 'ui.editor.asset.invalid',
        saved: 'ui.editor.asset.saved',
        spritesSaved: 'ui.editor.asset.imagesSaved',
      },
      prepare: async () => {
        await this.engine.ready();
        await this.i18n.ensureAdopted();
        await this.store.ensureLoaded();
        await this.workspace.ensureProbed();
      },
      declared: () => this.manifest.tileSets(),
      read: async (entry) => {
        const loaded = this.tileSets
          .tileSetDefinitions()
          .find((candidate) => candidate.id === entry.id);
        if (loaded === undefined) {
          return null;
        }
        const draft = structuredClone(loaded);
        // Written at the version this editor writes, whatever the file said.
        draft.schemaVersion = TILE_SET_SCHEMA_VERSION;
        return draft;
      },
      pathOf: (id) => this.tileSets.tileSetPath(id),
      serialize: (set) => serializeTileSet(set),
      validate: (_set, json) => this.engine.validateTileSet(json),
      // Replacing the loaded set is what rebuilds the open maps, so the palette
      // in the map editor grows without a reload (ADR-0006); loading it into
      // the engine is what makes the *runtime* agree with the file.
      adopt: (_id, json) => {
        this.tileSets.replaceTileSet(JSON.parse(json) as TileSetDefinition);
        this.engine.loadTileSet(json);
      },
      forget: () => {},
      declare: () => {},
      undeclare: () => {},
      dirtySprites: (set) => this.unwritten(set),
      writeSprites: (set) => this.writeSprites(set),
      // A tile set names no player-facing text: a tile's `visualId` is an art
      // id and its name is authored in place, so there is no key to create.
      keysOf: () => [],
      removed: () => {},
      refresh: () => this.schedulePreview(),
    };
  }

  // ------------------------------------------------------------------ browse

  /** `true` once a writable authoring server has answered. */
  protected readonly writable = computed(() => this.workspace.status() !== null);

  /** Ids of every tile set the project declared. */
  protected readonly tileSetIds = computed(() => this.drafts.drafts().map((set) => set.id));

  /** The set being edited, or `null` before the first read has finished. */
  protected readonly tileSet = this.drafts.open;

  /** Id of that set, for the picker and the path line. */
  protected readonly tileSetId = computed(() => this.tileSet()?.id ?? null);

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

  /**
   * The tile being edited, or `null` when the set holds none.
   *
   * Falls back to the first rather than to nothing when the selected id names
   * nothing — the same fallback `DraftSet.open` makes one level up, and for the
   * same reason: removing the open tile leaves the form showing its neighbour
   * instead of an empty screen, and a set that has just loaded opens on a tile
   * rather than on nothing.
   */
  protected readonly tile = computed<TileDefinition | null>(() => {
    const tiles = this.tileSet()?.tiles ?? [];
    const id = this.selectedTileId();
    return tiles.find((tile) => tile.id === id) ?? tiles[0] ?? null;
  });

  /** `false` when the id in the field is not one a content file may carry. */
  protected readonly idUsable = computed(() => {
    const tile = this.tile();
    return tile === null || isUsableId(tile.id);
  });

  protected readonly flatVariants = computed(() => {
    const tile = this.tile();
    return tile === null ? [] : [...variantsOf(tile, FLAT_LEVEL)];
  });

  protected readonly surfaceVariants = computed(() => {
    const tile = this.tile();
    return tile === null ? [] : [...variantsOf(tile, SURFACE_LEVEL)];
  });

  protected readonly levels = computed(() => this.tile()?.art?.elevation?.levels ?? []);

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
  protected readonly levelNumbers = computed(() => this.levels().map((_level, index) => index + 1));

  protected selectTileSet(event: Event): void {
    this.drafts.select((event.target as HTMLSelectElement).value);
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

  /**
   * Opens a panel, and with it the first image that panel can paint.
   *
   * The hexagon draws whichever image is open (`paintedChoice`), so a tab with
   * no image open shows a rolled variant and paints nothing. Opening one is
   * what the author meant by opening the tab
   * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
   */
  protected setTab(tab: TileEditorTab): void {
    this.tab.set(tab);
    const level = levelOfTab(tab);
    if (level === null) {
      return;
    }
    const tile = this.tile();
    const open = this.openImage();
    if (tile === null || (open !== null && open.level === level)) {
      return;
    }
    if (variantsOf(tile, level).length === 0) {
      this.openImage.set(null);
      return;
    }
    this.openVariant(level, 0);
  }

  // ---------------------------------------------------------------- mutation

  /**
   * Applies a change to the open set.
   *
   * A copy per edit, not a mutation in place: the session is what decides that
   * the set differs from its file, and `OnPush` only redraws what changed
   * identity. This screen used to keep a working overlay and bump a revision
   * counter instead, which is what let a half-converted list stay on screen
   * (`app/editing/draft-set.ts`).
   */
  private edit(mutate: (set: TileSetDefinition) => void): void {
    this.drafts.edit(mutate);
  }

  /** Applies a change to the selected tile, inside the open set's copy. */
  private editTile(mutate: (tile: TileDefinition) => void): void {
    const id = this.tile()?.id;
    if (id === undefined) {
      return;
    }
    this.edit((set) => {
      const tile = set.tiles.find((candidate) => candidate.id === id);
      if (tile !== undefined) {
        mutate(tile);
      }
    });
  }

  protected createTile(): void {
    const set = this.tileSet();
    if (set === null) {
      return;
    }
    const id = slugId(
      'tile',
      set.tiles.map((tile) => tile.id),
      'tile',
    );
    this.edit((draft) => {
      draft.tiles.push(blankTile(id, id));
    });
    this.selectedTileId.set(id);
    this.tab.set('definition');
  }

  protected duplicateSelected(): void {
    const set = this.tileSet();
    const tile = this.tile();
    if (set === null || tile === null) {
      return;
    }
    const id = slugId(
      `${tile.id}_copy`,
      set.tiles.map((entry) => entry.id),
      'tile',
    );
    this.edit((draft) => {
      draft.tiles.push(duplicateTile(tile, id, `${tile.name ?? tile.id} copy`));
    });
    this.selectedTileId.set(id);
  }

  protected removeSelected(): void {
    const set = this.tileSet();
    const id = this.tile()?.id ?? null;
    if (set === null || id === null || set.tiles.length <= 1) {
      return;
    }
    this.edit((draft) => {
      draft.tiles = draft.tiles.filter((tile) => tile.id !== id);
    });
    this.selectedTileId.set(this.tileSet()?.tiles[0]?.id ?? null);
    this.openImage.set(null);
  }

  protected renameTile(event: Event): void {
    const name = (event.target as HTMLInputElement).value;
    this.editTile((tile) => {
      tile.name = name;
    });
  }

  /**
   * Changes a tile's id.
   *
   * The id is the reference every map holds (ADR-0006), so this is the one
   * field that can break content. It is offered anyway — a tile authored as
   * `tile_2` has to be renameable — and validation reports the maps that no
   * longer resolve, which is the honest answer.
   *
   * By position rather than by id, because the id is what is moving: the
   * selection follows it in the same breath, so the form never falls back to a
   * neighbour on the way past.
   */
  protected changeTileId(event: Event): void {
    const set = this.tileSet();
    const tile = this.tile();
    const next = (event.target as HTMLInputElement).value.trim();
    if (set === null || tile === null || next.length === 0 || next === tile.id) {
      return;
    }
    if (set.tiles.some((entry) => entry.id === next)) {
      this.drafts.clearError();
      return;
    }
    const at = set.tiles.findIndex((entry) => entry.id === tile.id);
    this.edit((draft) => {
      const moved = draft.tiles[at];
      if (moved !== undefined) {
        moved.id = next;
      }
    });
    this.selectedTileId.set(next);
  }

  protected changeField(field: 'terrain' | 'visualId' | 'fallbackColor', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.editTile((tile) => {
      if (field === 'terrain') {
        tile.terrain = value;
      } else if (field === 'visualId') {
        tile.visual.visualId = value;
      } else {
        tile.visual.fallbackColor = value;
      }
    });
  }

  protected changeMovementCost(event: Event): void {
    const cost = Math.max(0, Number((event.target as HTMLInputElement).value) || 0);
    this.editTile((tile) => {
      tile.movementCost = cost;
    });
  }

  protected changeTags(event: Event): void {
    const tags = (event.target as HTMLInputElement).value
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    this.editTile((tile) => {
      tile.tags = tags;
    });
  }

  protected changeGeometry(field: keyof TileArtGeometry, event: Event): void {
    const value = Math.max(1, Math.round(Number((event.target as HTMLInputElement).value) || 1));
    this.edit((draft) => {
      draft.art = { ...tileArtGeometry(draft), [field]: Math.min(MAX_TILE_IMAGE_SIZE, value) };
    });
  }

  // ----------------------------------------------------------------- variants

  /** Adds a variant with a blank, transparent image the right size for it. */
  protected addVariant(level: number): void {
    const tile = this.tile();
    if (tile === null || !hasLevel(tile, level)) {
      return;
    }
    const list = variantsOf(tile, level);
    if (list.length >= MAX_TILE_VARIANTS) {
      return;
    }
    const at = list.length;
    const id = slugId(
      variantLetter(at),
      list.map((entry) => entry.id),
      'tile',
    );
    const asset = imagePath(tile.id, level, id);

    this.editTile((draft) => {
      listFor(artOf(draft), level)?.push({ id, asset });
    });

    const geometry = this.geometry();
    const sprite = SpriteDocument.blank(geometry.width, imageHeight(geometry, level));
    // It exists nowhere else, so it owes the disk a write from the moment it is
    // created rather than from its first stroke.
    sprite.markUnsaved();
    this.sessions.add(asset, sprite);
    this.touchSprites();
    this.openImage.set({ level, variant: at });
  }

  protected removeVariant(level: number, index: number): void {
    this.editTile((draft) => {
      listFor(artOf(draft), level)?.splice(index, 1);
      pruneArt(draft);
    });
    if (sameTarget(this.openImage(), { level, variant: index })) {
      this.openImage.set(null);
    }
  }

  protected openVariant(level: number, variant: number): void {
    this.openImage.set({ level, variant });
    // A face only exists on a cell tall enough to show it, and the hexagon is
    // where it is painted now
    // (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
    // A band spans several levels when a step is shorter than the faces, so the
    // cell has to be that much taller before the level being painted is on it.
    const needed = level * bandLevels(this.geometry());
    if (level >= 1 && this.previewElevation() < needed) {
      this.previewElevation.set(needed);
    }
    this.ensureSession(level, variant);
  }

  /** `true` when this variant is the one the pixel editor has open. */
  protected isOpen(level: number, variant: number): boolean {
    return sameTarget(this.openImage(), { level, variant });
  }

  /**
   * Opens a variant's buffer, decoding its file the first time it is asked for.
   *
   * A file that names nothing leaves the pixel editor empty; the variant row
   * already marks it missing.
   */
  private ensureSession(level: number, variant: number): void {
    const tile = this.tile();
    const entry = tile === null ? null : (variantsOf(tile, level)[variant] ?? null);
    if (entry !== null) {
      this.sessions.open(entry.asset);
    }
  }

  /** The image the pixel editor is holding. */
  protected readonly openSprite = computed<SpriteDocument | null>(() => {
    this.sessions.revision();
    const tile = this.tile();
    const target = this.openImage();
    if (tile === null || target === null) {
      return null;
    }
    const asset = variantAt(tile, target)?.asset;
    return asset === undefined ? null : (this.sessions.get(asset) ?? null);
  });

  /** Which guides the pixel editor draws: only an elevation image has faces. */
  protected readonly openKind = computed<ImageKind>(() => {
    const level = this.openImage()?.level;
    if (level === FLAT_LEVEL) {
      return 'flat';
    }
    return level === SURFACE_LEVEL ? 'surface' : 'elevation';
  });

  protected readonly openLabel = computed(() => {
    const tile = this.tile();
    const target = this.openImage();
    if (tile === null || target === null) {
      return '';
    }
    return variantAt(tile, target)?.asset ?? '';
  });

  /**
   * The open image's file name, without its directories.
   *
   * The bar it sits in is one line and the path is four segments of convention;
   * what an author reads is `grass_a.png`.
   */
  protected readonly openName = computed(() => this.openLabel().split('/').pop() ?? '');

  /** Every colour the set's open images use, so its tiles keep one palette. */
  protected readonly sharedPalette = computed<readonly string[]>(() => {
    this.sessions.revision();
    const counts = new Map<string, number>();
    for (const [, sprite] of this.sessions.entries()) {
      for (const color of sprite.palette(8)) {
        counts.set(color, (counts.get(color) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([color]) => color);
  });

  protected onPainted(): void {
    this.touchSprites();
  }

  /**
   * Tells the view, and the session, that the pixels moved.
   *
   * The session decides what "unsaved" means and a stroke is half of it, so a
   * painted buffer is not a second answer kept beside the draft's
   * (`app/editing/draft-set.ts`).
   */
  private touchSprites(): void {
    this.sessions.touched();
    this.drafts.touchSprites();
  }

  // ----------------------------------------------------------------- levels

  protected addLevel(): void {
    const tile = this.tile();
    if (tile === null) {
      return;
    }
    const count = tile.art?.elevation?.levels.length ?? 0;
    if (count >= MAX_ELEVATION_LEVELS) {
      return;
    }
    this.editTile((draft) => {
      artOf(draft).elevation.levels.push({ variants: [] });
    });
    this.addVariant(count + 1);
  }

  protected removeLevel(level: number): void {
    this.editTile((draft) => {
      const art = artOf(draft);
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
      pruneArt(draft);
    });
    this.openImage.set(null);
  }

  protected renameLevel(level: number, event: Event): void {
    const name = (event.target as HTMLInputElement).value;
    this.editTile((draft) => {
      const entry = artOf(draft).elevation.levels[level - 1];
      if (entry !== undefined) {
        entry.name = name;
      }
    });
  }

  protected setRepeatMode(mode: RepeatMode): void {
    this.editTile((draft) => {
      const art = artOf(draft);
      const count = art.elevation.levels.length;
      if (mode === 'last') {
        delete art.elevation.repeat;
      } else if (mode === 'level') {
        art.elevation.repeat = { level: Math.max(1, count) };
      } else {
        art.elevation.repeat = { pattern: count > 1 ? [count - 1, count] : [1] };
      }
    });
  }

  protected setRepeatLevel(event: Event): void {
    const level = Number((event.target as HTMLSelectElement).value);
    this.editTile((draft) => {
      artOf(draft).elevation.repeat = { level };
    });
  }

  /** Adds or removes a level from the repeating pattern, keeping it ordered. */
  protected togglePatternLevel(level: number): void {
    this.editTile((draft) => {
      const art = artOf(draft);
      const current = art.elevation.repeat;
      const pattern =
        current !== null && current !== undefined && 'pattern' in current
          ? [...current.pattern]
          : [];
      const at = pattern.indexOf(level);
      if (at >= 0) {
        pattern.splice(at, 1);
      } else {
        pattern.push(level);
        pattern.sort((left, right) => left - right);
      }
      art.elevation.repeat = { pattern } satisfies ElevationRepeat;
    });
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
    const tile = this.tile();
    if (file === undefined || tile === null) {
      return;
    }

    const sprite = await decodeSpriteFile(file);
    if (sprite === null) {
      this.drafts.fail(this.i18n.t('ui.editor.asset.importUnreadable', { file: file.name }));
      return;
    }

    const geometry = this.geometry();
    const expected = { width: geometry.width, height: imageHeight(geometry, level) };
    if (sprite.width !== expected.width || sprite.height !== expected.height) {
      this.drafts.fail(
        this.i18n.t('ui.editor.asset.importWrongSize', {
          file: file.name,
          actual: `${sprite.width}×${sprite.height}`,
          expected: `${expected.width}×${expected.height}`,
        }),
      );
      return;
    }

    // Read again rather than from `tile`: decoding is awaited, the draft is a
    // copy per edit, and a variant added or removed in between would leave the
    // pixels stored under a path the open set no longer names.
    const current = this.tile();
    const entry = current === null ? undefined : variantsOf(current, level)[index];
    if (entry === undefined) {
      return;
    }
    // The definition is untouched: the variant already names this file, and
    // what changed is its pixels — which is the other half of unsaved.
    sprite.markUnsaved();
    this.sessions.add(entry.asset, sprite);
    this.cache.clear();
    this.drafts.clearError();
    this.openImage.set({ level, variant: index });
    this.touchSprites();
  }

  // ------------------------------------------------------------------ saving

  /** What the engine says about the set as it stands. */
  protected readonly report = this.drafts.report;
  protected readonly issues = computed(() => this.report()?.issues ?? []);
  protected readonly valid = computed(() => this.report()?.valid !== false);

  /** `true` when the open set, or an image it owns, differs from disk. */
  protected readonly dirty = this.drafts.dirty;

  /** What the last write did, as one line. */
  protected readonly message = this.drafts.message;

  /** What went wrong, in the author's language where the author's language said it. */
  protected readonly error = this.drafts.error;

  /**
   * Images of the open set that the content directory does not have yet.
   *
   * The **open set's**, which is the same scope `dirtySprites` answers in and
   * the same one a save writes. `sessions` is keyed by path and outlives the
   * picker, so counting all of it would let the toolbar claim unwritten pixels
   * that belong to a set nobody is looking at — and a save on this one would
   * then write them and count them in its own message.
   */
  protected readonly unsavedImages = computed(() => {
    const set = this.tileSet();
    return set === null ? 0 : this.unwritten(set).length;
  });

  /**
   * Paths of one set's images whose pixels are not on disk.
   *
   * Takes the set rather than reading the open one, because the session asks
   * this of every draft it holds and not only of the one on screen.
   */
  private unwritten(set: TileSetDefinition): readonly string[] {
    return this.sessions.unsavedIn(assetsOf(set));
  }

  /**
   * Writes a set's edited images, one PNG each.
   *
   * Art and definition are one act of authoring, so they go together (ADR-0028)
   * — the session decides the order, and it writes the file first.
   *
   * @returns how many were written
   */
  private async writeSprites(set: TileSetDefinition): Promise<number> {
    const written = await this.sessions.writeIn(assetsOf(set));
    if (written > 0) {
      // The decoded copies hold the bytes these paths used to have.
      this.cache.clear();
      this.touchSprites();
    }
    return written;
  }

  /** Writes the open set into the content directory. */
  protected save(): Promise<void> {
    return this.drafts.save();
  }

  protected dismiss(): void {
    this.drafts.clearError();
    this.drafts.announce(null);
  }

  // ----------------------------------------------------------------- preview

  protected stepElevation(by: number): void {
    this.previewElevation.update((value) =>
      Math.max(0, Math.min(MAX_PREVIEW_ELEVATION, value + by)),
    );
  }

  /** The zoom on screen: the one asked for, or the one the fit settled on. */
  protected readonly shownZoom = computed(
    () => this.previewZoom() ?? Math.round((this.fitted() ?? 1) * 10) / 10,
  );

  /** What the last fit worked out, in screen pixels per authored pixel. */
  private readonly fitted = signal<number | null>(null);

  protected zoomBy(delta: number): void {
    this.previewZoom.set(zoomBy(this.previewZoom() ?? this.fitted() ?? 1, delta));
    this.schedulePreview();
  }

  protected fitZoom(): void {
    this.previewZoom.set(null);
    this.schedulePreview();
  }

  protected toggleGrid(): void {
    this.showGrid.update((on) => !on);
    this.schedulePreview();
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
  /**
   * Which cell of the board is the one being painted.
   *
   * The middle of the board, or the only cell when there is no board — and it
   * is the *centre column* that carries the open tile, so a click always lands
   * on the tile the inspector is showing.
   */
  private paintedAt(): { col: number; row: number } {
    return this.previewBoard() ? { col: 1, row: 1 } : { col: 0, row: 0 };
  }

  /**
   * The variants the painted cell must draw: the ones being edited.
   *
   * A map rolls a variant per cell so a field does not repeat itself; an editor
   * needs the opposite, or an author paints `grass_b` while looking at
   * `grass_f` (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
   */
  private paintedChoice(): CellArt {
    const target = this.openImage();
    if (target === null) {
      return {};
    }
    return target.level >= 1 ? { elevationVariant: target.variant } : { surface: target.variant };
  }

  private previewCells(): PreviewCell[] {
    const set = this.tileSet();
    const tile = this.tile();
    if (set === null || tile === null) {
      return [];
    }
    const elevation = this.previewElevation();
    const painted = this.paintedAt();
    const choice = this.paintedChoice();
    if (!this.previewBoard()) {
      return [
        {
          at: painted,
          tileId: tile.id,
          art: tile.art,
          fallbackColor: tile.visual.fallbackColor,
          elevation,
          choice,
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
        const isPainted = col === painted.col && row === painted.row;
        cells.push({
          at: { col, row },
          tileId: drawn.id,
          art: drawn.art,
          fallbackColor: drawn.visual.fallbackColor,
          elevation: col === 1 ? elevation : Math.max(0, elevation - 1),
          choice: isPainted ? choice : undefined,
        });
      }
    }
    return cells;
  }

  // ------------------------------------------------------------------ paint

  protected setTool(tool: PixelTool): void {
    this.tool.set(tool);
  }

  protected setColor(color: string): void {
    this.color.set(color);
  }

  /** `true` when there is an image open and a surface to paint it on. */
  protected readonly paintable = computed(() => this.openSprite() !== null);

  protected readonly canUndo = computed(() => {
    this.sessions.revision();
    return this.openSprite()?.canUndo === true;
  });

  protected readonly canRedo = computed(() => {
    this.sessions.revision();
    return this.openSprite()?.canRedo === true;
  });

  /**
   * Undo and redo, wherever the pointer is — but never while typing.
   *
   * The screen's only keyboard listener, and the same chord every other
   * painting surface answers to (`core/keyboard-shortcuts.ts`).
   */
  protected onKeyDown(event: KeyboardEvent): void {
    routeUndoRedo(event, { undo: () => this.undo(), redo: () => this.redo() });
  }

  protected undo(): void {
    if (this.openSprite()?.undo() === true) {
      this.onPainted();
    }
  }

  protected redo(): void {
    if (this.openSprite()?.redo() === true) {
      this.onPainted();
    }
  }

  protected clearImage(): void {
    const sprite = this.openSprite();
    if (sprite === null) {
      return;
    }
    sprite.begin();
    for (let y = 0; y < sprite.height; y += 1) {
      for (let x = 0; x < sprite.width; x += 1) {
        sprite.plot(x, y, null);
      }
    }
    sprite.end();
    this.onPainted();
  }

  protected onPointerDown(event: PointerEvent): void {
    const sprite = this.openSprite();
    const at = this.pixelAt(event);
    if (sprite === null || at === null || !sprite.holds(at.x, at.y)) {
      return;
    }
    event.preventDefault();
    // Alt is the eyedropper wherever you are (ADR-0028).
    if (this.tool() === 'picker' || event.altKey) {
      const color = sprite.colorAt(at.x, at.y);
      if (color !== null) {
        this.color.set(color);
      }
      return;
    }
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    sprite.begin();
    this.stroking = at;
    this.paintTo(at.x, at.y);
  }

  protected onPointerMove(event: PointerEvent): void {
    if (this.stroking === null) {
      return;
    }
    const at = this.pixelAt(event);
    if (at !== null) {
      this.paintTo(at.x, at.y);
    }
  }

  protected onPointerUp(): void {
    this.finishStroke();
  }

  private paintTo(x: number, y: number): void {
    const sprite = this.openSprite();
    const from = this.stroking;
    if (sprite === null || from === null) {
      return;
    }
    const color = this.tool() === 'eraser' ? null : this.color();
    if (sprite.stroke(from.x, from.y, x, y, color, this.alpha())) {
      this.onPainted();
    }
    this.stroking = { x, y };
  }

  /** Closes the open stroke, which is what makes it one step of the undo. */
  private finishStroke(): void {
    if (this.stroking === null) {
      return;
    }
    this.stroking = null;
    this.openSprite()?.end();
  }

  /**
   * The pixel of the open image under a pointer, or `null` when it is not over
   * it at all.
   *
   * The box comes from `previewImageBox()` — the same call the draw makes — so
   * the click and the blit cannot drift apart. The pointer is measured against
   * the canvas *element* rather than the layout, because the interface scale
   * multiplies one and not the other (ADR-0028).
   */
  private pixelAt(event: PointerEvent): { x: number; y: number } | null {
    const canvas = this.previewRef()?.nativeElement;
    const view = this.view;
    const sprite = this.openSprite();
    const target = this.openImage();
    const cells = this.previewCells();
    const painted = this.paintedAt();
    const cell = cells.find((one) => one.at.col === painted.col && one.at.row === painted.row);
    if (
      canvas === undefined ||
      view === null ||
      sprite === null ||
      target === null ||
      cell === undefined
    ) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }
    const scale = view.width / rect.width;
    const point = previewPointOf(
      { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale },
      view.layout,
    );

    // A stacked face is drawn once per band; the one showing this level is that
    // many bands down from the cell's own height. It may be negative — the
    // topmost band starts above the top face, which covers what sticks out.
    const drop = dropOf(cell.elevation, target.level, this.geometry());
    const box = previewImageBox(cell, this.geometry(), view.layout, this.openKind(), drop);
    if (box.width <= 0 || box.height <= 0) {
      return null;
    }
    return {
      x: Math.floor(((point.x - box.x) / box.width) * sprite.width),
      y: Math.floor(((point.y - box.y) / box.height) * sprite.height),
    };
  }

  private schedulePreview(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.paintPreview());
  }

  private paintPreview(): void {
    const canvas = this.previewRef()?.nativeElement;
    const frame = canvas?.parentElement;
    if (canvas === undefined || frame === null || frame === undefined) {
      return;
    }
    // The *client* box, not the bounding rect: a scrollbar takes room from one
    // and not the other, and sizing a canvas from the wrong one is how a
    // scrollbar starts flickering itself in and out.
    const boxWidth = Math.max(1, frame.clientWidth);
    const boxHeight = Math.max(1, frame.clientHeight);
    const cells = this.previewCells();
    const geometry = this.geometry();
    const zoom = this.previewZoom();
    const mode = this.previewMode();

    // At a zoom the board may want more room than the panel has, and then the
    // canvas is the board's size and the panel scrolls it. Measured first,
    // because the framing has to centre inside whatever the canvas ends up
    // being (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
    const measured = fitPreview(cells, geometry, boxWidth, boxHeight, mode, PREVIEW_PADDING, zoom);
    const width = zoom === null ? boxWidth : Math.max(boxWidth, Math.ceil(measured.contentWidth));
    const height =
      zoom === null ? boxHeight : Math.max(boxHeight, Math.ceil(measured.contentHeight));

    const context = canvas.getContext('2d');
    if (context === null) {
      return;
    }
    // One policy for every canvas in the application
    // (`renderer/canvas-surface.ts`). This board used to read the device ratio
    // uncapped, so a 3x screen was asking a tab for nine times the pixels.
    prepareSurface(context, { width, height });
    if (cells.length === 0) {
      return;
    }

    const view = fitPreview(cells, geometry, width, height, mode, PREVIEW_PADDING, zoom);
    this.view = { layout: view, width, height };
    this.fitted.set(view.layout.hexWidth / Math.max(1, geometry.width));
    drawPreview(context, cells, geometry, view, this.source);
    this.strokeGrid(context, view);
  }

  /**
   * The pixel grid, over the image being painted and nothing else.
   *
   * Only where an author is drawing: a grid over the whole board would be a
   * hatch over neighbours nobody is editing. Below a few pixels a square it is
   * noise, so it stops.
   */
  private strokeGrid(context: CanvasRenderingContext2D, view: PreviewLayout): void {
    const sprite = this.openSprite();
    const target = this.openImage();
    const painted = this.paintedAt();
    const cell = this.previewCells().find(
      (one) => one.at.col === painted.col && one.at.row === painted.row,
    );
    if (!this.showGrid() || sprite === null || target === null || cell === undefined) {
      return;
    }
    const drop = dropOf(cell.elevation, target.level, this.geometry());
    const box = previewImageBox(cell, this.geometry(), view, this.openKind(), drop);
    const perX = box.width / Math.max(1, sprite.width);
    const perY = box.height / Math.max(1, sprite.height);
    if (Math.min(perX, perY) < GRID_ZOOM) {
      return;
    }

    context.save();
    context.translate(view.originX, view.originY);
    context.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    context.lineWidth = 1;
    context.beginPath();
    for (let x = 1; x < sprite.width; x += 1) {
      context.moveTo(box.x + x * perX, box.y);
      context.lineTo(box.x + x * perX, box.y + box.height);
    }
    for (let y = 1; y < sprite.height; y += 1) {
      context.moveTo(box.x, box.y + y * perY);
      context.lineTo(box.x + box.width, box.y + y * perY);
    }
    context.stroke();
    context.restore();
  }
}
