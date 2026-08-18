/**
 * Holds every setting's value, and applies the ones that act on the shell.
 *
 * Two sources, one store: the application's settings
 * (`engine-settings.schema.ts`) and the game's, declared by content and
 * validated by the engine (`docs/adr/ADR-0025-settings.md`). They share a value
 * map so one screen can render both, and they are told apart by which
 * declaration a field came from — which is what decides where a value *goes*:
 *
 * - application settings act here: interface scale, volumes, language, window;
 * - game settings cross the boundary at `createGame` and nowhere else.
 *
 * Values live in `localStorage`. A save will carry the game's settings when
 * saves exist (ADR-0010); until then, starting a game reads them from here.
 */

import { Injectable, computed, effect, inject, signal } from '@angular/core';

import {
  ControlDefinition,
  SettingValue,
  SettingsSection,
  SettingsValues,
} from '../../content/content-types';
import { I18nService } from '../i18n/i18n.service';
import { AudioService } from '../services/audio.service';
import { DesktopShellService } from '../services/desktop-shell.service';
import { EngineService } from '../services/engine.service';
import { ProjectStoreService, contentUrl } from '../services/project-store.service';
import {
  ENGINE_SETTING,
  WINDOW_SIZES,
  engineSettingsDefaults,
  engineSettingsSections,
} from './engine-settings.schema';

