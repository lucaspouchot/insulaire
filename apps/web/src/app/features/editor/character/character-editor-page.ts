/**
 * The character editor.
 *
 * It edits **character definitions** — how a kind of character is drawn, and
 * what may be chosen about one. The player's character is simply the first of
 * them; nothing on this screen knows what a player is, and the same form
 * creates a merchant, a goblin or a dragon
 * (`docs/adr/ADR-0028-character-definitions.md`).
 *
 * A definition is two lists:
 *
 * * **parameters** — the choices it offers, written in the settings vocabulary,
 *   so "hair colour" is a `color` control and the player's character-creation
 *   screen will render it with the component that renders a volume slider
 *   (`docs/adr/ADR-0025-settings.md`);
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
 * (`docs/adr/ADR-0030-the-editor-paints-its-sprites.md`).
 *
 * Labels are keys: this screen picks and **creates** them — saving writes every
 * key the file names into every language, empty — and the language editor is
 * where their text is written (ADR-0023,
 * `docs/adr/ADR-0027-authoring-creates-keys.md`).
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
  CATEGORIES,
  CONTROL_KINDS,
  CharacterCategory,
  CharacterDefinition,
  CharacterLayer,
  CharacterValues,
  ControlDefinition,
  ControlKind,
  LayerVariant,
  MAX_SPRITE_RESOLUTION,
  ResolvedCharacter,
  SettingValue,
  SpriteResolution,
  blankVariant,
  clampResolution,
  freeId,
  isNumeric,
  move,
  usesOptions,
} from './character-editor.types';
import {
  CHARACTER_SCHEMA_VERSION,
  ContentRef,
  ResolvedLayer,
} from '../../../../content/content-types';
import { serializeCharacter } from '../../../../content/character-serializer';
import { PALETTE_SIZE, SpriteDocument } from '../../../../content/sprite-document';
import { ValidationReport } from '../../../../engine/engine.types';
import { assetUrl } from '../../../../core/asset-url';
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
import { ContentWorkspaceService, WorkspaceFile } from '../../../services/content-workspace.service';
import { EngineService } from '../../../services/engine.service';
import { LocaleAuthoringService } from '../../../services/locale-authoring.service';
import { CharacterLibraryService } from '../../../services/character-library.service';
import { CONTENT_ROOT, ProjectStoreService } from '../../../services/project-store.service';

/** Height of the preview's drawing box, in CSS pixels.
 *
 * Chosen so a 128-pixel-tall canvas — the shape most standing characters are
 * authored at — reaches a 3× zoom rather than stopping at 2×.
 */
const PREVIEW_HEIGHT = 400;

/** Where an uploaded sprite goes: a convention, not a rule. */
const ASSET_DIR = 'assets/characters';

/** The tint picker's entry for "a colour written in the file". */
const FIXED_TINT = '#fixed';

