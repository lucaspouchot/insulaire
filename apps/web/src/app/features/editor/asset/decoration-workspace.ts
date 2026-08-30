/**
 * The decoration editor.
 *
 * It edits **decoration definitions** — the things that stand on a hex without
 * being the hex: a tree, a house, a chest, a bush, a signpost. Several may
 * share one cell, and what makes them share it properly is three numbers this
 * screen exists to get right
 * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`):
 *
 * * the **anchor** — which pixel of the image lands on the cell's ground point;
 * * the **plane** — whether a character walking onto that cell passes in front
 *   of it or behind it;
 * * the **order** — where it sits among the other decorations of its plane.
 *
 * So the scene is not a sprite on a checkerboard. It is the decoration **on a
 * hexagon**, at the geometry the project's tile set declares, with a figure
 * standing on the same hexagon: the plane switch visibly moves the tree in
 * front of the walker or behind them, and the anchor is set by dragging the
 * image until its trunk sits on the ground point. Typing `[8, 31]` and hoping
 * is what this replaces.
 *
 * An animated decoration is a **flipbook** — one image per frame — not a
 * skeleton. A named animation is also how a decoration has *states*: a chest
 * declares `closed` and `open`, each one frame long, and the scenario asks for
 * one by id. Nothing here knows what opening a chest means
 * (`docs/adr/ADR-0004-scenario-runtime.md`).
 *
 * The pixels are painted on the same surface every other category paints on
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`), and the placement
 * is resolved by the Rust resolver the map will use — so what an author lines
 * up here is what a map will draw.
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
  ContentRef,
  DECORATION_SCHEMA_VERSION,
  DEFAULT_CHARACTER_HEIGHT_TILES,
  DEFAULT_DECORATION_RESOLUTION,
  DecorationAnimation,
  DecorationCategory,
  DecorationDefinition,
  DecorationPlane,
  MAX_FLIPBOOK_FRAMES,
  MAX_DECORATION_ORDER,
  ProjectionMode,
  ResolvedCharacter,
  ResolvedDecoration,
  SpriteResolution,
  TileArtGeometry,
  tileArtGeometry,
} from '../../../../content/content-types';
import { serializeDecoration } from '../../../../content/decoration-serializer';
import { SpriteDocument } from '../../../../content/sprite-document';
import { assetUrl } from '../../../../core/asset-url';
import { Point } from '../../../../core/hex/hex-layout';
import { zoomBy } from '../../../../renderer/canvas-surface';
import { SpriteCache, drawCharacter } from '../../../../renderer/character-renderer';
import { flatHexagon, surfaceHexagon } from '../../../../renderer/tile-preview';
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import {
  ContentWorkspaceService,
  WorkspaceFile,
} from '../../../services/content-workspace.service';
import { CharacterLibraryService } from '../../../services/character-library.service';
import { DecorationLibraryService } from '../../../services/decoration-library.service';
import { EngineService } from '../../../services/engine.service';
import { LocaleAuthoringService } from '../../../services/locale-authoring.service';
import { CONTENT_ROOT, ProjectStoreService } from '../../../services/project-store.service';
import { AssetWorkspace } from './asset-workspace';
import { clampResolution, move } from './asset-editing';
import { PixelEditor } from './pixel-editor';
import { DraftSet } from '../../../editing/draft-set';
import { DraftSource } from '../../../editing/draft-source';
import { FlipbookClock } from '../../../editing/flipbook-clock';
import { freeId } from '../../../editing/ids';

/** The categories the picker offers, in the order it shows them. */
const CATEGORIES: readonly DecorationCategory[] = [
  'nature',
  'building',
  'prop',
  'container',
  'other',
];

/** Where a created or uploaded frame goes: a convention, not a rule. */
const ASSET_DIR = 'assets/decorations';

/** Smallest drawing box the fit will work with, in CSS pixels. */
const MIN_STAGE = 120;

/**
 * The character canvas height `characterHeightTiles` is measured against.
 *
 * Mirrors the map renderer's own unit: a 128-pixel character spans that many
 * tile faces, and every other canvas scales in proportion
 * (`docs/adr/ADR-0031-map-entity-presentation.md`).
 */
const CHARACTER_UNIT_HEIGHT = 128;

/**
 * The picker's entry for the plain silhouette.
 *
 * Not a character id — no definition may start with `#` — because it is not a
 * character: it is what a project shipping none has to stand on the hex, and
 * what an author reaches for when a real figure's art is in the way of the
 * decoration they are lining up.
 */
const GENERIC_FIGURE = '#silhouette';

/** Colours the hex stage draws with; chrome, never content. */
const CHROME = {
  ground: 'rgba(122, 192, 255, 0.10)',
  outline: 'rgba(122, 192, 255, 0.55)',
  figure: 'rgba(233, 196, 106, 0.35)',
  figureEdge: 'rgba(233, 196, 106, 0.8)',
  anchor: '#7ac0ff',
  bounds: 'rgba(255, 255, 255, 0.18)',
} as const;

/**
 * How wide the reference figure is drawn, as a fraction of its height.
 *
 * The shipped human is authored on a 64x128 canvas and does not fill it, so a
 * silhouette a little narrower than half its height is what a character reads
 * as (`docs/adr/ADR-0024-character-definitions.md`).
 */
