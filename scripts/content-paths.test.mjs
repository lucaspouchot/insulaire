/**
 * The content server's path rules, tested directly.
 *
 * Run by `npm run test:scripts` (Node's built-in test runner, no dependency).
 * Everything here is a rejection the server must keep making: an authoring tool
 * that writes files is only as safe as this function.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contentTypeOf, extensionOf, safeContentPath } from './content-paths.mjs';

const ROOT = '/tmp/insulaire-content';

test('a plain content path resolves inside the root', () => {
  const result = safeContentPath(ROOT, 'worlds/demo_world.json');
  assert.equal(result.ok, true);
  assert.equal(result.path, `${ROOT}/worlds/demo_world.json`);
  assert.equal(result.relative, 'worlds/demo_world.json');
});

test('a leading slash is tolerated and stripped', () => {
  const result = safeContentPath(ROOT, '/assets/images/logo.png');
  assert.equal(result.ok, true);
  assert.equal(result.path, `${ROOT}/assets/images/logo.png`);
});

test('a path that looks absolute still lands inside the root', () => {
  // The leading slash is URL punctuation, not a filesystem root: what matters
  // is that the file opened is under the content directory, and it is.
  const result = safeContentPath(ROOT, '/etc/passwd.json');
  assert.equal(result.ok, true);
  assert.equal(result.path, `${ROOT}/etc/passwd.json`);
});

test('parent segments are refused, encoded or not', () => {
  for (const attempt of ['../secrets.json', 'worlds/../../secrets.json', '%2e%2e/secrets.json']) {
    const result = safeContentPath(ROOT, attempt);
    assert.equal(result.ok, false, `expected "${attempt}" to be refused`);
  }
});

test('Windows-style paths are refused', () => {
  for (const attempt of ['C:/windows/file.json', 'worlds\\demo.json', '\\\\server\\share\\a.json']) {
    const result = safeContentPath(ROOT, attempt);
    assert.equal(result.ok, false, `expected "${attempt}" to be refused`);
  }
});

test('a null byte is refused', () => {
  assert.equal(safeContentPath(ROOT, 'worlds/demo%00.json').ok, false);
});

test('an extension outside the allowed list is refused', () => {
  for (const attempt of ['script.sh', 'notes', 'engine.wasm', 'archive.zip']) {
    const result = safeContentPath(ROOT, attempt);
    assert.equal(result.ok, false, `expected "${attempt}" to be refused`);
  }
});

test('an empty path is refused', () => {
  assert.equal(safeContentPath(ROOT, '').ok, false);
  assert.equal(safeContentPath(ROOT, '/').ok, false);
});

test('extensions and MIME types are matched case-insensitively', () => {
  assert.equal(extensionOf('assets/Logo.PNG'), '.png');
  assert.equal(contentTypeOf('assets/Logo.PNG'), 'image/png');
  assert.equal(contentTypeOf('assets/theme.ogg'), 'audio/ogg');
  assert.equal(contentTypeOf('.hidden'), null);
  assert.equal(contentTypeOf('README'), null);
});
