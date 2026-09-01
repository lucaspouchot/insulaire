/**
 * The character editor.
 *
 * It edits **character definitions** — how a kind of character is drawn, and
 * what may be chosen about one. The player's character is simply the first of
 * them; nothing on this screen knows what a player is, and the same form
 * creates a merchant, a goblin or a dragon
 * (`docs/adr/ADR-0024-character-definitions.md`).
 *
 * A definition is two lists:
 *
 * * **parameters** — the choices it offers, written in the settings vocabulary,
 *   so "hair colour" is a `color` control and the player's character-creation
 *   screen will render it with the component that renders a volume slider
 *   (`docs/adr/ADR-0022-settings.md`);
 * * **layers** — the pieces it is drawn from, each with variants that answer to
 *   those choices.
 *
 * The preview on the right is not a mock-up. The customisation form is the real
 * `control-field`, the resolution is the real Rust resolver, and the drawing is
 * `character-renderer.ts` — the same three pieces the game will use. What an
 * author sees here is what a player gets.
 *
 * The preview is also the **drawing surface**. A character is made of small
 * PNGs, and an editor that could place them but not paint them would send an
 * author to another tool for every pixel; so the stage opens the sprite behind
 * the layer being edited and writes into it — pencil, eraser, eyedropper, the
 * character's own palette, and a whole-number zoom
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 *
 * A character is also a **skeleton**: a layer may hang off another one, and an
 * animation moves a node by whole pixels with everything below it following.
 * The preview is where that is watched — resolved by the same Rust code the
 * game will use, at the moment the timeline names
 * (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`).
 *
 * Labels are keys: this screen picks and **creates** them — saving writes every
 * key the file names into every language, empty — and the language editor is
 * where their text is written (ADR-0020,
 * `docs/adr/ADR-0020-localised-content-keys.md`).
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
  Animation,
  AttachmentPoint,
  CATEGORIES,
  CONTROL_KINDS,
  EDITOR_TABS,
  EditorTab,
  CharacterCategory,
  CharacterDefinition,
  CharacterLayer,
  CharacterValues,
  ControlDefinition,
  ControlKind,
  HierarchyRow,
  LayerVariant,
  DEFAULT_FRAME_DURATION_MS,
  MAX_SPRITE_RESOLUTION,
  PixelOffset,
  PixelRect,
  ResolvedCharacter,
  SettingValue,
  SpriteResolution,
  blankVariant,
  heldOffset,
  hierarchy,
  isNumeric,
  usesOptions,
  wouldLoop,
} from './character-editor.types';
import { clampResolution, move } from './asset-editing';
import { AssetWorkspace } from './asset-workspace';
import { CharacterAnimator } from './character-animator';
import { PixelEditor } from './pixel-editor';
import { PixelTool, PixelTools } from './pixel-tools';
import { CHARACTER_SCHEMA_VERSION, ResolvedLayer } from '../../../../content/generated/character';
import { ContentRef } from '../../../../content/generated/project';
import { serializeCharacter } from '../../../../content/character-serializer';
import { PALETTE_SIZE, SpriteDocument } from '../../../../content/sprite-document';
import { assetUrl } from '../../../../core/asset-url';
import { isEditableTarget, routeUndoRedo } from '../../../../core/keyboard-shortcuts';
import {
  CharacterBox,
  SpriteCache,
  SpriteSource,
  drawCharacter,
  pixelUnder,
  placement,
} from '../../../../renderer/character-renderer';
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import { ControlField } from '../../../settings/control-field';
import {
  ContentWorkspaceService,
  WorkspaceFile,
} from '../../../services/content-workspace.service';
import { CharacterPose, EngineService } from '../../../services/engine.service';
import { LocaleAuthoringService } from '../../../services/locale-authoring.service';
import { CharacterLibraryService } from '../../../services/character-library.service';
import { ProjectManifest } from '../../../project/project-manifest';
import { WriteLedger } from '../../../project/write-ledger';
import { CONTENT_ROOT, ProjectStoreService } from '../../../services/project-store.service';
import { DraftSet } from '../../../editing/draft-set';
import { DraftSource } from '../../../editing/draft-source';
import { freeId } from '../../../editing/ids';
import { prepareSurface, zoomBy } from '../../../../renderer/canvas-surface';

/**
 * Smallest drawing box the fit will work with, in CSS pixels.
 *
 * Only a floor for a panel that has not been laid out yet: the box the fit
 * actually uses is the frame's own, height included
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 */
const MIN_STAGE = 120;

/** Where an uploaded sprite goes: a convention, not a rule. */
const ASSET_DIR = 'assets/characters';

/** The tint picker's entry for "a colour written in the file". */
const FIXED_TINT = '#fixed';

/**
 * The zooms the pixel tools step through, in screen pixels per authored pixel.
 *
 * Whole numbers, for the reason the renderer's zoom is one: a pixel is a square
 * block of screen pixels or it is a smear
 * (`docs/adr/ADR-0024-character-definitions.md`).
 */
const ZOOM_STEPS: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

/**
 * The largest the stage may get, in CSS pixels a side.
 *
 * A 256-pixel canvas at 32x is an 8192-pixel one, which is a browser tab
 * spending a hundred megabytes to show one sprite. The zoom stops where the
 * stage would.
 */
const MAX_STAGE = 3072;

/** From this zoom up, the stage rules the pixel grid. */
const GRID_ZOOM = 6;

/** Smallest a transparency square may get on screen, in CSS pixels. */
const MIN_CHECKER = 6;

/**
 * The largest backing store the stage may allocate, in pixels a side.
 *
 * Browsers refuse a canvas past a few thousand pixels a side and fail by
 * drawing nothing, so the density is what gives way when the stage is already
 * as large as {@link MAX_STAGE} allows.
 */
const MAX_BACKING = 4096;

/** How many colours the palette carries over from previous strokes. */
const RECENT_COLORS = 8;

/** What a click on the stage does. */
/** Colour of the bones drawn between a node and its parent. */
const BONE_COLOR = 'rgba(122, 192, 255, 0.75)';

/** Colour of an attachment point, and of the selected node's own marker. */
const JOINT_COLOR = '#7ac0ff';

@Component({
  selector: 'app-character-workspace',
  imports: [
    TranslatePipe,
    ControlField,
    AssetWorkspace,
    CharacterAnimator,
    PixelEditor,
    PixelTools,
  ],
  templateUrl: './character-workspace.html',
  styleUrl: './character-workspace.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Undo is a keystroke wherever the pointer happens to be, so the listener is
  // on the document — and refuses to fire while a form field holds the caret.
  // The unload guard is the only thing standing between painted pixels and a
  // closed tab, since they live in memory until they are written.
  host: {
    '(document:keydown)': 'onKeyDown($event)',
    '(window:beforeunload)': 'onUnload($event)',
  },
})
export class CharacterWorkspace implements AfterViewInit, OnDestroy {
  private readonly store = inject(ProjectStoreService);
  private readonly manifest = inject(ProjectManifest);
  private readonly ledger = inject(WriteLedger);
  private readonly engine = inject(EngineService);
  private readonly i18n = inject(I18nService);
  private readonly workspace = inject(ContentWorkspaceService);
  private readonly locales = inject(LocaleAuthoringService);
  private readonly library = inject(CharacterLibraryService);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('stage');
  private readonly frameRef = viewChild<ElementRef<HTMLElement>>('frame');

  /**
   * The editing session: what is held, what is open, what is unwritten.
   *
   * The whole of load and save, which this screen only supplies the
   * character's half of (`app/editing/draft-set.ts`).
   */
  private readonly drafts = new DraftSet<CharacterDefinition>(this.draftSource(), {
    i18n: this.i18n,
    workspace: this.workspace,
    ledger: this.ledger,
    locales: this.locales,
  });

  protected readonly report = this.drafts.report;
  protected readonly message = this.drafts.message;
  protected readonly error = this.drafts.error;
  protected readonly busy = this.drafts.busy;
  protected readonly loading = this.drafts.loading;
  /** Paths the manifest declares that could not be read. */
  protected readonly unreadable = this.drafts.unreadable;

  /** The customisation the preview is showing. */
  protected readonly values = signal<CharacterValues>({});
  /** Content files the workspace holds, for the asset picker. */
  protected readonly files = signal<readonly WorkspaceFile[]>([]);
  /** What the resolver made of the open definition and those values. */
  protected readonly resolved = signal<ResolvedCharacter | null>(null);
  /** Whole-number zoom the preview settled on, for the readout. */
  protected readonly zoom = signal(1);

  /** What the pointer does on the stage. */
  protected readonly tool = signal<PixelTool>('pencil');
  /** The colour the pencil paints with. */
  protected readonly color = signal('#c9b28a');
  /**
   * Opacity of the pencil, `0..255`.
   *
   * Opaque by default and the author's to change: ADR-0028 forbade partial
   * alpha on a character because the tint pipeline turned a soft edge into a
   * pale halo, and the pipeline multiplies per pixel now
   * (`character-renderer.ts`, ADR-0028).
   */
  protected readonly alpha = signal(255);
  /**
   * Which surface the scene shows.
   *
   * `composed` is ADR-0028's: the figure, painted where it stands, which is the
   * only place the last three pixels can be judged. `flat` is the shared
   * {@link PixelEditor} over the very same buffer — the same document, so a
   * stroke in one is already in the other, and nothing has to be kept in step.
   */
  protected readonly scene = signal<'composed' | 'flat'>('composed');
  /** The zoom the author asked for; `null` fits the character to the stage. */
  protected readonly paintZoom = signal<number | null>(null);
  /**
   * Whether the pixel grid is drawn over the canvas.
   *
   * A view setting rather than a paint one: an author lining a cape up with a
   * shoulder wants the grid without picking up a pencil
   * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
   */
  protected readonly showGrid = signal(true);
  /** The flat view's zoom, so the file bar steps whichever surface is open. */
  protected readonly flatZoom = signal(6);
  /** Colours used lately, so a tone carries from one sprite to the next. */
  private readonly recent = signal<readonly string[]>([]);
  /** Bumped by every stroke, so the palette and the buttons re-read the pixels. */
  private readonly strokes = signal(0);
  /** The two greys of the transparency checker, read from the theme once. */
  private checker: readonly [string, string] | null = null;

