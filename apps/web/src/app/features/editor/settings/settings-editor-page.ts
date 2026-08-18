/**
 * The settings editor.
 *
 * It edits one content file — `settings.json` — and everything about it follows
 * from that: the form writes a `SettingsDefinition`, the Rust validator judges
 * it (ADR-0015), and the preview is the **real** `control-field` component, the
 * one the player's settings screen renders with
 * (`docs/adr/ADR-0025-settings.md`).
 *
 * Two things are deliberately not here.
 *
 * The **application's** settings — volumes, interface scale, language, window
 * size — are not editable, because they are not content: the application
 * implements each one, and a project that could delete "master volume" would
 * ship a game with no way to turn the music down. They are visible on the
 * player's screen next to the game's, and declared in
 * `app/settings/engine-settings.schema.ts`.
 *
 * And **what a setting does**: nothing here, and nothing in the engine, knows
 * what "difficulty" means. A declaration says what a value looks like; reading
 * it is the simulation's business.
 *
 * Labels are keys: this screen picks and **creates** them — saving writes every
 * key the file names into every language, empty — and the language editor is
 * where their text is written (ADR-0023,
 * `docs/adr/ADR-0027-authoring-creates-keys.md`).
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import {
  CONTROL_KINDS,
  ControlDefinition,
  ControlKind,
  SCOPES,
  SettingValue,
  SettingsDefinition,
  SettingsGroup,
  SettingsSection,
  defaultFor,
  isNumeric,
  usesOptions,
} from './settings-editor.types';
import { SETTINGS_SCHEMA_VERSION } from '../../../../content/content-types';
import { serializeSettings } from '../../../../content/settings-serializer';
import { ValidationReport } from '../../../../engine/engine.types';
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import { ControlField } from '../../../settings/control-field';
import { ContentWorkspaceService } from '../../../services/content-workspace.service';
import { EngineService } from '../../../services/engine.service';
import { LocaleAuthoringService } from '../../../services/locale-authoring.service';
import { SettingsService } from '../../../settings/settings.service';
import { CONTENT_ROOT, ProjectStoreService } from '../../../services/project-store.service';
import { assetUrl } from '../../../../core/asset-url';

/** Where a project's settings live when the manifest names no other path. */
const DEFAULT_PATH = 'settings.json';

