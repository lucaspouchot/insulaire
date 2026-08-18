/**
 * The language editor: every key, every language, side by side.
 *
 * Translating is a table job — one row per key, one column per language — and
 * the two things that make it bearable are seeing the languages together and
 * being told what is missing. Both come from the engine: it flattens the files,
 * and `validateLocales` reports the gaps
 * (`docs/adr/ADR-0023-localised-content-keys.md`).
 *
 * Editing writes back **namespace by namespace**, re-nesting the flat keys into
 * the shape the file had, so a diff stays as small as the change.
 *
 * The application's own `ui.` keys are listed too, greyed until they are
 * overridden: a game may rename anything the shell says, and this is where it
 * would see that it can.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { APP_DEFAULT_LANGUAGE, APP_STRINGS, flattenStrings } from '../../../i18n/app-strings';
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import { ContentWorkspaceService } from '../../../services/content-workspace.service';
import { EngineService } from '../../../services/engine.service';
import { ProjectStoreService } from '../../../services/project-store.service';

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
  private readonly store = inject(ProjectStoreService);
  private readonly engine = inject(EngineService);
  private readonly i18n = inject(I18nService);
  private readonly workspace = inject(ContentWorkspaceService);

  /** Content translations by language, as edited. */
  private readonly entries = signal<Record<string, Record<string, string>>>({});
  /** Bumped on every edit so the table recomputes. */
  private readonly revision = signal(0);

  protected readonly languages = this.i18n.languages;
  protected readonly namespaceFilter = signal<string | null>(null);
  protected readonly search = signal('');
  protected readonly onlyMissing = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  /** `true` once something has been edited and not yet written. */
  protected readonly dirty = signal(false);

  /** Paths the manifest gives each `<language>/<namespace>` file. */
  private readonly paths = computed(() => {
    const paths = new Map<string, string>();
    for (const language of this.store.project()?.locales?.languages ?? []) {
      for (const file of language.files ?? []) {
        paths.set(`${language.id}/${file.id}`, file.path);
      }
    }
    return paths;
  });

  /** Every namespace the project declares, plus the application's own. */
  protected readonly namespaces = computed<readonly string[]>(() => {
    this.revision();
    const found = new Set<string>();
    for (const key of this.allKeys()) {
      found.add(key.split('.')[0] ?? '');
    }
    return [...found].sort();
  });

  /** Every row, before filtering. */
  private readonly rows = computed<readonly KeyRow[]>(() => {
    this.revision();
    const entries = this.entries();
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
      await this.i18n.ensureAdopted();
      await this.workspace.ensureProbed();

      const entries: Record<string, Record<string, string>> = {};
      for (const language of this.languages()) {
        try {
          // The *authored* entries, not the resolved ones: an editor must show
          // what a language actually says, gaps included.
          entries[language.id] = authoredEntries(this.engine, language.id);
        } catch {
          entries[language.id] = {};
        }
      }
      this.entries.set(entries);
    } catch (cause) {
      this.error.set(describe(cause));
    }
  }

  /** Every key any language or the application defines, sorted. */
  private allKeys(): string[] {
    const keys = new Set<string>(Object.keys(flattenStrings(APP_STRINGS[APP_DEFAULT_LANGUAGE] ?? {})));
    for (const language of Object.values(this.entries())) {
      for (const key of Object.keys(language)) {
        keys.add(key);
      }
    }
    return [...keys].sort();
  }

  /** The text shown in a cell: what the language says, else the fallback. */
  protected placeholder(row: KeyRow, language: string): string {
    if (row.values[language]) {
      return '';
    }
    const application = flattenStrings(APP_STRINGS[language] ?? APP_STRINGS[APP_DEFAULT_LANGUAGE] ?? {});
    return application[row.key] ?? '';
  }

  protected edit(row: KeyRow, language: string, value: string): void {
    this.entries.update((entries) => ({
      ...entries,
      [language]: { ...(entries[language] ?? {}), [row.key]: value },
    }));
    this.revision.update((value) => value + 1);
    this.dirty.set(true);
    this.message.set(null);
  }

  /** Adds a key to every language, so a row exists to translate. */
  protected addKey(key: string): void {
    const trimmed = key.trim();
    if (trimmed.length === 0 || trimmed.split('.').length < 2) {
      this.error.set(this.i18n.t('ui.editor.locale.badKey'));
      return;
    }
    this.error.set(null);
    this.entries.update((entries) => {
      const next = { ...entries };
      for (const language of this.languages()) {
        next[language.id] = { ...(next[language.id] ?? {}), [trimmed]: '' };
      }
      return next;
    });
    this.revision.update((value) => value + 1);
    this.dirty.set(true);
  }

  /** Removes a key from every language. */
  protected removeKey(row: KeyRow): void {
    this.entries.update((entries) => {
      const next: Record<string, Record<string, string>> = {};
      for (const [language, values] of Object.entries(entries)) {
        const copy = { ...values };
        delete copy[row.key];
        next[language] = copy;
      }
      return next;
    });
    this.revision.update((value) => value + 1);
    this.dirty.set(true);
  }

  protected setNamespace(value: string): void {
    this.namespaceFilter.set(value === 'all' ? null : value);
  }

  /**
   * Writes every language's files back into the content directory.
   *
   * One file per `<language>/<namespace>` the manifest declares: keys are
   * re-nested into the tree the file holds, so the diff is the change and
   * nothing else.
   */
  protected async save(): Promise<void> {
    this.error.set(null);
    this.message.set(null);
    this.saving.set(true);

    try {
      const paths = this.paths();
      let written = 0;
      for (const [id, path] of paths) {
        const [language = '', namespace = ''] = id.split('/');
        const tree = nest(this.entries()[language] ?? {}, namespace);
        await this.workspace.writeJson(path, `${JSON.stringify(tree, null, 2)}\n`);
        written += 1;
      }
      this.dirty.set(false);
      this.message.set(this.i18n.t('ui.editor.locale.saved', { count: written }));
    } catch (cause) {
      this.error.set(describe(cause));
    } finally {
      this.saving.set(false);
    }
  }
}

/** One language's authored entries, without the default-language fallback. */
function authoredEntries(engine: EngineService, language: string): Record<string, string> {
  const view = engine.locale(language);
  const authored: Record<string, string> = {};
  for (const [key, value] of Object.entries(view.entries)) {
    if (!view.fallbacks.includes(key)) {
      authored[key] = value;
    }
  }
  return authored;
}

/**
 * Turns flat keys back into the nested object a locale file holds.
 *
 * Only the keys of `namespace`, and with the namespace segment dropped: the
 * manifest supplies it when the file is loaded.
 */
function nest(entries: Record<string, string>, namespace: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const prefix = `${namespace}.`;

  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const segments = key.slice(prefix.length).split('.');
    let node = root;
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        node[segment] = value;
        return;
      }
      const child = node[segment];
      if (typeof child !== 'object' || child === null) {
        node[segment] = {};
      }
      node = node[segment] as Record<string, unknown>;
    });
  }

  return root;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
