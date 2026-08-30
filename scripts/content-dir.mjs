#!/usr/bin/env node
/**
 * Resolves **which content directory this run works on**.
 *
 * There are two of them, and confusing them is the failure this module exists
 * to prevent:
 *
 * - `content/` at the repository root is the **fixture**: the minimum valid
 *   project that proves the engine works. The Rust tests, the web tests and the
 *   smoke harness all read it, so it must never move under them.
 * - the **workspace** is where an actual game is authored — a directory outside
 *   this repository, named by `INSULAIRE_CONTENT_DIR` in `.env`. The dev server
 *   serves it and the editor writes into it
 *   (`docs/adr/ADR-0019-authoring-content-workspace.md`).
 *
 * `.env` is parsed here rather than with `process.loadEnvFile`, which would
 * overwrite variables the caller set — see {@link loadEnvOnce}. A missing
 * `.env` is normal: the fixture is then the workspace, which is exactly what a
 * fresh checkout wants.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The fixture: the minimum valid project the test suites run against. */
export const FIXTURE_CONTENT_DIR = resolve(REPO_ROOT, 'content');

/** Name of the variable that points at an authoring workspace. */
export const CONTENT_DIR_VAR = 'INSULAIRE_CONTENT_DIR';

let envLoaded = false;

/**
 * Loads `.env` from the repository root, once, **without overriding** the
 * environment the process was started with.
 *
 * The environment has to win: the smoke harness pins the fixture by setting
 * `INSULAIRE_CONTENT_DIR` on the dev server it spawns, and a transcript
 * compared byte for byte against a baseline must never depend on whichever game
 * the developer happens to be authoring
 * (`docs/adr/ADR-0019-authoring-content-workspace.md`).
 *
 * Node's own `process.loadEnvFile` overwrites what is already set, which is the
 * opposite of that — so the file is parsed here instead. The format is the
 * common subset: `KEY=value`, `#` comments, optional quotes.
 */
function loadEnvOnce() {
  if (envLoaded) {
    return;
  }
  envLoaded = true;
  const envFile = resolve(REPO_ROOT, '.env');
  if (!existsSync(envFile)) {
    return;
  }
  try {
    for (const [key, value] of parseEnv(readFileSync(envFile, 'utf8'))) {
      process.env[key] ??= value;
    }
  } catch (cause) {
    console.warn(`[content-dir] could not read .env: ${cause.message}`);
  }
}

/**
 * Parses `.env` text into key/value pairs.
 *
 * Exported for the tests: this is small enough to write and small enough to get
 * wrong.
 */
export function parseEnv(text) {
  const pairs = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().replace(/^export\s+/, '');
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    pairs.push([key, value]);
  }
  return pairs;
}

/**
 * The content directory this run must use.
 *
 * A relative `INSULAIRE_CONTENT_DIR` resolves against the repository root, not
 * the current working directory, so the value means the same thing whether it
 * is read from `apps/web` or from the root.
 *
 * @returns {{ path: string, source: 'fixture' | 'workspace', declared: string | null }}
 * @throws when the declared directory does not exist — a typo there would
 *   otherwise show up much later as an empty game.
 */
export function contentDir() {
  loadEnvOnce();
  const declared = process.env[CONTENT_DIR_VAR]?.trim();
  if (!declared) {
    return { path: FIXTURE_CONTENT_DIR, source: 'fixture', declared: null };
  }

  const path = isAbsolute(declared) ? resolve(declared) : resolve(REPO_ROOT, declared);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(
      `${CONTENT_DIR_VAR} points at "${declared}" (${path}), which is not a directory. ` +
        'Fix it in .env, or remove the variable to work on the repository fixture.',
    );
  }

  return {
    path,
    source: path === FIXTURE_CONTENT_DIR ? 'fixture' : 'workspace',
    declared,
  };
}

/** One line naming the directory in use, for a server or script banner. */
export function describeContentDir(dir = contentDir()) {
  return dir.source === 'fixture'
    ? `content: repository fixture (${dir.path})`
    : `content: workspace ${dir.path} (${CONTENT_DIR_VAR})`;
}
