/**
 * What {@link LocaleAuthoringService} promises the three screens that author
 * text (`docs/adr/ADR-0020-localised-content-keys.md`).
 *
 * Two behaviours carry the whole feature: a key content names comes into
 * existence, in every language and in a namespace file that may not exist yet;
 * and a save does not stop at the disk — it puts the edited files back into the
 * engine, which is what everything else on screen reads through.
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { ContentWorkspaceService } from './content-workspace.service';
import { EngineService } from './engine.service';
import { LocaleAuthoringService } from './locale-authoring.service';
import { ProjectStoreService } from './project-store.service';
import { ProjectManifest } from '../project/project-manifest';
import { TILE_SET, world } from '../project/project-fixture';
import { WorldLibrary } from '../project/world-library';
import { WorldDocument } from '../../content/world-document';
import { LocaleView } from '../../engine/engine.types';
import { I18nService } from '../i18n/i18n.service';

/** A stand-in engine holding one bundle per language. */
class FakeEngine {
  bundles: Record<string, Record<string, string>> = { en: {}, fr: {} };
  resets = 0;

  async ready(): Promise<unknown> {
    return this;
  }

  loadLocale(language: string, namespace: string, json: string): void {
    const tree = JSON.parse(json) as Record<string, unknown>;
    const entries = (this.bundles[language] ??= {});
    for (const [key, value] of flatten(namespace, tree)) {
      entries[key] = value;
    }
  }

  resetLocales(): void {
    this.resets += 1;
    this.bundles = {};
  }

  locale(language: string): LocaleView {
    const entries = this.bundles[language];
    if (entries === undefined) {
      throw new Error(`no locale for ${language}`);
    }
    return { language, entries, fallbacks: [] };
  }
}

/** A stand-in content server that keeps what it was asked to write. */
class FakeWorkspace {
  readonly written = new Map<string, string>();

  async ensureProbed(): Promise<null> {
    return null;
  }

  async writeJson(path: string, json: string): Promise<void> {
    this.written.set(path, json);
  }
}

const PROJECT = {
  id: 'p',
  schemaVersion: 1,
  startWorld: 'w',
  tileSets: [],
  worlds: [],
  locales: {
    default: 'en',
    languages: [
      { id: 'en', name: 'English', files: [{ id: 'menu', path: 'locales/en/menu.json' }] },
      { id: 'fr', name: 'Français', files: [{ id: 'menu', path: 'locales/fr/menu.json' }] },
    ],
  },
};

function setup(): {
  locales: LocaleAuthoringService;
  engine: FakeEngine;
  workspace: FakeWorkspace;
  manifest: ProjectManifest;
} {
  const engine = new FakeEngine();
  const workspace = new FakeWorkspace();
  TestBed.configureTestingModule({
    providers: [
      { provide: EngineService, useValue: engine },
      { provide: ContentWorkspaceService, useValue: workspace },
    ],
  });

  const store = TestBed.inject(ProjectStoreService);
  // The manifest as if it had been fetched, with no files to load behind it.
  store.setLocaleFiles([]);
  Reflect.set(store, 'loading', Promise.resolve());
  const manifest = TestBed.inject(ProjectManifest);
  manifest.adopt(PROJECT);

  const i18n = TestBed.inject(I18nService);
  i18n.adopt(
    [],
    [
      { id: 'en', name: 'English' },
      { id: 'fr', name: 'Français' },
    ],
    'en',
  );

  return { locales: TestBed.inject(LocaleAuthoringService), engine, workspace, manifest };
}

describe('LocaleAuthoringService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('creates a key, empty, in every declared language', async () => {
    const { locales } = setup();
    await locales.ensureLoaded();

    expect(locales.ensureKeys(['menu.title.credits'])).toEqual(['menu.title.credits']);
    expect(locales.entries()['en']?.['menu.title.credits']).toBe('');
    expect(locales.entries()['fr']?.['menu.title.credits']).toBe('');
    // Already there: creating it again is not a change.
    expect(locales.ensureKeys(['menu.title.credits'])).toEqual([]);
  });

  it('refuses what a locale file cannot hold', async () => {
    const { locales } = setup();
    await locales.ensureLoaded();

    expect(locales.ensureKeys(['nonamespace', '', 'menu..empty'])).toEqual([]);
  });

  it('writes the files and puts them back into the engine', async () => {
    const { locales, engine, workspace } = setup();
    await locales.ensureLoaded();

    locales.ensureKeys(['menu.title.credits']);
    locales.set('en', 'menu.title.credits', 'Credits');
    const outcome = await locales.save();

    expect(outcome.files).toBe(2);
    expect(JSON.parse(workspace.written.get('locales/en/menu.json') ?? '{}')).toEqual({
      title: { credits: 'Credits' },
    });
    // The engine is what every screen reads through, so a save that only wrote
    // to disk would leave the running editor on the old text.
    expect(engine.resets).toBe(1);
    expect(engine.bundles['en']?.['menu.title.credits']).toBe('Credits');
    expect(locales.entries()['en']?.['menu.title.credits']).toBe('Credits');
    expect(locales.dirty()).toBe(false);
  });

  it('leaves a file alone rather than emptying it when it has no keys', async () => {
    const { locales, engine, workspace } = setup();
    // French never loaded: the table has nothing for it, which must not be
    // mistaken for "the author deleted every French string".
    engine.bundles = { en: { 'menu.play': 'Play' } };
    await locales.ensureLoaded();

    const outcome = await locales.save();

    expect(outcome.files).toBe(1);
    expect(workspace.written.has('locales/fr/menu.json')).toBe(false);
  });

  it('declares a namespace the manifest did not have, so its keys survive', async () => {
    const { locales, workspace, manifest } = setup();
    await locales.ensureLoaded();

    locales.ensureKeys(['credits.author']);
    const outcome = await locales.save();

    expect(outcome.manifestChanged).toBe(true);
    expect(workspace.written.has('locales/fr/credits.json')).toBe(true);
    expect(workspace.written.get('project.json')).toContain('locales/en/credits.json');
    const files = manifest.languages()[0]?.files ?? [];
    expect(files.map((file) => file.id)).toEqual(['menu', 'credits']);
  });

  it('writes a manifest that still lists an unwritten open world', async () => {
    // `project.json` has one writer: the regenerated manifest `WriteLedger`
    // owns. Writing it from the manifest as loaded would drop a map the editor
    // added but has not saved yet
    // (`.scratch/module-depth-2/issues/01-one-writer-for-project-json.md`).
    const { locales, workspace } = setup();
    TestBed.inject(WorldLibrary).addWorld(WorldDocument.fromDefinition(world('north'), TILE_SET));
    await locales.ensureLoaded();

    locales.ensureKeys(['credits.author']);
    const outcome = await locales.save();

    expect(outcome.manifestChanged).toBe(true);
    expect(workspace.written.get('project.json')).toContain('worlds/north.json');
  });
});

/** `{ a: { b: "x" } }` under `menu` → `menu.a.b` / `x`. */
function flatten(prefix: string, node: Record<string, unknown>): [string, string][] {
  return Object.entries(node).flatMap(([segment, value]) =>
    typeof value === 'string'
      ? [[`${prefix}.${segment}`, value] as [string, string]]
      : flatten(`${prefix}.${segment}`, value as Record<string, unknown>),
  );
}
