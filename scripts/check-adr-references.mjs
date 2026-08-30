#!/usr/bin/env node
/**
 * Checks that every ADR citation in the repository still resolves.
 *
 * Run by `npm run check`. The rules live in `adr-references.mjs`; this walks
 * the tree and reports.
 *
 * **What is skipped, and why.** Generated output — the WASM package, the Angular
 * build, `target/` — carries Rust doc comments captured before the last
 * renumbering and regenerates on the next build, so a stale citation there is
 * noise rather than a defect. `.scratch/` is skipped too: the issue tracker
 * records defects verbatim, including the broken citations a ticket exists to
 * fix, and a check that forbade quoting them would forbid describing them
 * (`docs/agents/issue-tracker.md`).
 *
 * One file needs a narrower exemption: the checker's own test has to hold
 * broken citations, because that is what it asserts against. A file declaring
 * the marker below is skipped, and every run names the files it skipped — an
 * exemption that hides is an exemption that rots.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADR_DIRECTORY, referenceProblems } from './adr-references.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKIPPED = [
  '.git',
  '.scratch',
  '.smoke',
  'node_modules',
  'target',
  join('apps', 'desktop', 'gen'),
  join('apps', 'web', 'dist'),
  join('apps', 'web', 'public', 'wasm'),
  join('apps', 'web', '.angular'),
];

const READ = new Set(['.ts', '.rs', '.md', '.mjs', '.js', '.json', '.html', '.toml']);

/** Declared by a file whose ADR citations are fixtures rather than references. */
const FIXTURES = ['@adr', 'fixtures'].join('-');

async function sourceFiles(directory) {
  const found = [];
  const entries = await readdir(join(repositoryRoot, directory || '.'), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const path = directory ? join(directory, entry.name) : entry.name;
    if (SKIPPED.some((skipped) => path === skipped || path.startsWith(skipped + sep))) {
      continue;
    }
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(path)));
    } else if (READ.has(path.slice(path.lastIndexOf('.')))) {
      found.push(path);
    }
  }
  return found;
}

async function read(paths) {
  return Promise.all(
    paths.map(async (path) => ({
      path,
      text: await readFile(join(repositoryRoot, path), 'utf8'),
    })),
  );
}

const paths = await sourceFiles('');
const everything = await read(paths);
const exempt = everything.filter((file) => file.text.includes(FIXTURES));
const sources = everything.filter((file) => !file.text.includes(FIXTURES));
const adrPaths = paths.filter((path) => path.startsWith(ADR_DIRECTORY + sep));
const adrs = (await read(adrPaths)).map((adr) => ({
  path: relative(ADR_DIRECTORY, adr.path),
  text: adr.text,
}));
const readme = await readFile(join(repositoryRoot, 'README.md'), 'utf8');

const problems = referenceProblems({ sources, adrs, readme });

if (problems.length > 0) {
  console.error('[adr] citations that do not resolve:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

const skipped = exempt.length === 0 ? '' : `, ${exempt.map((file) => file.path).join(', ')} exempt`;
console.log(
  `[adr] ${sources.length} file(s) checked against ${adrs.length} decision(s)${skipped}`,
);
