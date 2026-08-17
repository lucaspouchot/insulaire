#!/usr/bin/env node
/**
 * Bumps the project's version everywhere it is written down.
 *
 *   node .claude/skills/commit-and-push/scripts/bump-version.mjs <patch|minor>
 *   node .claude/skills/commit-and-push/scripts/bump-version.mjs --show
 *   node .claude/skills/commit-and-push/scripts/bump-version.mjs minor --dry-run
 *
 * The version lives in nine places across seven files — two Cargo workspaces,
 * two lockfiles, the npm package and its lock, and the Tauri manifest. Bumping
 * them by hand drifts, and a drifted `[workspace.package] version` against the
 * `version = "…"` pins on the path dependencies stops `cargo` resolving the
 * workspace at all. So this script is the only supported way to do it, and it
 * refuses to run when the sites do not already agree.
 *
 * Major bumps are deliberately not supported: they are the author's call
 * (`CLAUDE.md`, "Versioning"), and before 1.0 there is nothing to major-bump to.
 *
 * Exit codes: 0 bumped (or shown) · 1 the sites disagree, or bad usage.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Every place the version is written, as a read/replace pair.
 *
 * `read` returns what the file currently claims; `replace` returns the file's
 * new text. Both are deliberately narrow — a blanket search for the version
 * string would also rewrite a dependency that happens to sit on 0.1.0.
 */
const SITES = [
  {
    file: 'package.json',
    what: 'npm package',
    read: (text) => JSON.parse(text).version,
    replace: (text, from, to) => text.replace(`"version": "${from}"`, `"version": "${to}"`),
  },
  {
    file: 'package-lock.json',
    what: 'npm lockfile (root and packages."")',
    read: (text) => JSON.parse(text).version,
    replace: (text, from, to) => {
      const lock = JSON.parse(text);
      lock.version = to;
      if (lock.packages?.['']) {
        lock.packages[''].version = to;
      }
      // Two-space indent and a trailing newline is what npm itself writes.
      return `${JSON.stringify(lock, null, 2)}\n`;
    },
  },
  {
    file: 'Cargo.toml',
    what: 'workspace package version and the path-dependency pins',
    read: (text) => /^version = "([^"]+)"$/m.exec(text)?.[1],
    replace: (text, from, to) =>
      text
        .replace(`version = "${from}"`, `version = "${to}"`)
        .replaceAll(`, version = "${from}" }`, `, version = "${to}" }`),
  },
  {
    file: 'Cargo.lock',
    what: 'workspace members',
    read: (text) => memberVersion(text, 'insulaire-engine'),
    replace: (text, from, to) => bumpLockMembers(text, from, to),
  },
  {
    file: 'apps/desktop/Cargo.toml',
    what: 'desktop shell',
    read: (text) => /^version = "([^"]+)"$/m.exec(text)?.[1],
    replace: (text, from, to) => text.replace(`version = "${from}"`, `version = "${to}"`),
  },
  {
    file: 'apps/desktop/Cargo.lock',
    what: 'desktop shell lockfile',
    read: (text) => memberVersion(text, 'insulaire-desktop'),
    replace: (text, from, to) => bumpLockMembers(text, from, to),
  },
  {
    file: 'apps/desktop/tauri.conf.json',
    what: 'Tauri manifest (the installer’s version)',
    read: (text) => JSON.parse(text).version,
    replace: (text, from, to) => text.replace(`"version": "${from}"`, `"version": "${to}"`),
  },
];

/** The version recorded for a `[[package]]` in a Cargo lockfile. */
function memberVersion(text, name) {
  return new RegExp(`name = "${name}"\\nversion = "([^"]+)"`).exec(text)?.[1];
}

/** Bumps every `insulaire-*` entry of a Cargo lockfile, leaving registry crates alone. */
function bumpLockMembers(text, from, to) {
  return text.replaceAll(
    new RegExp(`(name = "insulaire-[a-z-]+"\\nversion = )"${from}"`, 'g'),
    `$1"${to}"`,
  );
}

function next(version, part) {
  const parsed = SEMVER.exec(version);
  if (parsed === null) {
    fail(`"${version}" is not a plain major.minor.patch version.`);
  }
  const [, major, minor, patch] = parsed.map(Number);
  return part === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

function fail(message) {
  console.error(`bump-version: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const show = args.includes('--show');
const part = args.find((arg) => arg === 'patch' || arg === 'minor');

if (!show && part === undefined) {
  fail('usage: bump-version.mjs <patch|minor> [--dry-run]   (or --show)');
}

// Read every site first: a disagreement means an earlier bump was done by hand
// and stopped halfway, and bumping on top of that would bury the mismatch.
const found = SITES.map((site) => {
  const path = join(ROOT, site.file);
  const text = readFileSync(path, 'utf8');
  const version = site.read(text);
  if (version === undefined) {
    fail(`could not find a version in ${site.file} — has its layout changed?`);
  }
  return { ...site, path, text, version };
});

const current = found[0].version;
const drifted = found.filter((site) => site.version !== current);
if (drifted.length > 0) {
  console.error(`bump-version: the version sites disagree (package.json says ${current}):`);
  for (const site of drifted) {
    console.error(`  ${site.file}: ${site.version}`);
  }
  fail('align them by hand first, then bump.');
}

if (show) {
  console.log(current);
  process.exit(0);
}

const target = next(current, part);
console.log(`${current} -> ${target} (${part})`);

for (const site of found) {
  const updated = site.replace(site.text, current, target);
  if (updated === site.text) {
    fail(`${site.file} was left unchanged — its layout no longer matches this script.`);
  }
  if (site.read(updated) !== target) {
    fail(`${site.file} still reports ${site.read(updated)} after the rewrite.`);
  }
  if (!dryRun) {
    writeFileSync(site.path, updated);
  }
  console.log(`  ${dryRun ? 'would write' : 'wrote'} ${relative(ROOT, site.path)} — ${site.what}`);
}

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
}
