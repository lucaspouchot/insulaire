# ADR-0027 — Naming a Key Creates It; an Untranslated Key Is a Warning

## Status
Accepted

Amends ADR-0023 (*Every Displayed String Is a Key, Resolved per Language*),
which stands except where this decision says otherwise.

## Context

ADR-0023 made every displayed string a key and gave `validate_referenced_keys`
the job of catching typos: a key no language defines is an **error**. That was
the right rule for *shipping* content and the wrong one for *writing* it.

The order authoring actually happens in is: name the label, then write its text.
A settings field's `labelKey` is invented in the settings editor; its French and
English text is written in the language editor, on another screen, later — often
by another person. With an unknown key as an error, that order was forbidden:

- the settings editor could not write `settings.json` at all until the key had
  text, so it grew a special case — untranslated keys filtered out of the
  blocking issues, listed separately, with a hint pointing at the Languages tab.
  A rule that every caller has to work around is a rule in the wrong place;
- the title editor had no such workaround, so a new button's label made the file
  unsavable;
- worse, `loadProject` merges the title screen's key report, so a manifest with
  one untranslated button label **failed to load** — an authored game refusing
  to boot over a missing translation, when the resolution rule already says what
  to show: the key itself.

And the language editor did not close the loop. It wrote its files to disk and
stopped there. The engine holds the languages, every screen reads through it,
and merging is additive and refuses a key twice — so a saved key was on disk and
absent from the running editor. Adding `menu.title.credits`, saving, and coming
back to the Languages tab showed it gone. With an external content directory,
where the file cannot be re-fetched by rebuilding the app, that is simply a lost
edit.

Alternatives considered. **Keep the error and let each editor work around it**:
that is what was there, and it is three workarounds and a boot failure.
**Create keys with the key as their text** (`menu.title.credits` → "menu.title.credits"):
they would then look translated, and the missing-translation report — the thing
the language editor is built from — would never mention them again. **Reload the
whole project after a language save** (`resetContent` + re-register everything):
correct but violent; it throws away the editor's loaded worlds to change one
string.

## Decision

**Naming a key creates it.** Saving in the settings or title editor writes every
key that file references into every declared language, with an **empty** value,
and writes the locale files. A namespace the manifest does not declare yet gets
a file *and* a manifest entry, because a key written nowhere is a key lost on the
next load.

**An unknown key is a warning, not an error.** `locale.unknownKey` keeps its code
and its path; only its severity changes, so content that references it loads —
including through `loadProject`. An **empty** key stays an error
(`locale.missingKey`): it names nothing, and nothing is what it would render.

**An empty value is a gap, not a translation.** `LocaleBundle::with_fallback`
lets the default language fill a key another language holds empty, and
`locale(language)` lists it in `fallbacks` so an editor still shows the cell as
the gap it is. When no language has text for it, the key reaches the screen as
itself — ADR-0023's rule, unchanged, now also covering the created-but-unwritten
state.

**Saving a language re-registers it.** `resetLocales()` — new on the engine
facade and the WASM boundary — forgets every loaded language and keeps worlds,
tile sets, title screen, settings and project. The editor writes its files, then
clears and re-registers, so the running editor answers the text it just wrote
without a reload and without dropping the rest of the content.

**One service owns the authored text.** `LocaleAuthoringService` holds the
entries, creates keys, writes the files, patches the manifest and re-registers.
The language editor is a table over it; the title and settings editors create
keys through it. Editor-only, like everything that writes through the content
server (ADR-0022).

## Consequences

Positive:
- a label can be authored before its text exists, which is the order authoring
  happens in;
- a game with an untranslated label boots and shows the key, instead of refusing
  to load;
- a key saved in the language editor is a key the running editor has, external
  content directory included;
- the settings editor's special case is now the general rule, so the title editor
  gets the same behaviour for free;
- a new namespace is authored rather than hand-edited into `project.json`.

Negative:
- shipping content with an untranslated key is now a warning someone has to
  *read*. `validateLocales` and the editors' reports are where that is caught;
  nothing fails the build over it, and a release check is owed later;
- saving the settings or title editor can write locale files and `project.json`
  as a side effect — more files touched by one button than before, and the
  message says so;
- an empty value now means "not written yet" everywhere, so a language that
  genuinely wants a blank string cannot say it with `""`. No content needs that
  today; a game that does will need a spelling for it.

## Rule

Content names keys; the editor creates them, empty, in every language. An
untranslated key is a warning and renders as itself. A language save is not done
until the engine has the new text.
