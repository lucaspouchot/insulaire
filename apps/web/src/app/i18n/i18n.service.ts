/**
 * Resolves a key to the text on screen, in the language in use.
 *
 * Three sources, in order:
 *
 * 1. the **project's** locale files, resolved by the engine (which has already
 *    applied the default-language fallback), so a game can say anything and
 *    override any application string;
 * 2. the **application's** strings for the current language;
 * 3. the application's strings for {@link APP_DEFAULT_LANGUAGE}.
 *
 * Only a key nobody defines reaches the screen as itself — visible on purpose,
 * because a missing key is a bug and hiding it would let the game ship blank
 * buttons (`docs/adr/ADR-0020-localised-content-keys.md`). A key that exists
 * with an empty value is the same thing said differently: the editor creates a
 * key the moment content names it, and until someone writes its text there is
 * none (`docs/adr/ADR-0020-localised-content-keys.md`).
 *
 * Resolution order is what makes the application usable before any content
 * loads: the chrome answers immediately, and content refines it.
 */

import { Injectable, computed, effect, inject, signal } from '@angular/core';

import { APP_DEFAULT_LANGUAGE, APP_LANGUAGES, APP_STRINGS, flattenStrings } from './app-strings';
import { EngineService } from '../services/engine.service';
import { ProjectManifest } from '../project/project-manifest';
import { LocaleFile, ProjectStoreService } from '../services/project-store.service';

/** Where the language in use came from. */
export type LanguagePreference = 'stored' | 'browser' | 'project' | 'application';

/** One language offered in the picker. */
export interface LanguageChoice {
  readonly id: string;
  readonly name: string;
}

const STORAGE_KEY = 'insulaire.language.v1';

/** The application's own strings, flattened once per language. */
const APP_ENTRIES: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(APP_STRINGS).map(([language, tree]) => [language, flattenStrings(tree)]),
);