const FIGURE_ASPECT = 0.38;

@Component({
  selector: 'app-decoration-workspace',
  imports: [TranslatePipe, AssetWorkspace, PixelEditor],
  templateUrl: './decoration-workspace.html',
  styleUrl: './decoration-workspace.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:beforeunload)': 'onUnload($event)' },
})
export class DecorationWorkspace implements AfterViewInit, OnDestroy {
  private readonly store = inject(ProjectStoreService);
  private readonly engine = inject(EngineService);
  private readonly i18n = inject(I18nService);
  private readonly workspace = inject(ContentWorkspaceService);
  private readonly library = inject(DecorationLibraryService);
  /**
   * The project's characters, for the figure standing on the hex.
   *
   * A *real* one: the plane decision is "does a character pass in front of
   * this", and the honest way to answer it is the character the game will
   * actually draw, at the scale the map will draw it
   * (`docs/adr/ADR-0031-map-entity-presentation.md`).
   */
  private readonly characters = inject(CharacterLibraryService);
  private readonly locales = inject(LocaleAuthoringService);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('stage');
  private readonly frameRef = viewChild<ElementRef<HTMLElement>>('frame');

  /**
   * The editing session: what is held, what is open, what is unwritten.
   *
   * The whole of load and save, which this screen only supplies the
   * decoration's half of (`app/editing/draft-set.ts`).
   */
  private readonly drafts = new DraftSet<DecorationDefinition>(this.draftSource(), {
    i18n: this.i18n,
    workspace: this.workspace,
    manifest: this.store,
    locales: this.locales,
  });

  protected readonly report = this.drafts.report;
  protected readonly message = this.drafts.message;
  protected readonly error = this.drafts.error;
  protected readonly busy = this.drafts.busy;
  protected readonly loading = this.drafts.loading;
  /** Paths the manifest declares that could not be read. */
  protected readonly unreadable = this.drafts.unreadable;
  /** Content files the workspace holds, for the frame picker. */
  protected readonly files = signal<readonly WorkspaceFile[]>([]);

  /** Which surface is open: the hexagon, or the frame's own pixels. */
  protected readonly scene = signal<'hex' | 'flat'>('hex');
  /** Which projection the hexagon is drawn in; a *view* setting, not content. */
  protected readonly projection = signal<ProjectionMode>('isometric');
  /**
   * Which character stands on the hexagon: an id, or `''` for none.
   *
   * A player, an NPC or a monster — whichever the author needs to judge this
   * decoration against. Empty until the library has loaded, and then the first
   * definition the project ships.
   */
  protected readonly figureId = signal('');
  /** The hex stage's zoom; `null` fits the hexagon and the image to the frame. */
  protected readonly hexZoom = signal<number | null>(null);
  /** The whole-number zoom the hex stage settled on, for the readout. */
  protected readonly shownZoom = signal(1);
  /** The flat surface's zoom, so the file bar steps whichever one is open. */
  protected readonly flatZoom = signal(6);
  protected readonly showGrid = signal(true);

  /** Id of the animation being edited and played. */
  private readonly animationIdSignal = signal<string | null>(null);

  /**
   * Play, pause and scrub, over the open animation.
   *
   * Which frame that is, is `content/flipbook.ts`'s answer — the same one the
   * Rust resolver gives, so the readout and the picture cannot disagree.
   */
  private readonly clock = new FlipbookClock(
    () => this.animation(),
    () => this.repose(),
  );

  protected readonly playing = this.clock.playing;
  /** What the resolver made of the open definition at that moment. */
  protected readonly resolved = signal<ResolvedDecoration | null>(null);

  /** The frames open for editing, by content path. */
  private readonly sessions = new Map<string, SpriteDocument>();
  /** Paths being decoded, so the effect asks for each of them only once. */
  private readonly opening = new Set<string>();
  /** Decoded images for the hex stage, by content path. */
  private readonly images = new Map<string, HTMLImageElement>();
  /** Paths already asked for, so a missing file is not fetched every frame. */
  private readonly requested = new Set<string>();
  /** Bumped by every stroke and every decode, so the view re-reads the pixels. */
  private readonly strokes = signal(0);

  /** The reference character's own sprites, fetched as the stage asks for them. */
  private readonly figureSprites = new SpriteCache(
    (asset) => assetUrl(`${CONTENT_ROOT}/${asset}`),
    () => this.draw(),
  );

  /** A drag on the hex stage, and where it started. */
  private dragging: { x: number; y: number; anchor: [number, number] } | null = null;
  private resizeObserver: ResizeObserver | null = null;

  protected readonly categories = CATEGORIES;
  protected readonly maxOrder = MAX_DECORATION_ORDER;
  protected readonly maxFrames = MAX_FLIPBOOK_FRAMES;

  /** Every definition, in project order. */
  protected readonly documents = this.drafts.drafts;

  /** The definition being edited, or `null` when the project has none. */
  protected readonly document = this.drafts.open;

  /** Path this definition's file has, declared or by convention. */
  protected readonly path = computed(() => {
    const document = this.document();
    return document === null ? '' : this.store.decorationPath(document.id);
  });

