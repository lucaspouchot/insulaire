/**
 * What {@link SettingsService} promises the settings screen and `createGame`.
 *
 * The cases that matter are the boundaries between the two kinds of setting:
 * which values cross into the engine, which act on the shell, and what a
 * `showIf` condition sees before anybody has touched anything
 * (`docs/adr/ADR-0022-settings.md`).
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsService } from './settings.service';
import { ENGINE_SETTING } from './engine-settings.schema';
import { ControlDefinition } from '../../content/generated/settings';
import { ProjectDefinition } from '../../content/generated/project';
import { SettingsValues } from '../../content/setting-values';
import { EngineService } from '../services/engine.service';
import { NativeShellService } from '../services/native-shell.service';
import { ProjectManifest } from '../project/project-manifest';
import { ProjectStoreService } from '../services/project-store.service';

/** A stand-in engine that answers with a fixed settings declaration. */
class FakeEngine {
  loaded: string[] = [];

  async ready(): Promise<unknown> {
    return this;
  }

  locale(language: string): {
    language: string;
    entries: Record<string, string>;
    fallbacks: string[];
  } {
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
                {
                  id: 'openChronicle',
                  labelKey: 'game.openChronicle',
                  control: 'keyBinding' as const,
                  default: 'Digit1',
                  scope: 'session' as const,
                },
              ],
            },
          ],
        },
      ],
    };
  }

  resolveSettings(values: SettingsValues): SettingsValues {
    return { difficulty: 'normal', harshWinters: true, openChronicle: 'Digit1', ...values };
  }

  get isReady(): boolean {
    return true;
  }

  hasGame(): boolean {
    return false;
  }
}

/** A store with nothing fetched behind it; the manifest is adopted directly. */
class FakeStore {
  localeFiles() {
    return [];
  }

  async ensureLoaded(): Promise<void> {}
}

/** A project that declares a settings file, for the manifest to answer from. */
const PROJECT: ProjectDefinition = {
  id: 'p',
  schemaVersion: 1,
  startWorld: 'w',
  tileSets: [],
  worlds: [],
  settings: { id: 'game', path: 'settings.json' },
};

/** A stand-in shell: `hasWindow` is the whole question the settings ask it. */
function fakeShell(hasWindow: boolean): Partial<NativeShellService> {
  return {
    isShell: signal(true).asReadonly(),
    isMobile: signal(!hasWindow).asReadonly(),
    hasWindow: signal(hasWindow).asReadonly(),
  } as Partial<NativeShellService>;
}

function setup(shell?: Partial<NativeShellService>): {
  settings: SettingsService;
  engine: FakeEngine;
} {
  const engine = new FakeEngine();
  // The declaration is fetched as a file; what it contains does not matter here,
  // because the fake engine is what parses it.
  vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => '{}' }));
  TestBed.configureTestingModule({
    providers: [
      { provide: EngineService, useValue: engine },
      { provide: ProjectStoreService, useValue: new FakeStore() },
      ...(shell === undefined ? [] : [{ provide: NativeShellService, useValue: shell }]),
    ],
  });
  TestBed.inject(ProjectManifest).adopt(PROJECT);
  return { settings: TestBed.inject(SettingsService), engine };
}

/** Every setting id the screen would show. */
function shownIds(settings: SettingsService): string[] {
  return settings
    .sections()
    .flatMap((section) => section.groups.flatMap((group) => group.fields.map((f) => f.id)));
}

/** The application setting with this id, from the rendered sections. */
function field(settings: SettingsService, id: string): ControlDefinition {
  const found = settings.field(id);
  expect(found, `setting ${id}`).toBeDefined();
  return found as ControlDefinition;
}

/** What the shell actually zooms by. */
function scaleVariable(): string {
  return document.documentElement.style.getPropertyValue('--ui-scale');
}

