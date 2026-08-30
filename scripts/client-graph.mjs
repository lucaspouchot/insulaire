/**
 * Which source files a client build can actually reach.
 *
 * The client build is the dev build with two files swapped
 * (`docs/adr/ADR-0015-client-delivery-build.md`): `app.routes.deliver.ts` omits
 * the editor, and `build-features.deliver.ts` turns its features off. Whether
 * something *ships* is therefore a question about the import graph from
 * `main.ts`, and this answers it.
 *
 * Why a graph rather than a grep of the emitted chunks: `verify-client-build`
 * already greps for two component selectors, and that works because a selector
 * is a string literal minification cannot rename. A module of pure functions —
 * `app/editing/draft-set.ts` — leaves no such literal behind. Grepping for one
 * would mean planting a marker string in every editor-only file and hoping
 * nobody tree-shakes it, which is a check that reports success for the wrong
 * reason. The graph has no blind spot and needs no markers.
 *
 * Kept apart from the runner so it can be tested directly (`node --test`), the
 * same split `adr-references.mjs` and `content-paths.mjs` use.
 */

/** The swaps the `deliver` configuration makes, as `angular.json` declares them. */
export const DELIVER_REPLACEMENTS = Object.freeze({
  'src/app/app.routes.ts': 'src/app/app.routes.deliver.ts',
  'src/app/build-features.ts': 'src/app/build-features.deliver.ts',
});

/**
 * Directories only the editor may reach.
 *
 * `app/editing/` is the editing session and everything behind it. A client
 * plays a game; it never holds a draft of one — the directory table in
 * `docs/adr/ADR-0015-client-delivery-build.md` is what this enforces.
 */
export const EDITOR_ONLY = Object.freeze(['src/app/editing/']);

/** Static, re-export and dynamic specifiers, in that order. */
const SPECIFIERS = [
  /^\s*import\s[^'"]*?from\s*['"]([^'"]+)['"]/gm,
  /^\s*export\s[^'"]*?from\s*['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
];

/** The specifiers one file imports, in source order, duplicates included. */
export function importsOf(source) {
  const found = [];
  for (const pattern of SPECIFIERS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) {
        found.push(match[1]);
      }
    }
  }
  return found;
}

/**
 * A relative specifier resolved against the file that wrote it.
 *
 * `null` for a package specifier — `@angular/core`, `rxjs` — which is not this
 * repository's source and not what is being checked.
 */
export function resolveSpecifier(fromPath, specifier) {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const parts = fromPath.split('/').slice(0, -1);
  for (const step of specifier.split('/')) {
    if (step === '.' || step === '') {
      continue;
    }
    if (step === '..') {
      parts.pop();
    } else {
      parts.push(step);
    }
  }
  return parts.join('/');
}

/** The candidate files a resolved specifier may name, best first. */
function candidates(base) {
  if (/\.(ts|mts|js|mjs|json|css|html)$/.test(base)) {
    return [base];
  }
  return [`${base}.ts`, `${base}/index.ts`];
}

/**
 * Every source file reachable from `entry`, as repo-relative paths.
 *
 * @param {string} entry the build's browser entry point
 * @param {(path: string) => string | null} read file contents, or `null` when
 *   the path names nothing — a missing file is skipped, because a specifier
 *   this resolver cannot follow is not evidence that the editor shipped
 * @param {Record<string, string>} replacements the build's file swaps
 */
export function reachableFrom(entry, read, replacements = DELIVER_REPLACEMENTS) {
  const swap = (path) => replacements[path] ?? path;
  const seen = new Set();
  const queue = [swap(entry)];

  while (queue.length > 0) {
    const path = queue.pop();
    if (path === undefined || seen.has(path)) {
      continue;
    }
    const source = read(path);
    if (source === null) {
      continue;
    }
    seen.add(path);
    for (const specifier of importsOf(source)) {
      const base = resolveSpecifier(path, specifier);
      if (base === null) {
        continue;
      }
      for (const candidate of candidates(base)) {
        if (read(candidate) !== null) {
          queue.push(swap(candidate));
          break;
        }
      }
    }
  }
  return seen;
}

/**
 * The editor-only files a client build reaches, sorted. Empty is the pass.
 *
 * @returns {string[]}
 */
export function editorOnlyReached(entry, read, replacements = DELIVER_REPLACEMENTS) {
  return [...reachableFrom(entry, read, replacements)]
    .filter((path) => EDITOR_ONLY.some((directory) => path.startsWith(directory)))
    .sort();
}
