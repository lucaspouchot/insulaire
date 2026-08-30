/**
 * The rules that keep every ADR citation in this repository resolvable.
 *
 * Kept apart from the runner so they can be tested directly (`node --test`),
 * for the same reason `content-paths.mjs` is: the whole value of this check is
 * that it catches what `grep` cannot, and "it seemed to pass on my tree" is not
 * evidence of that.
 *
 * `.claude/rules/specs.md` requires decisions to be cited by path "so the
 * reference stays greppable and can be checked to still resolve", and
 * `.claude/commands/create-adr.md` requires that check after folding one ADR
 * into another. Neither was enforceable: a citation wrapped across two comment
 * lines is invisible to a line-oriented search, so when 51 ADRs were
 * consolidated into 36 at 0.25.0, every citation that had wrapped kept pointing
 * at a file that no longer exists.
 *
 * Examples in this file spell the number `NNNN`, the placeholder
 * `.claude/commands/create-adr.md` uses, so that documenting a broken citation
 * does not create one.
 *
 * {@link unwrap} is the whole trick. Everything else is bookkeeping.
 */

/** Directory holding the corpus, relative to the repository root. */
export const ADR_DIRECTORY = 'docs/adr';

/**
 * A hyphen at end of line, the newline, and whatever comment marker opens the
 * next one — `*` in a block comment, `///` or `//` in Rust and TypeScript, `#`
 * in a script or YAML.
 */
const CONTINUATION = /-[ \t]*\r?\n[ \t]*(?:\/\/\/?|\*|#)?[ \t]*/g;

/**
 * Rejoins citations broken across lines by a comment wrapper.
 *
 * A path that wrapped reads `ADR-NNNN-characters-are-composed-` on one line and
 * `sprites.md` on the next. Joining at the hyphen makes it one token again.
 *
 * Ordinary hyphenated prose rejoins too — `top-\n * down` becomes `top-down` —
 * which is harmless, because the result is only ever searched for citations.
 */
export function unwrap(text) {
  return text.replace(CONTINUATION, '-');
}

const CITATION = /ADR-(\d{4})(\.\.(\d{4}))?([-A-Za-z0-9.]*)/g;

/**
 * Every ADR citation in `text`, already unwrapped, classified by shape.
 *
 * - `path` — `ADR-NNNN-a-decision.md`, the form the rules require.
 * - `number` — a bare `ADR-NNNN`, which still has to name a real decision.
 * - `range` — `ADR-NNNN..NNNN`, which `docs/architecture.md` uses to point at a
 *   run of decisions; both ends have to name one.
 * - `malformed` — anything else, which in practice means a citation that
 *   wrapped somewhere this rejoiner did not expect. Reported rather than
 *   ignored: a silent miss here is the defect this whole module exists for.
 */
export function citations(text) {
  const found = [];
  for (const match of unwrap(text).matchAll(CITATION)) {
    const number = `ADR-${match[1]}`;
    if (match[3] !== undefined) {
      found.push({ kind: 'number', number, text: number });
      found.push({ kind: 'number', number: `ADR-${match[3]}`, text: `ADR-${match[3]}` });
      continue;
    }
    let tail = match[4];
    if (!tail.endsWith('.md')) {
      tail = tail.replace(/\.+$/, '');
    }
    if (tail === '') {
      found.push({ kind: 'number', number, text: number });
    } else if (/^-[a-z0-9-]+\.md$/.test(tail)) {
      found.push({ kind: 'path', number, text: `${number}${tail}` });
    } else {
      found.push({ kind: 'malformed', number, text: `${number}${tail}` });
    }
  }
  return found;
}

const INDEX_ENTRY = /^-\s+\*\*ADR-(\d{4})\*\*\s+—\s+(.+?)\s*$/gm;
const INDEX_ANNOTATION = /\s*\*\([^)]*\)\*\s*$/;

/** The **Architecture decisions** list in `README.md`, by number. */
export function readmeIndex(readme) {
  const entries = new Map();
  for (const match of readme.matchAll(INDEX_ENTRY)) {
    entries.set(`ADR-${match[1]}`, match[2].replace(INDEX_ANNOTATION, '').trim());
  }
  return entries;
}

const HEADING = /^#\s+(ADR-\d{4})\s+—\s+(.+?)\s*$/m;

/** The number and title an ADR file declares in its own heading. */
export function adrHeading(text) {
  const match = HEADING.exec(text);
  return match === null ? null : { number: match[1], title: match[2] };
}

/**
 * Every way the corpus and its citations can disagree, as messages.
 *
 * `sources` is `[{ path, text }]` for the files that may cite an ADR; `adrs` is
 * the same for the corpus itself; `readme` is the root README's text.
 */
export function referenceProblems({ sources, adrs, readme }) {
  const problems = [];

  const numbers = new Set();
  const names = new Set();
  const titles = new Map();
  for (const adr of adrs) {
    names.add(adr.path);
    const heading = adrHeading(adr.text);
    if (heading === null) {
      problems.push(`${ADR_DIRECTORY}/${adr.path}: no "# ADR-NNNN — Title" heading`);
      continue;
    }
    if (!adr.path.startsWith(`${heading.number}-`)) {
      problems.push(`${ADR_DIRECTORY}/${adr.path}: heading says ${heading.number}`);
    }
    numbers.add(heading.number);
    titles.set(heading.number, heading.title);
  }

  for (const source of sources) {
    for (const citation of citations(source.text)) {
      if (citation.kind === 'malformed') {
        problems.push(`${source.path}: unreadable citation "${citation.text}"`);
      } else if (citation.kind === 'path' && !names.has(citation.text)) {
        problems.push(`${source.path}: cites ${citation.text}, which does not exist`);
      } else if (citation.kind === 'number' && !numbers.has(citation.number)) {
        problems.push(`${source.path}: mentions ${citation.number}, which does not exist`);
      }
    }
  }

  // `create-adr` calls the README list "the index, and it is the only one", so a
  // missing entry and a ghost entry are both defects.
  const index = readmeIndex(readme);
  for (const number of numbers) {
    if (!index.has(number)) {
      problems.push(`README.md: ${number} is missing from the index`);
    } else if (index.get(number) !== titles.get(number)) {
      problems.push(
        `README.md: ${number} is indexed as "${index.get(number)}", ` +
          `the ADR says "${titles.get(number)}"`,
      );
    }
  }
  for (const number of index.keys()) {
    if (!numbers.has(number)) {
      problems.push(`README.md: the index lists ${number}, which does not exist`);
    }
  }

  return problems;
}
