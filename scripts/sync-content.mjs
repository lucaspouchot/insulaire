#!/usr/bin/env node
/**
 * Mirrors the content directory into `apps/web/public/content/` **for a build**.
 *
 * A build has no server: the delivered bundle and the desktop executable carry
 * their content as static files, so whatever is being shipped has to be copied
 * into the Angular workspace, which is the only place its builder accepts
 * assets from.
 *
 * Development does *not* go through here any more. `scripts/dev.mjs` proxies
 * `/content` straight to the directory being authored, so an uploaded image is
 * on screen without a rebuild and no stale copy can survive
 * (`docs/adr/ADR-0022-authoring-content-workspace.md`).
 *
 * Which directory is mirrored is `INSULAIRE_CONTENT_DIR`'s answer — the
 * repository fixture by default, an authoring workspace when `.env` names one.
 * The mirror is generated output: it is git-ignored, and stale files are
 * deleted on every run so a renamed world cannot linger in a build.
 */
import { cp, mkdir, rm, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { REPO_ROOT, contentDir, describeContentDir } from './content-dir.mjs';
import {
  TILE_ART_BUNDLE,
  TILE_ART_DIR,
  collectSprites,
  packSpriteBundle,
} from './sprite-bundle.mjs';

const dir = contentDir();
const target = join(REPO_ROOT, 'apps', 'web', 'public', 'content');

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(dir.path, target, { recursive: true });

// The build has no server to generate it on demand, so the bundle is written
// here, next to the files it carries and at the URL the dev server serves it
// from — the runtime asks for `/content/tile-art.bundle` and never learns which
// of the two answered (`docs/adr/ADR-0040-tile-art-travels-as-one-bundle.md`).
const sprites = await collectSprites(dir.path, TILE_ART_DIR);
const bundle = packSpriteBundle(sprites);
await writeFile(join(target, TILE_ART_BUNDLE), bundle);

const copied = await readdir(target, { recursive: true, withFileTypes: true });
const files = copied.filter((entry) => entry.isFile()).length;
console.log(`[sync-content] ${describeContentDir(dir)}`);
console.log(`[sync-content] mirrored ${files} file(s) into apps/web/public/content`);
console.log(
  `[sync-content] bundled ${sprites.length} tile sprite(s) into ${TILE_ART_BUNDLE}` +
    ` (${Math.round(bundle.byteLength / 1024)} kB)`,
);
