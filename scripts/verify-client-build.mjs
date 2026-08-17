#!/usr/bin/env node
/**
 * Checks that the web bundle the desktop shell embeds is what a client should
 * receive: complete, and free of the editor.
 *
 * Run through `just deliver`, after `tauri build` has produced both the bundle
 * (through `beforeBuildCommand`) and the executable around it. The bundle is
 * embedded in that executable verbatim, so verifying the folder verifies what
 * ships — a bundle that still contains the editor, or that is missing its engine
 * or its content, is a defect the client must never see
 * (`docs/adr/ADR-0018-client-delivery-build.md`).
 *
 * This check is the reason the packaging step survived the move from a zip to
 * an executable (ADR-0020): the shell changed, the thing to prove did not.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(repoRoot, 'apps', 'web', 'dist', 'web', 'browser');

/** Without these, the game cannot start at all. */
const REQUIRED = ['index.html', join('wasm', 'insulaire_engine_bg.wasm'), join('content', 'project.json')];

/**
 * Component selectors that exist only in the editor. The editor is reached from
 * one file (`app.routes.deliver.ts` omits it), so finding one of these in an
 * emitted chunk means the file replacement did not happen.
 */
const EDITOR_SELECTORS = ['app-map-editor-page', 'app-editor-shell'];

if (!existsSync(buildDir)) {
  console.error(`[verify] no client build at ${buildDir}. Run "just deliver", which builds it.`);
  process.exit(1);
}

const problems = [];

for (const required of REQUIRED) {
  if (!existsSync(join(buildDir, required))) {
    problems.push(`missing ${required}`);
  }
}

const entries = await readdir(buildDir, { recursive: true, withFileTypes: true });
const scripts = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => relative(buildDir, join(entry.parentPath ?? entry.path, entry.name)));

for (const script of scripts) {
  const text = await readFile(join(buildDir, script), 'utf8');
  const found = EDITOR_SELECTORS.filter((selector) => text.includes(selector));
  if (found.length > 0) {
    problems.push(`editor code (${found.join(', ')}) found in ${script}`);
  }
}

if (problems.length > 0) {
  console.error('[verify] the build is not deliverable:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(`[verify] ${scripts.length} script(s) checked: no editor, engine and content present`);