describe('SettingsService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty('--ui-scale');
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
    expect(game).toEqual({ difficulty: 'harsh', harshWinters: true, openChronicle: 'Digit1' });
    expect(game[ENGINE_SETTING.music]).toBeUndefined();
  });

  it('offers spatial movement defaults as physical key positions', () => {
    const { settings } = setup();

    expect(settings.keyBinding('input.moveNorthWest')).toBe('KeyW');
    expect(settings.keyBinding('input.moveNorthEast')).toBe('KeyE');
    expect(settings.keyBinding('input.moveWest')).toBe('KeyA');
    expect(settings.keyBinding('input.moveEast')).toBe('KeyD');
    expect(settings.keyBinding('input.moveSouthWest')).toBe('KeyZ');
    expect(settings.keyBinding('input.moveSouthEast')).toBe('KeyX');
  });

  it('swaps two actions when a binding is already occupied', () => {
    const { settings } = setup();
    const northWest = field(settings, 'input.moveNorthWest');

    settings.set(northWest, 'KeyE');

    expect(settings.keyBinding('input.moveNorthWest')).toBe('KeyE');
    expect(settings.keyBinding('input.moveNorthEast')).toBe('KeyW');
  });

  it('loads and persists a game-authored key binding', async () => {
    const { settings } = setup();
    await settings.ensureLoaded();
    const chronicle = field(settings, 'openChronicle');

    settings.set(chronicle, 'Digit2');

    expect(settings.gameSettings()['openChronicle']).toBe('Digit2');
    expect(localStorage.getItem('insulaire.settings.v1')).toContain('Digit2');
  });

  /**
   * The one application setting whose effect is visible without a device: the
   * shell zooms by `--ui-scale` (`app.css`), so the variable *is* the feature.
   */
  it('applies the interface scale to the document', () => {
    const { settings } = setup();
    TestBed.tick();

    expect(scaleVariable()).toBe('1');

    settings.commit(field(settings, ENGINE_SETTING.scale), 125);
    TestBed.tick();

    expect(scaleVariable()).toBe('1.25');
  });

  /**
   * A shell that zooms on every movement slides the slider out from under the
   * cursor. The value follows the hand; the zoom waits for it to come off.
   */
  it('applies the interface scale only once the slider is released', () => {
    const { settings } = setup();
    const scale = field(settings, ENGINE_SETTING.scale);
    TestBed.tick();

    settings.set(scale, 140);
    TestBed.tick();

    expect(settings.value(scale)).toBe(140);
    expect(scaleVariable()).toBe('1');

    settings.commit(scale, 140);
    TestBed.tick();

    expect(scaleVariable()).toBe('1.4');
  });

  /** A stored value outside the slider's bounds must not lock the player out. */
  it('keeps the interface scale inside the declared bounds', () => {
    localStorage.setItem('insulaire.settings.v1', JSON.stringify({ [ENGINE_SETTING.scale]: 900 }));
    const { settings } = setup();
    TestBed.tick();

    expect(settings.value(field(settings, ENGINE_SETTING.scale))).toBe(900);
    expect(scaleVariable()).toBe('1.5');
  });

  /**
   * Dropping the 16:10 window sizes (`engine-settings.schema.ts`) left values
   * behind in the stores of anyone who had picked one. A choice the declaration
   * no longer offers is not a choice: the picker would show the first option
   * while the shell applied nothing.
   */
  it('drops a stored choice the declaration no longer offers', () => {
    localStorage.setItem(
      'insulaire.settings.v1',
      JSON.stringify({ [ENGINE_SETTING.seedMode]: 'whatever-this-used-to-be' }),
    );
    const { settings } = setup();

    expect(settings.value(field(settings, ENGINE_SETTING.seedMode))).toBe('fixed');
    expect(settings.seed()).toBe(2026);
  });

  /**
   * A window is what makes "how big should it be" a question. A shell that ships
   * as a phone application (`tauri android build`) has none: it is fullscreen in
   * the orientation its manifest fixes, so both controls would do nothing —
   * while the interface scale, which only zooms the page, is offered everywhere.
   */
  it('offers the window controls only to a shell that has a window', () => {
    const windowed = setup(fakeShell(true)).settings;
    expect(shownIds(windowed)).toContain(ENGINE_SETTING.windowSize);
    expect(shownIds(windowed)).toContain(ENGINE_SETTING.fullscreen);
    expect(shownIds(windowed)).toContain(ENGINE_SETTING.scale);

    TestBed.resetTestingModule();
    const mobile = setup(fakeShell(false)).settings;
    expect(shownIds(mobile)).not.toContain(ENGINE_SETTING.windowSize);
    expect(shownIds(mobile)).not.toContain(ENGINE_SETTING.fullscreen);
    expect(shownIds(mobile)).toContain(ENGINE_SETTING.scale);
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
    settings.commit(field(settings, ENGINE_SETTING.scale), 125);

    settings.reset();

    expect(settings.value(field(settings, ENGINE_SETTING.music))).toBe(70);
    expect(settings.gameSettings()['difficulty']).toBe('normal');
    TestBed.tick();
    expect(scaleVariable()).toBe('1');
  });
});
