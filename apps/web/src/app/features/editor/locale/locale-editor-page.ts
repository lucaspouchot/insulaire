/**
 * The language editor: every key, every language, side by side.
 *
 * Translating is a table job — one row per key, one column per language — and
 * the two things that make it bearable are seeing the languages together and
 * being told what is missing. Both come from the engine: it flattens the files,
 * and `validateLocales` reports the gaps
 * (`docs/adr/ADR-0020-localised-content-keys.md`).
 *
 * The text itself, the files it is written to and the re-registration that
 * follows a save belong to {@link LocaleAuthoringService}, because the title and
 * settings editors create keys through the same door
 * (`docs/adr/ADR-0020-localised-content-keys.md`). This screen is the table over
 * it: filtering, searching and showing what is still empty.
 *
 * The application's own `ui.` keys are listed too, greyed until they are
 * overridden: a game may rename anything the shell says, and this is where it
 * would see that it can.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { APP_DEFAULT_LANGUAGE, APP_STRINGS, flattenStrings } from '../../../i18n/app-strings';
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import { LocaleAuthoringService, isUsableKey } from '../../../services/locale-authoring.service';

/** One row of the table: a key and what each language says for it. */
interface KeyRow {
  readonly key: string;
  readonly namespace: string;
  /** Text by language id; empty when that language does not define it. */
  readonly values: Record<string, string>;
  /** `true` when the application ships this key and no content overrides it. */
  readonly fromApplication: boolean;
  /** `true` when some declared language is missing it. */
  readonly incomplete: boolean;
}

@Component({
  selector: 'app-locale-editor-page',
  imports: [TranslatePipe],
  templateUrl: './locale-editor-page.html',
  styleUrl: './locale-editor-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocaleEditorPage {
  private readonly i18n = inject(I18nService);
  private readonly locales = inject(LocaleAuthoringService);

  protected readonly languages = this.i18n.languages;
  protected readonly namespaceFilter = signal<string | null>(null);
  protected readonly search = signal('');
  protected readonly onlyMissing = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly dirty = this.locales.dirty;

  /** Every namespace the project declares, plus the application's own. */
  protected readonly namespaces = computed<readonly string[]>(() => {
    const found = new Set<string>();
    for (const key of this.allKeys()) {
      found.add(key.split('.')[0] ?? '');
    }
    return [...found].sort();
  });

  /** Every row, before filtering. */
  private readonly rows = computed<readonly KeyRow[]>(() => {
    this.locales.revision();
    const entries = this.locales.entries();
    const application = flattenStrings(APP_STRINGS[APP_DEFAULT_LANGUAGE] ?? {});
    const languages = this.languages();

    return this.allKeys().map((key) => {
      const values: Record<string, string> = {};
      let incomplete = false;
      for (const language of languages) {
        const value = entries[language.id]?.[key] ?? '';
        values[language.id] = value;
        if (value.trim().length === 0) {
          incomplete = true;
        }
      }
      return {
        key,
        namespace: key.split('.')[0] ?? '',
        values,
        fromApplication: key in application && !languages.some((l) => key in (entries[l.id] ?? {})),
        incomplete,
      };
    });
  });

  /** The rows the table shows, after the namespace, search and gap filters. */
  protected readonly visibleRows = computed<readonly KeyRow[]>(() => {
    const namespace = this.namespaceFilter();
    const needle = this.search().trim().toLowerCase();
    const onlyMissing = this.onlyMissing();

    return this.rows().filter((row) => {
      if (namespace !== null && row.namespace !== namespace) {
        return false;
      }
      if (onlyMissing && !row.incomplete) {
        return false;
      }
      if (needle.length === 0) {
        return true;
      }
      return (
        row.key.toLowerCase().includes(needle) ||
        Object.values(row.values).some((value) => value.toLowerCase().includes(needle))
      );
    });
  });

  /** How many rows some language is missing, for the header. */
  protected readonly missingCount = computed(
    () => this.rows().filter((row) => row.incomplete && !row.fromApplication).length,
  );

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      await this.locales.ensureLoaded();
    } catch (cause) {
      this.error.set(describe(cause));
    }
  }

  /** Every key any language or the application defines, sorted. */
  private allKeys(): string[] {
    this.locales.revision();
    const keys = new Set<string>(
      Object.keys(flattenStrings(APP_STRINGS[APP_DEFAULT_LANGUAGE] ?? {})),
    );
    for (const key of this.locales.keys()) {
      keys.add(key);
    }
    return [...keys].sort();
  }

  /** The text shown in a cell: what the language says, else the fallback. */
  protected placeholder(row: KeyRow, language: string): string {
    if (row.values[language]) {
      return '';
    }
    const application = flattenStrings(
      APP_STRINGS[language] ?? APP_STRINGS[APP_DEFAULT_LANGUAGE] ?? {},
    );
    return application[row.key] ?? '';
  }

  protected edit(row: KeyRow, language: string, value: string): void {
    this.locales.set(language, row.key, value);
    this.message.set(null);
  }

  /** Adds a key to every language, so a row exists to translate. */
  protected addKey(key: string): void {
    if (!isUsableKey(key)) {
      this.error.set(this.i18n.t('ui.editor.locale.badKey'));
      return;
    }
    this.error.set(null);
    this.locales.ensureKeys([key.trim()]);
  }

  /** Removes a key from every language. */
  protected removeKey(row: KeyRow): void {
    this.locales.removeKey(row.key);
  }

  protected setNamespace(value: string): void {
    this.namespaceFilter.set(value === 'all' ? null : value);
  }

  /** Writes every language's files back into the content directory. */
  protected async save(): Promise<void> {
    this.error.set(null);
    this.message.set(null);
    this.saving.set(true);

    try {
      const outcome = await this.locales.save();
      this.message.set(
        this.i18n.t(
          outcome.manifestChanged ? 'ui.editor.locale.savedWithManifest' : 'ui.editor.locale.saved',
          { count: outcome.files },
        ),
      );
    } catch (cause) {
      this.error.set(describe(cause));
    } finally {
      this.saving.set(false);
    }
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
