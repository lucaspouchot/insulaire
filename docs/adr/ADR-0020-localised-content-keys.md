# ADR-0020 — Every Displayed String Is a Key, Resolved per Language

## Status
Accepted

## Context

Every string on screen used to be written where it was displayed: labels in
templates, messages built with template literals, tab titles in a registry. That
is fine for one language and one audience, and this project has neither — the
game is authored in French, the code and its documentation are in English, and a
delivered client has to speak both plus whatever a game adds.

Retrofitting translation is expensive not for its mechanism but for its
*sweep*: every literal has to be found, named and moved. Doing it before the
title screen, the settings screen and the editors that author them is the
difference between one sweep and four.

Three questions had to be answered together.

**Where does the text live?** All in the application, and a game cannot rename a
button without a code change; all in content, and the editor is blank until a
project loads — with no application to open a project with.

**Who resolves a missing translation?** If each host implements its own
fallback, one key renders two ways, which is the class of bug the shared Rust
validator exists to prevent (ADR-0012).

**When does a key come into existence?** Authoring names a label first and
writes its text later, usually on another screen and often by another person.
Treating an unknown key as a load error forbids that order, and it did: the
settings editor grew a special case to work around it, the title editor had none
and could not save a new button, and a manifest with one untranslated label
refused to boot.

Alternatives considered. **Angular's `$localize`** compiles one bundle per
locale and resolves at build time: it cannot express content translations,
cannot switch language without reloading, and would put the game's text in the
application's catalogue. **A translation library** solves the application half
and leaves content, validation and the editor's language screen unanswered.
**Creating a key with its own name as its text** would make it look translated
and drop it out of the missing-translation report forever.

## Decision

**No string is written where it is displayed.** A template names a key; a
component logging an event stores a key and its values, not a sentence. This
covers document titles, tooltips, ARIA labels and the event log.

**A key is a path.** Locale files are nested objects of strings, and the
manifest gives each file a namespace which prefixes its keys:

```json
// content/locales/fr/menu.json, registered as `menu`
{ "title": { "buttons": { "newGame": "Nouvelle partie" } } }
//        →  menu.title.buttons.newGame
```

**Two sources, one lookup, in this order:** the project's locale files, then the
application's strings for the language in use, then the application's strings
for its default language. The chrome answers before any content has loaded, and
content can override any `ui.*` key — which is how a game renames "Play".

**The engine owns the language rules.** `LocaleBundle` flattens and merges in
Rust, `loadLocale` refuses a key defined twice rather than letting load order
decide, and `locale(language)` returns the bundle with the default language
already filling the gaps and says which keys were filled. No host implements a
fallback of its own.

**Naming a key creates it.** Saving in the settings or title editor writes every
key that file references into every declared language with an **empty** value.
A namespace the manifest does not declare yet gets a file *and* a manifest
entry, because a key written nowhere is a key lost on the next load.

**Severity follows what an author can fix.** A declared language with no file is
an error. An **unknown** key is a warning (`locale.unknownKey`) so content
referencing it still loads, and it renders as itself — a blank button in a
delivered game is worse than a wrong one. An **empty** key is an error
(`locale.missingKey`): it names nothing. An empty *value* in one language is a
gap the default language fills, reported in `fallbacks` so an editor shows the
cell as the gap it is.

**Saving a language re-registers it.** `resetLocales()` forgets every loaded
language and keeps worlds, tile sets, title screen, settings and project, so the
running editor answers the text it just wrote without a reload. One service,
`LocaleAuthoringService`, holds the entries, creates the keys, writes the files,
patches the manifest and re-registers — editor-only, like everything that writes
through the content server (ADR-0019).

## Consequences

Positive:
- adding a language is content: files, a manifest entry, no code;
- a label can be authored before its text exists, which is the order authoring
  happens in, and a game with an untranslated label boots;
- the same key resolves identically everywhere, because resolution is Rust's;
- the editor lists, compares and fills translations from a real report;
- a key saved in the language editor is a key the running editor has, external
  content directory included.

Negative:
- every screen reads through a lookup, so a key typo shows on screen instead of
  failing to compile;
- the translate pipe is impure and runs on every change detection cycle;
- two places define text, and "which one wins" is a rule someone has to know;
- shipping content with an untranslated key is a warning someone has to *read* —
  nothing fails a build over it, and a release check is owed;
- saving the settings or title editor can write locale files and `project.json`
  as a side effect;
- an empty value means "not written yet" everywhere, so a language that wants a
  genuinely blank string cannot say it with `""`;
- pluralisation and gendered forms are **not** handled — placeholders are simple
  `{name}` substitutions, and a game needing plural rules will need this revised.

## Rule

Text that reaches a screen is a key. The application's keys live under `ui.` in
`app-strings.ts` and ship in every language the application claims; everything
the *game* says is content under `content/locales/<language>/<namespace>.json`.
Content names keys, the editor creates them empty in every language, and an
untranslated key is a warning that renders as itself.
