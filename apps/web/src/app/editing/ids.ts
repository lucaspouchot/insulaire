/**
 * Proposing an id nothing has taken — the two jobs that shared one name.
 *
 * Ids are stable and names are not: renaming a tile must never repoint a map
 * (`docs/adr/ADR-0006-assets-tilesets.md`), so nothing here is ever used to
 * *change* an id. It only proposes one when something is created.
 *
 * There were two `freeId`s, and a caller who knew one did not know the other:
 * one appended `_2` to whatever it was handed, the other slugified first. Both
 * behaviours are wanted — a duplicate button starts from an id that is already
 * an id, a "new tile" dialog starts from what an author typed — so they keep
 * both, under two names. {@link slugId} is {@link freeId} with the slugifying
 * step in front of it.
 *
 * In `app/editing/` because only the editor creates content; the client build
 * never reaches this file (`docs/adr/ADR-0015-client-delivery-build.md`).
 */

/** `<stem>`, `<stem>_2`, … — the first one nobody is using. */
export function freeId(stem: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(stem)) {
    return stem;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem}_${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * A free id derived from something a human typed.
 *
 * The slug is what a content file may carry — `isUsableId` in
 * `tile-editor.types.ts` is the same alphabet — and `fallback` is what a name
 * made entirely of punctuation collapses to.
 */
export function slugId(name: string, taken: Iterable<string>, fallback: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || fallback;
  return freeId(slug, taken);
}
