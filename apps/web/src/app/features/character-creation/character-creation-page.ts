/** Player-facing traversal of the project's authored character creation. */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChildren,
} from '@angular/core';
import { Router } from '@angular/router';

import {
  CharacterCreationResult,
  CharacteristicDefinition,
  CreationBlock,
  CreationChoice,
  CreationScreen,
} from '../../../content/generated/character-creation';
import { ControlDefinition, SettingValue } from '../../../content/generated/settings';
import { ResolvedCharacter } from '../../../content/generated/character';
import { surfaceDensity } from '../../../renderer/canvas-surface';
import { SpriteCache, drawCharacter } from '../../../renderer/character-renderer';
import { I18nService } from '../../i18n/i18n.service';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { ControlField } from '../../settings/control-field';
import { CharacterCreationService } from '../../services/character-creation.service';
import { EngineService } from '../../services/engine.service';
import { contentUrl } from '../../services/project-store.service';
import { describeError } from '../../../core/errors';

type PreviewBlock = Extract<CreationBlock, { type: 'preview' }>;

interface ResolvedPreview {
  readonly block: PreviewBlock;
  readonly character: ResolvedCharacter | null;
}

@Component({
  selector: 'app-character-creation-page',
  imports: [TranslatePipe, ControlField],
  templateUrl: './character-creation-page.html',
  styleUrl: './character-creation-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CharacterCreationPage implements OnDestroy {
  private readonly engine = inject(EngineService);
  private readonly creation = inject(CharacterCreationService);
  private readonly i18n = inject(I18nService);
  private readonly router = inject(Router);

  private readonly canvasRefs = viewChildren<ElementRef<HTMLCanvasElement>>('previewCanvas');
  private readonly sprites = new SpriteCache(
    (asset) => contentUrl(asset),
    () => this.drawPreviews(),
  );
  private resizeObserver: ResizeObserver | null = null;

  protected readonly busy = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly screenIndex = signal(0);
  protected readonly choiceValues = signal<Record<string, SettingValue>>({});
  protected readonly characteristicValues = signal<Record<string, SettingValue | null>>({});

  protected readonly definition = this.creation.definition;
  protected readonly screens = computed(() => this.definition()?.screens ?? []);
  protected readonly screen = computed(() => this.screens()[this.screenIndex()] ?? null);
  /** A single tracked item makes Angular recreate the article and replay its transition. */
  protected readonly activeScreens = computed<readonly CreationScreen[]>(() => {
    const screen = this.screen();
    return screen === null ? [] : [screen];
  });
  protected readonly lastScreen = computed(
    () => this.screenIndex() >= Math.max(0, this.screens().length - 1),
  );
  protected readonly progress = computed(() =>
    this.screens().length === 0 ? 0 : ((this.screenIndex() + 1) / this.screens().length) * 100,
  );

  protected readonly result = computed<CharacterCreationResult | null>(() => {
    if (this.definition() === null || !this.engine.isReady) {
      return null;
    }
    try {
      return this.engine.resolveCharacterCreation(this.choiceValues(), this.characteristicValues());
    } catch {
      return null;
    }
  });

  protected readonly contentBlocks = computed(
    () => this.screen()?.blocks?.filter((block) => block.type !== 'preview') ?? [],
  );
  protected readonly previewBlocks = computed<readonly PreviewBlock[]>(() =>
    (this.screen()?.blocks ?? []).filter(
      (block): block is PreviewBlock => block.type === 'preview',
    ),
  );
  private readonly resolvedPreviews = computed<readonly ResolvedPreview[]>(() => {
    const result = this.result();
    return this.previewBlocks().map((block) => ({
      block,
      character: result === null ? null : this.resolvePreview(result, block),
    }));
  });

  protected readonly summaryChoices = computed(() => {
    const result = this.result();
    return result === null
      ? []
      : (this.definition()?.choices ?? []).filter((field) => field.id in result.choices);
  });
  protected readonly summaryCharacteristics = computed(
    () => this.definition()?.characteristics ?? [],
  );

  constructor() {
    effect(() => {
      const previews = this.resolvedPreviews();
      const canvases = this.canvasRefs();
      if (previews.length === 0 || canvases.length === 0) {
        return;
      }
      void this.sprites.preload(
        previews.flatMap((preview) => preview.character?.layers.map((layer) => layer.asset) ?? []),
      );
      queueMicrotask(() => this.observeAndDraw());
    });
    void this.load();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  protected choiceFor(id: string): CreationChoice | null {
    return this.definition()?.choices?.find((choice) => choice.id === id) ?? null;
  }

  protected characteristicFor(id: string): CharacteristicDefinition | null {
    return this.definition()?.characteristics?.find((field) => field.id === id) ?? null;
  }

  protected choiceVisible(choice: CreationChoice): boolean {
    const condition = choice.showIf;
    if (condition === undefined || condition === null) {
      return true;
    }
    return sameValue(this.result()?.choices[condition.field], condition.equals);
  }

  protected choiceValue(field: CreationChoice): SettingValue {
    return this.result()?.choices[field.id] ?? fallbackFor(field);
  }

  protected characteristicValue(field: CharacteristicDefinition): SettingValue {
    const value = this.result()?.characteristics[field.id];
    return value === null || value === undefined ? fallbackFor(field) : value;
  }

  protected controlFor(field: CharacteristicDefinition): ControlDefinition {
    return { ...field, default: this.characteristicValue(field) };
  }

  protected isCharacteristicNull(id: string): boolean {
    return this.result()?.characteristics[id] === null;
  }

  protected setChoiceValue(id: string, value: SettingValue): void {
    this.choiceValues.update((values) => ({ ...values, [id]: value }));
  }

  protected setCharacteristicValue(id: string, value: SettingValue): void {
    this.characteristicValues.update((values) => ({ ...values, [id]: value }));
  }

  protected setCharacteristicNull(field: CharacteristicDefinition, nullable: boolean): void {
    this.characteristicValues.update((values) => ({
      ...values,
      [field.id]: nullable ? null : fallbackFor(field),
    }));
  }

  protected displayValue(
    field: ControlDefinition | CharacteristicDefinition,
    value: SettingValue | null | undefined,
  ): string {
    if (value === null || value === undefined || value === '') {
      return this.i18n.t('ui.creation.noValue');
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.optionText(field, entry)).join(', ');
    }
    if (typeof value === 'boolean') {
      return this.i18n.t(value ? 'ui.creation.yes' : 'ui.creation.no');
    }
    if (typeof value === 'string') {
      return this.optionText(field, value);
    }
    return `${value}${field.unit ?? ''}`;
  }

  protected async previous(): Promise<void> {
    if (this.screenIndex() === 0) {
      await this.router.navigate(['/title']);
      return;
    }
    this.screenIndex.update((index) => index - 1);
  }

  protected next(): void {
    this.screenIndex.update((index) => Math.min(index + 1, this.screens().length - 1));
  }

  protected async exit(): Promise<void> {
    await this.router.navigate(['/title']);
  }

  protected async start(): Promise<void> {
    const result = this.result();
    if (result === null) {
      return;
    }
    this.creation.complete(result);
    // The route can also be reached through browser history. Starting from it
    // must never cause Play to resume a session that predates this creation.
    if (this.engine.hasGame()) {
      this.engine.endGame();
    }
    await this.router.navigate(['/play']);
  }

  private async load(): Promise<void> {
    try {
      await this.i18n.ensureAdopted();
      const definition = await this.creation.ensureLoaded();
      if (definition === null) {
        // Character creation is optional content; a bare project keeps the old
        // New game behaviour instead of opening an empty intermediary.
        await this.router.navigate(['/play']);
        return;
      }
      this.creation.begin();
    } catch (cause) {
      this.error.set(describeError(cause));
    } finally {
      this.busy.set(false);
    }
  }

  private resolvePreview(
    result: CharacterCreationResult,
    block: PreviewBlock,
  ): ResolvedCharacter | null {
    if (result.character.length === 0) {
      return null;
    }
    try {
      return this.engine.resolveCharacter(
        result.character,
        { ...result.parameters, ...(block.parameters ?? {}) },
        block.animation ? { animation: block.animation, timeMs: 0 } : undefined,
      );
    } catch {
      return null;
    }
  }

  private optionText(field: Pick<ControlDefinition, 'options'>, value: string): string {
    const option = field.options?.find((entry) => entry.value === value);
    return option === undefined ? value : this.i18n.t(option.labelKey);
  }

  private observeAndDraw(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.drawPreviews());
    for (const reference of this.canvasRefs()) {
      this.resizeObserver.observe(reference.nativeElement);
    }
    this.drawPreviews();
  }

  private drawPreviews(): void {
    const previews = this.resolvedPreviews();
    for (const [index, reference] of this.canvasRefs().entries()) {
      const canvas = reference.nativeElement;
      const width = Math.max(1, Math.round(canvas.clientWidth || 360));
      const height = Math.max(1, Math.round(canvas.clientHeight || 480));
      // One policy for every canvas in the application
      // (`renderer/canvas-surface.ts`). The element's CSS size is not set here:
      // this canvas is laid out by CSS, and a pixel width would freeze it.
      const density = surfaceDensity({ width, height });
      canvas.width = Math.round(width * density);
      canvas.height = Math.round(height * density);
      const context = canvas.getContext('2d');
      if (context === null) {
        continue;
      }
      context.setTransform(density, 0, 0, density, 0, 0);
      context.clearRect(0, 0, width, height);
      const character = previews[index]?.character;
      if (character !== null && character !== undefined) {
        drawCharacter(
          context,
          character,
          { x: 18, y: 18, width: width - 36, height: height - 36 },
          this.sprites,
        );
      }
    }
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A valid value to reveal when a nullable characteristic becomes non-null. */
function fallbackFor(field: ControlDefinition): SettingValue {
  if (field.default !== null) {
    return structuredClone(field.default);
  }
  switch (field.control) {
    case 'toggle':
    case 'checkbox':
      return false;
    case 'slider':
    case 'number': {
      const zeroOrMinimum = field.min ?? 0;
      return field.max === null || field.max === undefined
        ? zeroOrMinimum
        : Math.min(zeroOrMinimum, field.max);
    }
    case 'color':
      return '#ffd166';
    case 'select':
      return field.options?.[0]?.value ?? '';
    case 'multiSelect':
      return [];
    case 'text':
      return '';
    case 'keyBinding':
      // Validation rejects settings-only key bindings in character content.
      return 'KeyQ';
  }
}
