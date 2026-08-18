/**
 * The application ships every string in every language it claims.
 *
 * This is the guard rail behind the rule that no text is written where it is
 * displayed (`docs/adr/ADR-0023-localised-content-keys.md`): adding an English
 * key without its French counterpart, or leaving a placeholder behind in one of
 * the two, fails here rather than in front of a player.
 */
import { describe, expect, it } from 'vitest';

import { APP_DEFAULT_LANGUAGE, APP_LANGUAGES, APP_STRINGS, flattenStrings } from './app-strings';

const flat = Object.fromEntries(
  Object.entries(APP_STRINGS).map(([language, tree]) => [language, flattenStrings(tree)]),
);

/** `{name}` placeholders a text expects, sorted. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();
}

describe('application strings', () => {
  it('translates the languages it offers, and only those', () => {
    expect(Object.keys(APP_STRINGS).sort()).toEqual(APP_LANGUAGES.map((l) => l.id).sort());
    expect(APP_STRINGS[APP_DEFAULT_LANGUAGE]).toBeDefined();
  });

  it('defines exactly the same keys in every language', () => {
    const reference = Object.keys(flat[APP_DEFAULT_LANGUAGE] ?? {}).sort();
    expect(reference.length).toBeGreaterThan(50);

    for (const language of Object.keys(flat)) {
      expect(Object.keys(flat[language] ?? {}).sort(), `language ${language}`).toEqual(reference);
    }
  });

  it('never ships an empty string', () => {
    for (const [language, entries] of Object.entries(flat)) {
      for (const [key, value] of Object.entries(entries)) {
        expect(value.trim(), `${language}.${key}`).not.toBe('');
      }
    }
  });

  /**
   * A translation that drops `{count}` renders a sentence with a hole in it,
   * and one that invents `{total}` renders the placeholder verbatim.
   */
  it('uses the same placeholders in every language', () => {
    const reference = flat[APP_DEFAULT_LANGUAGE] ?? {};

    for (const [language, entries] of Object.entries(flat)) {
      for (const [key, value] of Object.entries(entries)) {
        expect(placeholders(value), `${language}.${key}`).toEqual(
          placeholders(reference[key] ?? ''),
        );
      }
    }
  });

  it('flattens nested trees the way a locale file is flattened', () => {
    expect(flattenStrings({ menu: { buttons: { newGame: 'Play' } } })).toEqual({
      'menu.buttons.newGame': 'Play',
    });
  });
});
