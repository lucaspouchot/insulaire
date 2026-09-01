#!/usr/bin/env node
/**
 * Writes the TypeScript mirror of the content definitions.
 *
 * The shapes come from `ts-rs`, which derives them from the definition structs;
 * the bounds come from `crates/world/src/ts_export.rs`, which publishes them
 * with the values the compiler resolved. Both are produced by `cargo test`, into
 * a temporary directory this script points them at, so a bare `cargo test`
 * cannot leave half-written bindings in the working tree.
 *
 * With `--check` it writes nothing and fails if any module is stale, which is
 * what `npm run check:types` runs in the gate. See `scripts/content-types.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import prettier from 'prettier';

import { assembleModule, valuesByModule } from './content-types.mjs';

const root = new URL('..', import.meta.url);
const at = (path) => fileURLToPath(new URL(path, root));

/** Where the assembled modules live, relative to the repository root. */
const OUTPUT = 'apps/web/src/content/generated';

/** A generator that cannot run is a gate failure, not a stack trace. */
function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Renders both halves of the mirror into `directory`.
 *
 * `cargo` is the generator here, not this script: the export tests `ts-rs`
 * derives and the one `ts_export.rs` writes by hand are what produce the files.
 */
function render(directory) {
  execFileSync('cargo', ['test', '--package', 'insulaire-world', 'export_'], {
    cwd: at('.'),
    env: { ...process.env, TS_RS_EXPORT_DIR: directory },
    stdio: 'pipe',
  });
}

/** Every `.ts` file under `directory`, as paths relative to it. */
function modulesIn(directory, prefix = '') {
  const found = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...modulesIn(directory, path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found.sort();
}

const checking = process.argv.includes('--check');
const directory = mkdtempSync(join(tmpdir(), 'content-types-'));
let outputs;

try {
  render(directory);

  const values = valuesByModule(
    JSON.parse(readFileSync(join(directory, 'boundary-values.json'), 'utf8')),
  );

  const options = { ...(await prettier.resolveConfig(at(`${OUTPUT}/world.ts`))), parser: 'typescript' };
  outputs = [];
  for (const name of modulesIn(directory)) {
    const assembled = assembleModule(
      name,
      readFileSync(join(directory, name), 'utf8'),
      values.get(name) ?? [],
    );
    outputs.push({ path: `${OUTPUT}/${name}`, content: await prettier.format(assembled, options) });
  }

  const unplaced = [...values.keys()].filter((name) => !outputs.some((o) => o.path.endsWith(name)));
  if (unplaced.length > 0) {
    throw new Error(`these bounds name a module no type is exported to: ${unplaced.join(', ')}`);
  }
} catch (error) {
  fail(`The content types cannot be rendered: ${error.stderr?.toString() || error.message}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

/** Modules that exist on disk but no longer have a Rust item behind them. */
const orphans = (() => {
  try {
    return modulesIn(at(OUTPUT))
      .map((name) => `${OUTPUT}/${name}`)
      .filter((path) => !outputs.some((output) => output.path === path));
  } catch {
    return [];
  }
})();

const stale = [...orphans];
for (const output of outputs) {
  let current = null;
  try {
    current = readFileSync(at(output.path), 'utf8');
  } catch {
    /* a module that does not exist yet is stale */
  }
  if (current === output.content) continue;
  stale.push(output.path);
}

if (checking && stale.length > 0) {
  fail(
    `These copies of the content types are stale:\n\n  ${stale.join('\n  ')}\n\n` +
      'Run `node scripts/generate-content-types.mjs` and commit the result.',
  );
}

if (!checking) {
  for (const orphan of orphans) rmSync(at(orphan));
  for (const output of outputs) {
    mkdirSync(at(output.path).replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(at(output.path), output.content);
  }
}

const boundCount = outputs.reduce(
  (total, output) => total + (output.content.match(/^export const /gm)?.length ?? 0),
  0,
);
const typeCount = outputs.reduce(
  (total, output) => total + (output.content.match(/^export type /gm)?.length ?? 0),
  0,
);

console.log(
  checking
    ? `The content types are derived: ${typeCount} shapes and ${boundCount} bounds, ${outputs.length} modules in sync.`
    : stale.length === 0
      ? 'The content types were already up to date.'
      : `Rewrote ${stale.length} of ${outputs.length} content type modules:\n  ${stale.map((path) => relative(OUTPUT, path)).join('\n  ')}`,
);
