#!/usr/bin/env node
/**
 * Writes the four copies of the engine seam from `crates/engine/seam.json`.
 *
 * With `--check` it writes nothing and fails if any copy is stale, which is
 * what `npm run check:seam` runs in the gate. See `scripts/seam.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SEAM_PATH,
  loadSeam,
  renderJsonEngine,
  renderMethodTable,
  renderRawEngineInterface,
  renderWasmBindings,
  unwiredMethods,
} from './seam.mjs';

const root = new URL('..', import.meta.url);
const at = (path) => fileURLToPath(new URL(path, root));

/** Runs the output through rustfmt, so the gate's formatter has nothing to say. */
function rustfmt(source) {
  const directory = mkdtempSync(join(tmpdir(), 'seam-'));
  const file = join(directory, 'generated.rs');
  try {
    writeFileSync(file, source);
    // rustfmt walks into `mod x;`, so give the declared children somewhere to be.
    for (const [, child] of source.matchAll(/^mod (\w+);$/gm)) {
      writeFileSync(join(directory, `${child}.rs`), '');
    }
    execFileSync('rustfmt', ['--edition', '2021', file], { stdio: 'pipe' });
    return readFileSync(file, 'utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Replaces the region between two markers, keeping the authored text around it. */
function splice(document, { open, close }, replacement) {
  const from = document.indexOf(open);
  const to = document.indexOf(close);
  if (from === -1 || to === -1) throw new Error(`missing ${open} … ${close} markers`);
  return `${document.slice(0, from + open.length)}\n${replacement}\n${document.slice(to)}`;
}

const TS_MARKERS = { open: '// <generated:seam>', close: '// </generated:seam>' };
const MD_MARKERS = { open: '<!-- generated:seam -->', close: '<!-- /generated:seam -->' };

/** A declaration the targets cannot render is a gate failure, not a stack trace. */
function fail(message) {
  console.error(message);
  process.exit(1);
}

let seam;
let outputs;
try {
  seam = loadSeam(JSON.parse(readFileSync(fileURLToPath(SEAM_PATH), 'utf8')));

  // The `###` sections `docs/wasm-api.md` authors by hand, which the table links to.
  const reference = readFileSync(at('docs/wasm-api.md'), 'utf8');
  const headings = reference
    .split('\n')
    .filter((line) => line.startsWith('### `'))
    .map((line) => line.slice(4));

  outputs = [
    { path: 'crates/engine/src/json.rs', content: rustfmt(renderJsonEngine(seam)) },
    { path: 'crates/wasm/src/lib.rs', content: rustfmt(renderWasmBindings(seam)) },
    {
      path: 'apps/web/src/engine/engine.types.ts',
      content: splice(
        readFileSync(at('apps/web/src/engine/engine.types.ts'), 'utf8'),
        TS_MARKERS,
        renderRawEngineInterface(seam),
      ),
    },
    {
      path: 'docs/wasm-api.md',
      content: splice(reference, MD_MARKERS, renderMethodTable(seam, headings)),
    },
  ];
} catch (error) {
  fail(`The engine seam cannot be rendered: ${error.message}`);
}

const checking = process.argv.includes('--check');
const stale = [];
for (const output of outputs) {
  const current = readFileSync(at(output.path), 'utf8');
  if (current === output.content) continue;
  stale.push(output.path);
  if (!checking) writeFileSync(at(output.path), output.content);
}

if (checking && stale.length > 0) {
  fail(
    `These copies of the engine seam are stale:\n\n  ${stale.join('\n  ')}\n\n` +
      'Run `node scripts/generate-seam.mjs` and commit the result.',
  );
}

// The fifth copy is hand-written, so it is checked rather than rendered — and
// only in `--check`. `EngineService` cannot call a method before this generator
// has declared it on `RawInsulaireEngine`, so refusing to write until the
// service is wired would deadlock the workflow `docs/wasm-api.md` documents.
if (checking) {
  const unwired = unwiredMethods(
    seam,
    readFileSync(at('apps/web/src/app/services/engine.service.ts'), 'utf8'),
  );
  if (unwired.length > 0) {
    fail(
      `These seam methods never reach Angular:\n\n  ${unwired.join('\n  ')}\n\n` +
        'Wire them into EngineService, or drop them from the declaration.',
    );
  }
}

console.log(
  checking
    ? `The engine seam is declared once: ${seam.methods.length} methods, 4 copies in sync, all wired.`
    : stale.length === 0
      ? 'The engine seam was already up to date.'
      : `Rewrote ${stale.length} copies of the engine seam:\n  ${stale.join('\n  ')}`,
);
