#!/usr/bin/env node
/**
 * Collects what `tauri build` just produced into `deliveries/`.
 *
 * Run through `just deliver`, after the WASM engine and the editor-free web
 * build. Tauri writes its output deep under `apps/desktop/target/release/`, in
 * one folder per bundle format; this script gathers the installers and the raw
 * executable in one place, names them, and hashes them, so that "the thing to
 * send" is never a path someone has to remember
 * (`docs/adr/ADR-0020-desktop-executable.md`).
 *
 * The raw executable is collected on purpose, next to the installers: a Steam
 * depot takes the binary, not an installer, and the frontend and the engine are
 * embedded in it — so that single file is a complete build.
 *
 * Nothing is verified here beyond existence: the bundle contents are Tauri's
 * business, and what a client must not receive — the editor — is settled in the
 * web build the shell embeds (ADR-0018).
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(repoRoot, 'apps', 'desktop', 'target', 'release');
const bundleDir = join(releaseDir, 'bundle');
const deliveriesDir = join(repoRoot, 'deliveries');

/** Installer formats Tauri emits, one subfolder each. */
const INSTALLER_EXTENSIONS = new Set(['.deb', '.rpm', '.AppImage', '.msi', '.exe', '.dmg']);

/** Every installer under `bundle/`, whatever format this platform produced. */
async function findInstallers() {
  if (!existsSync(bundleDir)) return [];

  const entries = await readdir(bundleDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && INSTALLER_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .sort();
}

/** The unpackaged executable: a whole build in one file, and what Steam wants. */
function findExecutable() {
  for (const name of ['insulaire', 'insulaire.exe']) {
    const candidate = join(releaseDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

const installers = await findInstallers();
const executable = findExecutable();

if (installers.length === 0 && executable === null) {
  console.error(
    `[deliver] nothing built under ${releaseDir}. Run "just deliver", which builds it first.`,
  );
  process.exit(1);
}

await mkdir(deliveriesDir, { recursive: true });

for (const source of [...installers, ...(executable ? [executable] : [])]) {
  const name = source.split(/[\\/]/).pop();
  const target = join(deliveriesDir, name);
  await copyFile(source, target);
  const { size } = await stat(target);
  console.log(`[deliver] ${target}`);
  console.log(`[deliver]   ${(size / 1024 / 1024).toFixed(2)} MiB · sha256 ${await sha256(target)}`);
}

if (executable) {
  console.log('[deliver] the bare executable is a complete build: give it to a Steam depot as is');
}