const STORAGE_KEY = 'insulaire.settings.v1';

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly engine = inject(EngineService);
  private readonly store = inject(ProjectStoreService);
  private readonly i18n = inject(I18nService);
  private readonly audio = inject(AudioService);
  private readonly desktop = inject(DesktopShellService);

  /** Every value, application and game alike, by field id. */
  private readonly valuesSignal = signal<SettingsValues>(readStored());
  readonly values = this.valuesSignal.asReadonly();

  /** The game's sections, once its declaration has been loaded. */
  private readonly gameSections = signal<readonly SettingsSection[]>([]);

  private loading: Promise<void> | null = null;
  /** The declaration as authored, kept so it can be re-registered. */
  private declarationJson: string | null = null;

  /** The application's sections, which depend on the languages and the shell. */
  readonly applicationSections = computed<readonly SettingsSection[]>(() =>
    engineSettingsSections(this.i18n.languages(), this.desktop.isDesktop()),
  );

  /** Everything the settings screen shows, application first. */
  readonly sections = computed<readonly SettingsSection[]>(() => [
    ...this.applicationSections(),
    ...this.gameSections(),
  ]);

  /** Ids of the settings that belong to the *game*, not the application. */
  private readonly gameFieldIds = computed<ReadonlySet<string>>(
    () => new Set(fieldsOf(this.gameSections()).map((field) => field.id)),
  );

  constructor() {
    // Applying is an effect, not a step in `set`, so a value restored from
    // storage lands on the same path as one a player just moved.
    effect(() => this.applySessionSettings());
  }

  /**
   * Loads the game's settings declaration, at most once.
   *
   * A project that declares none is normal: the screen then shows only the
   * application's own settings.
   */
  async ensureLoaded(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    await this.i18n.ensureAdopted();

    const declared = this.store.project()?.settings;
    if (declared === undefined) {
      return;
    }

    const response = await fetch(contentUrl(declared.path));
    if (!response.ok) {
      throw new Error(`Could not load ${declared.path} (HTTP ${response.status}).`);
    }
    this.declarationJson = await response.text();
    this.register();

    const definition = this.engine.settings();
    this.gameSections.set(definition.sections);
    // The engine fills defaults and drops what the declaration does not know,
    // so a settings file that lost a field does not leave its value behind.
    this.valuesSignal.update((values) => ({
      ...values,
      ...this.engine.resolveSettings(this.gameValues(values)),
    }));
  }

  /**
   * Registers the declaration with the engine.
   *
   * Called again by anything that runs `resetContent()` before re-loading a
   * project: the manifest names the settings file, and will not load without it
   * (`docs/adr/ADR-0025-settings.md`).
   */
  register(): void {
    if (this.declarationJson === null) {
      return;
    }
    try {
      this.engine.loadSettings(this.declarationJson);
    } catch {
      // A declaration the engine refuses is reported when it is loaded; the
      // screen keeps the application's own settings either way.
    }
  }

  /** The value of one setting, falling back to its declared default. */
  value(field: ControlDefinition): SettingValue {
    return this.valuesSignal()[field.id] ?? field.default;
  }

  /** Sets one value and persists every one of them. */
  set(field: ControlDefinition, value: SettingValue): void {
    this.valuesSignal.update((values) => ({ ...values, [field.id]: value }));
    this.persist();
  }

  /** Restores every setting to its declared default. */
  reset(): void {
    const defaults: SettingsValues = {
      ...engineSettingsDefaults(this.i18n.languages(), this.desktop.isDesktop()),
    };
    for (const field of fieldsOf(this.gameSections())) {
      defaults[field.id] = field.default;
    }
    this.valuesSignal.set(defaults);
    this.persist();
  }

  /**
   * Whether `field` should be shown, given the other values.
   *
   * `showIf` is the whole conditional vocabulary: one field, one value. Anything
   * richer would be a rules language, which is a non-goal (`CLAUDE.md`).
   */
  isVisible(field: ControlDefinition): boolean {
    const condition = field.showIf;
    if (condition === undefined || condition === null) {
      return true;
    }
    // The *effective* value, default included: a condition on a setting nobody
    // has touched must still see the value the player is actually looking at,
    // or the field it guards would only appear after an unrelated change.
    const target = this.field(condition.field);
    const current =
      this.valuesSignal()[condition.field] ?? (target === undefined ? undefined : target.default);
    return JSON.stringify(current) === JSON.stringify(condition.equals);
  }

  /** The declared setting with this id, application or game. */
  field(id: string): ControlDefinition | undefined {
    return fieldsOf(this.sections()).find((field) => field.id === id);
  }

  /** The game's settings only — what `createGame` receives. */
  gameSettings(): SettingsValues {
    return this.gameValues(this.valuesSignal());
  }

  /** The seed a new game starts from, honouring `seedMode`. */
  seed(): number {
    const mode = this.effective(ENGINE_SETTING.seedMode) ?? 'fixed';
    if (mode === 'random') {
      return Math.floor(Math.random() * 0xffff_ffff);
    }
    const seed = this.effective(ENGINE_SETTING.seed);
    return typeof seed === 'number' ? seed : 2026;
  }

  /** How fast text should be revealed, for whatever displays prose. */
  textSpeed(): string {
    const value = this.effective(ENGINE_SETTING.textSpeed);
    return typeof value === 'string' ? value : 'normal';
  }

  /** The value in force for a setting id: what is stored, else its default. */
  private effective(id: string): SettingValue | undefined {
    return this.valuesSignal()[id] ?? this.field(id)?.default;
  }

  // ------------------------------------------------------------- application

  /**
   * Applies every `session`-scoped application setting.
   *
   * Runs whenever a value changes, which is what makes a volume slider audible
   * while it is being dragged.
   */
  private applySessionSettings(): void {
    const values = this.valuesSignal();

    const scale = numberOr(values[ENGINE_SETTING.scale], 100);
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--ui-scale', String(scale / 100));
    }

    this.audio.master.set(numberOr(values[ENGINE_SETTING.master], 100) / 100);
    this.audio.music.set(numberOr(values[ENGINE_SETTING.music], 70) / 100);
    this.audio.effects.set(numberOr(values[ENGINE_SETTING.effects], 80) / 100);
    this.audio.applyVolume();

    const language = values[ENGINE_SETTING.language];
    if (typeof language === 'string' && language.length > 0) {
      this.i18n.use(language);
    }

    if (this.desktop.isDesktop()) {
      void this.desktop.setFullscreen(values[ENGINE_SETTING.fullscreen] === true);
      const size = WINDOW_SIZES[String(values[ENGINE_SETTING.windowSize] ?? '')];
      if (size !== undefined && values[ENGINE_SETTING.fullscreen] !== true) {
        void this.desktop.setSize(size.width, size.height);
      }
    }
  }

  // ------------------------------------------------------------------ storage

  private gameValues(values: SettingsValues): SettingsValues {
    const ids = this.gameFieldIds();
    return Object.fromEntries(Object.entries(values).filter(([id]) => ids.has(id)));
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.valuesSignal()));
    } catch {
      // Private mode or a full store: the settings still apply to this session.
    }
  }
}

function fieldsOf(sections: readonly SettingsSection[]): ControlDefinition[] {
  return sections.flatMap((section) => section.groups.flatMap((group) => group.fields));
}

function numberOr(value: SettingValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readStored(): SettingsValues {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? {} : (JSON.parse(stored) as SettingsValues);
  } catch {
    return {};
  }
}
