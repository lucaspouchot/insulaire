import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DELIVER_REPLACEMENTS,
  editorOnlyReached,
  importsOf,
  reachableFrom,
  resolveSpecifier,
} from './client-graph.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A tree in memory, so the rules are tested rather than this repository. */
function reader(files) {
  return (path) => files[path] ?? null;
}

test('finds static, dynamic, re-exported and side-effect imports', () => {
  const source = [
    "import { A } from './a';",
    "import type { B } from '../b';",
    "export { C } from './c';",
    "const lazy = () => import('./d');",
    "import './e.css';",
    "import { Component } from '@angular/core';",
  ].join('\n');

  assert.deepEqual(importsOf(source).sort(), [
    '../b',
    './a',
    './c',
    './d',
    './e.css',
    '@angular/core',
  ]);
});

test('finds an import written across several lines', () => {
  const source = 'import {\n  A,\n  B,\n} from "./wide";\n';

  assert.deepEqual(importsOf(source), ['./wide']);
});

test('resolves a specifier against the file that wrote it', () => {
  assert.equal(resolveSpecifier('src/app/x.ts', './y'), 'src/app/y');
  assert.equal(resolveSpecifier('src/app/features/x.ts', '../../core/y'), 'src/core/y');
  assert.equal(resolveSpecifier('src/app/x.ts', '@angular/core'), null);
});

test('walks the whole graph from the entry', () => {
  const read = reader({
    'src/main.ts': "import './app/app';",
    'src/app/app.ts': "import { play } from '../play';",
    'src/play.ts': 'export const play = 1;',
  });

  assert.deepEqual([...reachableFrom('src/main.ts', read, {})].sort(), [
    'src/app/app.ts',
    'src/main.ts',
    'src/play.ts',
  ]);
});

test('follows the file the deliver build swaps in, not the one it swaps out', () => {
  const read = reader({
    'src/main.ts': "import './app/app.routes';",
    'src/app/app.routes.ts': "import '../app/editing/draft-set';",
    'src/app/app.routes.deliver.ts': "import '../play';",
    'src/app/editing/draft-set.ts': 'export const draft = 1;',
    'src/play.ts': 'export const play = 1;',
  });

  assert.deepEqual(editorOnlyReached('src/main.ts', read), []);
  // And the swap is what does it: without one, the editor is reachable.
  assert.deepEqual(editorOnlyReached('src/main.ts', read, {}), ['src/app/editing/draft-set.ts']);
});

test('names every editor-only file a client build would reach', () => {
  const read = reader({
    'src/main.ts': "import './app/app.routes';",
    'src/app/app.routes.deliver.ts': "import '../play';",
    'src/app/app.routes.ts': '',
    'src/play.ts': "import { freeId } from './app/editing/ids';",
    'src/app/editing/ids.ts': "import { d } from './draft-set';",
    'src/app/editing/draft-set.ts': 'export const d = 1;',
  });

  assert.deepEqual(editorOnlyReached('src/main.ts', read), [
    'src/app/editing/draft-set.ts',
    'src/app/editing/ids.ts',
  ]);
});

test('skips a specifier that names nothing rather than failing on it', () => {
  const read = reader({ 'src/main.ts': "import './gone';\nimport './here';", 'src/here.ts': '' });

  assert.deepEqual([...reachableFrom('src/main.ts', read, {})].sort(), [
    'src/here.ts',
    'src/main.ts',
  ]);
});

test('survives a cycle', () => {
  const read = reader({ 'src/a.ts': "import './b';", 'src/b.ts': "import './a';" });

  assert.deepEqual([...reachableFrom('src/a.ts', read, {})].sort(), ['src/a.ts', 'src/b.ts']);
});

test('the declared replacements are the ones angular.json actually makes', () => {
  // Read rather than restated: a swap added to the build configuration and not
  // here would leave this check walking a graph the client build does not have.
  const workspace = JSON.parse(
    readFileSync(join(repoRoot, 'apps', 'web', 'angular.json'), 'utf8'),
  );
  const declared = Object.fromEntries(
    workspace.projects.web.architect.build.configurations.deliver.fileReplacements.map(
      (replacement) => [replacement.replace, replacement.with],
    ),
  );

  assert.deepEqual(DELIVER_REPLACEMENTS, declared);
});
