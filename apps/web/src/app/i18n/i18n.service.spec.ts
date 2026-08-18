/**
 * What {@link I18nService} promises every screen.
 *
 * The interesting cases are the ones that decide what a player actually reads:
 * which source wins, what happens to a key nobody defines, and whether the
 * screen follows a language change (`docs/adr/ADR-0023-localised-content-keys.md`).
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nService } from './i18n.service';
import { LocaleView } from '../../engine/engine.types';
import { EngineService } from '../services/engine.service';
import { LocaleFile } from '../services/project-store.service';

/** A stand-in engine: it records what it was given and answers bundles. */
class FakeEngine {
  readonly loaded: LocaleFile[] = [];
  bundles: Record<string, Record<string, string>> = {};

  loadLocale(language: string, namespace: string, json: string): void {
    this.loaded.push({ language, namespace, json });
  }

  locale(language: string): LocaleView {
    const entries = this.bundles[language];
    if (entries === undefined) {
      throw new Error(`no locale for ${language}`);
    }
    return { language, entries, fallbacks: [] };
  }
}

function setup(): { i18n: I18nService; engine: FakeEngine } {
  const engine = new FakeEngine();
  TestBed.configureTestingModule({ providers: [{ provide: EngineService, useValue: engine }] });
  return { i18n: TestBed.inject(I18nService), engine };
}

describe('I18nService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('answers the application’s own keys before any content is loaded', () => {
    const { i18n } = setup();
    i18n.use('en');

    expect(i18n.t('ui.app.nav.play')).toBe('Play');
    expect(i18n.has('ui.app.nav.play')).toBe(true);
  });

  it('replaces placeholders, and leaves unknown ones alone', () => {
    const { i18n } = setup();
    i18n.use('en');

    expect(i18n.t('ui.play.log.tick', { tick: 12 })).toBe('tick 12');
    expect(i18n.t('ui.play.overlay.hover', { col: 3, row: 9 })).toContain('[3, 9]');
    // A missing value is left visible rather than rendered as "undefined".
    expect(i18n.t('ui.play.log.tick', {})).toBe('tick {tick}');
  });

  /**
   * A key nobody defines shows itself. That is deliberate: a blank button in a
   * delivered game is worse than a visibly wrong one, and this is what the
   * validation report is there to prevent before shipping.
   */
  it('shows the key itself when nothing defines it', () => {
    const { i18n } = setup();
    expect(i18n.t('menu.buttons.newGame')).toBe('menu.buttons.newGame');
    expect(i18n.has('menu.buttons.newGame')).toBe(false);
  });

  it('lets content define new keys and override the application’s', () => {
    const { i18n, engine } = setup();
    engine.bundles = {
      en: { 'menu.buttons.newGame': 'New game', 'ui.app.nav.play': 'Adventure' },
    };

    i18n.adopt([], [{ id: 'en', name: 'English' }], 'en');
    i18n.use('en');

    expect(i18n.t('menu.buttons.newGame')).toBe('New game');
    expect(i18n.t('ui.app.nav.play')).toBe('Adventure');
  });

  it('registers every locale file with the engine, and again on demand', () => {
    const { i18n, engine } = setup();
    const files: LocaleFile[] = [
      { language: 'en', namespace: 'menu', json: '{}' },
      { language: 'fr', namespace: 'menu', json: '{}' },
    ];
    engine.bundles = { en: {}, fr: {} };

    i18n.adopt(files, [{ id: 'en', name: 'English' }], 'en');
    expect(engine.loaded).toHaveLength(2);

    // What a caller does after `resetContent()` wiped the registry.
    i18n.register();
    expect(engine.loaded).toHaveLength(4);
  });

  it('switches language, remembers it, and re-answers every key', () => {
    const { i18n } = setup();
    i18n.use('en');
    expect(i18n.t('ui.app.nav.play')).toBe('Play');

    i18n.use('fr');

    expect(i18n.t('ui.app.nav.play')).toBe('Jouer');
    expect(localStorage.getItem('insulaire.language.v1')).toBe('fr');
  });

  it('falls back to a language the project offers when the stored one is not', () => {
    const { i18n, engine } = setup();
    i18n.use('en');
    engine.bundles = { fr: { 'menu.play': 'Jouer' } };

    i18n.adopt([], [{ id: 'fr', name: 'Français' }], 'fr');

    expect(i18n.language()).toBe('fr');
    expect(i18n.languages().map((language) => language.id)).toEqual(['fr']);
  });

  it('survives a language the engine has no bundle for', () => {
    const { i18n, engine } = setup();
    const locale = vi.spyOn(engine, 'locale');
    engine.bundles = {};

    i18n.adopt([], [{ id: 'de', name: 'Deutsch' }], 'de');

    expect(locale).toHaveBeenCalledWith('de');
    // The chrome still answers; only the content keys are missing.
    expect(i18n.t('ui.common.apply')).not.toBe('');
  });
});
