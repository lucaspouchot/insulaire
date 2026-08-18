/**
 * What {@link SettingsService} promises the settings screen and `createGame`.
 *
 * The cases that matter are the boundaries between the two kinds of setting:
 * which values cross into the engine, which act on the shell, and what a
 * `showIf` condition sees before anybody has touched anything
 * (`docs/adr/ADR-0025-settings.md`).
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsService } from './settings.service';
import { ENGINE_SETTING } from './engine-settings.schema';
import { ControlDefinition, SettingsValues } from '../../content/content-types';
import { EngineService } from '../services/engine.service';
import { ProjectStoreService } from '../services/project-store.service';

/** A stand-in engine that answers with a fixed settings declaration. */
class FakeEngine {
  loaded: string[] = [];

  async ready(): Promise<unknown> {
    return this;
  }

  locale(language: string): { language: string; entries: Record<string, string>; fallbacks: string[] } {
    return { language, entries: {}, fallbacks: [] };
  }

  loadLocale(): void {}

  loadSettings(json: string): void {
    this.loaded.push(json);
  }

  settings() {
    return {
      id: 'game',
      schemaVersion: 1,
      sections: [
        {
          id: 'gameplay',
          labelKey: 'game.gameplay',
          groups: [
            {
              id: 'world',
              labelKey: 'game.world',
              fields: [
                {
                  id: 'difficulty',
                  labelKey: 'game.difficulty',
                  control: 'select' as const,
                  default: 'normal',
                  scope: 'newGame' as const,
                  options: [
                    { value: 'normal', labelKey: 'game.normal' },
                    { value: 'harsh', labelKey: 'game.harsh' },
                  ],
                },
                {
                  id: 'harshWinters',
                  labelKey: 'game.harshWinters',
                  control: 'checkbox' as const,
                  default: true,
                  scope: 'newGame' as const,
                  showIf: { field: 'difficulty', equals: 'harsh' },
                },
              ],
            },
          ],
        },
      ],
    };
  }

  resolveSettings(values: SettingsValues): SettingsValues {
    return { difficulty: 'normal', harshWinters: true, ...values };
  }

  get isReady(): boolean {
    return true;
  }

  hasGame(): boolean {
    return false;
  }
}

/** A store whose project declares a settings file. */
class FakeStore {
  project() {
    return { id: 'p', schemaVersion: 1, startWorld: 'w', tileSets: [], worlds: [],
      settings: { id: 'game', path: 'settings.json' } };
  }

  localeFiles() {
    return [];
  }

  async ensureLoaded(): Promise<void> {}
}

function setup(): { settings: SettingsService; engine: FakeEngine } {
  const engine = new FakeEngine();
  // The declaration is fetched as a file; what it contains does not matter here,
  // because the fake engine is what parses it.
  vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => '{}' }));
  TestBed.configureTestingModule({
    providers: [
      { provide: EngineService, useValue: engine },
      { provide: ProjectStoreService, useValue: new FakeStore() },
    ],
  });
  return { settings: TestBed.inject(SettingsService), engine };
}

/** The application setting with this id, from the rendered sections. */
function field(settings: SettingsService, id: string): ControlDefinition {
  const found = settings.field(id);
  expect(found, `setting ${id}`).toBeDefined();
  return found as ControlDefinition;
}

describe('SettingsService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('offers the application’s settings with no project loaded', () => {
    const { settings } = setup();

    const ids = settings
      .sections()
      .flatMap((section) => section.groups.flatMap((group) => group.fields.map((f) => f.id)));

    expect(ids).toContain(ENGINE_SETTING.master);
    expect(ids).toContain(ENGINE_SETTING.language);
    expect(settings.value(field(settings, ENGINE_SETTING.music))).toBe(70);
  });

  it('stores a change and reads it back', () => {
    const { settings } = setup();
    const music = field(settings, ENGINE_SETTING.music);

    settings.set(music, 25);

    expect(settings.value(music)).toBe(25);
    expect(localStorage.getItem('insulaire.settings.v1')).toContain('25');
  });

  /**
   * A condition has to see the value in force, default included — otherwise the
   * field it guards only appears once something unrelated has been changed.
   */
  it('evaluates showIf against the effective value', async () => {
    const { settings } = setup();
    await settings.ensureLoaded();
    const difficulty = field(settings, 'difficulty');
    const winters = field(settings, 'harshWinters');

    expect(settings.isVisible(winters)).toBe(false);

    settings.set(difficulty, 'harsh');
    expect(settings.isVisible(winters)).toBe(true);
  });

  /**
   * The line this service exists to hold: the game gets its own settings, and
   * nothing of the application's — the engine has no business knowing about a
   * music volume.
   */
  it('hands the engine the game’s settings and nothing else', async () => {
    const { settings } = setup();
    await settings.ensureLoaded();

    settings.set(field(settings, ENGINE_SETTING.music), 10);
    settings.set(field(settings, 'difficulty'), 'harsh');

    const game = settings.gameSettings();
    expect(game).toEqual({ difficulty: 'harsh', harshWinters: true });
    expect(game[ENGINE_SETTING.music]).toBeUndefined();
  });

  it('honours the seed mode', () => {
    const { settings } = setup();
    expect(settings.seed()).toBe(2026);

    settings.set(field(settings, ENGINE_SETTING.seed), 7);
    expect(settings.seed()).toBe(7);

    settings.set(field(settings, ENGINE_SETTING.seedMode), 'random');
    const first = settings.seed();
    expect(Number.isInteger(first)).toBe(true);
  });

  it('restores every default', async () => {
    const { settings } = setup();
    await settings.ensureLoaded();
    settings.set(field(settings, ENGINE_SETTING.music), 3);
    settings.set(field(settings, 'difficulty'), 'harsh');

    settings.reset();

    expect(settings.value(field(settings, ENGINE_SETTING.music))).toBe(70);
    expect(settings.gameSettings()['difficulty']).toBe('normal');
  });
});
