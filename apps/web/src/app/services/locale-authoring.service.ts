/**
 * The editor's hold on the project's languages: the authored text, the files it
 * is written to, and the keys content has named.
 *
 * Three screens need the same three things — the language editor edits every
 * key, and the title and settings editors *create* keys as an author types a
 * `labelKey` — so the table, the writing and the re-registration live here
 * rather than three times over (`docs/adr/ADR-0020-localised-content-keys.md`).
 *
 * Two rules matter and both are the ADR's:
 *
 * - **naming a key creates it**, empty, in every language the project declares,
 *   including in a namespace file the manifest did not have yet;
 * - **writing a file is not enough**. The engine holds the languages, loading is
 *   additive and refuses a key twice, so a save that does not clear and
 *   re-register leaves the running editor answering the *old* text — which is
 *   how a key could be saved to disk and vanish from the table.
 *
 * **Editor-only.** It writes through {@link ContentWorkspaceService}, so nothing
 * the client build imports may reach it (`docs/adr/ADR-0015-client-delivery-build.md`).
 */

import { Injectable, computed, inject, signal } from '@angular/core';

import { serializeProject } from '../../content/world-serializer';
import { I18nService } from '../i18n/i18n.service';
import { ContentWorkspaceService } from './content-workspace.service';
import { EngineService } from './engine.service';
import { LocaleFile, ProjectStoreService } from './project-store.service';

/** What one save wrote. */
export interface LocaleSaveOutcome {
  /** How many locale files were written. */
  readonly files: number;
  /** `true` when the manifest gained a file and was written too. */
  readonly manifestChanged: boolean;
}

@Injectable({ providedIn: 'root' })
export class LocaleAuthoringService {
  private readonly store = inject(ProjectStoreService);
  private readonly engine = inject(EngineService);
  private readonly i18n = inject(I18nService);
  private readonly workspace = inject(ContentWorkspaceService);

  /** Authored text by language, as edited: no default-language fallback. */
  private readonly entriesSignal = signal<Record<string, Record<string, string>>>({});
  /** Bumped whenever the text changes, so tables recompute. */
  private readonly revisionSignal = signal(0);
  /** `true` once something has been edited and not yet written. */
  private readonly dirtySignal = signal(false);

  readonly entries = this.entriesSignal.asReadonly();
  readonly revision = this.revisionSignal.asReadonly();
  readonly dirty = this.dirtySignal.asReadonly();

  private loading: Promise<void> | null = null;

  /** The languages the project offers, in author order. */
  readonly languages = this.i18n.languages;

  /** Paths the manifest gives each `<language>/<namespace>` file. */
  private readonly declaredPaths = computed(() => {
    const paths = new Map<string, string>();
    for (const language of this.store.project()?.locales?.languages ?? []) {
      for (const file of language.files ?? []) {
        paths.set(`${language.id}/${file.id}`, file.path);
      }
    }
    return paths;
  });

  /** Loads the authored text out of the engine, at most once. */
  async ensureLoaded(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    await this.i18n.ensureAdopted();
    await this.workspace.ensureProbed();
    this.readBack();
  }

  /**
   * Re-reads every language from the engine, discarding unsaved edits.
   *
   * The *authored* entries, not the resolved ones: an editor has to show what a
   * language actually says, gaps included.
   */
  private readBack(): void {
    const entries: Record<string, Record<string, string>> = {};
    for (const language of this.languages()) {
      try {
        entries[language.id] = authoredEntries(this.engine, language.id);
      } catch {
        // A declared language the engine has no bundle for: `validateLocales`
        // reports it, and the table still shows every other language.
        entries[language.id] = {};
      }
    }
    this.entriesSignal.set(entries);
    this.revisionSignal.update((value) => value + 1);
    this.dirtySignal.set(false);
  }

  /** Every key some language defines. */
  keys(): readonly string[] {
    const keys = new Set<string>();
    for (const language of Object.values(this.entriesSignal())) {
      for (const key of Object.keys(language)) {
        keys.add(key);
      }
    }
    return [...keys];
  }

  /** Sets one language's text for a key. */
  set(language: string, key: string, value: string): void {
    this.entriesSignal.update((entries) => ({
      ...entries,
      [language]: { ...(entries[language] ?? {}), [key]: value },
    }));
    this.touch();
  }

