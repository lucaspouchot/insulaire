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
  RENDERING_MODES,
  RenderingMode,
  ResolvedCharacter,
  SHAPE_KINDS,
  SettingValue,
  ShapeKind,
  blankVariant,
  freeId,
  isNumeric,
  move,
  usesOptions,
} from './character-editor.types';
import { CHARACTER_SCHEMA_VERSION, ContentRef } from '../../../../content/content-types';
import { serializeCharacter } from '../../../../content/character-serializer';
import { ValidationReport } from '../../../../engine/engine.types';
import { assetUrl } from '../../../../core/asset-url';
import { SpriteCache, drawCharacter } from '../../../../renderer/character-renderer';
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import { ControlField } from '../../../settings/control-field';
import { ContentWorkspaceService } from '../../../services/content-workspace.service';
import { EngineService } from '../../../services/engine.service';
import { LocaleAuthoringService } from '../../../services/locale-authoring.service';
import { CharacterLibraryService } from '../../../services/character-library.service';
import { CONTENT_ROOT, ProjectStoreService } from '../../../services/project-store.service';

/** Height of the preview's drawing box, in CSS pixels. */
const PREVIEW_HEIGHT = 320;

@Component({
  selector: 'app-character-editor-page',
  imports: [TranslatePipe, ControlField],
  templateUrl: './character-editor-page.html',
  styleUrl: './character-editor-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CharacterEditorPage implements AfterViewInit, OnDestroy {
  private readonly store = inject(ProjectStoreService);
  private readonly engine = inject(EngineService);
  private readonly i18n = inject(I18nService);
  private readonly workspace = inject(ContentWorkspaceService);
  private readonly locales = inject(LocaleAuthoringService);
  private readonly library = inject(CharacterLibraryService);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('stage');

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

  /** The customisation the preview is showing. */
  protected readonly values = signal<CharacterValues>({});
  /** What the resolver made of the open definition and those values. */
  protected readonly resolved = signal<ResolvedCharacter | null>(null);

  /** Which layer the variant editor is showing. */
  private readonly layerIdSignal = signal<string | null>(null);

  protected readonly categories = CATEGORIES;
  protected readonly renderingModes = RENDERING_MODES;
  protected readonly shapeKinds = SHAPE_KINDS;
  protected readonly controlKinds = CONTROL_KINDS;
  protected readonly usesOptions = usesOptions;
  protected readonly isNumeric = isNumeric;

  private readonly sprites = new SpriteCache(
    (asset) => assetUrl(`${CONTENT_ROOT}/${asset}`),
    () => this.draw(),
  );
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

  protected readonly parameters = computed<readonly ControlDefinition[]>(
    () => this.document()?.parameters ?? [],
  );

  /** Parameters that could drive a scale: the numeric ones. */
  protected readonly numericParameters = computed<readonly ControlDefinition[]>(() =>
    this.parameters().filter((parameter) => isNumeric(parameter.control)),
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
      this.draw();
    });
    void this.load();
  }

  ngAfterViewInit(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (canvas !== undefined) {
      this.resizeObserver = new ResizeObserver(() => this.draw());
      this.resizeObserver.observe(canvas);
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

      const declared = this.store.project()?.characters ?? [];
      const documents = await Promise.all(declared.map((entry) => this.fetchCharacter(entry)));
      this.documentsSignal.set(documents.filter((document) => document !== null));
      this.openIdSignal.set(this.documentsSignal()[0]?.id ?? null);
      this.refresh();
    } catch (cause) {
      this.error.set(describe(cause));
    } finally {
      this.loading.set(false);
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
   * It starts as a body and a head so the preview shows a character rather than
   * an empty box: a new definition should be something to change, not something
   * to build from nothing.
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
      rendering: 'procedural',
      parameters: [],
      layers: [
        {
          id: 'body',
          variants: [
            {
              id: 'default',
              rect: [0.34, 0.4, 0.32, 0.45],
              visual: { kind: 'shape', shape: 'rect', color: { fixed: '#7a5c3e' } },
            },
          ],
        },
        {
          id: 'head',
          variants: [
            {
              id: 'default',
              rect: [0.41, 0.18, 0.18, 0.22],
              visual: { kind: 'shape', shape: 'ellipse', color: { fixed: '#e8c39e' } },
            },
          ],
        },
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
   * Changes how the character is drawn, and takes its variants with it.
   *
   * The engine refuses a definition whose variants contradict its declared
   * mode, so switching modes converts every visual rather than producing a file
   * that cannot load on a single click.
   */
  protected setRendering(rendering: string): void {
    const mode = rendering as RenderingMode;
    this.edit((draft) => {
      draft.rendering = mode;
      for (const layer of draft.layers ?? []) {
        for (const variant of layer.variants) {
          if (mode === 'assetComposition' && variant.visual.kind === 'shape') {
            variant.visual = { kind: 'sprite', asset: '' };
          } else if (mode === 'procedural' && variant.visual.kind === 'sprite') {
            variant.visual = { kind: 'shape', shape: 'rect', color: { fixed: '#7a5c3e' } };
          }
        }
      }
    });
  }

  /** Binds — or unbinds, given `''` — the parameter that scales the character. */
  protected setScaleParameter(id: string): void {
    this.edit((draft) => {
      draft.scaleParameter = id;
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
      if (removed !== undefined && draft.scaleParameter === removed.id) {
        // A binding to a parameter that no longer exists would not validate.
        draft.scaleParameter = '';
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
        if (draft.scaleParameter === parameter.id) {
          draft.scaleParameter = '';
        }
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
    const rendering = this.document()?.rendering ?? 'procedural';
    this.edit((draft) => {
      draft.layers = [
        ...(draft.layers ?? []),
        { id, variants: [blankVariant('default', rendering)] },
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
      draft.variants.push(blankVariant(id, this.document()?.rendering ?? 'procedural'));
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

  /** Sets one corner or side of a variant's box, in unit space. */
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
      const rect: [number, number, number, number] = [...(variant.rect ?? [0, 0, 1, 1])];
      rect[part] = parsed;
      variant.rect = rect;
    });
  }

  protected setShape(index: number, shape: string): void {
    this.editLayer((draft) => {
      const variant = draft.variants[index];
      if (variant?.visual.kind === 'shape') {
        variant.visual.shape = shape as ShapeKind;
      }
    });
  }

  protected setAsset(index: number, asset: string): void {
    this.editLayer((draft) => {
      const variant = draft.variants[index];
      if (variant?.visual.kind === 'sprite') {
        variant.visual.asset = asset.trim();
      }
    });
  }

  /**
   * Points a shape's colour at a parameter, or back at a fixed colour.
   *
   * `''` means fixed; anything else is a parameter id. This is the choice that
   * turns "brown hair" into "the hair colour the player picked".
   */
  protected setColorSource(index: number, parameterId: string): void {
    this.editLayer((draft) => {
      const variant = draft.variants[index];
      if (variant?.visual.kind !== 'shape') {
        return;
      }
      variant.visual.color =
        parameterId.length === 0 ? { fixed: '#7a5c3e' } : { parameter: parameterId };
    });
  }

  protected setFixedColor(index: number, color: string): void {
    this.editLayer((draft) => {
      const variant = draft.variants[index];
      if (variant?.visual.kind === 'shape') {
        variant.visual.color = { fixed: color };
      }
    });
  }

  /** The parameter a variant's colour is bound to, or `''` when it is fixed. */
  protected colorParameter(variant: LayerVariant): string {
    if (variant.visual.kind !== 'shape') {
      return '';
    }
    return 'parameter' in variant.visual.color ? variant.visual.color.parameter : '';
  }

  /** The colour written in the file, for the swatch that edits it. */
  protected fixedColor(variant: LayerVariant): string {
    if (variant.visual.kind !== 'shape' || !('fixed' in variant.visual.color)) {
      return '#000000';
    }
    return variant.visual.color.fixed;
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

  // ----------------------------------------------------------------- drawing

  /**
   * Draws the resolved character into the preview canvas.
   *
   * The same function the game will draw with, over the same payload — the
   * preview has no drawing code of its own.
   */
  private draw(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const resolved = this.resolved();
    if (canvas === undefined) {
      return;
    }

    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.max(1, Math.floor(canvas.clientWidth));
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(PREVIEW_HEIGHT * ratio);

    const context = canvas.getContext('2d');
    if (context === null) {
      return;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, PREVIEW_HEIGHT);
    if (resolved === null) {
      return;
    }

    // A portrait-shaped box, centred: a character is taller than it is wide,
    // and the unit square is square, so the box is what gives it proportions.
    const height = PREVIEW_HEIGHT;
    const boxWidth = height * 0.55;
    drawCharacter(
      context,
      resolved,
      { x: (width - boxWidth) / 2, y: 0, width: boxWidth, height },
      this.sprites,
    );
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

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