  /** The sprites open for editing, by content path. */
  private readonly sessions = new Map<string, SpriteDocument>();
  /** Paths being decoded, so the effect asks for each of them only once. */
  private readonly opening = new Set<string>();
  /** Where the pointer was when it last painted, in the sprite's own pixels. */
  private stroking: { x: number; y: number } | null = null;
  /**
   * What the last draw put on the stage, for turning a click into a pixel.
   *
   * The box is kept with the placement because a pointer arrives in the box the
   * *element* occupies, which the interface scale has multiplied, and only the
   * box we drew in says what that means (`app/app.css`).
   */
  private view = { zoom: 1, originX: 0, originY: 0, box: { x: 0, y: 0, width: 1, height: 1 } };

  /** Which layer the variant editor is showing — and which *node* is selected. */
  private readonly layerIdSignal = signal<string | null>(null);

  /** Id of the animation the preview is playing; `null` is the rest pose. */
  private readonly animationIdSignal = signal<string | null>(null);
  /** Where in that animation the preview is, in milliseconds. */
  private readonly timeMs = signal(0);
  protected readonly playing = signal(false);
  /** Playback rate, as a multiple of real time. */
  protected readonly speed = signal(1);
  /** `true` while the preview draws the bones and joints over the character. */
  protected readonly skeleton = signal(false);

  /**
   * Which module of the left column is open.
   *
   * `layers` by default: it is the one an author reaches for on opening a
   * character, and the one the preview beside it is showing.
   */
  protected readonly tab = signal<EditorTab>('layers');

  /** The running playback loop, if any. */
  private clock: number | null = null;
  /** When the loop last advanced, so a dropped frame does not skip time. */
  private lastTick = 0;
  /** A node being dragged in the preview, and where the drag started. */
  private dragging: {
    readonly node: string;
    readonly from: { x: number; y: number };
    readonly base: PixelOffset;
  } | null = null;

  protected readonly categories = CATEGORIES;
  protected readonly controlKinds = CONTROL_KINDS;
  protected readonly TABS = EDITOR_TABS;
  protected readonly maxResolution = MAX_SPRITE_RESOLUTION;
  protected readonly usesOptions = usesOptions;
  protected readonly isNumeric = isNumeric;

  private readonly sprites = new SpriteCache(
    (asset) => assetUrl(`${CONTENT_ROOT}/${asset}`),
    () => this.draw(),
  );
  /**
   * What the preview draws with: the file, unless the author is painting it.
   *
   * An open sprite shadows the cache, so a stroke shows up in the composed
   * character as it is painted rather than after a save and a reload.
   */
  private readonly source: SpriteSource = {
    image: (asset) => this.sessions.get(asset)?.surface() ?? this.sprites.image(asset),
    // An open sprite is already in memory; everything else is the cache's.
    preload: (assets) => this.sprites.preload(assets),
  };
  private resizeObserver: ResizeObserver | null = null;

  /** Every definition, in project order. */
  protected readonly documents = this.drafts.drafts;

  /** The definition being edited, or `null` when the project has none. */
  protected readonly document = this.drafts.open;

  /** Path this definition's file has, declared or by convention. */
  protected readonly path = computed(() => {
    const document = this.document();
    return document === null ? '' : this.manifest.characterPath(document.id);
  });

  /** `true` when the open definition, or a sprite it owns, differs from disk. */
  protected readonly dirty = this.drafts.dirty;

  /** `true` when files can actually be written — the editor is honest about it. */
  protected readonly writable = computed(() => this.workspace.status() !== null);

  /** `true` when the manifest does not list the open definition. */
  protected readonly unlisted = computed(() => {
    const document = this.document();
    return (
      document !== null && !this.manifest.characters().some((entry) => entry.id === document.id)
    );
  });

  /** The canvas the open definition is authored on. */
  protected readonly resolution = computed<SpriteResolution>(
    () => this.document()?.resolution ?? { width: 64, height: 128 },
  );

  /** Every image in the content directory, which is what a variant may name. */
  protected readonly images = computed<readonly WorkspaceFile[]>(() =>
    this.files().filter((file) => /\.(png|gif|webp)$/i.test(file.path)),
  );

  protected readonly parameters = computed<readonly ControlDefinition[]>(
    () => this.document()?.parameters ?? [],
  );

  /**
   * How many things a tab holds, shown beside its name.
   *
   * The point of a tab bar is knowing what is behind the ones that are shut;
   * a count is the cheapest true thing to say about each.
   */
  protected tabCount(tab: EditorTab): number {
    switch (tab) {
      case 'parameters':
        return this.parameters().length;
      case 'layers':
        return this.layers().length;
      case 'animation':
        return this.animations().length;
      default:
        return 0;
    }
  }

  protected readonly layers = computed<readonly CharacterLayer[]>(
    () => this.document()?.layers ?? [],
  );

  protected readonly layer = computed<CharacterLayer | null>(() => {
    const layers = this.layers();
    const id = this.layerIdSignal();
    return layers.find((candidate) => candidate.id === id) ?? layers.at(0) ?? null;
  });

  protected readonly variants = computed<readonly LayerVariant[]>(
    () => this.layer()?.variants ?? [],
  );

  /** Every layer, flattened depth-first: the tree the animation composes down. */
  protected readonly rows = computed<readonly HierarchyRow[]>(() => hierarchy(this.layers()));

  protected readonly animations = computed<readonly Animation[]>(
    () => this.document()?.animations ?? [],
  );

  /** The animation the preview is playing, if the definition still declares it. */
  protected readonly animation = computed<Animation | null>(() => {
    const id = this.animationIdSignal();
    return this.animations().find((animation) => animation.id === id) ?? null;
  });

  /**
   * The animation whose clock and tracks actually run.
   *
   * Itself, unless it is a mirror — a mirror borrows its source's timing, so
   * the playback loop and the timeline have to read the source or they would
   * be counting frames nothing has (`docs/adr/ADR-0025-characters-animate-by-
   * hierarchy-and-offsets.md`).
   */
  protected readonly played = computed<Animation | null>(() => {
    const open = this.animation();
    if (open === null || !open.mirrorOf) {
      return open;
    }
    const source = this.animations().find((entry) => entry.id === open.mirrorOf);
    return source === undefined || source.mirrorOf ? null : source;
  });

  /**
   * Which animation and moment the preview should be resolved at.
   *
   * `undefined` is the rest pose, which is what the editor shows until an
   * animation is opened — and what it goes back to when one is deleted.
   */
  protected readonly pose = computed<CharacterPose | undefined>(() => {
    const animation = this.animation();
    return animation === null
      ? undefined
      : { animation: animation.id, timeMs: Math.max(0, Math.round(this.timeMs())) };
  });

  /**
   * The frame on screen — **the engine's answer**, not a count kept here.
   *
   * Time to frame is arithmetic the animation owns, and asking it is what stops
   * the timeline's highlight and the drawn pose from drifting apart.
   */
  protected readonly poseFrame = computed(() => this.resolved()?.pose?.frame ?? 0);

  /** The layers the open layer may hang off without closing a loop. */
  protected readonly parentOptions = computed<readonly CharacterLayer[]>(() => {
    const layers = this.layers();
    const open = this.layer()?.id;
    return open === undefined
      ? []
      : layers.filter((candidate) => !wouldLoop(layers, open, candidate.id));
  });

  /** The attachment points the open layer's parent offers. */
  protected readonly parentAnchors = computed<readonly AttachmentPoint[]>(() => {
    const parent = this.layer()?.parent;
    if (!parent) {
      return [];
    }
    return this.layers().find((candidate) => candidate.id === parent)?.anchors ?? [];
  });

  /** `true` when a drag on the stage would write a keyframe. */
  /**
   * `true` when a drag on the stage would write a keyframe.
   *
   * Never on a mirror: it has no tracks of its own, and a drag that silently
   * edited the animation it reflects would move the *other* direction too.
   */
  /**
   * Whether a drag on the stage moves the open node instead of painting it.
   *
   * The stage has one pointer and two jobs, and what decides between them is
   * **which panel is open**: an author with the animation editor in front of
   * them is placing a limb, and one with the layers panel open is drawing. It
   * used to be the paint toggle, and the paint toggle is gone
   * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`). The hint under
   * the stage says which one a drag will do.
   */
  protected readonly posable = computed(
    () =>
      this.tab() === 'animation' &&
      this.animation() !== null &&
      this.animation()?.mirrorOf == null &&
      this.layer() !== null,
  );

  /** The layer the pixel tools edit: the open one, as the resolver drew it. */
  protected readonly target = computed<ResolvedLayer | null>(() => {
    const open = this.layer()?.id;
    return this.resolved()?.layers.find((drawn) => drawn.layer === open) ?? null;
  });

  /** The pixels behind that layer, once its image has been decoded. */
  protected readonly sprite = computed<SpriteDocument | null>(() => {
    this.strokes();
    const asset = this.target()?.asset ?? '';
    return asset.length === 0 ? null : (this.sessions.get(asset) ?? null);
  });

  /**
   * `true` when the layer's box is not the image's own size.
   *
   * Painting would then have to map a click through a stretch, and every
   * stroke would land on a pixel the author did not point at. The editor says
   * so and offers *Fit to image*, rather than guessing which pixel was meant.
   */
  protected readonly stretched = computed(() => {
    const target = this.target();
    const sprite = this.sprite();
    return (
      target !== null &&
      sprite !== null &&
      (target.rect[2] !== sprite.width || target.rect[3] !== sprite.height)
    );
  });

  /** `true` when a click on the stage would put a pixel somewhere. */
  protected readonly paintable = computed(() => this.sprite() !== null && !this.stretched());

  /**
   * The colours to offer, most reachable first.
   *
   * The sprite's own tones lead, then the rest of this character's, then what
   * has been used lately. A palette made of the drawing is what keeps two
   * layers on the same browns instead of drifting a few values apart — which
   * is the whole difference between a figure and a collage.
   */
  protected readonly palette = computed<readonly string[]>(() => {
    this.strokes();
    const active = this.target()?.asset ?? '';
    const colors: string[] = [];
    const add = (found: readonly string[]): void => {
      for (const color of found) {
        if (!colors.includes(color)) {
          colors.push(color);
        }
      }
    };
    add(this.sessions.get(active)?.palette() ?? []);
    for (const [asset, sprite] of this.sessions) {
      if (asset !== active) {
        add(sprite.palette(8));
      }
    }
    add(this.recent());
    return colors.slice(0, PALETTE_SIZE);
  });