@Component({
  selector: 'app-settings-editor-page',
  imports: [TranslatePipe, ControlField],
  templateUrl: './settings-editor-page.html',
  styleUrl: './settings-editor-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsEditorPage {
  private readonly store = inject(ProjectStoreService);
  private readonly engine = inject(EngineService);
  private readonly i18n = inject(I18nService);
  private readonly workspace = inject(ContentWorkspaceService);
  private readonly settings = inject(SettingsService);
  private readonly locales = inject(LocaleAuthoringService);

  /** The document being edited. */
  protected readonly document = signal<SettingsDefinition | null>(null);
  /** What the Rust validator says about it. */
  protected readonly report = signal<ValidationReport | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly dirty = signal(false);
  protected readonly busy = signal(false);

  /** Which section and group the form is showing; the first, until picked. */
  private readonly sectionId = signal<string | null>(null);
  private readonly groupId = signal<string | null>(null);

  protected readonly controlKinds = CONTROL_KINDS;
  protected readonly scopes = SCOPES;
  protected readonly usesOptions = usesOptions;
  protected readonly isNumeric = isNumeric;

  /** Path the manifest gives the settings, or the conventional one. */
  protected readonly path = computed(() => this.store.project()?.settings?.path ?? DEFAULT_PATH);

  /**
   * The id the manifest expects, when it declares one.
   *
   * A mismatch is not this screen's error to raise — `loadProject` reports
   * `project.unloadedSettings` — but it is this screen's job to make it
   * impossible to walk into by accident.
   */
  protected readonly declaredId = computed(() => this.store.project()?.settings?.id ?? null);

  /** `true` when the manifest does not point at this file at all. */
  protected readonly unlisted = computed(() => this.store.project()?.settings === undefined);

  /** `true` when files can actually be written — the editor is honest about it. */
  protected readonly writable = computed(() => this.workspace.status() !== null);

  protected readonly sections = computed<readonly SettingsSection[]>(
    () => this.document()?.sections ?? [],
  );

  protected readonly section = computed<SettingsSection | null>(() => {
    const sections = this.sections();
    const id = this.sectionId();
    return sections.find((candidate) => candidate.id === id) ?? sections.at(0) ?? null;
  });

  protected readonly groups = computed<readonly SettingsGroup[]>(
    () => this.section()?.groups ?? [],
  );

  protected readonly group = computed<SettingsGroup | null>(() => {
    const groups = this.groups();
    const id = this.groupId();
    return groups.find((candidate) => candidate.id === id) ?? groups.at(0) ?? null;
  });

  protected readonly fields = computed<readonly ControlDefinition[]>(
    () => this.group()?.fields ?? [],
  );

  /** Every field in the file, which is the vocabulary a `showIf` may name. */
  protected readonly allFields = computed<readonly ControlDefinition[]>(() =>
    this.sections().flatMap((section) => section.groups.flatMap((group) => group.fields)),
  );

  /**
   * Issues that would stop the runtime loading this file.
   *
   * Not the untranslated keys: naming a key is how a key comes to exist, and
   * saving creates it in every language
   * (`docs/adr/ADR-0027-authoring-creates-keys.md`). They are listed on their
   * own, as work left to do in the Languages tab, rather than as something in
   * the way of writing the file.
   */
  protected readonly blocking = computed(() =>
    (this.report()?.issues ?? []).filter((issue) => issue.code !== 'locale.unknownKey'),
  );

  /** Keys this file names that no language gives text to yet. */
  protected readonly untranslated = computed(() =>
    (this.report()?.issues ?? []).filter((issue) => issue.code === 'locale.unknownKey'),
  );

  /** How many issues actually stand in the way, for the toolbar. */
  protected readonly errorCount = computed(
    () => this.blocking().filter((issue) => issue.severity === 'error').length,
  );

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      await this.engine.ready();
      await this.i18n.ensureAdopted();
      await this.workspace.ensureProbed();
      await this.locales.ensureLoaded();

      const declared = this.store.project()?.settings;
      if (declared === undefined) {
        // Nothing authored yet: start from a declaration that already validates.
        this.document.set(blankSettings());
        this.dirty.set(true);
        this.validate();
        return;
      }

      const json = await fetchText(assetUrl(`${CONTENT_ROOT}/${declared.path}`));
      // Read back through the engine rather than parsed here, so the form starts
      // from the same defaults-filled shape the runtime works with.
      this.engine.loadSettings(json);
      this.document.set(this.engine.settings());
      this.validate();
    } catch (cause) {
      this.error.set(describe(cause));
    }
  }

  // ------------------------------------------------------------------ edits

  /**
   * Applies a change to the document and re-validates it.
   *
   * A copy per edit, not a mutation: the form is a tree of nested arrays, and
   * `OnPush` only redraws what changed identity.
   */
  private edit(mutate: (draft: SettingsDefinition) => void): void {
    const current = this.document();
    if (current === null) {
      return;
    }
    const draft = structuredClone(current) as SettingsDefinition;
    mutate(draft);
    this.document.set(draft);
    this.dirty.set(true);
    this.message.set(null);
    this.validate();
  }

  protected setId(id: string): void {
    this.edit((draft) => {
      draft.id = id.trim();
    });
  }

  // ---------------------------------------------------------------- sections

  protected selectSection(id: string): void {
    this.sectionId.set(id);
    this.groupId.set(null);
  }

  protected addSection(): void {
    const id = freeId(
      'section',
      this.sections().map((section) => section.id),
    );
    this.edit((draft) => {
      draft.sections.push({ id, labelKey: `game.settings.${id}`, groups: [] });
    });
    this.selectSection(id);
  }

  protected patchSection(index: number, change: Partial<SettingsSection>): void {
    this.edit((draft) => {
      const section = draft.sections[index];
      if (section !== undefined) {
        Object.assign(section, change);
      }
    });
  }

  protected removeSection(index: number): void {
    this.edit((draft) => {
      draft.sections.splice(index, 1);
    });
    this.sectionId.set(null);
    this.groupId.set(null);
  }

  protected moveSection(index: number, delta: number): void {
    this.edit((draft) => move(draft.sections, index, delta));
  }

  // ------------------------------------------------------------------ groups

  protected selectGroup(id: string): void {
    this.groupId.set(id);
  }

  protected addGroup(): void {
    const section = this.section();
    if (section === null) {
      return;
    }
    const id = freeId(
      'group',
      section.groups.map((group) => group.id),
    );
    this.editSection((draft) => {
      draft.groups.push({ id, labelKey: `game.settings.${id}`, fields: [] });
    });
    this.selectGroup(id);
  }

  protected patchGroup(index: number, change: Partial<SettingsGroup>): void {
    this.editSection((draft) => {
      const group = draft.groups[index];
      if (group !== undefined) {
        Object.assign(group, change);
      }
    });
  }

  protected removeGroup(index: number): void {
    this.editSection((draft) => {
      draft.groups.splice(index, 1);
    });
    this.groupId.set(null);
  }

  protected moveGroup(index: number, delta: number): void {
    this.editSection((draft) => move(draft.groups, index, delta));
  }

  // ------------------------------------------------------------------ fields

  /**
   * Adds a setting to the open group.
   *
   * A field id is the key its value is stored under and must be unique across
   * the **whole file**, not just its group, so a new one is named against every
   * field there is.
   */
  protected addField(): void {
    const id = freeId(
      'setting',
      this.allFields().map((field) => field.id),
    );
    this.editGroup((draft) => {
      draft.fields.push({
        id,
        labelKey: `game.settings.${id}`,
        control: 'toggle',
        default: defaultFor('toggle'),
        scope: 'newGame',
      });
    });
  }

  protected patchField(index: number, change: Partial<ControlDefinition>): void {
    this.editGroup((draft) => {
      const field = draft.fields[index];
      if (field !== undefined) {
        Object.assign(field, change);
      }
    });
  }

  protected removeField(index: number): void {
    this.editGroup((draft) => {
      draft.fields.splice(index, 1);
    });
  }

  protected moveField(index: number, delta: number): void {
    this.editGroup((draft) => move(draft.fields, index, delta));
  }

  /**
   * Changes what a setting *is*, and takes its default with it.
   *
   * The engine refuses a default its own control does not accept, so switching
   * a slider to a select has to replace `120` with an option — otherwise the
   * form would produce an invalid file on a single click.
   */
  protected setControl(index: number, control: ControlKind): void {
    this.editGroup((draft) => {
      const field = draft.fields[index];
      if (field === undefined || field.control === control) {
        return;
      }
      field.control = control;
      field.default = defaultFor(
        control,
        (field.options ?? []).map((option) => option.value),
      );
      if (!usesOptions(control)) {
        delete field.options;
      }
      if (!isNumeric(control)) {
        delete field.min;
        delete field.max;
        delete field.step;
        delete field.unit;
      }
    });
  }

  /** Reads a bound out of an input; an empty field means "no bound". */
  protected setBound(index: number, bound: 'min' | 'max' | 'step', raw: string): void {
    const parsed = Number.parseFloat(raw);
    const value = Number.isFinite(parsed) ? parsed : null;
    this.patchField(
      index,
      bound === 'min' ? { min: value } : bound === 'max' ? { max: value } : { step: value },
    );
  }

  // ----------------------------------------------------------------- options

  protected addOption(index: number): void {
    this.editGroup((draft) => {
      const field = draft.fields[index];
      if (field === undefined) {
        return;
      }
      const options = field.options ?? [];
      const value = freeId(
        'option',
        options.map((option) => option.value),
      );
      field.options = [...options, { value, labelKey: `game.settings.${value}` }];
      // The first option of an empty select becomes its default: a select whose
      // default is not one of its own options does not validate.
      if (field.control === 'select' && options.length === 0) {
        field.default = value;
      }
    });
  }

  protected patchOption(
    index: number,
    optionIndex: number,
    change: Partial<{ value: string; labelKey: string }>,
  ): void {
    this.editGroup((draft) => {
      const field = draft.fields[index];
      const option = field?.options?.[optionIndex];
      if (field === undefined || option === undefined) {
        return;
      }
      const previous = option.value;
      Object.assign(option, change);
      // A renamed option takes the default with it, rather than leaving behind a
      // default naming a value nobody declares any more.
      if (change.value !== undefined && field.default === previous) {
        field.default = change.value;
      }
    });
  }

  protected removeOption(index: number, optionIndex: number): void {
    this.editGroup((draft) => {
      const field = draft.fields[index];
      if (field?.options === undefined) {
        return;
      }
      const [removed] = field.options.splice(optionIndex, 1);
      if (field.control === 'select' && field.default === removed?.value) {
        field.default = field.options[0]?.value ?? '';
      }
      if (field.control === 'multiSelect' && Array.isArray(field.default)) {
        field.default = field.default.filter((value) => value !== removed?.value);
      }
    });
  }

  // ------------------------------------------------------------------ showIf

  /** Points a setting at another one, or clears the condition when given `''`. */
  protected setCondition(index: number, fieldId: string): void {
    this.editGroup((draft) => {
      const field = draft.fields[index];
      if (field === undefined) {
        return;
      }
      if (fieldId.length === 0) {
        field.showIf = null;
        return;
      }
      const target = this.allFields().find((candidate) => candidate.id === fieldId);
      field.showIf = { field: fieldId, equals: target?.default ?? '' };
    });
  }

  /** The value the condition compares against, entered as JSON-ish text. */
  protected setConditionValue(index: number, raw: string): void {
    this.editGroup((draft) => {
      const field = draft.fields[index];
      if (field?.showIf) {
        field.showIf = { field: field.showIf.field, equals: parseValue(raw) };
      }
    });
  }

  /** The condition's value as text, for the input that edits it. */
  protected conditionValue(field: ControlDefinition): string {
    const equals = field.showIf?.equals;
    return equals === undefined ? '' : typeof equals === 'string' ? equals : JSON.stringify(equals);
  }

  // ----------------------------------------------------------------- preview

  /**
   * Sets a setting's **declared default** from the preview.
   *
   * The preview is the control a player will use, so it is also the honest way
   * to enter a default: a colour is picked, a slider is dragged, and the value
   * cannot be one the control does not accept.
   */
  protected setDefault(fieldId: string, value: SettingValue): void {
    this.edit((draft) => {
      for (const section of draft.sections) {
        for (const group of section.groups) {
          for (const field of group.fields) {
            if (field.id === fieldId) {
              field.default = value;
            }
          }
        }
      }
    });
  }

  /**
   * Whether the preview shows this field, given every other field's default.
   *
   * The same rule the settings screen applies, evaluated against defaults
   * because defaults are all a declaration has: this is what a player sees
   * before touching anything.
   */
  protected isVisible(field: ControlDefinition): boolean {
    const condition = field.showIf;
    if (condition === undefined || condition === null) {
      return true;
    }
    const target = this.allFields().find((candidate) => candidate.id === condition.field);
    return JSON.stringify(target?.default) === JSON.stringify(condition.equals);
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

  /** Asks Rust whether this declaration is usable — the runtime's own check. */
  protected validate(): void {
    const document = this.document();
    if (document === null || !this.engine.isReady) {
      return;
    }
    try {
      this.report.set(this.engine.validateSettings(serializeSettings(document)));
    } catch (cause) {
      this.error.set(describe(cause));
    }
  }

  /** Writes the declaration into the content directory. */
  protected async save(): Promise<void> {
    const document = this.document();
    if (document === null) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.message.set(null);

    try {
      const json = serializeSettings(document);
      this.report.set(this.engine.validateSettings(json));
      if (this.errorCount() > 0) {
        this.error.set(this.i18n.t('ui.editor.settings.invalid'));
        return;
      }

      await this.workspace.writeJson(this.path(), json);
      // Adopting it is what makes the player's settings screen agree with the
      // file from here on, without a reload — and what a later content reset
      // puts back.
      this.settings.adopt(json);

      // Every label this file names now exists as a key, in every language, so
      // the Languages tab lists it and a translator can fill it in. Until then
      // it shows as itself, which is what an untranslated key has always done.
      const created = await this.createMissingKeys(document);

      this.dirty.set(false);
      this.validate();
      this.message.set(
        this.i18n.t('ui.editor.settings.saved', { file: this.path() }) +
          (created === 0 ? '' : ` · ${this.i18n.t('ui.editor.locale.created', { count: created })}`),
      );
    } catch (cause) {
      this.error.set(describe(cause));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Creates every key this declaration names that no language has yet.
   *
   * @returns how many keys were created
   */
  private async createMissingKeys(document: SettingsDefinition): Promise<number> {
    const created = this.locales.ensureKeys(referencedKeys(document));
    if (created.length === 0) {
      return 0;
    }
    await this.locales.save();
    return created.length;
  }

  // ----------------------------------------------------------------- plumbing

  /** Edits the open section in place. */
  private editSection(mutate: (section: SettingsSection) => void): void {
    const id = this.section()?.id;
    this.edit((draft) => {
      const section = draft.sections.find((candidate) => candidate.id === id);
      if (section !== undefined) {
        mutate(section);
      }
    });
  }

  /** Edits the open group in place. */
  private editGroup(mutate: (group: SettingsGroup) => void): void {
    const groupId = this.group()?.id;
    this.editSection((section) => {
      const group = section.groups.find((candidate) => candidate.id === groupId);
      if (group !== undefined) {
        mutate(group);
      }
    });
  }
}

/**
 * Every locale key a settings declaration names.
 *
 * The same set the Rust validator walks, in the same order — sections, groups,
 * fields, their help text and their options.
 */
function referencedKeys(document: SettingsDefinition): string[] {
  const keys: string[] = [];
  for (const section of document.sections) {
    keys.push(section.labelKey);
    for (const group of section.groups) {
      keys.push(group.labelKey);
      for (const field of group.fields) {
        keys.push(field.labelKey);
        if (field.helpKey !== undefined) {
          keys.push(field.helpKey);
        }
        for (const option of field.options ?? []) {
          keys.push(option.labelKey);
        }
      }
    }
  }
  return keys;
}

/** A declaration that is valid the moment it is created. */
function blankSettings(): SettingsDefinition {
  return {
    id: 'game_settings',
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    sections: [
      {
        id: 'gameplay',
        labelKey: 'game.settings.gameplay',
        groups: [{ id: 'world', labelKey: 'game.settings.worldGroup', fields: [] }],
      },
    ],
  };
}

/** `<stem>`, `<stem>_2`, … — the first one nobody is using. */
function freeId(stem: string, taken: readonly string[]): string {
  if (!taken.includes(stem)) {
    return stem;
  }
  let index = 2;
  while (taken.includes(`${stem}_${index}`)) {
    index += 1;
  }
  return `${stem}_${index}`;
}

/** Moves one entry of an array, staying inside it. */
function move<T>(items: T[], index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= items.length) {
    return;
  }
  const [moved] = items.splice(index, 1);
  if (moved !== undefined) {
    items.splice(target, 0, moved);
  }
}

/**
 * Reads a `showIf` value out of a text field.
 *
 * `true`, `12` and `"harsh"` are all legitimate things to compare against, and
 * an author typing `harsh` means the string — so JSON is tried first and the
 * raw text is the answer when it is not JSON.
 */
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

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${url} (HTTP ${response.status}).`);
  }
  return response.text();
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
