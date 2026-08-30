/**
 * Resolves a static asset against the document's base URL.
 *
 * The dev build is served from the site root, but a delivered bundle is a
 * folder someone unzips wherever they like — under `/games/insulaire/`, on a
 * file share, behind a reverse proxy. Absolute paths like `/content/...` break
 * in every one of those cases, and paths relative to the *current route*
 * (`/editor/map`) break in the dev build.
 *
 * `document.baseURI` is the one anchor that is right in both: Angular writes
 * `<base href>` into `index.html`, and the `deliver` configuration sets it to
 * `./` (`docs/adr/ADR-0015-client-delivery-build.md`).
 */
export function assetUrl(path: string): string {
  const base = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI;
  return new URL(path.replace(/^\/+/, ''), base).toString();
}