  /** Images holding pixels the content directory has not been told about. */
  protected readonly unsavedSprites = computed<readonly string[]>(() => {
    this.strokes();
    return [...this.sessions].filter(([, sprite]) => sprite.unsaved).map(([asset]) => asset);
  });

  protected readonly canUndo = computed(() => {
    this.strokes();
    return this.sprite()?.canUndo === true;
  });

  protected readonly canRedo = computed(() => {
    this.strokes();
    return this.sprite()?.canRedo === true;
  });

  /** The zooms this canvas may be shown at without a stage nobody can hold. */
  protected readonly zoomSteps = computed<readonly number[]>(() => {
    const longest = Math.max(this.resolution().width, this.resolution().height);
    const steps = ZOOM_STEPS.filter((step) => step * longest <= MAX_STAGE);
    return steps.length === 0 ? [1] : steps;
  });

  /**
   * Issues that would stop the runtime loading this file.
   *
   * Not the untranslated keys: naming a key is how a key comes to exist, and
   * saving creates it in every language
   * (`docs/adr/ADR-0020-localised-content-keys.md`).
   */
  protected readonly blocking = computed(() =>
    (this.report()?.issues ?? []).filter((issue) => issue.code !== 'locale.unknownKey'),
  );

  /** Keys this file names that no language gives text to yet. */
  protected readonly untranslated = computed(() =>
    (this.report()?.issues ?? []).filter((issue) => issue.code === 'locale.unknownKey'),
  );

  /**
   * How many issues stop a write.
   *
   * The session's count, and it is the same number {@link blocking} would give:
   * `locale.unknownKey` is a warning, so filtering it out never took an error
   * with it (`docs/adr/ADR-0020-localised-content-keys.md`).
   */
  protected readonly errorCount = this.drafts.errorCount;

  constructor() {
    // Redrawing is a side effect of the resolved character changing, whatever
    // changed it — an edit, a preview choice, or opening another definition.
    effect(() => {
      this.resolved();
      this.strokes();
      this.paintZoom();
      this.showGrid();
      this.scene();
      this.draw();
    });
    // Every sprite the character draws is opened, not just the one being
    // edited: that is what makes the palette the *character's* palette, and
    // what makes switching layers instant rather than a decode away.
    //
    // The flat view needs them too, and needs them without paint mode: it *is*
    // the image, so arriving there with nothing decoded showed "open an image"
    // over a layer that was already selected
    // (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
    effect(() => {
      for (const drawn of this.resolved()?.layers ?? []) {
        this.requireSprite(drawn.asset);
      }
    });
    // The playback loop lives and dies with the Play button, and with the
    // animation still existing: deleting the one being played must stop it
    // rather than leave a timer running against a definition nobody has.
    effect(() => {
      if (this.playing() && this.played() !== null) {
        this.startClock();
      } else {
        this.stopClock();
      }
    });
    void this.drafts.load();
  }

  ngAfterViewInit(): void {
    // The frame is observed, never the canvas: the canvas is sized *by* the
    // draw, so watching it would be watching our own output.
    const frame = this.frameRef()?.nativeElement;
    if (frame !== undefined) {
      this.resizeObserver = new ResizeObserver(() => this.draw());
      this.resizeObserver.observe(frame);
    }
    this.draw();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.stopClock();
  }

  // --------------------------------------------------------------- playback

  /**
   * Advances the preview in real time, one animation frame of the *browser*
   * per pose.
   *
   * The clock is here rather than in the animation panel because the preview
   * is here: the loop's only job is to move the time the resolver is asked
   * about, and everything else follows from the resolved character changing.
   *
   * And it is *this screen's own* rather than `app/editing/flipbook-clock.ts`,
   * which the decoration and object editors share. A flipbook is a list of
   * images at a rate; a character animation is a frame **count** with tracks
   * over it, played at a speed the author sets, and it stops itself at the end
   * when it does not loop. None of those three is a flipbook's
   * (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`).
   */
  private startClock(): void {
    if (this.clock !== null) {
      return;
    }
    this.lastTick = performance.now();
    const tick = (now: number): void => {
      const elapsed = now - this.lastTick;
      this.lastTick = now;
      this.timeMs.update((time) => time + elapsed * this.speed());

      // An animation that does not loop is over when it is over; leaving the
      // loop running would burn a frame a tick to redraw the same picture.
      const animation = this.played();
      if (animation !== null && animation.looping !== true) {
        const duration =
          (animation.frames ?? 1) * (animation.frameDurationMs ?? DEFAULT_FRAME_DURATION_MS);
        if (this.timeMs() >= duration) {
          this.timeMs.set(Math.max(0, duration - 1));
          this.playing.set(false);
          this.repose();
          return;
        }
      }

      this.repose();
      this.clock = requestAnimationFrame(tick);
    };
    this.clock = requestAnimationFrame(tick);
  }

  private stopClock(): void {
    if (this.clock !== null) {
      cancelAnimationFrame(this.clock);
      this.clock = null;
    }
  }

  protected togglePlay(): void {
    this.playing.update((on) => !on);
  }

  protected setSpeed(speed: number): void {
    this.speed.set(speed);
  }

  protected toggleSkeleton(): void {
    this.skeleton.update((on) => !on);
    this.draw();
  }

  /** Opens an animation in the timeline, from its first frame. */
  protected openAnimation(id: string | null): void {
    this.animationIdSignal.set(id);
    this.timeMs.set(0);
    this.playing.set(false);
    this.repose();
  }

  /**
   * Scrubs to a frame, which means scrubbing to the moment it starts.
   *
   * Frames are what an author writes; milliseconds are what plays. The
   * conversion is the animation's own, so the timeline and the preview cannot
   * disagree about which frame is on screen.
   */
  protected scrubTo(frame: number): void {
    const animation = this.played();
    if (animation === null) {
      return;
    }
    this.playing.set(false);
    this.timeMs.set(Math.max(0, frame) * (animation.frameDurationMs ?? DEFAULT_FRAME_DURATION_MS));
    this.repose();
  }

  /** Takes on the definition the animation panel produced. */
  protected onAnimationsChanged(draft: CharacterDefinition): void {
    this.edit((document) => {
      document.animations = draft.animations;
    });
  }

  /**
   * What a *character* means by reading, validating, writing and declaring.
   *
   * Everything else about the session — the order of the steps, the bail-out on
   * a failing verdict, what a rename takes with it — is `DraftSet`'s.
   */
  private draftSource(): DraftSource<CharacterDefinition> {
    return {
      declaredInManifest: true,
      // A list: a project shipping no characters opens on an empty list.
      blank: () => null,
      messages: {
        invalid: 'ui.editor.character.invalid',
        saved: 'ui.editor.character.saved',
        spritesSaved: 'ui.editor.character.spritesSaved',
        savedManifest: 'ui.editor.character.savedManifest',
      },
      prepare: async () => {
        await this.engine.ready();
        await this.i18n.ensureAdopted();
        await this.store.ensureLoaded();
        await this.workspace.ensureProbed();
        await this.locales.ensureLoaded();
        // Registered as well as fetched: the *runtime* holds these, and this
        // screen is about to replace one of them.
        await this.library.ensureLoaded();
        await this.refreshFiles();
      },
      declared: () => this.manifest.characters(),
      read: (entry) => this.fetchCharacter(entry),
      pathOf: (id) => this.manifest.characterPath(id),
      serialize: (document) => serializeCharacter(document),
      validate: (_document, json) => this.engine.validateCharacter(json),
      adopt: (id, json) => this.library.adopt(id, json),
      forget: (id) => this.library.forget(id),
      declare: (id, path) => this.manifest.declareCharacter(id, path),
      undeclare: (id) => this.manifest.undeclareCharacter(id),
      dirtySprites: (document) => {
        this.strokes();
        return spriteAssets(document).filter((asset) => this.sessions.get(asset)?.unsaved === true);
      },
      writeSprites: () => this.writeSprites(),
      keysOf: (document) => referencedKeys(document),
      removed: () => {},
      refresh: () => this.repose(),
    };
  }