  /** `true` when the open definition, or a frame it owns, differs from disk. */
  protected readonly dirty = this.drafts.dirty;

  /** `true` when files can actually be written — the editor is honest about it. */
  protected readonly writable = computed(() => this.workspace.status() !== null);

  /** `true` when the manifest does not list the open definition. */
  protected readonly unlisted = computed(() => {
    const document = this.document();
    if (document === null) {
      return false;
    }
    return !(this.store.project()?.decorations ?? []).some((entry) => entry.id === document.id);
  });

  /** The canvas the open definition's frames are drawn on. */
  protected readonly resolution = computed<SpriteResolution>(
    () => this.document()?.resolution ?? { ...DEFAULT_DECORATION_RESOLUTION },
  );

  /** Where the anchor is, as two numbers the form edits. */
  protected readonly anchor = computed<[number, number]>(() => this.document()?.anchor ?? [0, 0]);

  /**
   * The pixel grid the hexagon is drawn on.
   *
   * The project's own tile geometry, not a shape this screen invented: a
   * decoration is judged against the tiles it will stand on
   * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
   */
  protected readonly geometry = computed<TileArtGeometry>(() => {
    const tileSet = this.store.tileSetDefinitions()[0];
    return tileArtGeometry(tileSet ?? {});
  });

  /** Every image in the content directory, which is what a frame may name. */
  protected readonly assets = computed<readonly WorkspaceFile[]>(() =>
    this.files().filter((file) => /\.(png|gif|webp)$/i.test(file.path)),
  );

  /** The characters the figure picker offers, in manifest order. */
  protected readonly figureChoices = this.characters.choices;

  /** The picker's value for the plain silhouette, for the template. */
  protected readonly genericFigure = GENERIC_FIGURE;

  /**
   * The character standing on the hexagon, resolved by the engine.
   *
   * The same resolver the game draws with, so what an author judges the plane
   * against is a real figure at the real proportion and not a stand-in
   * (`docs/adr/ADR-0024-character-definitions.md`). `null` falls back to the
   * plain silhouette, which is what a project shipping no character gets.
   */
  protected readonly figure = computed<ResolvedCharacter | null>(() => {
    const id = this.figureId();
    if (id.length === 0 || id === GENERIC_FIGURE || !this.engine.isReady) {
      return null;
    }
    try {
      return this.engine.resolveCharacter(id);
    } catch {
      // A definition the engine will not resolve is one the character editor
      // reports; here it simply means no figure.
      return null;
    }
  });

  protected readonly animations = computed<readonly DecorationAnimation[]>(
    () => this.document()?.animations ?? [],
  );

  /** The animation being edited, or `null` when the definition declares none. */
  protected readonly animation = computed<DecorationAnimation | null>(() => {
    const id = this.animationIdSignal();
    const animations = this.animations();
    return animations.find((entry) => entry.id === id) ?? animations[0] ?? null;
  });

  protected readonly frames = computed<readonly string[]>(() => this.animation()?.frames ?? []);

  /** Which frame the author is on — the clock's answer, running or parked. */
  protected readonly frameIndex = this.clock.frame;

  /** The image that frame names, empty when it names none. */
  protected readonly openAsset = computed(() => this.frames()[this.frameIndex()] ?? '');

  /** The pixels behind that image, once it has been decoded. */
  protected readonly sprite = computed<SpriteDocument | null>(() => {
    this.strokes();
    const asset = this.openAsset();
    return asset.length === 0 ? null : (this.sessions.get(asset) ?? null);
  });

  /** Frames holding pixels the content directory has not been told about. */
  protected readonly unsavedSprites = computed<readonly string[]>(() => {
    this.strokes();
    return [...this.sessions].filter(([, sprite]) => sprite.unsaved).map(([asset]) => asset);
  });

  protected readonly errorCount = this.drafts.errorCount;

  constructor() {
    void this.drafts.load();

    // Everything the stage draws from, in one place: reading them here is what
    // makes the canvas repaint when any of them moves.
    effect(() => {
      this.document();
      this.resolved();
      this.scene();
      this.projection();
      this.figure();
      this.hexZoom();
      this.geometry();
      this.strokes();
      this.draw();
    });

    // The frames of the open animation are decoded on demand: a decoration the
    // author has not opened costs nothing.
    effect(() => {
      for (const asset of this.frames()) {
        this.require(asset);
      }
    });
  }

  ngAfterViewInit(): void {
    const frame = this.frameRef()?.nativeElement;
    if (frame !== undefined && typeof ResizeObserver !== 'undefined') {
      // A canvas sized in script from its parent's box has to be repainted when
      // that box moves — the inspector divider moves it without a window resize
      // (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
      this.resizeObserver = new ResizeObserver(() => this.draw());
      this.resizeObserver.observe(frame);
    }
    this.draw();
  }

  ngOnDestroy(): void {
    this.clock.stop();
    this.resizeObserver?.disconnect();
    this.sessions.clear();
  }

  // ----------------------------------------------------------------- source

