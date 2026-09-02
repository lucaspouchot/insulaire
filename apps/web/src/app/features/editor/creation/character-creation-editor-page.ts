/** Editor for the project's generic character-creation declaration. */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { serializeCharacterCreation } from '../../../../content/character-creation-serializer';
import {
  CHARACTER_CREATION_SCHEMA_VERSION,
  CharacterCreationDefinition,
  CharacterCreationResult,
  CharacteristicDefinition,
  CreationBinding,
  CreationBlock,
  CreationChoice,
  CreationScreen,
  ScreenTransition,
} from '../../../../content/generated/character-creation';
import {
  ControlDefinition,
  ControlKind,
  ControlOption,
  SettingValue,
} from '../../../../content/generated/settings';
import { surfaceDensity } from '../../../../renderer/canvas-surface';
import { SpriteCache } from '../../../../renderer/character-renderer';
import { CharacterStage, NO_STAGE_CHROME } from '../../../../renderer/character-stage';
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import { ControlField } from '../../../settings/control-field';
import { CharacterCreationService } from '../../../services/character-creation.service';
import { CharacterLibraryService } from '../../../services/character-library.service';
import { ContentWorkspaceService } from '../../../services/content-workspace.service';
import { EngineService } from '../../../services/engine.service';
import { LocaleAuthoringService } from '../../../services/locale-authoring.service';
import { ProjectManifest } from '../../../project/project-manifest';
import { WriteLedger } from '../../../project/write-ledger';
import {
  CONTENT_ROOT,
  ProjectStoreService,
  contentUrl,
} from '../../../services/project-store.service';
import { CONTROL_KINDS, defaultFor } from '../settings/settings-editor.types';
import {
  addOption,
  editOption,
  isNumeric,
  removeOption,
  setControlKind,
  usesOptions,
} from '../../../settings/control-list';
import { DraftSet } from '../../../editing/draft-set';
import { DraftSource } from '../../../editing/draft-source';
import { freeId } from '../../../editing/ids';

type EditorTab = 'choices' | 'characteristics' | 'workflow';

const TRANSITIONS: readonly ScreenTransition[] = ['none', 'fade', 'slideLeft', 'slideUp'];
const BLOCK_TYPES: readonly CreationBlock['type'][] = [
  'text',
  'choice',
  'characteristic',
  'preview',
  'summary',
];