  /**
   * Re-reads what the content directory holds, for the asset picker.
   *
   * A read-only workspace answers nothing, which is not an error: the picker is
   * then empty and a path can still be typed by hand.
   */
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
   * manifest is content like any other and may name a file nobody wrote yet,
   * and refusing to open the editor is no way to fix that.
   */
  private async fetchCharacter(entry: ContentRef): Promise<CharacterDefinition | null> {
    try {
      const response = await fetch(assetUrl(`${CONTENT_ROOT}/${entry.path}`));
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as CharacterDefinition;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ edits

  /**
   * Applies a change to the open definition, then re-validates and re-resolves.
   *
   * A copy per edit, not a mutation: the form is a tree of nested arrays, and
   * `OnPush` only redraws what changed identity.
   */
  private edit(mutate: (draft: CharacterDefinition) => void): void {
    this.drafts.edit(mutate);
  }

  protected open(id: string): void {
    this.drafts.select(id);
    this.layerIdSignal.set(null);
    this.resetChoices();
  }

  /**
   * Adds a definition to the project and opens it.
   *
   * It starts with a body and a head layer, placed but unpainted: the preview
   * draws an outline where each sprite will go, so a definition can be blocked
   * out before any art exists and the first thing an author does is point a
   * layer at an image.
   */
  protected addCharacter(): void {
    const id = freeId(
      'character',
      this.documents().map((document) => document.id),
    );
    const document: CharacterDefinition = {
      id,
      schemaVersion: CHARACTER_SCHEMA_VERSION,
      name: id,
      category: 'other',
      resolution: { width: 64, height: 128 },
      parameters: [],
      layers: [
        {
          id: 'body',
          variants: [{ id: 'default', rect: [20, 40, 24, 76], sprite: { asset: '' } }],
        },
        {
          id: 'head',
          variants: [{ id: 'default', rect: [24, 12, 16, 28], sprite: { asset: '' } }],
        },
      ],
    };

    this.drafts.add(document);
    this.layerIdSignal.set(null);
    this.resetChoices();
  }

  /**
   * Removes the open definition from the editor and from the manifest.
   *
   * The file is left on disk: deleting content is a decision an author makes
   * with their own tools, and a manifest that no longer lists it is enough to
   * take it out of the game.
   */
  protected removeCharacter(): void {
    const document = this.document();
    if (document !== null) {
      this.drafts.remove(document.id);
      this.layerIdSignal.set(null);
      this.resetChoices();
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
      draft.category = category as CharacterCategory;
    });
  }

  /**
   * Resizes the canvas the sprites are authored on.
   *
   * Layers are **not** moved with it: a box is a position on the grid the art
   * was drawn on, and silently rescaling every layer would move sprites off
   * the pixels they were painted for. Validation reports whatever now hangs
   * off the edge (`character.rectOutOfCanvas`).
   */
  protected setResolution(side: 'width' | 'height', raw: string): void {
    const value = clampResolution(Number.parseFloat(raw));
    this.edit((draft) => {
      const current = draft.resolution ?? { width: 64, height: 128 };
      draft.resolution =
        side === 'width'
          ? { width: value, height: current.height }
          : { width: current.width, height: value };
    });
  }

  // -------------------------------------------------------------- parameters

  protected addParameter(): void {
    const id = freeId(
      'parameter',
      this.parameters().map((parameter) => parameter.id),
    );
    this.edit((draft) => {
      draft.parameters = [
        ...(draft.parameters ?? []),
        {
          id,
          labelKey: `game.character.${id}`,
          control: 'select',
          default: '',
          options: [],
        },
      ];
    });
  }

  protected patchParameter(index: number, change: Partial<ControlDefinition>): void {
    this.resetChoices();
    this.edit((draft) => {
      const parameter = draft.parameters?.[index];
      if (parameter !== undefined) {
        Object.assign(parameter, change);
      }
    });
  }

  /**
   * Drops the preview's chosen values, which an edit to the parameters may have
   * made meaningless — a renamed id, a changed control, a deleted option.
   *
   * Called *before* the edit, so the resolution the edit triggers is the one
   * the author sees rather than one render behind.
   */
  private resetChoices(): void {
    this.values.set({});
  }

  protected removeParameter(index: number): void {
    this.resetChoices();
    this.edit((draft) => {
      const removed = draft.parameters?.[index];
      draft.parameters?.splice(index, 1);
      if (removed !== undefined) {
        // A tint bound to a parameter that no longer exists would not validate.
        dropTint(draft, removed.id);
      }
    });
  }

  protected moveParameter(index: number, delta: number): void {
    this.edit((draft) => move(draft.parameters ?? [], index, delta));
  }

  /**
   * Changes what a parameter *is*, and takes its default with it.
   *
   * The engine refuses a default its own control does not accept, so switching
   * a slider to a select has to replace `1` with an option.
   */
  protected setControl(index: number, control: ControlKind): void {
    this.resetChoices();
    this.edit((draft) => {
      const parameter = draft.parameters?.[index];
      if (parameter === undefined || parameter.control === control) {
        return;
      }
      parameter.control = control;
      parameter.default = defaultFor(
        control,
        (parameter.options ?? []).map((option) => option.value),
      );
      if (!usesOptions(control)) {
        delete parameter.options;
      }
      if (!isNumeric(control)) {
        delete parameter.min;
        delete parameter.max;
        delete parameter.step;
      }
    });
  }

  /** Reads a bound out of an input; an empty field means "no bound". */
  protected setBound(index: number, bound: 'min' | 'max' | 'step', raw: string): void {
    const parsed = Number.parseFloat(raw);
    const value = Number.isFinite(parsed) ? parsed : null;
    this.patchParameter(
      index,
      bound === 'min' ? { min: value } : bound === 'max' ? { max: value } : { step: value },
    );
  }

  protected addOption(index: number): void {
    this.resetChoices();
    this.edit((draft) => {
      const parameter = draft.parameters?.[index];
      if (parameter === undefined) {
        return;
      }
      const options = parameter.options ?? [];
      const value = freeId(
        'value',
        options.map((option) => option.value),
      );
      parameter.options = [...options, { value, labelKey: `game.character.${value}` }];
      // The first option of an empty select becomes its default: a select whose
      // default is not one of its own options does not validate.
      if (parameter.control === 'select' && options.length === 0) {
        parameter.default = value;
      }
    });
  }

  protected patchOption(
    index: number,
    optionIndex: number,
    change: Partial<{ value: string; labelKey: string }>,
  ): void {
    this.resetChoices();
    this.edit((draft) => {
      const parameter = draft.parameters?.[index];
      const option = parameter?.options?.[optionIndex];
      if (parameter === undefined || option === undefined) {
        return;
      }
      const previous = option.value;
      Object.assign(option, change);
      if (change.value === undefined || change.value === previous) {
        return;
      }
      // A renamed option takes the default and every condition naming it along,
      // rather than leaving a variant waiting for a value nobody offers.
      if (parameter.default === previous) {
        parameter.default = change.value;
      }
      for (const layer of draft.layers ?? []) {
        for (const variant of layer.variants) {
          if (variant.when?.[parameter.id] === previous) {
            variant.when[parameter.id] = change.value;
          }
        }
      }
    });
  }

  protected removeOption(index: number, optionIndex: number): void {
    this.resetChoices();
    this.edit((draft) => {
      const parameter = draft.parameters?.[index];
      if (parameter?.options === undefined) {
        return;
      }
      const [removed] = parameter.options.splice(optionIndex, 1);
      if (parameter.control === 'select' && parameter.default === removed?.value) {
        parameter.default = parameter.options[0]?.value ?? '';
      }
      if (parameter.control === 'multiSelect' && Array.isArray(parameter.default)) {
        parameter.default = parameter.default.filter((value) => value !== removed?.value);
      }
    });
  }

  // ------------------------------------------------------------------ layers

  protected selectLayer(id: string): void {
    this.layerIdSignal.set(id);
  }

  protected addLayer(): void {
    const id = freeId(
      'layer',
      this.layers().map((layer) => layer.id),
    );
    const resolution = this.resolution();
    this.edit((draft) => {
      draft.layers = [
        ...(draft.layers ?? []),
        { id, variants: [blankVariant('default', resolution)] },
      ];
    });
    this.selectLayer(id);
  }

  protected patchLayer(index: number, change: Partial<CharacterLayer>): void {
    this.edit((draft) => {
      const layer = draft.layers?.[index];
      if (layer !== undefined) {
        Object.assign(layer, change);
      }
    });
  }

  protected removeLayer(index: number): void {
    this.edit((draft) => {
      draft.layers?.splice(index, 1);
    });
    this.layerIdSignal.set(null);
  }

  /** Moves a layer, which is what changes what covers what. */
  protected moveLayer(index: number, delta: number): void {
    this.edit((draft) => move(draft.layers ?? [], index, delta));
  }

  // --------------------------------------------------------------- skeleton

  /**
   * Hangs the open layer off another one, or makes it a root again.
   *
   * The picker only ever offers layers that would not close a loop, so this
   * cannot create one — but the anchor goes with the parent, because an
   * attachment point on the old parent means nothing on the new one.
   */
  protected setParent(parentId: string): void {
    this.rebasing((draft) => {
      if (parentId.length === 0) {
        delete draft.parent;
      } else {
        draft.parent = parentId;
      }
      delete draft.parentAnchor;
    });
  }

  protected setParentAnchor(anchorId: string): void {
    this.rebasing((draft) => {
      if (anchorId.length === 0) {
        delete draft.parentAnchor;
      } else {
        draft.parentAnchor = anchorId;
      }
    });
  }

  /**
   * Changes where the open layer hangs **without moving it on the canvas**.
   *
   * A box is measured from the joint it hangs off, so changing the joint
   * changes what every number in the layer means: re-parenting a head onto a
   * shoulder would otherwise throw it across the canvas, and an author would
   * have to type its position back in from nothing
   * (`docs/adr/ADR-0024-character-definitions.md`).
   *
   * So the boxes are rebased by the difference between the old frame and the
   * new one, and the picture is unchanged. Moving a layer is a separate act
   * from deciding what it follows.
   */
  private rebasing(mutate: (draft: CharacterLayer) => void): void {
    const id = this.layer()?.id;
    const before = this.originOf(this.document(), id);
    this.editLayer(mutate);
    // `editLayer` has published a new document; the frame is read off it.
    const after = this.originOf(this.document(), id);
    const dx = before[0] - after[0];
    const dy = before[1] - after[1];
    if (dx === 0 && dy === 0) {
      return;
    }
    this.editLayer((draft) => {
      for (const variant of draft.variants ?? []) {
        const rect = variant.rect ?? [0, 0, 0, 0];
        variant.rect = [rect[0] + dx, rect[1] + dy, rect[2], rect[3]];
      }
      // The layer's own anchors are measured from its frame too, so whatever
      // hangs off *them* would move a second time if they were left alone.
      for (const anchor of draft.anchors ?? []) {
        anchor.at = [anchor.at[0] + dx, anchor.at[1] + dy];
      }
    });
  }

  /**
   * Where a layer's frame sits on the canvas, at rest.
   *
   * The engine's walk, mirrored here because this one question is asked
   * *between* two edits — the resolved character is a frame behind, and a
   * rebase that used it would rebase onto the old parent.
   */
  private originOf(document: CharacterDefinition | null, id: string | undefined): PixelOffset {
    const layers = document?.layers ?? [];
    let origin: PixelOffset = [0, 0];
    const chain: CharacterLayer[] = [];
    const seen = new Set<string>();
    let node = layers.find((layer) => layer.id === id);
    while (node !== undefined && !seen.has(node.id)) {
      seen.add(node.id);
      chain.push(node);
      const parent: string | undefined = node.parent ?? undefined;
      node = parent === undefined ? undefined : layers.find((layer) => layer.id === parent);
    }
    for (let index = chain.length - 1; index > 0; index -= 1) {
      const parent = chain[index] as CharacterLayer;
      const child = chain[index - 1] as CharacterLayer;
      const at = (parent.anchors ?? []).find((anchor) => anchor.id === child.parentAnchor)?.at;
      if (at !== undefined) {
        origin = [origin[0] + at[0], origin[1] + at[1]];
      }
    }
    return origin;
  }

  /**
   * Where the open layer's frame sits: what its boxes are measured from.
   *
   * Read off the **resolved** character, so it is the engine's answer and not
   * a second calculation that could disagree with the preview.
   */
  protected readonly openOrigin = computed<PixelOffset>(() => {
    const open = this.layer()?.id;
    return this.resolved()?.layers.find((drawn) => drawn.layer === open)?.origin ?? [0, 0];
  });

  /** Moves a variant out of the author order, or back into it. */
  protected setOrder(index: number, raw: string): void {
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      return;
    }
    this.editLayer((draft) => {
      const variant = draft.variants[index];
      if (variant === undefined) {
        return;
      }
      const order = Math.round(parsed);
      if (order === 0) {
        delete variant.order;
      } else {
        variant.order = order;
      }
    });
  }