  /**
   * What a *decoration* means by reading, validating, writing and declaring.
   *
   * Everything else about the session — the order of the steps, the bail-out on
   * a failing verdict, what a rename takes with it — is `DraftSet`'s.
   */
  private draftSource(): DraftSource<DecorationDefinition> {
    return {
      messages: {
        invalid: 'ui.editor.decoration.invalid',
        saved: 'ui.editor.decoration.saved',
        spritesSaved: 'ui.editor.decoration.framesSaved',
        savedManifest: 'ui.editor.decoration.savedManifest',
      },
      prepare: async () => {
        await this.engine.ready();
        await this.i18n.ensureAdopted();
        await this.store.ensureLoaded();
        await this.workspace.ensureProbed();
        // Registered as well as fetched: the *runtime* holds these, and this
        // screen is about to replace one of them.
        await this.library.ensureLoaded();
        // The figure is a real character, so the library it comes from has to
        // be in the engine before the stage asks for one.
        await this.characters.ensureLoaded();
        // The first real character the project ships, or the plain silhouette
        // when it ships none: the hex is judged against *something* by default.
        this.figureId.set(this.characters.choices()[0]?.id ?? GENERIC_FIGURE);
        await this.refreshFiles();
      },
      declared: () => this.store.project()?.decorations ?? [],
      read: (entry) => this.fetchDecoration(entry),
      pathOf: (id) => this.store.decorationPath(id),
      serialize: (document) => serializeDecoration(document),
      // The project's own grid goes with it: `decoration.overflowsCell` is the
      // one check that needs to know what a hex is.
      validate: (_document, json) => this.engine.validateDecoration(json, this.geometry()),
      adopt: (id, json) => this.library.adopt(id, json),
      forget: (id) => this.library.forget(id),
      declare: (id, path) => this.store.declareDecoration(id, path),
      undeclare: (id) => this.store.undeclareDecoration(id),
      dirtySprites: (document) => {
        this.strokes();
        return (document.animations ?? [])
          .flatMap((animation) => animation.frames)
          .filter((asset) => this.sessions.get(asset)?.unsaved === true);
      },
      writeSprites: () => this.writeSprites(),
      // A decoration is not player-facing text: it names no locale keys.
      keysOf: () => [],
      removed: () => {},
      refresh: () => this.repose(),
    };
  }

  private async refreshFiles(): Promise<void> {
    if (this.workspace.status() === null) {
      return;
    }
    try {
      this.files.set(await this.workspace.list());
    } catch {
      // Reported by the workspace service; the editor stays usable without it.
    }
  }

