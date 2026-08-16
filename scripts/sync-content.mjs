#!/usr/bin/env node
/**
 * Mirrors `content/` into `apps/web/public/content/`.
 *
 * The canonical authored content lives at the repository root so it is easy to
 * find, diff and validate with `cargo test`. The Angular builder only accepts
 * asset paths inside its own workspace root, so the files are mirrored rather
 * than referenced.
 *
 * The mirror is generated output: it is git-ignored, and stale files are
 * deleted on every run so a renamed world cannot linger in a build. Both
 * `npm start` and `npm run build` run this first, so it cannot be forgotten.
 */
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repoRoot, 'content');
const target = join(repoRoot, 'apps', 'web', 'public', 'content');

if (!existsSync(source)) {
  console.error(`[sync-content] missing source directory: ${source}`);
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

const copied = await readdir(target, { recursive: true, withFileTypes: true });
const files = copied.filter((entry) => entry.isFile()).length;
console.log(`[sync-content] mirrored ${files} file(s) into apps/web/public/content`);