  /**
   * Creates a key, empty, in every language that does not have it.
   *
   * This is what lets a `labelKey` be typed before its text exists: the key
   * becomes something the language editor lists and a translator can fill in,
   * and until then every screen shows the key itself.
   *
   * @returns the keys that were actually created
   */
  ensureKeys(keys: Iterable<string>): readonly string[] {
    const languages = this.languages();
    const created: string[] = [];

    this.entriesSignal.update((entries) => {
      const next = { ...entries };
      for (const key of keys) {
        if (!isUsableKey(key)) {
          continue;
        }
        const missing = languages.filter((language) => next[language.id]?.[key] === undefined);
        if (missing.length === 0) {
          continue;
        }
        for (const language of missing) {
          next[language.id] = { ...(next[language.id] ?? {}), [key]: '' };
        }
        created.push(key);
      }
      return next;
    });

    if (created.length > 0) {
      this.touch();
    }
    return created;
  }

  /** Removes a key from every language. */
  removeKey(key: string): void {
    this.entriesSignal.update((entries) =>
      Object.fromEntries(
        Object.entries(entries).map(([language, values]) => {
          const copy = { ...values };
          delete copy[key];
          return [language, copy];
        }),
      ),
    );
    this.touch();
  }

  /**
   * Writes every language's files, then makes the running editor agree with
   * them.
   *
   * One file per `<language>/<namespace>`: keys are re-nested into the tree the
   * file holds, so the diff is the change and nothing else. A namespace the
   * manifest does not declare yet gets a file *and* a manifest entry — without
   * it, the key would be written nowhere and lost on the next load.
   *
   * A file the table has no key for is left alone rather than emptied: a
   * language whose file failed to load must not have its translations
   * overwritten by the blank table that failure produces.
   */
  async save(): Promise<LocaleSaveOutcome> {
    const targets = this.targets();
    let manifestChanged = false;

    for (const target of targets) {
      if (target.declare) {
        manifestChanged =
          this.store.declareLocaleFile(target.language, target.namespace, target.path) ||
          manifestChanged;
      }
    }

    const files: LocaleFile[] = [];
    for (const target of targets) {
      const tree = nest(this.entriesSignal()[target.language] ?? {}, target.namespace);
      if (Object.keys(tree).length === 0) {
        // Nothing to write, and writing `{}` would empty a real file — which is
        // what a language whose file failed to fetch would otherwise cause. The
        // last key of a namespace therefore has to be removed by deleting the
        // file, not by saving an empty table.
        continue;
      }
      const json = `${JSON.stringify(tree, null, 2)}\n`;
      await this.workspace.writeJson(target.path, json);
      files.push({ language: target.language, namespace: target.namespace, json });
    }

    if (manifestChanged) {
      await this.workspace.writeJson('project.json', serializeProject(this.store.requireProject()));
    }

    // Disk is only half of it: the engine still holds the text it was given at
    // boot, and every screen reads through it.
    this.store.setLocaleFiles(files);
    this.i18n.reload(files);
    this.readBack();

    return { files: files.length, manifestChanged };
  }

  /**
   * Every file to write: the ones the manifest declares, plus one per namespace
   * an edit introduced.
   */
  private targets(): readonly {
    language: string;
    namespace: string;
    path: string;
    declare: boolean;
  }[] {
    const declared = this.declaredPaths();
    const targets = [...declared].map(([id, path]) => {
      const [language = '', namespace = ''] = id.split('/');
      return { language, namespace, path, declare: false };
    });

    for (const language of this.languages()) {
      const namespaces = new Set(
        Object.keys(this.entriesSignal()[language.id] ?? {}).map((key) => key.split('.')[0] ?? ''),
      );
      for (const namespace of namespaces) {
        if (namespace.length === 0 || declared.has(`${language.id}/${namespace}`)) {
          continue;
        }
        targets.push({
          language: language.id,
          namespace,
          path: `${this.directoryFor(language.id)}/${namespace}.json`,
          declare: true,
        });
      }
    }

    return targets;
  }

  /** Where a language keeps its files: where it already does, else by convention. */
  private directoryFor(language: string): string {
    for (const [id, path] of this.declaredPaths()) {
      if (id.startsWith(`${language}/`) && path.includes('/')) {
        return path.slice(0, path.lastIndexOf('/'));
      }
    }
    return `locales/${language}`;
  }

  private touch(): void {
    this.revisionSignal.update((value) => value + 1);
    this.dirtySignal.set(true);
  }
}

/** `true` when a key is something a locale file can hold: `namespace.rest`. */
export function isUsableKey(key: string): boolean {
  const segments = key.trim().split('.');
  return segments.length >= 2 && segments.every((segment) => segment.trim().length > 0);
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