  /**
   * Reads one declared definition off disk.
   *
   * A file that is missing or unreadable is skipped rather than fatal: the
   * manifest is content like any other and may name a file nobody wrote yet.
   */
  private async fetchDecoration(entry: ContentRef): Promise<DecorationDefinition | null> {
    try {
      const response = await fetch(assetUrl(`${CONTENT_ROOT}/${entry.path}`));
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as DecorationDefinition;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ edits

  private edit(mutate: (draft: DecorationDefinition) => void): void {
    this.drafts.edit(mutate);
  }

  /** Applies a change to the open animation. */
  private editAnimation(mutate: (draft: DecorationAnimation) => void): void {
    const open = this.animation();
    if (open === null) {
      return;
    }
    this.edit((draft) => {
      const target = (draft.animations ?? []).find((entry) => entry.id === open.id);
      if (target !== undefined) {
        mutate(target);
      }
    });
  }

  protected open(id: string): void {
    this.drafts.select(id);
    this.animationIdSignal.set(null);
    this.clock.seek(0);
  }

  /**
   * Adds a definition to the project and opens it.
   *
   * It starts as **exactly its hex**: the project's own tile box for a canvas,
   * anchored at the middle of it. A new decoration is then a picture of the
   * cell it stands on — it fits, so nothing is reported about it, and the first
   * thing an author does is draw rather than fix a warning.
   *
   * The *foot* is one button away, and that is the right shape for it: a thing
   * standing on the ground wants its anchor at its bottom middle, and that is
   * a statement about a drawing that does not exist yet.
   */
  protected addDecoration(): void {
    const id = freeId(
      'decoration',
      this.documents().map((document) => document.id),
    );
    // The canvas a new decoration starts on is **this project's hex**, not the
    // schema's fallback: a prop is drawn against the tiles it will stand on,
    // and a 32-pixel canvas on a 64-pixel tile set is a first edit every author
    // would have to make (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
    const geometry = this.geometry();
    const resolution = {
      width: clampResolution(geometry.width),
      height: clampResolution(geometry.flatHeight),
    };
    const anchor: [number, number] = [
      Math.round(resolution.width / 2),
      Math.round(resolution.height / 2),
    ];
    const document: DecorationDefinition = {
      id,
      schemaVersion: DECORATION_SCHEMA_VERSION,
      name: id,
      category: 'other',
      resolution,
      anchor,
      plane: 'behind',
      order: 0,
      animations: [{ id: 'idle', frames: [''] }],
    };

    this.drafts.add(document);
    this.animationIdSignal.set(null);
    this.clock.seek(0);
  }

  /**
   * Removes the open definition from the editor and from the manifest.
   *
   * The file is left on disk: deleting content is a decision an author makes
   * with their own tools, and a manifest that no longer lists it is enough to
   * take it out of the game.
   */
  protected removeDecoration(): void {
    const document = this.document();
    if (document !== null) {
      this.drafts.remove(document.id);
      this.animationIdSignal.set(null);
      this.clock.seek(0);
    }
  }

  protected setId(id: string): void {
    this.edit((draft) => {
      draft.id = id.trim();
    });
  }

  protected setName(name: string): void {
    this.edit((draft) => {
      draft.name = name;
    });
  }

  protected setCategory(category: string): void {
    this.edit((draft) => {
      draft.category = category as DecorationCategory;
    });
  }

  protected setPlane(plane: DecorationPlane): void {
    this.edit((draft) => {
      draft.plane = plane;
    });
  }

  protected setOrder(raw: string): void {
    const value = Number.parseInt(raw, 10);
    this.edit((draft) => {
      draft.order = Number.isFinite(value)
        ? Math.max(-MAX_DECORATION_ORDER, Math.min(MAX_DECORATION_ORDER, value))
        : 0;
    });
  }

  protected setTags(raw: string): void {
    const tags = raw
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    this.edit((draft) => {
      draft.tags = tags;
    });
  }

  protected setAnchor(axis: 0 | 1, raw: string): void {
    const value = Math.round(Number.parseFloat(raw));
    if (!Number.isFinite(value)) {
      return;
    }
    this.edit((draft) => {
      const anchor: [number, number] = [...(draft.anchor ?? [0, 0])];
      anchor[axis] = value;
      draft.anchor = anchor;
    });
  }

  /** Puts the anchor where a thing standing on the ground wants it. */
  protected anchorToFoot(): void {
    const { width, height } = this.resolution();
    this.edit((draft) => {
      draft.anchor = [Math.round(width / 2), height - 1];
    });
  }

  /**
   * Resizes the canvas the frames are drawn on.
   *
   * The images are **not** resampled with it, for the reason a character's
   * layers are not: a canvas is the grid the art was drawn on, and stretching
   * it would move every pixel an author placed.
   */
  protected setResolution(side: 'width' | 'height', raw: string): void {
    const value = clampResolution(Number.parseFloat(raw));
    this.edit((draft) => {
      const current = draft.resolution ?? DEFAULT_DECORATION_RESOLUTION;
      draft.resolution =
        side === 'width'
          ? { width: value, height: current.height }
          : { width: current.width, height: value };
    });
  }

  // ------------------------------------------------------------- animations

  protected openAnimation(id: string): void {
    this.animationIdSignal.set(id);
    this.clock.seek(0);
    this.repose();
  }

  protected addAnimation(): void {
    const id = freeId(
      'state',
      this.animations().map((animation) => animation.id),
    );
    this.edit((draft) => {
      draft.animations = [...(draft.animations ?? []), { id, frames: [''] }];
    });
    this.openAnimation(id);
  }

  protected removeAnimation(id: string): void {
    this.edit((draft) => {
      draft.animations = (draft.animations ?? []).filter((entry) => entry.id !== id);
      if (draft.defaultAnimation === id) {
        draft.defaultAnimation = undefined;
      }
    });
    this.animationIdSignal.set(null);
    this.clock.seek(0);
  }

  protected setAnimationId(id: string): void {
    const open = this.animation();
    const next = id.trim();
    if (open === null || next.length === 0) {
      return;
    }
    this.edit((draft) => {
      const target = (draft.animations ?? []).find((entry) => entry.id === open.id);
      if (target !== undefined) {
        target.id = next;
      }
      if (draft.defaultAnimation === open.id) {
        draft.defaultAnimation = next;
      }
    });
    this.animationIdSignal.set(next);
  }

  protected setAnimationName(name: string): void {
    this.editAnimation((draft) => {
      draft.name = name;
    });
  }

  protected setFrameDuration(raw: string): void {
    const value = Number.parseInt(raw, 10);
    this.editAnimation((draft) => {
      draft.frameDurationMs = Number.isFinite(value) ? Math.max(0, value) : undefined;
    });
  }

  protected setLooping(looping: boolean): void {
    this.editAnimation((draft) => {
      draft.looping = looping;
    });
  }

  /** Which animation plays when nothing asks for one; `''` is the first. */
  protected setDefaultAnimation(id: string): void {
    this.edit((draft) => {
      draft.defaultAnimation = id.length === 0 ? undefined : id;
    });
  }

  // ----------------------------------------------------------------- frames

  protected selectFrame(index: number): void {
    this.clock.seek(index);
    this.repose();
  }

  protected addFrame(): void {
    if (this.frames().length >= MAX_FLIPBOOK_FRAMES) {
      return;
    }
    this.editAnimation((draft) => {
      draft.frames = [...draft.frames, ''];
    });
    this.selectFrame(this.frames().length - 1);
  }

  protected removeFrame(index: number): void {
    this.editAnimation((draft) => {
      draft.frames = draft.frames.filter((_frame, at) => at !== index);
    });
    this.selectFrame(Math.max(0, index - 1));
  }

  protected moveFrame(index: number, delta: number): void {
    this.editAnimation((draft) => move(draft.frames, index, delta));
    this.selectFrame(index + delta);
  }

  protected setFrame(index: number, asset: string): void {
    const path = asset.trim();
    this.editAnimation((draft) => {
      draft.frames = draft.frames.map((frame, at) => (at === index ? path : frame));
    });
    this.require(path);
  }

  /** `true` when a frame names a file the content directory does not hold. */
  protected frameMissing(asset: string): boolean {
    const files = this.files();
    return asset.length > 0 && files.length > 0 && !files.some((file) => file.path === asset);
  }

  /** Creates a blank image at the declared canvas size and points a frame at it. */
  protected createFrame(index: number): void {
    const document = this.document();
    const animation = this.animation();
    if (document === null || animation === null) {
      return;
    }
    const { width, height } = this.resolution();
    const path = `${ASSET_DIR}/${document.id}_${animation.id}_${index}.png`;
    const sprite = SpriteDocument.blank(width, height);
    // It exists nowhere else, so it owes the disk a write from the moment it is
    // created rather than from its first stroke.
    sprite.markUnsaved();
    this.sessions.set(path, sprite);
    this.touchSprites();
    this.setFrame(index, path);
  }

  /**
   * Uploads an image into the content directory and points a frame at it.
   *
   * The same door the character editor opens, at the same convention: an author
   * with a PNG should not have to leave the editor to use it
   * (`docs/adr/ADR-0019-authoring-content-workspace.md`).
   */
  protected async uploadFrame(event: Event, index: number): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    input.value = '';

    this.drafts.setBusy(true);
    this.drafts.fail(null);
    try {
      const path = `${ASSET_DIR}/${file.name}`;
      await this.workspace.write(path, file);
      await this.refreshFiles();
      // The decoded copies hold the bytes this path used to have.
      this.forgetImage(path);
      this.setFrame(index, path);
      this.drafts.announce(this.i18n.t('ui.editor.decoration.uploaded', { file: path }));
    } catch (cause) {
      this.drafts.fail(cause);
    } finally {
      this.drafts.setBusy(false);
    }
  }

  // -------------------------------------------------------------- playback

  protected togglePlay(): void {
    this.clock.togglePlay();
  }

  // --------------------------------------------------------------- validate

  /** Re-validates and re-resolves the open definition. */
  protected refresh(): void {
    this.drafts.refresh();
  }

  /**
   * Re-resolves the preview without re-validating it.
   *
   * What playback and scrubbing call sixty times a second: a verdict cannot
   * change because time passed, and serialising the definition to re-validate
   * on every frame would be the one expensive thing in the loop.
   */
  private repose(): void {
    const document = this.document();
    if (document === null || !this.engine.isReady) {
      this.resolved.set(null);
      return;
    }
    try {
      this.resolved.set(
        this.engine.previewDecoration(document, this.animation()?.id, this.clock.timeMs()),
      );
    } catch (cause) {
      this.drafts.fail(cause);
    }
  }

  /** Writes the open definition into the content directory. */
  protected save(): Promise<void> {
    return this.drafts.save();
  }

  /** Pixels and definitions both live in memory until they are written. */
  protected onUnload(event: BeforeUnloadEvent): void {
    if (this.drafts.anyUnsaved() || this.unsavedSprites().length > 0) {
      event.preventDefault();
    }
  }

  // ------------------------------------------------------------------ pixels

  protected onPainted(): void {
    this.touchSprites();
  }

  /**
   * Writes the edited frames, one PNG each.
   *
   * @returns how many were written
   */
  private async writeSprites(): Promise<number> {
    const pending = [...this.sessions].filter(([, sprite]) => sprite.unsaved);
    for (const [asset, sprite] of pending) {
      await this.workspace.write(asset, await sprite.toBlob());
      sprite.markSaved();
    }
    if (pending.length > 0) {
      await this.refreshFiles();
      this.touchSprites();
    }
    return pending.length;
  }

  /** Opens a frame for editing and for drawing, at most once per path. */
  private require(asset: string): void {
    if (asset.length === 0 || this.requested.has(asset)) {
      return;
    }
    this.requested.add(asset);
    void this.decode(asset);
  }

  private async decode(asset: string): Promise<void> {
    if (this.opening.has(asset)) {
      return;
    }
    this.opening.add(asset);
    try {
      const image = await loadImage(asset);
      if (image === null) {
        // A path naming nothing is already reported as a missing frame, and the
        // stage draws the box the image would have filled.
        return;
      }
      this.images.set(asset, image);
      const sprite = SpriteDocument.fromImage(image);
      if (sprite !== null) {
        this.sessions.set(asset, sprite);
      }
      this.touchSprites();
    } finally {
      this.opening.delete(asset);
    }
  }

  /** Drops what was decoded for a path whose bytes have just changed. */
  private forgetImage(asset: string): void {
    this.images.delete(asset);
    this.sessions.delete(asset);
    this.requested.delete(asset);
  }

  /** Tells the view that the pixels moved. */
  private touchSprites(): void {
    this.strokes.update((count) => count + 1);
    // The session decides what "unsaved" means, and a stroke is half of it.
    this.drafts.touchSprites();
  }

  // -------------------------------------------------------------- the stage

  protected zoomBy(delta: number): void {
    if (this.scene() === 'flat') {
      this.flatZoom.set(zoomBy(this.flatZoom(), delta));
      return;
    }
    this.hexZoom.set(zoomBy(this.shownZoom(), delta));
  }

  protected fitZoom(): void {
    if (this.scene() === 'flat') {
      this.flatZoom.set(6);
      return;
    }
    this.hexZoom.set(null);
  }

  /** The zoom shown in the file bar, whichever surface is open. */
  protected readonly barZoom = computed(() =>
    this.scene() === 'flat' ? this.flatZoom() : this.shownZoom(),
  );

  /**
   * Drags the image to place the anchor.
   *
   * The anchor is the pixel of the image that sits on the ground point, so
   * moving the image *up* moves the anchor *down* its own canvas — which is
   * why this is a delta on the anchor rather than a position for it.
   */
  protected onPointerDown(event: PointerEvent): void {
    if (this.document() === null) {
      return;
    }
    event.preventDefault();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    this.dragging = { x: event.clientX, y: event.clientY, anchor: [...this.anchor()] };
  }

  protected onPointerMove(event: PointerEvent): void {
    const start = this.dragging;
    if (start === null) {
      return;
    }
    const zoom = Math.max(1, this.shownZoom());
    const dx = Math.round((event.clientX - start.x) / zoom);
    const dy = Math.round((event.clientY - start.y) / zoom);
    const next: [number, number] = [start.anchor[0] - dx, start.anchor[1] - dy];
    if (next[0] === this.anchor()[0] && next[1] === this.anchor()[1]) {
      return;
    }
    this.edit((draft) => {
      draft.anchor = next;
    });
  }

  protected onPointerUp(event: PointerEvent): void {
    this.dragging = null;
    (event.target as Element).releasePointerCapture?.(event.pointerId);
  }

  /** Ctrl or Cmd with the wheel zooms; a plain wheel is left to the scroller. */
  protected onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    this.zoomBy(event.deltaY < 0 ? 1 : -1);
  }