@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly engine = inject(EngineService);
  private readonly store = inject(ProjectStoreService);
  private readonly manifest = inject(ProjectManifest);

  /** Language currently displayed. */
  readonly language = signal<string>(initialLanguage());
  /** Where that language came from, for the settings screen to explain. */
  readonly source = signal<LanguagePreference>(storedLanguage() === null ? 'browser' : 'stored');

  /** Content translations, by language, as loaded from the engine. */
  private readonly contentEntries = signal<Record<string, Record<string, string>>>({});
  /** The project's locale files, kept so they can be re-registered. */
  private files: LocaleFile[] = [];
  /** The one-shot adoption, so every caller shares it. */
  private adoption: Promise<void> | null = null;

  /** Languages the project offers; the application's own when it declares none. */
  readonly languages = signal<readonly LanguageChoice[]>(
    APP_LANGUAGES.map((language) => ({ ...language })),
  );

  /** The lookup table in use, content over chrome. */
  private readonly entries = computed<Record<string, string>>(() => {
    const language = this.language();
    return {
      ...APP_ENTRIES[APP_DEFAULT_LANGUAGE],
      ...(APP_ENTRIES[language] ?? {}),
      ...(this.contentEntries()[language] ?? {}),
    };
  });

  constructor() {
    // The document has to say which language it is in, for the browser's own
    // hyphenation, spell-checking and assistive technology.
    effect(() => {
      if (typeof document !== 'undefined') {
        document.documentElement.lang = this.language();
      }
    });
  }

  /**
   * The text for `key`, with `{name}` placeholders replaced.
   *
   * @param key full key, e.g. `ui.play.controls.wait`
   * @param params values for the placeholders the text contains
   */
  t(key: string, params?: Readonly<Record<string, string | number>>): string {
    const defined = this.entries()[key];
    // An empty value is a key that exists but has no text yet — the state a key
    // is created in (`docs/adr/ADR-0020-localised-content-keys.md`). It reads
    // like a key nobody defines, because that is what it is.
    const text = defined === undefined || defined.trim().length === 0 ? key : defined;
    if (params === undefined) {
      return text;
    }
    return text.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  }

  /** `true` when some source gives this key actual text. */
  has(key: string): boolean {
    return (this.entries()[key] ?? '').trim().length > 0;
  }

  /** Switches language and remembers the choice. */
  use(language: string): void {
    if (language === this.language()) {
      return;
    }
    this.language.set(language);
    this.source.set('stored');
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // Private mode or a full store: the language still applies to this session.
    }
  }

  /**
   * Re-registers edited locale files and re-reads every bundle.
   *
   * The language editor writes files to disk; this is what makes the *running*
   * editor agree with them, without a reload. The engine's languages are
   * cleared first because loading is additive and refuses a key twice, so the
   * edited files could not otherwise go back in
   * (`docs/adr/ADR-0020-localised-content-keys.md`).
   *
   * @param files every locale file, as edited
   */
  reload(files: readonly LocaleFile[]): void {
    this.engine.resetLocales();
    this.adopt(files, this.languages(), this.language());
  }

  /**
   * Registers the project's locale files with the engine.
   *
   * Loading is additive and refuses a key twice, so this is called exactly once
   * per empty registry: at adoption, and again by anything that calls
   * `resetContent()` before re-loading a project.
   */
  register(): void {
    for (const file of this.files) {
      try {
        this.engine.loadLocale(file.language, file.namespace, file.json);
      } catch {
        // A malformed locale file must not stop a project from loading: the
        // language simply falls back, and `validateLocales` says why.
      }
    }
  }

  /**
   * Brings the engine and the content up, then adopts the project's languages —
   * at most once, whoever asks first.
   *
   * Every screen that loads content into the engine has to await this, because
   * a manifest that declares languages will not load until their files are
   * registered. Memoising it here is what removes the ordering question: the
   * shell and a page can both ask, in any order, and the work happens once.
   */
  async ensureAdopted(): Promise<void> {
    this.adoption ??= this.runAdoption();
    return this.adoption;
  }

  private async runAdoption(): Promise<void> {
    await Promise.all([this.engine.ready(), this.store.ensureLoaded()]);

    const declared = this.manifest.languages().map((language) => ({
      id: language.id,
      name: language.name ?? language.id,
    }));
    const fallback = this.manifest.locales()?.default;

    this.adopt(this.store.localeFiles(), declared, fallback ?? declared[0]?.id ?? null);
  }

  /**
   * Adopts the project's languages: registers its files, then reads the
   * resolved bundles back out of the engine.
   *
   * Reading them back rather than merging here is deliberate — the
   * default-language fallback is Rust's rule, and a second implementation in
   * TypeScript is exactly how two hosts start disagreeing about what a key says.
   *
   * @param files every locale file the manifest lists
   * @param declared languages the project offers, in author order
   * @param defaultLanguage the project's fallback language, if it names one
   */
  adopt(
    files: readonly LocaleFile[],
    declared: readonly LanguageChoice[],
    defaultLanguage: string | null,
  ): void {
    this.files = [...files];
    this.register();

    if (declared.length > 0) {
      this.languages.set(declared.map((language) => ({ ...language })));
    }

    const entries: Record<string, Record<string, string>> = {};
    for (const language of declared) {
      try {
        entries[language.id] = this.engine.locale(language.id).entries;
      } catch {
        // A declared language with no loaded file: `validateLocales` reports it,
        // and the chrome still answers for its own keys.
      }
    }
    this.contentEntries.set(entries);

    // A stored or browser language the project does not offer would show the
    // application's chrome around untranslated content; the project decides.
    const offered = this.languages().map((language) => language.id);
    if (!offered.includes(this.language())) {
      const fallback = defaultLanguage ?? offered[0] ?? APP_DEFAULT_LANGUAGE;
      this.language.set(fallback);
      this.source.set('project');
    }
  }
}

/** The stored choice, if the user made one. */
function storedLanguage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Stored choice, else the browser's language, else the application default. */
function initialLanguage(): string {
  const stored = storedLanguage();
  if (stored !== null && stored.length > 0) {
    return stored;
  }
  const browser = typeof navigator === 'undefined' ? '' : (navigator.language ?? '');
  const base = browser.split('-')[0] ?? '';
  return base in APP_STRINGS ? base : APP_DEFAULT_LANGUAGE;
}
