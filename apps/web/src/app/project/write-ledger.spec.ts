/**
 * What {@link WriteLedger} promises a save: it knows the difference between the
 * documents and the content directory.
 *
 * That difference is the whole feature. Authored content lives under version
 * control, so a save has to write the files that moved, leave the ones that did
 * not, and delete the ones whose map is gone — anything coarser buries the real
 * change in a diff of timestamps, or leaves a file behind that no manifest
 * names (`docs/adr/ADR-0019-authoring-content-workspace.md`).
 *
 * Driven through the real load path rather than by handing the ledger a
 * baseline: the baseline being the *directory* and not what a session happened
 * to hold is the property most worth defending here.
 */
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROJECT, contentFiles, fetchFrom, world } from './project-fixture';
import { ProjectManifest } from './project-manifest';
import { TileSetLibrary } from './tile-set-library';
import { WorldLibrary } from './world-library';
import { WriteLedger } from './write-ledger';
import { ProjectDefinition } from '../../content/generated/project';
import { WorldDocument } from '../../content/world-document';
import { ProjectStoreService } from '../services/project-store.service';

interface Held {
  readonly ledger: WriteLedger;
  readonly worlds: WorldLibrary;
  readonly tileSets: TileSetLibrary;
  readonly manifest: ProjectManifest;
}

async function open(project: ProjectDefinition = PROJECT): Promise<Held> {
  vi.stubGlobal('fetch', fetchFrom(contentFiles(project)));
  TestBed.configureTestingModule({});
  // `localStorage` from another test would be restored instead of the files.
  localStorage.clear();
  await TestBed.inject(ProjectStoreService).ensureLoaded();
  return {
    ledger: TestBed.inject(WriteLedger),
    worlds: TestBed.inject(WorldLibrary),
    tileSets: TestBed.inject(TileSetLibrary),
    manifest: TestBed.inject(ProjectManifest),
  };
}

