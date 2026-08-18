/**
 * Which content directory a run works on, and where that answer comes from.
 *
 * The one that matters: an environment variable set by a caller — the smoke
 * harness pinning the fixture — must beat `.env`, or a transcript compared
 * against a baseline would silently run on whichever game the developer is
 * authoring (`docs/adr/ADR-0022-authoring-content-workspace.md`).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseEnv } from './content-dir.mjs';

test('it parses the common .env subset', () => {
  const parsed = parseEnv([
    '# a comment',
    '',
    'INSULAIRE_CONTENT_DIR=/games/one/content',
    'QUOTED="/games/two/content"',
    "SINGLE='/games/three/content'",
    'export EXPORTED=/games/four/content',
    'no-separator-here',
  ].join('\n'));

  assert.deepEqual(parsed, [
    ['INSULAIRE_CONTENT_DIR', '/games/one/content'],
    ['QUOTED', '/games/two/content'],
    ['SINGLE', '/games/three/content'],
    ['EXPORTED', '/games/four/content'],
  ]);
});

test('an empty value is kept, so a variable can be blanked', () => {
  assert.deepEqual(parseEnv('INSULAIRE_CONTENT_DIR='), [['INSULAIRE_CONTENT_DIR', '']]);
});
