/**
 * Tests for the ADR citation rules.
 *
 * Every broken citation below is a fixture, not a reference, which is why this
 * file declares itself exempt from the check it tests: @adr-fixtures
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { adrHeading, citations, readmeIndex, referenceProblems, unwrap } from './adr-references.mjs';

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A corpus of two decisions, indexed correctly, that nothing cites wrongly. */
function healthy() {
  return {
    sources: [],
    adrs: [
      { path: 'ADR-0001-first-decision.md', text: '# ADR-0001 — First Decision\n' },
      { path: 'ADR-0002-second-decision.md', text: '# ADR-0002 — Second Decision\n' },
    ],
    readme: [
      '## Architecture decisions',
      '',
      '- **ADR-0001** — First Decision',
      '- **ADR-0002** — Second Decision *(not implemented yet)*',
      '',
    ].join('\n'),
  };
}

test('a healthy corpus reports nothing', () => {
  assert.deepEqual(referenceProblems(healthy()), []);
});

test('unwrap rejoins a citation a comment wrapper broke', () => {
  const block = ' * (`docs/adr/ADR-0029-characters-are-composed-\n * sprites.md`)';
  assert.match(unwrap(block), /ADR-0029-characters-are-composed-sprites\.md/);

  const rust = '/// `docs/adr/ADR-0037-a-flat-map-is-drawn-from-\n/// flat-art.md`';
  assert.match(unwrap(rust), /ADR-0037-a-flat-map-is-drawn-from-flat-art\.md/);

  const script = '# see docs/adr/ADR-0012-shared-content-\n# validation.md';
  assert.match(unwrap(script), /ADR-0012-shared-content-validation\.md/);
});

test('unwrap leaves an unwrapped citation alone', () => {
  const line = '(`docs/adr/ADR-0024-character-definitions.md`)';
  assert.equal(unwrap(line), line);
});

test('citations classifies each shape it must tell apart', () => {
  assert.deepEqual(
    citations('see `docs/adr/ADR-0024-character-definitions.md`').map((c) => c.kind),
    ['path'],
  );
  assert.deepEqual(citations('as ADR-0033 decided.').map((c) => c.kind), ['number']);
  assert.deepEqual(
    citations('(ADR-0024..0034)').map((c) => c.text),
    ['ADR-0024', 'ADR-0034'],
  );
  assert.deepEqual(citations('ADR-0029-a-slug-that-').map((c) => c.kind), ['malformed']);
});

// The bug this module exists for: when 51 ADRs became 36, the citations that had
// wrapped kept pointing at files that no longer exist, and grep could not see
// them. This is that exact shape.
test('a stale path that wrapped across two comment lines is caught', () => {
  const corpus = healthy();
  const problems = referenceProblems({
    ...corpus,
    sources: [
      {
        path: 'apps/web/src/content/sprite-document.ts',
        text: ' * on a declared pixel canvas (`docs/adr/ADR-0029-characters-are-\n * composed-sprites.md`).',
      },
    ],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /sprite-document\.ts/);
  assert.match(problems[0], /ADR-0029-characters-are-composed-sprites\.md/);
  assert.match(problems[0], /does not exist/);
});

test('a bare number naming no decision is caught', () => {
  const problems = referenceProblems({
    ...healthy(),
    sources: [{ path: 'crates/world/src/tileset.rs', text: '/// the flat view of ADR-0037.' }],
  });
  assert.deepEqual(problems, [
    'crates/world/src/tileset.rs: mentions ADR-0037, which does not exist',
  ]);
});

test('a citation broken somewhere unexpected is reported, not skipped', () => {
  const problems = referenceProblems({
    ...healthy(),
    sources: [{ path: 'a.ts', text: '`docs/adr/ADR-0001-first-decision.m\nd`' }],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unreadable citation/);
});

test('the README index must match the corpus, both ways', () => {
  const missing = healthy();
  missing.readme = '- **ADR-0001** — First Decision\n';
  assert.deepEqual(referenceProblems(missing), [
    'README.md: ADR-0002 is missing from the index',
  ]);

  const ghost = healthy();
  ghost.readme += '- **ADR-0003** — A Decision Nobody Wrote\n';
  assert.deepEqual(referenceProblems(ghost), [
    'README.md: the index lists ADR-0003, which does not exist',
  ]);

  const renamed = healthy();
  renamed.readme = renamed.readme.replace('First Decision', 'A Renamed Decision');
  assert.equal(referenceProblems(renamed).length, 1);
  assert.match(referenceProblems(renamed)[0], /indexed as "A Renamed Decision"/);
});

test('an ADR whose heading disagrees with its filename is caught', () => {
  const renumbered = healthy();
  renumbered.adrs[0].text = '# ADR-0009 — First Decision\n';
  assert.ok(
    referenceProblems(renumbered).some((problem) => /heading says ADR-0009/.test(problem)),
  );
});

test('readmeIndex and adrHeading read the house format', () => {
  assert.equal(
    readmeIndex('- **ADR-0007** — Store Local Saves in IndexedDB *(not implemented yet)*').get(
      'ADR-0007',
    ),
    'Store Local Saves in IndexedDB',
  );
  assert.deepEqual(adrHeading('# ADR-0011 — Use Odd-R Offset Coordinates\n\n## Status'), {
    number: 'ADR-0011',
    title: 'Use Odd-R Offset Coordinates',
  });
});

test('this repository resolves every citation it makes', async () => {
  const { stdout } = await run('node', ['scripts/check-adr-references.mjs'], {
    cwd: repositoryRoot,
  });
  assert.match(stdout, /decision\(s\)/);
});