describe('WriteLedger — what a save has to write', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('has nothing to write for a project just loaded', async () => {
    const { ledger } = await open();

    expect(ledger.changedWorldIds()).toEqual([]);
    expect(ledger.orphanedWorlds()).toEqual([]);
    expect(ledger.manifestNeedsWriting()).toBe(false);
    expect(ledger.hasUnwrittenChanges()).toBe(false);
    expect(ledger.dirty()).toBe(false);
  });

  it('does not call a map changed for having been serialised later', async () => {
    const { ledger, worlds } = await open();
    const first = worlds.currentDefinition().metadata?.updatedAt;

    // `toDefinition` stamps `updatedAt` on every call. If the baseline compared
    // raw output, the clock alone would make every save rewrite every file.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-03-04T05:06:07.000Z'));
    try {
      expect(worlds.currentDefinition().metadata?.updatedAt).not.toBe(first);
      expect(ledger.changedWorldIds()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names only the map that was painted', async () => {
    const { ledger, worlds } = await open();
    worlds.selectWorld('valley');
    worlds.requireDocument().paint({ col: 1, row: 1 }, 'water');
    ledger.touch();

    expect(ledger.changedWorldIds()).toEqual(['valley']);
    expect(ledger.worldNeedsWriting('valley')).toBe(true);
    expect(ledger.worldNeedsWriting('ridge')).toBe(false);
    expect(ledger.manifestNeedsWriting()).toBe(false);
  });

  it('forgets a map once its file has been written', async () => {
    const { ledger, worlds } = await open();
    worlds.selectWorld('valley');
    worlds.requireDocument().paint({ col: 1, row: 1 }, 'water');
    ledger.touch();
    ledger.markWorldWritten('valley');
    ledger.refreshDirty();

    expect(ledger.changedWorldIds()).toEqual([]);
    expect(ledger.dirty()).toBe(false);
  });

  it('keeps the dirty flag up while another map is still unwritten', async () => {
    const { ledger, worlds } = await open();
    for (const id of ['valley', 'ridge']) {
      worlds.selectWorld(id);
      worlds.requireDocument().paint({ col: 1, row: 1 }, 'water');
    }
    ledger.touch();
    ledger.markWorldWritten('valley');
    ledger.refreshDirty();

    expect(ledger.changedWorldIds()).toEqual(['ridge']);
    expect(ledger.dirty()).toBe(true);
  });

  it('raises the dirty flag for a manifest edit no document saw', async () => {
    // The counter the flag is derived from is the sum of both modules', so a
    // character declared with no map touched still owes the disk a write.
    const { ledger, manifest } = await open();

    expect(manifest.declareCharacter('goblin', 'characters/goblin.json')).toBe(true);
    expect(ledger.dirty()).toBe(true);
    expect(ledger.manifestNeedsWriting()).toBe(true);

    ledger.markManifestWritten();
    ledger.refreshDirty();
    expect(ledger.dirty()).toBe(false);
  });

  it('does not owe the disk anything for a tile set replaced under the maps', async () => {
    // The asset editor replaces a set and every map painting with it is rebuilt.
    // That changes what is *drawn*, not what the author wrote, so it must not
    // queue a write — least of all for a map nobody opened.
    const { ledger, tileSets, worlds } = await open();
    const replaced = structuredClone(tileSets.requireTileSetFor('terrain'));
    replaced.tiles[0].name = 'Meadow';

    tileSets.replaceTileSet(replaced);

    expect(worlds.documents().map((document) => document.id)).toEqual(['valley', 'ridge']);
    expect(worlds.activeWorldId()).toBe('valley');
    expect(ledger.changedWorldIds()).toEqual([]);
    expect(ledger.dirty()).toBe(false);
  });

  it('wants a new map written, and the manifest with it', async () => {
    const { ledger, worlds, tileSets } = await open();
    worlds.addWorld(
      WorldDocument.fromDefinition(world('north'), tileSets.requireTileSetFor('terrain')),
    );

    expect(ledger.changedWorldIds()).toEqual(['north']);
    expect(ledger.worldPath('north')).toBe('worlds/north.json');
    expect(ledger.manifestNeedsWriting()).toBe(true);
    expect(ledger.orphanedWorlds()).toEqual([]);
  });

  it('orphans the file of a removed map', async () => {
    const { ledger, worlds } = await open();

    expect(worlds.removeWorld('ridge')).toBe(true);
    expect(ledger.orphanedWorlds()).toEqual([{ id: 'ridge', path: 'worlds/ridge.json' }]);
    expect(ledger.changedWorldIds()).toEqual([]);
    expect(ledger.manifestNeedsWriting()).toBe(true);

    ledger.markWorldDeleted('ridge');
    expect(ledger.orphanedWorlds()).toEqual([]);
  });

  it('orphans the old file of a renamed map, and writes the new one', async () => {
    const { ledger, worlds } = await open();
    worlds.selectWorld('valley');

    expect(worlds.renameWorld('vale', 'Vale')).toBe(true);
    expect(ledger.changedWorldIds()).toEqual(['vale']);
    expect(ledger.orphanedWorlds()).toEqual([{ id: 'valley', path: 'worlds/valley.json' }]);
  });

  it('does not queue a deletion for a map renamed back to itself', async () => {
    const { ledger, worlds } = await open();
    worlds.selectWorld('valley');
    worlds.renameWorld('vale', 'Vale');
    worlds.renameWorld('valley', 'valley');

    expect(ledger.orphanedWorlds()).toEqual([]);
    // Renaming and back leaves the document as it was, timestamp aside.
    expect(ledger.changedWorldIds()).toEqual([]);
  });

  it('wants the manifest written when a project declares no zone', async () => {
    // A zone is mandatory in the model even where the file leaves it out
    // (`docs/adr/ADR-0018-map-zones.md`), so the first save materialises the
    // implicit default. It is a real change to the file, and it converges: the
    // save after it has nothing to write.
    const { zones: _zones, ...unzoned } = PROJECT;
    const { ledger } = await open(unzoned as ProjectDefinition);

    expect(ledger.manifestNeedsWriting()).toBe(true);
    expect(ledger.changedWorldIds()).toEqual([]);

    // A debt no edit caused: the counters see nothing, so only a look does.
    expect(ledger.dirty()).toBe(false);
    ledger.refreshDirty();
    expect(ledger.dirty()).toBe(true);

    ledger.markManifestWritten();
    expect(ledger.hasUnwrittenChanges()).toBe(false);
    ledger.refreshDirty();
    expect(ledger.dirty()).toBe(false);
  });

  it('wants the manifest written when a map moves to another zone', async () => {
    const { ledger, worlds, manifest } = await open();
    worlds.selectWorld('valley');
    manifest.setZones([...manifest.zones(), { id: 'north', name: 'North' }]);
    worlds.setZone('north');

    expect(ledger.manifestNeedsWriting()).toBe(true);
    // The zone lives in the map file too, so both have to be written.
    expect(ledger.changedWorldIds()).toEqual(['valley']);
  });
});
