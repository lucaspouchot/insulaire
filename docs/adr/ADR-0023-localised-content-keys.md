# ADR-0023 — Every Displayed String Is a Key, Resolved per Language

## Status
Accepted

## Context

Until now every string on screen was written where it was displayed: labels in
templates, messages built with template literals in components, tab titles in
`editor-modules.ts`. That is fine for one language and one audience, and the
project has neither. The game is authored in French, the code and its
documentation are in English, and a delivered client has to be able to speak
both — plus whatever a game adds later.

Retrofitting translation is the expensive kind of change, because the cost is
not the mechanism but the *sweep*: every literal has to be found, named and
moved. Doing it before the title screen, the settings screen and the editors
that author them is the difference between one sweep and four.

Two questions had to be answered together.

**Where does the text live?** Putting it all in the application means a game
cannot rename a single button without a code change; putting it all in content
means the editor is blank until a project loads, and there is no application to
open a project *with*.

**Who resolves a missing translation?** If each host — the browser app today,
whatever else tomorrow — implements its own fallback, the same key can render
differently in two places, which is exactly the class of bug the shared Rust
validator exists to prevent (ADR-0015).

Alternatives considered. **Angular's built-in i18n** (`$localize`) compiles one
bundle per locale and resolves at build time: it cannot express *content*
translations, cannot switch language at runtime without reloading, and would put
the game's text in the application's message catalogue. **A translation library**
(`transloco`, `ngx-translate`) solves the application half well and still leaves
content, validation and the editor's language screen unanswered — the part that
actually matters here.

## Decision

**No string is written where it is displayed.** A template names a key; a
component logging an event stores a key and its values, not a sentence. This is
a rule about all displayed text, including document titles, tooltips, ARIA
labels and the event log.

**A key is a path.** Locale files are plain nested objects of strings, and the
manifest gives each file a **namespace** which prefixes its keys:

```json
// content/locales/fr/menu.json, registered as `menu`
{ "title": { "buttons": { "newGame": "Nouvelle partie" } } }
//        →  menu.title.buttons.newGame
```

Nested, because that is how a translator reads a file and how a diff stays
legible; several files per language, because one file per game does not survive
a scenario.

**Two sources, one lookup, in this order:** the project's locale files, then the
application's own strings for the language in use, then the application's
strings for its default language. So the *chrome* answers before any content has
loaded — the editor opens on an empty project — and content can override any
`ui.*` key, which is how a game renames "Play" without touching the source.

**The engine owns the language rules.** `LocaleBundle` flattens and merges files
in Rust; `loadLocale` refuses a key defined twice rather than letting load order
decide; `locale(language)` returns the bundle with the default language already
filling the gaps, and says which keys were filled. The application looks keys up
in what it is given and implements no fallback of its own.

**A language a project declares must load.** `validate_locales` runs inside
`loadProject`, and a declared language with no file is an **error**, exactly as
an unlisted world is. A *missing translation* is a warning: the default language
stands in, so a player never sees a raw key — but the report says so, and it is
what the editor's language screen will be built from.

**A key nobody defines renders as itself.** Visible on purpose: a blank button
in a delivered game is worse than a wrong one, and `validate_referenced_keys`
gives content a way to fail before shipping.

## Consequences

Positive:
- adding a language is content: files, a manifest entry, no code;
- the application ships English and French for its own chrome and cannot lose
  one of them — a spec fails when the two disagree on keys or placeholders;
- the same key resolves identically everywhere, because the resolution is Rust's;
- the editor can list, compare and fill translations from a real report rather
  than from a grep;
- the title screen and settings screens can be authored in any language from the
  day they exist.

Negative:
- every screen now reads through a lookup, and a key typo shows up as a key on
  screen instead of failing to compile;
- the translate pipe is impure, so it runs on every change detection cycle —
  cheap, but not free, and worth remembering in a large list;
- two places define text (application strings and content), and "which one wins"
  is a rule someone has to know;
- `loadProject` now depends on the locale files being registered first, which is
  one more ordering constraint for every host;
- pluralisation and gendered forms are **not** handled. Placeholders are simple
  `{name}` substitutions. A game needing plural rules will need this ADR revised.

## Rule

Text that reaches a screen is a key. The application's keys live under `ui.` in
`app-strings.ts` and ship in every language the application claims; everything
the *game* says is content under `content/locales/<language>/<namespace>.json`.