  /**
   * Adds an attachment point at the middle of the layer's box.
   *
   * Somewhere visible rather than at the canvas origin: an anchor an author
   * cannot see on the preview is an anchor they cannot place.
   */
  protected addAnchor(): void {
    const layer = this.layer();
    if (layer === null) {
      return;
    }
    const id = freeId(
      'anchor',
      (layer.anchors ?? []).map((anchor) => anchor.id),
    );
    const rect = this.target()?.rect ?? [0, 0, 0, 0];
    this.editLayer((draft) => {
      draft.anchors = [
        ...(draft.anchors ?? []),
        { id, at: [rect[0] + Math.round(rect[2] / 2), rect[1] + Math.round(rect[3] / 2)] },
      ];
    });
  }

  protected patchAnchor(index: number, change: Partial<AttachmentPoint>): void {
    this.editLayer((draft) => {
      const anchor = draft.anchors?.[index];
      if (anchor !== undefined) {
        Object.assign(anchor, change);
      }
    });
  }

  /** Sets one coordinate of an attachment point, in canvas pixels. */
  protected setAnchorAt(index: number, axis: 0 | 1, raw: string): void {
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      return;
    }
    this.editLayer((draft) => {
      const anchor = draft.anchors?.[index];
      if (anchor !== undefined) {
        const at: PixelOffset = [...anchor.at];
        at[axis] = Math.round(parsed);
        anchor.at = at;
      }
    });
  }

  /**
   * Removes an attachment point, and every reference to it.
   *
   * A `parentAnchor` naming an anchor that no longer exists does not validate,
   * and deleting a joint is not a way of saying "and break what hung off it".
   */
  protected removeAnchor(index: number): void {
    const layerId = this.layer()?.id;
    const removed = this.layer()?.anchors?.[index]?.id;
    this.edit((draft) => {
      const layer = draft.layers?.find((candidate) => candidate.id === layerId);
      layer?.anchors?.splice(index, 1);
      for (const other of draft.layers ?? []) {
        if (other.parent === layerId && other.parentAnchor === removed) {
          delete other.parentAnchor;
        }
      }
    });
  }

  // ---------------------------------------------------------------- variants

  protected addVariant(): void {
    const layer = this.layer();
    if (layer === null) {
      return;
    }
    const id = freeId(
      'variant',
      layer.variants.map((variant) => variant.id),
    );
    this.editLayer((draft) => {
      draft.variants.push(blankVariant(id, this.resolution()));
    });
  }

  protected patchVariant(index: number, change: Partial<LayerVariant>): void {
    this.editLayer((draft) => {
      const variant = draft.variants[index];
      if (variant !== undefined) {
        Object.assign(variant, change);
      }
    });
  }

  protected removeVariant(index: number): void {
    this.editLayer((draft) => {
      draft.variants.splice(index, 1);
    });
  }

  /** Author order is priority: the first matching variant is the one drawn. */
  protected moveVariant(index: number, delta: number): void {
    this.editLayer((draft) => move(draft.variants, index, delta));
  }

  /**
   * Sets one corner or side of a variant's box, in canvas pixels.
   *
   * Rounded on the way in: half a pixel of offset is a seam between two layers
   * that were drawn to touch.
   */
  protected setRect(index: number, part: 0 | 1 | 2 | 3, raw: string): void {
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      return;
    }
    this.editLayer((draft) => {
      const variant = draft.variants[index];
      if (variant === undefined) {
        return;
      }
      const rect: [number, number, number, number] = [...(variant.rect ?? [0, 0, 0, 0])];
      rect[part] = Math.round(parsed);
      variant.rect = rect;
    });
  }

  /**
   * Points a variant at an image, and fits its box to it.
   *
   * Fitting on pick is what makes the common case correct without thinking
   * about it: a sprite drawn 24x30 wants a 24x30 box, and any other size
   * stretches pixel art. The author can still resize it afterwards.
   */
  protected setAsset(index: number, asset: string): void {
    const trimmed = asset.trim();
    this.editLayer((draft) => {
      const variant = draft.variants[index];
      if (variant !== undefined) {
        variant.sprite = { ...variant.sprite, asset: trimmed };
      }
    });
    if (trimmed.length > 0) {
      void this.fitToImage(index, trimmed);
    }
  }

  /**
   * Sets a variant's box to the image's own pixel size, once it has loaded.
   *
   * The image may not be in the cache yet, so this waits for it rather than
   * guessing — and does nothing at all if it never arrives.
   */
  protected async fitToImage(index: number, asset?: string): Promise<void> {
    const variant = this.variants()[index];
    const path = asset ?? variant?.sprite.asset ?? '';
    if (path.length === 0) {
      return;
    }
    const size = await this.measure(path);
    if (size === null) {
      return;
    }
    this.editLayer((draft) => {
      const target = draft.variants[index];
      if (target !== undefined) {
        const rect = target.rect ?? [0, 0, 0, 0];
        target.rect = [rect[0], rect[1], size.width, size.height];
      }
    });
  }

  /** The natural size of an image under the content root, or `null`. */
  private async measure(asset: string): Promise<{ width: number; height: number } | null> {
    const open = this.sessions.get(asset);
    if (open !== undefined) {
      // An edited sprite is its own truth: the file may still be the old size.
      return { width: open.width, height: open.height };
    }
    const cached = this.sprites.naturalSize(asset);
    if (cached !== null) {
      return cached;
    }
    const image = await this.loadImage(asset);
    return image === null ? null : { width: image.naturalWidth, height: image.naturalHeight };
  }

  /** Loads one content image, resolving to `null` when it is not there. */
  private loadImage(asset: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
      const image = new Image();
      image.addEventListener('load', () => resolve(image));
      image.addEventListener('error', () => resolve(null));
      image.src = assetUrl(`${CONTENT_ROOT}/${asset}`);
    });
  }

  /**
   * Uploads an image into the content directory and points a variant at it.
   *
   * The same door the title editor opens, at the same convention: an author
   * with a PNG should not have to leave the editor to use it
   * (`docs/adr/ADR-0019-authoring-content-workspace.md`).
   */
  protected async uploadAsset(event: Event, index: number): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    input.value = '';

    this.drafts.setBusy(true);
    this.drafts.clearError();
    try {
      const path = `${ASSET_DIR}/${file.name}`;
      await this.workspace.write(path, file);
      await this.refreshFiles();
      // The cache may hold a "missing" entry for this path from a previous
      // draw, and the file on disk has just changed under it either way.
      this.sprites.clear();
      this.setAsset(index, path);
      this.drafts.announce(this.i18n.t('ui.editor.character.uploaded', { file: path }));
    } catch (cause) {
      this.drafts.fail(cause);
    } finally {
      this.drafts.setBusy(false);
    }
  }

  /**
   * Points a variant's tint at a parameter, at a fixed colour, or nowhere.
   *
   * `''` is no tint — the sprite is drawn as authored — and a parameter id is
   * what turns "brown hair" into "the hair colour the player picked", with one
   * greyscale sprite instead of one per colour.
   */
  protected setTintSource(index: number, source: string): void {
    this.editLayer((draft) => {
      const variant = draft.variants[index];
      if (variant === undefined) {
        return;
      }
      if (source.length === 0) {
        variant.sprite = { asset: variant.sprite.asset };
      } else if (source === FIXED_TINT) {
        variant.sprite = { ...variant.sprite, tint: { fixed: '#ffffff' } };
      } else {
        variant.sprite = { ...variant.sprite, tint: { parameter: source } };
      }
    });
  }

  protected setFixedTint(index: number, color: string): void {
    this.editLayer((draft) => {
      const variant = draft.variants[index];
      if (variant !== undefined) {
        variant.sprite = { ...variant.sprite, tint: { fixed: color } };
      }
    });
  }

  /** What the tint picker shows: `''`, {@link FIXED_TINT}, or a parameter id. */
  protected tintSource(variant: LayerVariant): string {
    const tint = variant.sprite.tint;
    if (!tint) {
      return '';
    }
    return 'parameter' in tint ? tint.parameter : FIXED_TINT;
  }

  /** The colour written in the file, for the swatch that edits it. */
  protected fixedTint(variant: LayerVariant): string {
    const tint = variant.sprite.tint;
    return tint && 'fixed' in tint ? tint.fixed : '#ffffff';
  }

  /** `true` when this variant names an image the content directory does not hold. */
  protected assetMissing(variant: LayerVariant): boolean {
    const asset = variant.sprite.asset;
    return asset.length > 0 && !this.files().some((file) => file.path === asset);
  }

  // -------------------------------------------------------------- conditions

  /** The value a variant waits for on this parameter, or `''` for "any". */
  /**
   * Everything a variant may wait on: the declared parameters, and the pose
   * keys the character's animations set.
   *
   * One namespace, because that is what a `when` reads
   * (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`). Offering only the
   * parameters would leave a condition like `view: side` in the file and
   * nowhere on screen — invisible and uneditable, which is how it was until
   * this list existed.
   */
  protected readonly conditionFields = computed<readonly { id: string; pose: boolean }[]>(() => {
    const declared = this.parameters().map((parameter) => parameter.id);
    const poses = new Set<string>();
    for (const animation of this.animations()) {
      for (const key of Object.keys(animation.pose ?? {})) {
        poses.add(key);
      }
      for (const entry of animation.poses ?? []) {
        for (const key of Object.keys(entry)) {
          if (key !== 'frame') {
            poses.add(key);
          }
        }
      }
    }
    return [
      ...declared.map((id) => ({ id, pose: false })),
      ...[...poses]
        .filter((id) => !declared.includes(id))
        .sort()
        .map((id) => ({ id, pose: true })),
    ];
  });

  protected condition(variant: LayerVariant, parameterId: string): string {
    const held = variant.when?.[parameterId];
    if (held === undefined) {
      return '';
    }
    return typeof held === 'string' ? held : JSON.stringify(held);
  }

  /**
   * Makes a variant wait on a parameter, or stop waiting when given `''`.
   *
   * The value is read as JSON first so `true` and `12` mean what they look
   * like, and as text otherwise — an author typing `female` means the string.
   */
  protected setCondition(index: number, parameterId: string, raw: string): void {
    this.editLayer((draft) => {
      const variant = draft.variants[index];
      if (variant === undefined) {
        return;
      }
      const when = { ...(variant.when ?? {}) };
      if (raw.length === 0) {
        delete when[parameterId];
      } else {
        when[parameterId] = parseValue(raw);
      }
      variant.when = when;
    });
  }

  // ----------------------------------------------------------------- preview

  /** Sets one choice in the preview, which re-resolves and redraws. */
  protected setValue(parameterId: string, value: SettingValue): void {
    this.values.update((values) => ({ ...values, [parameterId]: value }));
    this.refresh();
  }

  /**
   * The value the preview holds for a parameter — the resolver's, not the form's.
   *
   * Reading it back off the resolved character is what makes the preview show
   * *the* value rather than what was typed: a number out of range comes back
   * clamped, exactly as it would in a game.
   */
  protected value(parameter: ControlDefinition): SettingValue {
    return (
      this.resolved()?.values[parameter.id] ??
      parameter.default ??
      defaultFor(
        parameter.control,
        parameter.options?.map((option) => option.value),
      )
    );
  }

  /**
   * Whether the preview shows this parameter, given the others.
   *
   * The same `showIf` rule the settings screen applies, evaluated against the
   * values in play.
   */
  protected isVisible(parameter: ControlDefinition): boolean {
    const condition = parameter.showIf;
    if (condition === undefined || condition === null) {
      return true;
    }
    const held = this.resolved()?.values[condition.field];
    return JSON.stringify(held) === JSON.stringify(condition.equals);
  }

  /** The text a key currently resolves to, so the form reads as prose. */
  protected preview(key: string): string {
    return key.length === 0 ? '' : this.i18n.t(key);
  }

  /** `true` when no language defines this key — the language editor's job. */
  protected missingKey(key: string): boolean {
    return key.length > 0 && !this.i18n.has(key);
  }

  // --------------------------------------------------------------- validate

  /**
   * Re-validates and re-resolves the open definition.
   *
   * Both go through Rust: the validator is the runtime's own, and the resolver
   * is the one the game will draw with, so neither the verdict nor the picture
   * is this screen's opinion (ADR-0012, ADR-0024).
   */
  protected refresh(): void {
    this.drafts.refresh();
  }

  /**
   * Re-resolves the preview without re-validating it.
   *
   * What playback and scrubbing call sixty times a second: the verdict on a
   * definition cannot change because time passed, and serialising it to
   * re-validate on every frame would be the one expensive thing in the loop.
   */
  private repose(): void {
    const document = this.document();
    if (document === null || !this.engine.isReady) {
      this.resolved.set(null);
      return;
    }
    try {
      this.resolved.set(this.engine.previewCharacter(document, this.values(), this.pose()));
    } catch (cause) {
      this.drafts.fail(cause);
    }
  }

  /** Writes the open definition into the content directory. */
  protected save(): Promise<void> {
    return this.drafts.save();
  }

  // ------------------------------------------------------------------ pixels

  protected setTool(tool: PixelTool): void {
    this.tool.set(tool);
  }

  /**
   * A stroke the flat view made.
   *
   * It painted the same {@link SpriteDocument} the composed stage paints, so
   * there is nothing to copy across — only the counter every palette, button
   * and figure reads, and a redraw for when the scene switches back
   * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
   */
  protected onFlatPainted(): void {
    this.strokes.update((count) => count + 1);
    this.draw();
  }

  protected setColor(color: string): void {
    this.color.set(color);
    this.remember(color);
  }

  /** The zoom in force: the one asked for, or the one the fit settled on. */
  protected effectiveZoom(): number {
    return this.paintZoom() ?? this.zoom();
  }

  /**
   * Steps the zoom of whichever surface is open.
   *
   * One pair of buttons, in the file bar, for the composed stage and the flat
   * view both: an author should not have to find a different control depending
   * on which one they are looking at
   * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
   */
  protected zoomBy(delta: number): void {
    if (this.scene() === 'flat') {
      this.flatZoom.set(zoomBy(this.flatZoom(), delta));
      return;
    }
    const steps = this.zoomSteps();
    const from = steps.findIndex((step) => step >= this.effectiveZoom());
    const at = from < 0 ? steps.length - 1 : from;
    const next = steps[Math.min(steps.length - 1, Math.max(0, at + delta))];
    if (next !== undefined) {
      this.paintZoom.set(next);
    }
  }

  /** The zoom on screen, whichever surface is showing it. */
  protected readonly shownZoom = computed(() =>
    this.scene() === 'flat' ? this.flatZoom() : this.effectiveZoom(),
  );

  /** Back to the zoom that fits the whole character in the stage. */
  protected fitZoom(): void {
    if (this.scene() === 'flat') {
      this.flatZoom.set(6);
      return;
    }
    this.paintZoom.set(null);
  }

  protected toggleGrid(): void {
    this.showGrid.update((on) => !on);
  }

  /**
   * Zooms with the wheel, but only while a modifier is held.
   *
   * A zoomed stage is a scrolling one, and a plain wheel over a scrolling thing
   * means scroll. Taking that away is how a drawing tool becomes unusable.
   */
  protected onWheel(event: WheelEvent): void {
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }
    event.preventDefault();
    this.zoomBy(event.deltaY < 0 ? 1 : -1);
  }

  protected onPointerDown(event: PointerEvent): void {
    if (this.beginPose(event)) {
      return;
    }
    const sprite = this.sprite();
    const at = this.pixelAt(event);
    if (sprite === null || at === null || !sprite.holds(at.x, at.y)) {
      return;
    }
    event.preventDefault();
    // Alt is the eyedropper wherever you are: reaching for the tool to take a
    // colour and reaching back to use it is two clicks around every stroke.
    if (this.tool() === 'picker' || event.altKey) {
      this.pick(at.x, at.y);
      return;
    }
    if (this.stretched()) {
      return;
    }
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    sprite.begin();
    this.stroking = at;
    this.paintTo(at.x, at.y);
  }

  protected onPointerMove(event: PointerEvent): void {
    if (this.dragging !== null) {
      this.dragTo(event);
      return;
    }
    if (this.stroking === null) {
      return;
    }
    const at = this.pixelAt(event);
    if (at !== null) {
      this.paintTo(at.x, at.y);
    }
  }

  protected onPointerUp(): void {
    this.dragging = null;
    this.finishStroke();
  }

  /**
   * Starts dragging the selected node, if an animation is open.
   *
   * Moving a node in the preview is how a pose is authored, and what it writes
   * is the node's **local** transform at the frame on screen. Everything below it follows,
   * because the composition is the engine's and nothing here bypasses it.
   *
   * @returns `true` when the pointer was taken for a drag
   */
  private beginPose(event: PointerEvent): boolean {
    const animation = this.played();
    const node = this.layer()?.id;
    const at = this.canvasPixel(event);
    if (!this.posable() || animation === null || node === undefined || at === null) {
      return false;
    }
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    // Playing while dragging would fight the pointer for the same value.
    this.playing.set(false);
    this.dragging = {
      node,
      from: at,
      base: heldOffset(
        (animation.tracks ?? []).find((track) => track.node === node),
        this.poseFrame(),
      ),
    };
    return true;
  }

  /** Writes the dragged node's keyframe at the frame on screen. */
  private dragTo(event: PointerEvent): void {
    const drag = this.dragging;
    const at = this.canvasPixel(event);
    if (drag === null || at === null) {
      return;
    }
    const offset: PixelOffset = [
      drag.base[0] + (at.x - drag.from.x),
      drag.base[1] + (at.y - drag.from.y),
    ];
    const animationId = this.played()?.id;
    const frame = this.poseFrame();
    this.edit((draft) => {
      const animation = (draft.animations ?? []).find((candidate) => candidate.id === animationId);
      if (animation === undefined) {
        return;
      }
      const tracks = animation.tracks ?? [];
      let track = tracks.find((candidate) => candidate.node === drag.node);
      if (track === undefined) {
        track = { node: drag.node, keyframes: [] };
        tracks.push(track);
        animation.tracks = tracks;
      }
      const existing = track.keyframes.find((keyframe) => keyframe.frame === frame);
      if (existing === undefined) {
        track.keyframes.push({ frame, offset });
        track.keyframes.sort((left, right) => left.frame - right.frame);
      } else {
        existing.offset = offset;
      }
    });
  }

  /**
   * The canvas pixel a pointer is over, in the character's own coordinates.
   *
   * Un-mirrored on the way back: the stage may be showing the character
   * flipped, and a click means the pixel it *points at*, not the one that
   * would be there if it were facing the other way.
   */
  private canvasPixel(event: PointerEvent): { x: number; y: number } | null {
    const canvas = this.canvasRef()?.nativeElement;
    if (canvas === undefined) {
      return null;
    }
    const at = pixelUnder(
      { x: event.clientX, y: event.clientY },
      canvas.getBoundingClientRect(),
      this.view.box,
      this.view,
    );
    if (at === null || this.resolved()?.mirrored !== true) {
      return at;
    }
    return { x: this.resolution().width - 1 - at.x, y: at.y };
  }

  /** Paints from the last point to this one, so a fast drag is still a line. */
  private paintTo(x: number, y: number): void {
    const sprite = this.sprite();
    const from = this.stroking;
    if (sprite === null || from === null) {
      return;
    }
    const color = this.tool() === 'eraser' ? null : this.color();
    if (sprite.stroke(from.x, from.y, x, y, color, this.alpha())) {
      // Drawn here rather than through the effect: a pencil a frame behind the
      // pointer is a pencil nobody can aim.
      this.draw();
    }
    this.stroking = { x, y };
  }

  /** Closes the open stroke, which is what makes it one step of the undo. */
  private finishStroke(): void {
    if (this.stroking === null) {
      return;
    }
    this.stroking = null;
    this.sprite()?.end();
    if (this.tool() === 'pencil') {
      this.remember(this.color());
    }
    this.touchSprites();
  }

  /** Takes the colour under the pointer, then goes back to drawing with it. */
  private pick(x: number, y: number): void {
    const found = this.sprite()?.colorAt(x, y) ?? null;
    if (found === null) {
      return;
    }
    this.color.set(found);
    this.remember(found);
    this.tool.set('pencil');
  }

  protected undo(): void {
    if (this.sprite()?.undo() === true) {
      this.touchSprites();
    }
  }

  protected redo(): void {
    if (this.sprite()?.redo() === true) {
      this.touchSprites();
    }
  }

  /**
   * Undo and redo, wherever the pointer is — but never while typing.
   *
   * The screen's **only** keyboard listener. The embedded {@link PixelEditor}
   * used to attach one of its own to the window, so on the flat scene both
   * fired and one Ctrl+Z undid two strokes. The chord is parsed in one place
   * now (`core/keyboard-shortcuts.ts`); acting on it is the screen's, because
   * only the screen knows which surface is open.
   */
  protected onKeyDown(event: KeyboardEvent): void {
    routeUndoRedo(event, { undo: () => this.undo(), redo: () => this.redo() });
  }

  /** Asks the browser to confirm before pixels nobody has written are lost. */
  protected onUnload(event: BeforeUnloadEvent): void {
    if (this.drafts.anyUnsaved() || this.unsavedSprites().length > 0) {
      event.preventDefault();
    }
  }

  /**
   * Creates a transparent image the size of the layer's box, and paints on it.
   *
   * Without it the pixel tools would only ever edit art made somewhere else,
   * which is the wrong half of the job: a layer blocked out on the canvas
   * should be paintable where it stands.
   */
  protected createImage(): void {
    const document = this.document();
    const layer = this.layer();
    const index = this.targetVariantIndex();
    const variant = this.variants()[index];
    if (document === null || layer === null || variant === undefined) {
      return;
    }
    const [, , width, height] = variant.rect ?? [0, 0, 16, 16];
    const path = `${ASSET_DIR}/${document.id}_${layer.id}_${variant.id}.png`;
    const sprite = SpriteDocument.blank(width, height);
    // It exists nowhere else, so it owes the disk a write from the moment it is
    // created rather than from its first stroke.
    sprite.markUnsaved();
    this.sessions.set(path, sprite);
    this.touchSprites();

    this.editLayer((draft) => {
      const target = draft.variants[index];
      if (target !== undefined) {
        target.sprite = { ...target.sprite, asset: path };
      }
    });
  }

  /** Which variant of the open layer is the one on screen. */
  private targetVariantIndex(): number {
    const drawn = this.target();
    const variants = this.variants();
    if (drawn === null) {
      return variants.length > 0 ? 0 : -1;
    }
    return variants.findIndex((variant) => variant.id === drawn.variant);
  }

  /** Writes every edited sprite into the content directory. */
  protected async saveSprites(): Promise<void> {
    this.drafts.setBusy(true);
    this.drafts.clearError();
    this.drafts.announce(null);
    try {
      const written = await this.writeSprites();
      this.drafts.announce(this.i18n.t('ui.editor.character.spritesSaved', { count: written }));
    } catch (cause) {
      this.drafts.fail(cause);
    } finally {
      this.drafts.setBusy(false);
    }
  }

  /**
   * Writes the edited sprites, one PNG each.
   *
   * @returns how many were written
   */
  private async writeSprites(): Promise<number> {
    const pending = [...this.sessions].filter(([, sprite]) => sprite.unsaved);
    if (pending.length === 0) {
      return 0;
    }
    for (const [asset, sprite] of pending) {
      await this.workspace.write(asset, await sprite.toBlob());
      sprite.markSaved();
    }
    await this.refreshFiles();
    // The cache holds the bytes these paths used to have — including a
    // "missing" entry for one that has only just been created.
    this.sprites.clear();
    this.touchSprites();
    return pending.length;
  }

  /** Opens a sprite for editing, at most once per path. */
  private requireSprite(asset: string): void {
    if (asset.length === 0 || this.sessions.has(asset) || this.opening.has(asset)) {
      return;
    }
    this.opening.add(asset);
    void this.openSprite(asset);
  }

  private async openSprite(asset: string): Promise<void> {
    try {
      const image = await this.loadImage(asset);
      const sprite = image === null ? null : SpriteDocument.fromImage(image);
      if (sprite === null) {
        // A path naming nothing is already reported as a missing asset, and the
        // stage draws the outline the renderer draws for one.
        return;
      }
      this.sessions.set(asset, sprite);
      this.touchSprites();
    } finally {
      this.opening.delete(asset);
    }
  }

  private remember(color: string): void {
    this.recent.update((colors) =>
      [color, ...colors.filter((held) => held !== color)].slice(0, RECENT_COLORS),
    );
  }

  /** Tells the view that the pixels moved. */
  private touchSprites(): void {
    this.strokes.update((count) => count + 1);
    // The session decides what "unsaved" means, and a stroke is half of it.
    this.drafts.touchSprites();
  }

  /**
   * Where in the edited sprite this pointer is, in the sprite's own pixels.
   *
   * Deliberately unbounded: a drag that leaves the sprite and comes back is one
   * stroke, and the line between two points is the part that matters. What is
   * outside is dropped a layer down, by the plot itself.
   */
  private pixelAt(event: PointerEvent): { x: number; y: number } | null {
    // The **resolved** box, not the authored one: a child's `rect` is measured
    // from the joint it hangs off, so the file's numbers are not where the
    // sprite is (`docs/adr/ADR-0024-character-definitions.md`).
    const box = this.drawnRect();
    if (box === null) {
      return null;
    }
    // Through the renderer's own inverse, measured off the element: a pointer
    // is reported in screen pixels and the stage was drawn in layout pixels,
    // and the interface scale is the factor between them.
    const at = this.canvasPixel(event);
    return at === null ? null : { x: at.x - box[0], y: at.y - box[1] };
  }

  /** Where the open layer's sprite actually landed, animation included. */
  private drawnRect(): PixelRect | null {
    const open = this.layer()?.id;
    return this.resolved()?.layers.find((drawn) => drawn.layer === open)?.rect ?? null;
  }

  // ----------------------------------------------------------------- drawing

  /**
   * Draws the resolved character into the preview canvas.
   *
   * The same function the game will draw with, over the same payload — the
   * preview has no drawing code of its own. What it adds is what only an
   * *editor* needs: the canvas bounds, a box around the layer being edited so
   * an author can see what they are moving, and — once the zoom is high enough
   * for it to mean anything — the pixel grid they are painting on.
   */
  private draw(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const frame = this.frameRef()?.nativeElement;
    const resolved = this.resolved();
    if (canvas === undefined || frame === undefined) {
      return;
    }

    // Two stages, one drawing: fitted to the panel until a zoom is asked for,
    // and then the canvas at exactly that zoom — where it is often larger than
    // the panel and scrolls inside it. The zoom is not the paint mode's: an
    // author looking closely at a sprite is not necessarily about to paint it.
    const explicit = this.paintZoom();
    const resolution = resolved?.resolution ?? this.resolution();
    // Fitting means the *frame*, both ways. It used to mean the frame's width
    // and a fixed 400px of height, which is why a fit in a tall panel left the
    // figure small with a band of nothing under it, and why the box the click
    // arithmetic used did not match the panel it was drawn in (ADR-0028).
    const width =
      explicit === null
        ? Math.max(MIN_STAGE, Math.floor(frame.clientWidth))
        : resolution.width * explicit;
    const height =
      explicit === null
        ? Math.max(MIN_STAGE, Math.floor(frame.clientHeight))
        : resolution.height * explicit;

    // The shell is zoomed by the interface scale, so a layout pixel is not a
    // screen pixel (`app/app.css`). The backing store follows the *screen*, or
    // a scaled interface would resample the sprites this whole pipeline exists
    // not to resample. Measured rather than read from the setting: whatever
    // scales the page, the element knows by how much.
    // Rounded to a percent, which is what the setting is: `clientWidth` is a
    // whole number and the rect is not, so an unscaled shell measures 1.0007
    // and would move the backing store for nothing.
    const measured =
      frame.clientWidth > 0 ? frame.getBoundingClientRect().width / frame.clientWidth : 1;
    const shell = Math.round(measured * 100) / 100;
    const context = canvas.getContext('2d');
    if (context === null) {
      return;
    }
    // One policy for every canvas in the application
    // (`renderer/canvas-surface.ts`). What is this stage's own is the three
    // arguments: the zoom already being applied, whatever is scaling the page,
    // and the largest backing store it will ask a tab for.
    prepareSurface(
      context,
      { width, height },
      { zoom: explicit ?? 1, scale: shell, maxSide: MAX_BACKING },
    );
    if (resolved === null) {
      return;
    }

    const box: CharacterBox = { x: 0, y: 0, width, height };
    // Asked of the renderer rather than assumed, so a click lands on the pixel
    // it points at: the stage and the drawing agree because they are the same
    // calculation.
    const { zoom, originX, originY } = placement(resolved.resolution, box);
    this.view = { zoom, originX, originY, box };

    this.paintTransparency(context, resolved.resolution, zoom, originX, originY);
    this.strokeCanvasBounds(context, resolved.resolution, zoom, originX, originY);
    drawCharacter(context, this.painted(resolved), box, this.source);
    if (this.showGrid() && zoom >= GRID_ZOOM) {
      this.strokeGrid(context, resolved.resolution, zoom, originX, originY);
    }

    // The overlays are drawn in canvas coordinates, so a mirrored character
    // needs them reflected too — a selection box on the wrong side of the
    // figure is worse than none at all.
    context.save();
    if (resolved.mirrored) {
      context.translate(originX * 2 + resolved.resolution.width * zoom, 0);
      context.scale(-1, 1);
    }
    if (this.skeleton()) {
      this.strokeSkeleton(context, zoom, originX, originY);
    }
    this.strokeOpenLayer(context, zoom, originX, originY);
    context.restore();
    this.zoom.set(zoom);
  }

  /**
   * The bones and joints, drawn over the character.
   *
   * What makes a positioning problem diagnosable: a line runs from where a
   * layer hangs — its parent's attachment point when it names one, the parent's
   * own origin otherwise — to the child's centre, and every attachment point is
   * marked. Both ends move with the animation, because
   * both are read off the *resolved* boxes rather than the authored ones.
   *
   * Editor-only: nothing in this method exists in the runtime's renderer.
   */
  private strokeSkeleton(
    context: CanvasRenderingContext2D,
    zoom: number,
    originX: number,
    originY: number,
  ): void {
    const drawn = new Map((this.resolved()?.layers ?? []).map((layer) => [layer.layer, layer]));
    const selected = this.layer()?.id;
    const point = (x: number, y: number): [number, number] => [
      originX + x * zoom + zoom / 2,
      originY + y * zoom + zoom / 2,
    ];

    context.save();
    context.lineWidth = Math.max(1, Math.round(zoom / 3));

    for (const layer of this.layers()) {
      const child = drawn.get(layer.id);
      const parentId = layer.parent;
      if (child === undefined || !parentId) {
        continue;
      }
      const parent = drawn.get(parentId);
      if (parent === undefined) {
        continue;
      }
      // Where it hangs: the named attachment point, measured from its own
      // layer's frame — which is what the child was placed from, so the bone
      // ends exactly where the placement started.
      const anchor = this.layers()
        .find((candidate) => candidate.id === parentId)
        ?.anchors?.find((candidate) => candidate.id === layer.parentAnchor);
      const from = anchor
        ? point(parent.origin[0] + anchor.at[0], parent.origin[1] + anchor.at[1])
        : point(parent.origin[0], parent.origin[1]);
      const to = point(child.rect[0] + child.rect[2] / 2, child.rect[1] + child.rect[3] / 2);

      context.strokeStyle =
        layer.id === selected || parentId === selected ? JOINT_COLOR : BONE_COLOR;
      context.beginPath();
      context.moveTo(from[0], from[1]);
      context.lineTo(to[0], to[1]);
      context.stroke();
    }

    // The joints themselves, on top of the bones so they stay readable.
    const radius = Math.max(2, Math.round(zoom * 0.9));
    context.fillStyle = JOINT_COLOR;
    for (const layer of this.layers()) {
      const placed = drawn.get(layer.id);
      if (placed === undefined) {
        continue;
      }
      for (const anchor of layer.anchors ?? []) {
        const [x, y] = point(placed.origin[0] + anchor.at[0], placed.origin[1] + anchor.at[1]);
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.restore();
  }

  /**
   * The character as the stage shows it while painting.
   *
   * The edited layer loses its tint. What the pencil writes is the file, and a
   * file seen through a multiply is not the thing being edited — an author
   * matching two greys would be matching them through a colour that is not in
   * either of them (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
   */
  private painted(resolved: ResolvedCharacter): ResolvedCharacter {
    const target = this.target();
    if (target === null || target.tint.length === 0) {
      return resolved;
    }
    return {
      ...resolved,
      layers: resolved.layers.map((layer) => (layer === target ? { ...layer, tint: '' } : layer)),
    };
  }

  /** One line per authored pixel, once they are big enough to aim at. */
  private strokeGrid(
    context: CanvasRenderingContext2D,
    resolution: SpriteResolution,
    zoom: number,
    originX: number,
    originY: number,
  ): void {
    context.save();
    context.strokeStyle = 'rgba(147, 161, 177, 0.16)';
    context.lineWidth = 1;
    context.beginPath();
    for (let x = 1; x < resolution.width; x += 1) {
      context.moveTo(originX + x * zoom + 0.5, originY);
      context.lineTo(originX + x * zoom + 0.5, originY + resolution.height * zoom);
    }
    for (let y = 1; y < resolution.height; y += 1) {
      context.moveTo(originX, originY + y * zoom + 0.5);
      context.lineTo(originX + resolution.width * zoom, originY + y * zoom + 0.5);
    }
    context.stroke();
    context.restore();
  }

  /**
   * The checkerboard that says "nothing is drawn here", on the canvas itself.
   *
   * Its squares are a whole number of **authored** pixels, so it reads as the
   * grid being painted on and zooms with it. A fixed screen size — which is
   * what a CSS background is — puts a second grid on the stage at a different
   * scale from the first, and at any real zoom the two disagree visibly.
   *
   * It covers the authored canvas and nothing else, which also makes the canvas
   * itself visible as a region rather than as a dashed line around everything.
   */
  private paintTransparency(
    context: CanvasRenderingContext2D,
    resolution: SpriteResolution,
    zoom: number,
    originX: number,
    originY: number,
  ): void {
    const [light, dark] = this.checkerColors();
    const width = resolution.width * zoom;
    const height = resolution.height * zoom;

    context.save();
    context.fillStyle = light;
    context.fillRect(originX, originY, width, height);

    // How many authored pixels one square is: one, unless one would be too
    // small to read, in which case as few as still clear MIN_CHECKER.
    const step = Math.max(1, Math.ceil(MIN_CHECKER / zoom));
    const square = step * zoom;
    context.fillStyle = dark;
    for (let row = 0; row * step < resolution.height; row += 1) {
      for (let column = row % 2; column * step < resolution.width; column += 2) {
        context.fillRect(
          originX + column * square,
          originY + row * square,
          Math.min(square, width - column * square),
          Math.min(square, height - row * square),
        );
      }
    }
    context.restore();
  }

  /**
   * The checker's two greys, taken from the theme rather than written here.
   *
   * Read once: `getComputedStyle` is a style recalculation, and this runs on
   * every frame of a drag.
   */
  private checkerColors(): readonly [string, string] {
    if (this.checker === null) {
      const canvas = this.canvasRef()?.nativeElement;
      const style = canvas === undefined ? null : getComputedStyle(canvas);
      this.checker = [
        style?.getPropertyValue('--bg').trim() || '#0d1117',
        style?.getPropertyValue('--bg-raised').trim() || '#1c242f',
      ];
    }
    return this.checker;
  }

  /** The authored canvas, so an author sees what their pixels are measured in. */
  private strokeCanvasBounds(
    context: CanvasRenderingContext2D,
    resolution: SpriteResolution,
    zoom: number,
    originX: number,
    originY: number,
  ): void {
    context.save();
    context.strokeStyle = 'rgba(147, 161, 177, 0.35)';
    context.setLineDash([2, 3]);
    context.strokeRect(
      originX + 0.5,
      originY + 0.5,
      resolution.width * zoom - 1,
      resolution.height * zoom - 1,
    );
    context.restore();
  }

  /** A box around the layer open in the form, drawn over the character. */
  private strokeOpenLayer(
    context: CanvasRenderingContext2D,
    zoom: number,
    originX: number,
    originY: number,
  ): void {
    const open = this.layer()?.id;
    const drawn = this.resolved()?.layers.find((layer) => layer.layer === open);
    if (drawn === undefined) {
      return;
    }
    const [x, y, layerWidth, layerHeight] = drawn.rect;
    context.save();
    context.strokeStyle = '#ffd166';
    context.lineWidth = 1;
    context.strokeRect(
      originX + x * zoom - 0.5,
      originY + y * zoom - 0.5,
      layerWidth * zoom + 1,
      layerHeight * zoom + 1,
    );
    context.restore();
  }

  // ---------------------------------------------------------------- plumbing

  /** Edits the open layer in place. */
  private editLayer(mutate: (layer: CharacterLayer) => void): void {
    const id = this.layer()?.id;
    this.edit((draft) => {
      const layer = draft.layers?.find((candidate) => candidate.id === id);
      if (layer !== undefined) {
        mutate(layer);
      }
    });
  }
}

/**
 * Drops every tint bound to a parameter that no longer exists.
 *
 * A dangling binding does not validate, and the author deleting a parameter is
 * not saying "and break every layer that read it".
 */
function dropTint(draft: CharacterDefinition, parameterId: string): void {
  for (const layer of draft.layers ?? []) {
    for (const variant of layer.variants) {
      const tint = variant.sprite.tint;
      if (tint && 'parameter' in tint && tint.parameter === parameterId) {
        variant.sprite = { asset: variant.sprite.asset };
      }
    }
  }
}

/**
 * Every image a character definition names, once each.
 *
 * What the session asks for when it wants to know whether this draft owes the
 * disk any pixels: a sprite is only *this* character's if one of its layers
 * points at it.
 */
function spriteAssets(document: CharacterDefinition): string[] {
  const assets = new Set<string>();
  for (const layer of document.layers ?? []) {
    for (const variant of layer.variants ?? []) {
      const asset = variant.sprite?.asset ?? '';
      if (asset.length > 0) {
        assets.add(asset);
      }
    }
  }
  return [...assets];
}

/**
 * Every locale key a character definition names.
 *
 * The same set the Rust validator walks, in the same order.
 */
function referencedKeys(document: CharacterDefinition): string[] {
  const keys: string[] = [];
  for (const parameter of document.parameters ?? []) {
    keys.push(parameter.labelKey);
    if (parameter.helpKey !== undefined) {
      keys.push(parameter.helpKey);
    }
    for (const option of parameter.options ?? []) {
      keys.push(option.labelKey);
    }
  }
  return keys;
}

/** A default this control accepts, given the options it currently declares. */
function defaultFor(control: ControlKind, options: readonly string[] = []): SettingValue {
  switch (control) {
    case 'toggle':
    case 'checkbox':
      return false;
    case 'slider':
    case 'number':
      return 1;
    case 'color':
      return '#7a5c3e';
    case 'select':
      return options[0] ?? '';
    case 'multiSelect':
      return [];
    case 'text':
      return '';
    case 'keyBinding':
      // The character editor never offers this settings-only control. Keeping
      // the shared union exhaustive makes an imported invalid document fail in
      // Rust instead of leaving this helper with an undefined value.
      return 'KeyQ';
  }
}

/** Reads a condition value out of a text field: JSON when it is, text otherwise. */
function parseValue(raw: string): SettingValue {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'boolean' || typeof parsed === 'number' || typeof parsed === 'string') {
      return parsed;
    }
  } catch {
    // Not JSON, so it is the text itself.
  }
  return raw;
}