/**
 * The zooms the pixel tools step through, in screen pixels per authored pixel.
 *
 * Whole numbers, for the reason the renderer's zoom is one: a pixel is a square
 * block of screen pixels or it is a smear
 * (`docs/adr/ADR-0029-characters-are-composed-sprites.md`).
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
const GRID_ZOOM = 8;

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
type PaintTool = 'pencil' | 'eraser' | 'picker';

@Component({
  selector: 'app-character-editor-page',
  imports: [TranslatePipe, ControlField],
  templateUrl: './character-editor-page.html',
  styleUrl: './character-editor-page.css',
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
export class CharacterEditorPage implements AfterViewInit, OnDestroy {
  private readonly store = inject(ProjectStoreService);
  private readonly engine = inject(EngineService);
  private readonly i18n = inject(I18nService);
  private readonly workspace = inject(ContentWorkspaceService);
  private readonly locales = inject(LocaleAuthoringService);
  private readonly library = inject(CharacterLibraryService);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('stage');
  private readonly frameRef = viewChild<ElementRef<HTMLElement>>('frame');

  /** Every definition the project holds, by id, as edited. */
  private readonly documentsSignal = signal<readonly CharacterDefinition[]>([]);
  /** Id of the definition open in the form. */
  private readonly openIdSignal = signal<string | null>(null);
  /** Ids of the definitions whose file no longer matches the document. */
  private readonly unsaved = signal<readonly string[]>([]);

  protected readonly report = signal<ValidationReport | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly loading = signal(true);
  /** Paths the manifest declares that could not be read. */
  protected readonly unreadable = signal<readonly string[]>([]);

  /** The customisation the preview is showing. */
  protected readonly values = signal<CharacterValues>({});
  /** Content files the workspace holds, for the asset picker. */
  protected readonly files = signal<readonly WorkspaceFile[]>([]);
  /** What the resolver made of the open definition and those values. */
  protected readonly resolved = signal<ResolvedCharacter | null>(null);
  /** Whole-number zoom the preview settled on, for the readout. */
  protected readonly zoom = signal(1);

  /** `true` while the stage is a drawing surface rather than a preview. */
  protected readonly painting = signal(false);
  /** What the pointer does on the stage. */
  protected readonly tool = signal<PaintTool>('pencil');
  /** The colour the pencil paints with. */
  protected readonly color = signal('#c9b28a');
  /** The zoom the author asked for; `null` fits the character to the stage. */
  protected readonly paintZoom = signal<number | null>(null);
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

  /** Which layer the variant editor is showing. */
  private readonly layerIdSignal = signal<string | null>(null);

  protected readonly categories = CATEGORIES;
  protected readonly controlKinds = CONTROL_KINDS;
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
  };
  private resizeObserver: ResizeObserver | null = null;

  /** Every definition, in project order. */
  protected readonly documents = this.documentsSignal.asReadonly();

  /** The definition being edited, or `null` when the project has none. */
  protected readonly document = computed<CharacterDefinition | null>(() => {
    const documents = this.documentsSignal();
    const id = this.openIdSignal();
    return documents.find((candidate) => candidate.id === id) ?? documents.at(0) ?? null;
  });

  /** Path this definition's file has, declared or by convention. */
  protected readonly path = computed(() => {
    const document = this.document();
    return document === null ? '' : this.store.characterPath(document.id);
  });

  /** `true` when the open definition differs from its file. */
  protected readonly dirty = computed(() => {
    const document = this.document();
    return document !== null && this.unsaved().includes(document.id);
  });

  /** `true` when files can actually be written — the editor is honest about it. */
  protected readonly writable = computed(() => this.workspace.status() !== null);

  /** `true` when the manifest does not list the open definition. */
  protected readonly unlisted = computed(() => {
    const document = this.document();
    return (
      document !== null &&
      !(this.store.project()?.characters ?? []).some((entry) => entry.id === document.id)
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
   * (`docs/adr/ADR-0027-authoring-creates-keys.md`).
   */
  protected readonly blocking = computed(() =>
    (this.report()?.issues ?? []).filter((issue) => issue.code !== 'locale.unknownKey'),
  );

  /** Keys this file names that no language gives text to yet. */
  protected readonly untranslated = computed(() =>
    (this.report()?.issues ?? []).filter((issue) => issue.code === 'locale.unknownKey'),
  );

  protected readonly errorCount = computed(
    () => this.blocking().filter((issue) => issue.severity === 'error').length,
  );

  constructor() {
    // Redrawing is a side effect of the resolved character changing, whatever
    // changed it — an edit, a preview choice, or opening another definition.
    effect(() => {
      this.resolved();
      this.strokes();
      this.painting();
      this.paintZoom();
      this.draw();
    });
    // Every sprite the character draws is opened, not just the one being
    // edited: that is what makes the palette the *character's* palette, and
    // what makes switching layers instant rather than a decode away.
    effect(() => {
      if (!this.painting()) {
        return;
      }
      for (const drawn of this.resolved()?.layers ?? []) {
        this.requireSprite(drawn.asset);
      }
    });
    void this.load();
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
  }

  private async load(): Promise<void> {
    try {
      await this.engine.ready();
      await this.i18n.ensureAdopted();
      await this.store.ensureLoaded();
      await this.workspace.ensureProbed();
      await this.locales.ensureLoaded();
      // Registered as well as fetched: the *runtime* holds these, and this
      // screen is about to replace one of them.
      await this.library.ensureLoaded();
      await this.refreshFiles();

      const declared = this.store.project()?.characters ?? [];
      const documents = await Promise.all(declared.map((entry) => this.fetchCharacter(entry)));
      this.documentsSignal.set(documents.filter((document) => document !== null));
      // A declared character that will not open used to vanish without a word,
      // which is indistinguishable from one that was never declared — and it is
      // the editor, not the author, that knows the difference.
      this.unreadable.set(
        declared.filter((_entry, index) => documents[index] === null).map((entry) => entry.path),
      );
      this.openIdSignal.set(this.documentsSignal()[0]?.id ?? null);
      this.refresh();
    } catch (cause) {
      this.error.set(describe(cause));
    } finally {
      this.loading.set(false);
    }
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
    const current = this.document();
    if (current === null) {
      return;
    }
    const draft = structuredClone(current) as CharacterDefinition;
    mutate(draft);

    this.documentsSignal.update((documents) =>
      documents.map((document) => (document.id === current.id ? draft : document)),
    );
    if (this.openIdSignal() === current.id) {
      this.openIdSignal.set(draft.id);
    }
    if (draft.id === current.id) {
      this.markUnsaved(current.id);
    } else {
      // A rename takes the manifest entry with it. The old *file* is left on
      // disk — deleting content is the author's decision — but a manifest that
      // still listed the old id would name a definition nothing writes any more.
      this.store.undeclareCharacter(current.id);
      this.library.forget(current.id);
      this.unsaved.update((ids) => ids.filter((id) => id !== current.id));
      this.markUnsaved(draft.id);
    }
    this.message.set(null);
    this.refresh();
  }

  private markUnsaved(id: string): void {
    this.unsaved.update((ids) => (ids.includes(id) ? ids : [...ids, id]));
  }

  protected open(id: string): void {
    this.openIdSignal.set(id);
    this.layerIdSignal.set(null);
    this.resetChoices();
    this.message.set(null);
    this.refresh();
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
      this.documentsSignal().map((document) => document.id),
    );
    const document: CharacterDefinition = {
      id,
      schemaVersion: CHARACTER_SCHEMA_VERSION,
      name: id,
      category: 'other',
      resolution: { width: 64, height: 128 },
      parameters: [],
      layers: [
        { id: 'body', variants: [{ id: 'default', rect: [20, 40, 24, 76], sprite: { asset: '' } }] },
        { id: 'head', variants: [{ id: 'default', rect: [24, 12, 16, 28], sprite: { asset: '' } }] },
      ],
    };

    this.documentsSignal.update((documents) => [...documents, document]);
    this.markUnsaved(id);
    this.open(id);
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
    if (document === null) {
      return;
    }
    this.documentsSignal.update((documents) =>
      documents.filter((candidate) => candidate.id !== document.id),
    );
    this.store.undeclareCharacter(document.id);
    this.library.forget(document.id);
    this.unsaved.update((ids) => ids.filter((id) => id !== document.id));
    this.open(this.documentsSignal()[0]?.id ?? '');
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
   * (`docs/adr/ADR-0022-authoring-content-workspace.md`).
   */
  protected async uploadAsset(event: Event, index: number): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    input.value = '';

    this.busy.set(true);
    this.error.set(null);
    try {
      const path = `${ASSET_DIR}/${file.name}`;
      await this.workspace.write(path, file);
      await this.refreshFiles();
      // The cache may hold a "missing" entry for this path from a previous
      // draw, and the file on disk has just changed under it either way.
      this.sprites.clear();
      this.setAsset(index, path);
      this.message.set(this.i18n.t('ui.editor.character.uploaded', { file: path }));
    } catch (cause) {
      this.error.set(describe(cause));
    } finally {
      this.busy.set(false);
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
    return this.resolved()?.values[parameter.id] ?? parameter.default;
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
   * is this screen's opinion (ADR-0015, ADR-0028).
   */
  protected refresh(): void {
    const document = this.document();
    if (document === null || !this.engine.isReady) {
      this.report.set(null);
      this.resolved.set(null);
      return;
    }
    try {
      this.report.set(this.engine.validateCharacter(serializeCharacter(document)));
      this.resolved.set(this.engine.previewCharacter(document, this.values()));
      this.error.set(null);
    } catch (cause) {
      this.error.set(describe(cause));
    }
  }

  /** Writes the open definition into the content directory. */
  protected async save(): Promise<void> {
    const document = this.document();
    if (document === null) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.message.set(null);

    try {
      const json = serializeCharacter(document);
      this.report.set(this.engine.validateCharacter(json));
      if (this.errorCount() > 0) {
        this.error.set(this.i18n.t('ui.editor.character.invalid'));
        return;
      }

      const path = this.store.characterPath(document.id);
      await this.workspace.writeJson(path, json);
      // Adopting it is what makes the *runtime* agree with the file from here
      // on, without a reload — and what a later content reset puts back.
      this.library.adopt(document.id, json);

      // A definition nobody lists is a definition nobody loads, so saving one
      // declares it — and writes the manifest that now names it.
      const parts = [this.i18n.t('ui.editor.character.saved', { file: path })];

      // The art goes with the definition. An author who painted and pressed
      // Save meant both, and a sprite left only in a tab is a sprite lost.
      const written = await this.writeSprites();
      if (written > 0) {
        parts.push(this.i18n.t('ui.editor.character.spritesSaved', { count: written }));
      }

      this.store.declareCharacter(document.id, path);
      if (this.store.manifestNeedsWriting()) {
        await this.workspace.writeJson('project.json', this.store.projectJson());
        this.store.markManifestWritten();
        parts.push(this.i18n.t('ui.editor.character.savedManifest'));
      }
      this.store.refreshDirty();

      // Every label this file names now exists as a key, in every language, so
      // the Languages tab lists it and a translator can fill it in.
      const created = await this.createMissingKeys(document);
      if (created > 0) {
        parts.push(this.i18n.t('ui.editor.locale.created', { count: created }));
      }

      this.unsaved.update((ids) => ids.filter((id) => id !== document.id));
      this.refresh();
      this.message.set(parts.join(' · '));
    } catch (cause) {
      this.error.set(describe(cause));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Creates every key this definition names that no language has yet.
   *
   * @returns how many keys were created
   */
  private async createMissingKeys(document: CharacterDefinition): Promise<number> {
    const created = this.locales.ensureKeys(referencedKeys(document));
    if (created.length === 0) {
      return 0;
    }
    await this.locales.save();
    return created.length;
  }

  // ------------------------------------------------------------------ pixels

  /** Turns the stage into a drawing surface, or back into a preview. */
  protected togglePaint(): void {
    this.finishStroke();
    this.painting.update((on) => !on);
  }

  protected setTool(tool: PaintTool): void {
    this.tool.set(tool);
  }

  protected setColor(color: string): void {
    this.color.set(color);
    this.remember(color);
  }

  /** The zoom in force: the one asked for, or the one the fit settled on. */
  protected effectiveZoom(): number {
    return this.paintZoom() ?? this.zoom();
  }

  protected zoomBy(delta: number): void {
    const steps = this.zoomSteps();
    const from = steps.findIndex((step) => step >= this.effectiveZoom());
    const at = from < 0 ? steps.length - 1 : from;
    const next = steps[Math.min(steps.length - 1, Math.max(0, at + delta))];
    if (next !== undefined) {
      this.paintZoom.set(next);
    }
  }

  /** Back to the zoom that fits the whole character in the stage. */
  protected fitZoom(): void {
    this.paintZoom.set(null);
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
    const sprite = this.sprite();
    const at = this.pixelAt(event);
    if (!this.painting() || sprite === null || at === null || !sprite.holds(at.x, at.y)) {
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

  /** Paints from the last point to this one, so a fast drag is still a line. */
  private paintTo(x: number, y: number): void {
    const sprite = this.sprite();
    const from = this.stroking;
    if (sprite === null || from === null) {
      return;
    }
    const color = this.tool() === 'eraser' ? null : this.color();
    if (sprite.stroke(from.x, from.y, x, y, color)) {
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

  /** Undo and redo, wherever the pointer is — but never while typing. */
  protected onKeyDown(event: KeyboardEvent): void {
    if (!this.painting() || isTyping(event.target) || !(event.ctrlKey || event.metaKey)) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
    } else if (key === 'y') {
      event.preventDefault();
      this.redo();
    }
  }

  /** Asks the browser to confirm before pixels nobody has written are lost. */
  protected onUnload(event: BeforeUnloadEvent): void {
    if (this.unsavedSprites().length > 0) {
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
    this.painting.set(true);
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
    this.busy.set(true);
    this.error.set(null);
    this.message.set(null);
    try {
      const written = await this.writeSprites();
      this.message.set(this.i18n.t('ui.editor.character.spritesSaved', { count: written }));
    } catch (cause) {
      this.error.set(describe(cause));
    } finally {
      this.busy.set(false);
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
  }

  /**
   * Where in the edited sprite this pointer is, in the sprite's own pixels.
   *
   * Deliberately unbounded: a drag that leaves the sprite and comes back is one
   * stroke, and the line between two points is the part that matters. What is
   * outside is dropped a layer down, by the plot itself.
   */
  private pixelAt(event: PointerEvent): { x: number; y: number } | null {
    const canvas = this.canvasRef()?.nativeElement;
    const target = this.target();
    if (canvas === undefined || target === null) {
      return null;
    }
    // Through the renderer's own inverse, measured off the element: a pointer
    // is reported in screen pixels and the stage was drawn in layout pixels,
    // and the interface scale is the factor between them.
    const at = pixelUnder(
      { x: event.clientX, y: event.clientY },
      canvas.getBoundingClientRect(),
      this.view.box,
      this.view,
    );
    return at === null ? null : { x: at.x - target.rect[0], y: at.y - target.rect[1] };
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
    const width =
      explicit === null ? Math.max(1, Math.floor(frame.clientWidth)) : resolution.width * explicit;
    const height = explicit === null ? PREVIEW_HEIGHT : resolution.height * explicit;

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
    // A device ratio buys nothing once one authored pixel is a block four
    // screen pixels wide, and at these sizes it costs a great deal of memory.
    const dense =
      explicit !== null && explicit >= 4 ? 1 : Math.min(window.devicePixelRatio || 1, 3);
    const ratio = Math.min(dense * shell, MAX_BACKING / Math.max(width, height));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);

    const context = canvas.getContext('2d');
    if (context === null) {
      return;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
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
    if (this.painting() && zoom >= GRID_ZOOM) {
      this.strokeGrid(context, resolved.resolution, zoom, originX, originY);
    }
    this.strokeOpenLayer(context, zoom, originX, originY);
    this.zoom.set(zoom);
  }

  /**
   * The character as the stage shows it while painting.
   *
   * The edited layer loses its tint. What the pencil writes is the file, and a
   * file seen through a multiply is not the thing being edited — an author
   * matching two greys would be matching them through a colour that is not in
   * either of them (`docs/adr/ADR-0030-the-editor-paints-its-sprites.md`).
   */
  private painted(resolved: ResolvedCharacter): ResolvedCharacter {
    const target = this.target();
    if (!this.painting() || target === null || target.tint.length === 0) {
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

/** `true` when a keystroke belongs to a form field rather than to the stage. */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && /^(input|textarea|select)$/i.test(target.tagName);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