@Component({
  selector: 'app-character-creation-editor-page',
  imports: [TranslatePipe, ControlField],
  templateUrl: './character-creation-editor-page.html',
  styleUrl: './character-creation-editor-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CharacterCreationEditorPage {
  private readonly engine = inject(EngineService);
  private readonly store = inject(ProjectStoreService);
  private readonly manifest = inject(ProjectManifest);
  private readonly ledger = inject(WriteLedger);
  private readonly library = inject(CharacterLibraryService);
  private readonly creation = inject(CharacterCreationService);
  private readonly workspace = inject(ContentWorkspaceService);
  private readonly locales = inject(LocaleAuthoringService);
  private readonly i18n = inject(I18nService);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('previewCanvas');
  private readonly sprites = new SpriteCache(
    (asset) => contentUrl(asset),
    () => this.drawPreview(),
  );
  /**
   * The framework-free drawing surface, rebuilt when the canvas element
   * changes: `#previewCanvas` sits inside the workflow-screen `@switch`, so
   * navigating away from a screen with a preview block and back recreates it.
   */
  private stage: CharacterStage | null = null;
  private stageCanvas: HTMLCanvasElement | null = null;

  /**
   * The editing session, holding exactly one draft.
   *
   * A creation declaration is a list of length one: the manifest names one
   * path and there is no "add" button, so what is left of the session is the
   * load and save choreography (`app/editing/draft-set.ts`).
   */
  private readonly drafts = new DraftSet<CharacterCreationDefinition>(this.draftSource(), {
    i18n: this.i18n,
    workspace: this.workspace,
    ledger: this.ledger,
    locales: this.locales,
  });

  protected readonly document = this.drafts.open;
  protected readonly report = this.drafts.report;
  protected readonly error = this.drafts.error;
  protected readonly message = this.drafts.message;
  protected readonly dirty = this.drafts.dirty;
  protected readonly busy = this.drafts.busy;
  protected readonly tab = signal<EditorTab>('choices');
  protected readonly choiceId = signal<string | null>(null);
  protected readonly characteristicId = signal<string | null>(null);
  protected readonly screenId = signal<string | null>(null);
  protected readonly previewIndex = signal(0);
  protected readonly choiceValues = signal<Record<string, SettingValue>>({});
  protected readonly characteristicValues = signal<Record<string, SettingValue | null>>({});

  protected readonly controlKinds = CONTROL_KINDS;
  protected readonly transitions = TRANSITIONS;
  protected readonly blockTypes = BLOCK_TYPES;
  protected readonly usesOptions = usesOptions;
  protected readonly isNumeric = isNumeric;

  protected readonly path = computed(() => this.manifest.characterCreationPath());
  protected readonly writable = computed(() => this.workspace.status() !== null);
  protected readonly unlisted = computed(() => this.manifest.characterCreation() === null);
  protected readonly errorCount = this.drafts.errorCount;
  protected readonly choices = computed(() => this.document()?.choices ?? []);
  protected readonly characteristics = computed(() => this.document()?.characteristics ?? []);
  protected readonly screens = computed(() => this.document()?.screens ?? []);

  protected readonly choice = computed(
    () =>
      this.choices().find((choice) => choice.id === this.choiceId()) ?? this.choices()[0] ?? null,
  );
  protected readonly characteristic = computed(
    () =>
      this.characteristics().find((field) => field.id === this.characteristicId()) ??
      this.characteristics()[0] ??
      null,
  );
  protected readonly screen = computed(
    () =>
      this.screens().find((screen) => screen.id === this.screenId()) ?? this.screens()[0] ?? null,
  );
  protected readonly previewScreen = computed(
    () =>
      this.screens()[Math.min(this.previewIndex(), Math.max(0, this.screens().length - 1))] ?? null,
  );

  /** Character definitions the resource editor currently exposes. */
  protected readonly characterIds = computed(() => this.library.ids());

  /** Union of parameters declared by candidate character definitions. */
  protected readonly characterParameters = computed<readonly ControlDefinition[]>(() => {
    const fields = new Map<string, ControlDefinition>();
    if (!this.engine.isReady) {
      return [];
    }
    for (const id of this.characterIds()) {
      try {
        for (const field of this.engine.character(id).parameters ?? []) {
          fields.set(field.id, field);
        }
      } catch {
        // A manifest entry the character editor cannot load is already reported there.
      }
    }
    return [...fields.values()];
  });

  protected readonly creationResult = computed<CharacterCreationResult | null>(() => {
    const document = this.document();
    if (document === null || !this.engine.isReady) {
      return null;
    }
    try {
      return this.engine.previewCharacterCreation(
        document,
        this.choiceValues(),
        this.characteristicValues(),
      );
    } catch {
      return null;
    }
  });

  private readonly previewBlock = computed(() =>
    this.previewScreen()?.blocks?.find(
      (block): block is Extract<CreationBlock, { type: 'preview' }> => block.type === 'preview',
    ),
  );

  protected readonly resolvedCharacter = computed(() => {
    const result = this.creationResult();
    if (result === null || result.character.length === 0 || !this.engine.isReady) {
      return null;
    }
    const preview = this.previewBlock();
    try {
      return this.engine.resolveCharacter(
        result.character,
        { ...result.parameters, ...(preview?.parameters ?? {}) },
        preview?.animation ? { animation: preview.animation, timeMs: 0 } : undefined,
      );
    } catch {
      return null;
    }
  });

  constructor() {
    effect(() => {
      const resolved = this.resolvedCharacter();
      const canvas = this.canvasRef()?.nativeElement;
      if (resolved === null || canvas === undefined) {
        return;
      }
      void this.sprites.preload(resolved.layers.map((layer) => layer.asset));
      queueMicrotask(() => this.drawPreview());
    });
    // The preview starts on the declared defaults, once the document is in.
    void this.drafts.load().then(() => this.resetPreview());
  }

  /**
   * What a *creation declaration* means by reading, validating and writing.
   *
   * Everything else about the session is `DraftSet`'s. Unlike the settings and
   * title screens, this one *is* listed in the manifest — saving the first one
   * is what puts `characterCreation` into `project.json`.
   */
  private draftSource(): DraftSource<CharacterCreationDefinition> {
    return {
      declaredInManifest: true,
      // Nothing authored yet: start from a declaration that already validates.
      blank: () => blankCreation(this.characterIds()[0] ?? ''),
      messages: {
        invalid: 'ui.editor.creation.invalid',
        saved: 'ui.editor.creation.saved',
      },
      prepare: async () => {
        await this.engine.ready();
        await this.store.ensureLoaded();
        await this.library.ensureLoaded();
        await this.locales.ensureLoaded();
        await this.workspace.ensureProbed();
      },
      declared: () => {
        const declared = this.manifest.characterCreation();
        return declared === null ? [] : [declared];
      },
      read: async (entry) => {
        const response = await fetch(contentUrl(entry.path));
        if (!response.ok) {
          throw new Error(`Could not load ${entry.path} (HTTP ${response.status}).`);
        }
        return (await response.json()) as CharacterCreationDefinition;
      },
      pathOf: () => this.path(),
      serialize: (document) => serializeCharacterCreation(document),
      validate: (_document, json) => this.engine.validateCharacterCreation(json),
      adopt: (_id, json) => this.creation.adopt(json),
      forget: () => {},
      declare: (id) => this.manifest.declareCharacterCreation(id, this.path()),
      undeclare: () => {},
      dirtySprites: () => [],
      writeSprites: async () => 0,
      keysOf: (document) => referencedKeys(document),
      removed: () => {},
      // Nothing to redraw per edit: the preview's own choices belong to the
      // author, and resetting them to the declared defaults on every keystroke
      // would throw away what they had picked.
      refresh: () => {},
    };
  }

  private edit(mutate: (draft: CharacterCreationDefinition) => void): void {
    this.drafts.edit(mutate);
  }

  protected setId(id: string): void {
    this.edit((draft) => (draft.id = id.trim()));
  }

  protected setBaseCharacter(id: string): void {
    this.edit((draft) => (draft.baseCharacter = id));
  }

  // --------------------------------------------------------------- choices

  protected selectChoice(id: string): void {
    this.choiceId.set(id);
  }

  protected addChoice(): void {
    const ids = this.choices().map((choice) => choice.id);
    const id = freeId('choice', ids);
    const parameter = this.characterParameters()[0];
    const field: CreationChoice = parameter
      ? {
          ...structuredClone(parameter),
          id,
          labelKey: `game.creation.${id}`,
          binding: { kind: 'parameter', parameter: parameter.id },
        }
      : {
          id,
          labelKey: `game.creation.${id}`,
          control: 'select',
          default: this.characterIds()[0] ?? '',
          options: this.characterIds().map((value) => ({
            value,
            labelKey: `game.creation.${value}`,
          })),
          binding: { kind: 'character' },
        };
    delete field.scope;
    this.edit((draft) => (draft.choices = [...(draft.choices ?? []), field]));
    this.choiceId.set(id);
    this.resetPreview();
  }

  protected patchChoice(change: Partial<CreationChoice>): void {
    const id = this.choice()?.id;
    this.edit((draft) => {
      const choice = draft.choices?.find((choice) => choice.id === id);
      if (choice !== undefined) {
        Object.assign(choice, change);
      }
    });
  }

  protected renameChoice(nextId: string): void {
    const previousId = this.choice()?.id;
    const id = nextId.trim();
    if (previousId === undefined || id.length === 0 || id === previousId) {
      return;
    }
    this.edit((draft) => {
      const choice = draft.choices?.find((entry) => entry.id === previousId);
      if (choice === undefined) {
        return;
      }
      choice.id = id;
      for (const entry of draft.choices ?? []) {
        if (entry.showIf?.field === previousId) {
          entry.showIf = { ...entry.showIf, field: id };
        }
      }
      for (const screen of draft.screens ?? []) {
        for (const block of screen.blocks ?? []) {
          if (block.type === 'choice' && block.choice === previousId) {
            block.choice = id;
          }
        }
      }
    });
    this.choiceId.set(id);
    this.resetPreview();
  }

  protected removeChoice(): void {
    const id = this.choice()?.id;
    this.edit((draft) => {
      draft.choices = (draft.choices ?? []).filter((choice) => choice.id !== id);
      for (const screen of draft.screens ?? []) {
        screen.blocks = (screen.blocks ?? []).filter(
          (block) => block.type !== 'choice' || block.choice !== id,
        );
      }
    });
    this.choiceId.set(null);
    this.resetPreview();
  }

  protected moveChoice(delta: number): void {
    this.edit((draft) => moveById(draft.choices ?? [], this.choice()?.id, delta));
  }

  protected setChoiceControl(control: ControlKind): void {
    const choice = this.choice();
    if (choice === null || choice.control === control) {
      return;
    }
    this.patchChoice(setControlKind(choice, control, defaultFor));
    this.resetPreview();
  }

  protected setBindingKind(kind: CreationBinding['kind']): void {
    if (kind === 'character') {
      const options = this.characterIds().map((value) => ({
        value,
        labelKey: `game.creation.${value}`,
      }));
      this.patchChoice({
        binding: { kind: 'character' },
        control: 'select',
        options,
        default: options[0]?.value ?? '',
      });
    } else {
      this.setParameterBinding(this.characterParameters()[0]?.id ?? '');
    }
    this.resetPreview();
  }

  protected setParameterBinding(parameterId: string): void {
    const parameter = this.characterParameters().find((field) => field.id === parameterId);
    this.patchChoice(
      parameter === undefined
        ? { binding: { kind: 'parameter', parameter: parameterId } }
        : {
            binding: { kind: 'parameter', parameter: parameterId },
            control: parameter.control,
            default: structuredClone(parameter.default),
            options: structuredClone(parameter.options),
            min: parameter.min,
            max: parameter.max,
            step: parameter.step,
            unit: parameter.unit,
          },
    );
    this.resetPreview();
  }

  protected addChoiceOption(): void {
    const choice = this.choice();
    if (choice === null) {
      return;
    }
    const value = freeId(
      'option',
      (choice.options ?? []).map((option) => option.value),
    );
    const next = addOption(choice, { value, labelKey: `game.creation.${value}` });
    this.patchChoice({ options: next.options, default: next.default });
  }

  protected patchChoiceOption(
    optionIndex: number,
    change: Partial<{ value: string; labelKey: string }>,
  ): void {
    const choice = this.choice();
    if (choice === null) {
      return;
    }
    const next = editOption(choice, optionIndex, change);
    this.patchChoice({ options: next.options, default: next.default });
    this.resetPreview();
  }

  protected removeChoiceOption(index: number): void {
    const choice = this.choice();
    if (choice === null) {
      return;
    }
    const next = removeOption(choice, index);
    this.patchChoice({ options: next.options, default: next.default });
    this.resetPreview();
  }

  protected setChoiceCondition(field: string): void {
    const target = this.choices().find((choice) => choice.id === field);
    this.patchChoice({ showIf: field ? { field, equals: target?.default ?? '' } : null });
  }

  protected setChoiceConditionValue(raw: string): void {
    const choice = this.choice();
    if (choice?.showIf) {
      this.patchChoice({ showIf: { ...choice.showIf, equals: parseValue(raw) ?? '' } });
    }
  }

  // ------------------------------------------------------ characteristics

  protected selectCharacteristic(id: string): void {
    this.characteristicId.set(id);
  }

  protected addCharacteristic(): void {
    const id = freeId(
      'stat',
      this.characteristics().map((field) => field.id),
    );
    const characteristic: CharacteristicDefinition = {
      id,
      labelKey: `game.creation.${id}`,
      control: 'number',
      default: 0,
      nullable: false,
    };
    this.edit((draft) => {
      draft.characteristics = [...(draft.characteristics ?? []), characteristic];
    });
    this.characteristicId.set(id);
    this.resetPreview();
  }

  protected patchCharacteristic(change: Partial<CharacteristicDefinition>): void {
    const id = this.characteristic()?.id;
    this.edit((draft) => {
      const field = draft.characteristics?.find((field) => field.id === id);
      if (field !== undefined) {
        Object.assign(field, change);
      }
    });
  }

  protected renameCharacteristic(nextId: string): void {
    const previousId = this.characteristic()?.id;
    const id = nextId.trim();
    if (previousId === undefined || id.length === 0 || id === previousId) {
      return;
    }
    this.edit((draft) => {
      const field = draft.characteristics?.find((entry) => entry.id === previousId);
      if (field === undefined) {
        return;
      }
      field.id = id;
      for (const screen of draft.screens ?? []) {
        for (const block of screen.blocks ?? []) {
          if (block.type === 'characteristic' && block.characteristic === previousId) {
            block.characteristic = id;
          }
        }
      }
    });
    this.characteristicId.set(id);
    this.resetPreview();
  }

  protected setCharacteristicControl(control: ControlKind): void {
    const field = this.characteristic();
    if (field === null) {
      return;
    }
    const next = setControlKind(field, control, defaultFor);
    // A nullable characteristic that was left empty stays empty across the switch.
    this.patchCharacteristic(
      field.nullable && field.default === null ? { ...next, default: null } : next,
    );
    this.resetPreview();
  }

  protected setNullable(nullable: boolean): void {
    this.patchCharacteristic({
      nullable,
      default: nullable ? null : defaultFor(this.characteristic()?.control ?? 'text'),
    });
    this.resetPreview();
  }

  protected addCharacteristicOption(): void {
    const field = this.characteristic();
    if (field === null) {
      return;
    }
    const value = freeId(
      'value',
      (field.options ?? []).map((option) => option.value),
    );
    const next = addOption(field, { value, labelKey: `game.creation.${value}` });
    this.patchCharacteristic({ options: next.options, default: next.default });
  }

  protected patchCharacteristicOption(
    index: number,
    key: 'value' | 'labelKey',
    value: string,
  ): void {
    const field = this.characteristic();
    if (field === null) {
      return;
    }
    const next = editOption(field, index, { [key]: value } as Partial<ControlOption>);
    this.patchCharacteristic({ options: next.options, default: next.default });
  }

  protected removeCharacteristicOption(index: number): void {
    const field = this.characteristic();
    if (field === null) {
      return;
    }
    const next = removeOption(field, index);
    this.patchCharacteristic({ options: next.options, default: next.default });
  }

  protected removeCharacteristic(): void {
    const id = this.characteristic()?.id;
    this.edit((draft) => {
      draft.characteristics = (draft.characteristics ?? []).filter((field) => field.id !== id);
      for (const screen of draft.screens ?? []) {
        screen.blocks = (screen.blocks ?? []).filter(
          (block) => block.type !== 'characteristic' || block.characteristic !== id,
        );
      }
    });
    this.characteristicId.set(null);
    this.resetPreview();
  }

  protected moveCharacteristic(delta: number): void {
    this.edit((draft) => moveById(draft.characteristics ?? [], this.characteristic()?.id, delta));
  }

  // ------------------------------------------------------------- workflow

  protected selectScreen(id: string): void {
    this.screenId.set(id);
  }

  protected addScreen(): void {
    const id = freeId(
      'screen',
      this.screens().map((screen) => screen.id),
    );
    this.edit((draft) => {
      draft.screens = [
        ...(draft.screens ?? []),
        { id, titleKey: `game.creation.${id}Title`, transition: 'fade', blocks: [] },
      ];
    });
    this.screenId.set(id);
  }

  protected patchScreen(change: Partial<CreationScreen>): void {
    const id = this.screen()?.id;
    this.edit((draft) => {
      const screen = draft.screens?.find((screen) => screen.id === id);
      if (screen !== undefined) {
        Object.assign(screen, change);
      }
    });
  }

  protected renameScreen(nextId: string): void {
    const previousId = this.screen()?.id;
    const id = nextId.trim();
    if (previousId === undefined || id.length === 0 || id === previousId) {
      return;
    }
    this.patchScreen({ id });
    this.screenId.set(id);
  }

  protected removeScreen(): void {
    const id = this.screen()?.id;
    this.edit((draft) => {
      draft.screens = (draft.screens ?? []).filter((screen) => screen.id !== id);
    });
    this.screenId.set(null);
    this.previewIndex.set(0);
  }

  protected moveScreen(delta: number): void {
    this.edit((draft) => moveById(draft.screens ?? [], this.screen()?.id, delta));
  }

  protected addBlock(type: CreationBlock['type']): void {
    const block = blankBlock(type, this.choices()[0]?.id, this.characteristics()[0]?.id);
    this.patchScreen({ blocks: [...(this.screen()?.blocks ?? []), block] });
  }

  protected setBlockType(index: number, type: CreationBlock['type']): void {
    const blocks = [...(this.screen()?.blocks ?? [])];
    blocks[index] = blankBlock(type, this.choices()[0]?.id, this.characteristics()[0]?.id);
    this.patchScreen({ blocks });
  }

  protected patchBlock(index: number, change: Record<string, unknown>): void {
    const blocks = structuredClone(this.screen()?.blocks ?? []);
    const block = blocks[index];
    if (block !== undefined) {
      Object.assign(block, change);
      this.patchScreen({ blocks });
    }
  }

  protected removeBlock(index: number): void {
    this.patchScreen({
      blocks: (this.screen()?.blocks ?? []).filter((_block, at) => at !== index),
    });
  }

  protected moveBlock(index: number, delta: number): void {
    const blocks = [...(this.screen()?.blocks ?? [])];
    moveAt(blocks, index, delta);
    this.patchScreen({ blocks });
  }

  protected setPreviewParameters(index: number, raw: string): void {
    try {
      const value = JSON.parse(raw) as Record<string, SettingValue>;
      this.patchBlock(index, { parameters: value });
    } catch {
      this.drafts.fail(this.i18n.t('ui.editor.creation.invalidJson'));
    }
  }

  protected previewParameters(block: CreationBlock): string {
    return block.type === 'preview' ? JSON.stringify(block.parameters ?? {}) : '{}';
  }

  // -------------------------------------------------------------- preview

  protected setPreviewScreen(index: number): void {
    this.previewIndex.set(Math.max(0, Math.min(index, this.screens().length - 1)));
  }

  protected choiceVisible(choice: CreationChoice): boolean {
    const condition = choice.showIf;
    if (condition === undefined || condition === null) {
      return true;
    }
    return (
      JSON.stringify(this.choiceValues()[condition.field]) === JSON.stringify(condition.equals)
    );
  }

  protected setChoiceValue(id: string, value: SettingValue): void {
    this.choiceValues.update((values) => ({ ...values, [id]: value }));
  }

  protected setCharacteristicValue(id: string, value: SettingValue): void {
    this.characteristicValues.update((values) => ({ ...values, [id]: value }));
  }

  protected setCharacteristicNull(id: string, nullable: boolean): void {
    const field = this.characteristics().find((field) => field.id === id);
    this.characteristicValues.update((values) => ({
      ...values,
      [id]: nullable
        ? null
        : ((field?.default ?? defaultFor(field?.control ?? 'text')) as SettingValue),
    }));
  }

  protected previewValue(field: ControlDefinition): SettingValue {
    return this.choiceValues()[field.id] ?? field.default;
  }

  protected characteristicValue(field: CharacteristicDefinition): SettingValue {
    const value = this.characteristicValues()[field.id];
    return value === null || value === undefined
      ? defaultFor(
          field.control,
          (field.options ?? []).map((option) => option.value),
        )
      : value;
  }

  protected isCharacteristicNull(id: string): boolean {
    return this.characteristicValues()[id] === null;
  }

  protected controlFor(field: CharacteristicDefinition): ControlDefinition {
    return { ...field, default: this.characteristicValue(field) };
  }

  protected previewText(key: string | undefined): string {
    return key ? this.i18n.t(key) : '';
  }

  protected choiceFor(id: string): CreationChoice | null {
    return this.choices().find((choice) => choice.id === id) ?? null;
  }

  protected characteristicFor(id: string): CharacteristicDefinition | null {
    return this.characteristics().find((field) => field.id === id) ?? null;
  }

  private resetPreview(): void {
    this.choiceValues.set(
      Object.fromEntries(
        this.choices().map((choice) => [
          choice.id,
          structuredClone(
            choice.default ??
              defaultFor(
                choice.control,
                choice.options?.map((o) => o.value),
              ),
          ),
        ]),
      ),
    );
    this.characteristicValues.set(
      Object.fromEntries(
        this.characteristics().map((field) => [field.id, structuredClone(field.default)]),
      ),
    );
  }

  private drawPreview(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const resolved = this.resolvedCharacter();
    if (canvas === undefined || resolved === null) {
      return;
    }
    const width = Math.max(1, Math.round(canvas.clientWidth || 320));
    const height = Math.max(1, Math.round(canvas.clientHeight || 360));
    // One policy for every canvas in the application
    // (`renderer/canvas-surface.ts`). The element's CSS size is not set here:
    // this canvas is laid out by CSS, and a pixel width would freeze it.
    const density = surfaceDensity({ width, height });
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    const context = canvas.getContext('2d');
    if (context === null) {
      return;
    }
    context.setTransform(density, 0, 0, density, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#101820';
    context.fillRect(0, 0, width, height);
    if (this.stageCanvas !== canvas || this.stage === null) {
      this.stage = new CharacterStage(context, this.sprites);
      this.stageCanvas = canvas;
    }
    this.stage.setModel({
      character: resolved,
      box: { x: 12, y: 12, width: width - 24, height: height - 24 },
      chrome: NO_STAGE_CHROME,
    });
    this.stage.draw();
  }

  // ------------------------------------------------------------- validation

  protected validate(): void {
    this.drafts.refresh();
  }

  protected save(): Promise<void> {
    return this.drafts.save();
  }

  protected setBound(
    target: 'choice' | 'characteristic',
    bound: 'min' | 'max' | 'step',
    raw: string,
  ): void {
    const value = raw.trim().length === 0 ? null : Number.parseFloat(raw);
    const change = { [bound]: value === null || Number.isFinite(value) ? value : null };
    target === 'choice' ? this.patchChoice(change) : this.patchCharacteristic(change);
  }

  protected setDefault(target: 'choice' | 'characteristic', raw: string): void {
    const value = parseValue(raw);
    target === 'choice'
      ? this.patchChoice({ default: value as SettingValue })
      : this.patchCharacteristic({ default: value as SettingValue | null });
    this.resetPreview();
  }

  protected shown(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

function blankCreation(baseCharacter: string): CharacterCreationDefinition {
  return {
    id: 'new_game',
    schemaVersion: CHARACTER_CREATION_SCHEMA_VERSION,
    baseCharacter,
    choices: [],
    characteristics: [],
    screens: [
      {
        id: 'identity',
        titleKey: 'game.creation.identityTitle',
        transition: 'fade',
        blocks: [{ type: 'summary' }],
      },
    ],
  };
}

function blankBlock(
  type: CreationBlock['type'],
  choice: string | undefined,
  characteristic: string | undefined,
): CreationBlock {
  switch (type) {
    case 'text':
      return { type, textKey: 'game.creation.text' };
    case 'choice':
      return { type, choice: choice ?? '' };
    case 'characteristic':
      return { type, characteristic: characteristic ?? '' };
    case 'preview':
      return { type, animation: 'idle', parameters: {} };
    case 'summary':
      return { type };
  }
}

function parseValue(raw: string): SettingValue | null {
  const value = raw.trim();
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('[')) {
    try {
      return JSON.parse(value) as string[];
    } catch {
      return value;
    }
  }
  const number = Number(value);
  return value.length > 0 && Number.isFinite(number) ? number : value;
}

function moveAt<T>(items: T[], index: number, delta: number): void {
  const to = index + delta;
  if (index < 0 || index >= items.length || to < 0 || to >= items.length) return;
  const [item] = items.splice(index, 1);
  if (item !== undefined) items.splice(to, 0, item);
}

function moveById<T extends { id: string }>(
  items: T[],
  id: string | undefined,
  delta: number,
): void {
  moveAt(
    items,
    items.findIndex((item) => item.id === id),
    delta,
  );
}

function referencedKeys(document: CharacterCreationDefinition): string[] {
  const keys: string[] = [];
  for (const field of [...(document.choices ?? []), ...(document.characteristics ?? [])]) {
    keys.push(field.labelKey);
    if (field.helpKey) keys.push(field.helpKey);
    for (const option of field.options ?? []) keys.push(option.labelKey);
  }
  for (const screen of document.screens ?? []) {
    keys.push(screen.titleKey);
    if (screen.textKey) keys.push(screen.textKey);
    for (const block of screen.blocks ?? []) {
      if (block.type === 'text') keys.push(block.textKey);
    }
  }
  return keys.filter((key) => key.length > 0);
}