  /**
   * Draws the hexagon, the decoration and the reference figure.
   *
   * The order *is* the decision this screen exists to make visible: everything
   * in the `behind` plane, then the characters, then everything in `front`
   * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   */
  private draw(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const frame = this.frameRef()?.nativeElement;
    if (canvas === undefined || frame === undefined) {
      return;
    }

    const box = frame.getBoundingClientRect();
    const width = Math.max(MIN_STAGE, Math.floor(box.width));
    const height = Math.max(MIN_STAGE, Math.floor(box.height));
    const density = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(width * density);
    canvas.height = Math.floor(height * density);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext('2d');
    if (context === null) {
      return;
    }
    context.setTransform(density, 0, 0, density, 0, 0);
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = false;

    const geometry = this.geometry();
    const resolution = this.resolution();
    const anchor = this.anchor();

    // The fit holds the hexagon and the image, and **nothing else**. The
    // reference figure is deliberately left out of it: it is two tile faces
    // tall, so letting it drive the zoom pushed the hex to the bottom of the
    // frame and, at a large interface scale, out of it — and the hex is the one
    // thing an author is always lining something up against. A guide may be
    // clipped; the cell may not.
    const hexHeight =
      this.projection() === 'isometric' ? geometry.surfaceHeight : geometry.flatHeight;
    const spread = {
      left: Math.max(geometry.width / 2, anchor[0]),
      right: Math.max(geometry.width / 2, resolution.width - anchor[0]),
      up: Math.max(hexHeight / 2, anchor[1]),
      down: Math.max(hexHeight / 2, resolution.height - anchor[1]),
    };
    const zoom =
      this.hexZoom() ??
      Math.max(
        1,
        Math.floor(
          Math.min(
            (width - 24) / Math.max(1, spread.left + spread.right),
            (height - 24) / Math.max(1, spread.up + spread.down),
          ),
        ),
      );
    if (zoom !== this.shownZoom()) {
      this.shownZoom.set(zoom);
    }

    // The ground point: the origin everything else is measured from, placed so
    // the *whole* spread is centred in the frame. The sign matters — reaching
    // further up than down moves the ground point **down**, not up, and getting
    // it backwards is what put the reference figure's head off the top.
    const groundX = Math.round(width / 2 + ((spread.left - spread.right) / 2) * zoom);
    const groundY = Math.round(height / 2 + ((spread.up - spread.down) / 2) * zoom);

    const hexagon = (
      this.projection() === 'isometric' ? surfaceHexagon(geometry) : flatHexagon(geometry)
    ).map((corner: Point) => ({
      x: groundX + (corner.x - geometry.width / 2) * zoom,
      y: groundY + (corner.y - hexHeight / 2) * zoom,
    }));

    context.beginPath();
    hexagon.forEach((corner, index) => {
      if (index === 0) {
        context.moveTo(corner.x, corner.y);
      } else {
        context.lineTo(corner.x, corner.y);
      }
    });
    context.closePath();
    context.fillStyle = CHROME.ground;
    context.fill();
    context.strokeStyle = CHROME.outline;
    context.lineWidth = 1;
    context.stroke();

    // The figure is a *comparison*, so it is drawn only when there is something
    // to compare it against: on an empty library it is a shape with no meaning,
    // standing where the decoration would be.
    const open = this.document();
    const drawGuide = (): void => {
      if (open !== null && this.figureId().length > 0) {
        this.drawFigure(context, groundX, groundY, zoom, hexHeight);
      }
    };
    if ((open?.plane ?? 'behind') === 'behind') {
      this.blit(context, groundX, groundY, zoom);
      drawGuide();
    } else {
      drawGuide();
      this.blit(context, groundX, groundY, zoom);
    }

    this.drawAnchor(context, groundX, groundY);
  }

  /** The resolved frame, placed by the box the Rust resolver produced. */
  private blit(
    context: CanvasRenderingContext2D,
    groundX: number,
    groundY: number,
    zoom: number,
  ): void {
    const resolved = this.resolved();
    if (resolved === null) {
      return;
    }
    const [x, y, boxWidth, boxHeight] = resolved.placement;
    const left = groundX + x * zoom;
    const top = groundY + y * zoom;

    const painted = this.sessions.get(resolved.asset)?.surface() ?? null;
    const image = painted ?? this.images.get(resolved.asset) ?? null;
    if (image === null) {
      // No image yet: the box it will fill, so the anchor can still be placed
      // against a canvas that exists only as two numbers.
      context.strokeStyle = CHROME.bounds;
      context.setLineDash([4, 3]);
      context.strokeRect(left, top, boxWidth * zoom, boxHeight * zoom);
      context.setLineDash([]);
      return;
    }
    context.drawImage(image, left, top, boxWidth * zoom, boxHeight * zoom);
  }

  /**
   * The reference figure standing on the ground point.
   *
   * A **real character** whenever the project ships one — the player, an NPC, a
   * monster, whichever the picker names — resolved by the engine's own resolver
   * and drawn by the renderer the game draws with. That is the whole point:
   * "does a character pass in front of this decoration" is a question about a
   * character, and a stand-in shape answers it only approximately.
   *
   * It is placed at the scale the map places one: a 128-pixel canvas spans
   * `characterHeightTiles` tile faces, and every other canvas scales with it,
   * so a rat is small and a dragon is not
   * (`docs/adr/ADR-0031-map-entity-presentation.md`). The zoom `drawCharacter`
   * settles on is a whole number, which is what an editor preview keeps
   * (`docs/adr/ADR-0024-character-definitions.md`), so the figure is
   * the nearest whole zoom under that height rather than exactly it.
   *
   * The plain silhouette below is the fallback for a project with no character
   * definition at all: something has to stand there, or the plane switch shows
   * nothing.
   */
  private drawFigure(
    context: CanvasRenderingContext2D,
    groundX: number,
    groundY: number,
    zoom: number,
    hexHeight: number,
  ): void {
    const character = this.figure();
    if (character !== null) {
      const unit = (hexHeight * DEFAULT_CHARACTER_HEIGHT_TILES * zoom) / CHARACTER_UNIT_HEIGHT;
      const width = character.resolution.width * unit;
      const height = character.resolution.height * unit;
      // `drawCharacter` sits the canvas on the bottom of the box, so the box's
      // bottom edge *is* the ground point and the feet land on it.
      drawCharacter(
        context,
        character,
        { x: groundX - width / 2, y: groundY - height, width, height },
        this.figureSprites,
      );
      return;
    }

    const box = figureBox(hexHeight);
    const height = box.height * zoom;
    const width = box.width * zoom;
    const head = width * 0.34;

    context.fillStyle = CHROME.figure;
    context.strokeStyle = CHROME.figureEdge;
    context.lineWidth = 1;

    // The ground shadow, which is what says the figure is standing *here*.
    context.beginPath();
    context.ellipse(groundX, groundY, width * 0.5, width * 0.17, 0, 0, Math.PI * 2);
    context.fill();

    // Body and head as one path, so the outline runs round the silhouette
    // rather than through the neck.
    const body = height - head * 2;
    context.beginPath();
    context.roundRect(groundX - width / 2, groundY - body, width, body, width * 0.35);
    context.fill();
    context.stroke();
    context.beginPath();
    context.arc(groundX, groundY - body - head, head, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }

  /** The ground point itself: a cross, so the anchor is visible under the art. */
  private drawAnchor(context: CanvasRenderingContext2D, groundX: number, groundY: number): void {
    context.strokeStyle = CHROME.anchor;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(groundX - 6.5, groundY + 0.5);
    context.lineTo(groundX + 6.5, groundY + 0.5);
    context.moveTo(groundX + 0.5, groundY - 6.5);
    context.lineTo(groundX + 0.5, groundY + 6.5);
    context.stroke();
  }
}

/**
 * How large the reference figure is drawn, in authored pixels.
 *
 * `characterHeightTiles` tile faces tall, which is what a map means by "as tall
 * as a character" (`docs/adr/ADR-0031-map-entity-presentation.md`). Shared by
 * the fit and the draw, so the guide can never be sized into the frame's edge.
 */
function figureBox(hexHeight: number): { width: number; height: number } {
  const height = hexHeight * DEFAULT_CHARACTER_HEIGHT_TILES;
  return { width: height * FIGURE_ASPECT, height };
}

function loadImage(asset: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', () => resolve(null));
    image.src = assetUrl(`${CONTENT_ROOT}/${asset}`);
  });
}
