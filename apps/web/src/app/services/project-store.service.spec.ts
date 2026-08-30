/**
 * What {@link ProjectStoreService} promises a save: it knows the difference
 * between the documents and the content directory.
 *
 * That difference is the whole feature. Authored content lives under version
 * control, so a save has to write the files that moved, leave the ones that did
 * not, and delete the ones whose map is gone — anything coarser buries the real
 * change in a diff of timestamps, or leaves a file behind that no manifest
 * names (`docs/adr/ADR-0019-authoring-content-workspace.md`).
 */
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectStoreService } from './project-store.service';
import { ProjectDefinition, TileSetDefinition, WorldDefinition } from '../../content/content-types';
import { WorldDocument } from '../../content/world-document';

const TILE_SET: TileSetDefinition = {
  id: 'terrain',
  schemaVersion: 1,
  name: 'Terrain',
  tiles: [
    {
      id: 'grass',
      name: 'Grass',
      terrain: 'grass',
      movementCost: 1,
      visual: { visualId: 'terrain.grass', fallbackColor: '#4a7c3f' },
    },
    {
      id: 'water',
      name: 'Water',
      terrain: 'water',
      movementCost: 0,
      visual: { visualId: 'terrain.water', fallbackColor: '#2f6f9f' },
    },
  ],
};

function world(id: string): WorldDefinition {
  return {
    id,
    schemaVersion: 1,
    name: id,
    width: 4,
    height: 4,
    orientation: 'pointy',
    tileSetId: 'terrain',
    defaultTile: 'grass',
    tiles: [],
    entities: [{ id: 'p', templateId: 'player', at: [0, 0] }],
    locations: [],
    links: [],
    metadata: { updatedAt: '2026-01-01T00:00:00.000Z' },
  };
}

const PROJECT: ProjectDefinition = {
  id: 'p',
  schemaVersion: 1,
  name: 'P',
  startWorld: 'valley',
  zones: [{ id: 'valley', name: 'Valley' }],
  tileSets: [{ id: 'terrain', path: 'tilesets/terrain.json' }],
  worlds: [
    { id: 'valley', path: 'worlds/valley.json' },
    { id: 'ridge', path: 'worlds/ridge.json' },
  ],
};

/** Serves the manifest, the tile set and two maps, as the dev server would. */
function serveContent(project: ProjectDefinition): void {
  const files = new Map<string, unknown>([
    ['content/project.json', project],
    ['content/tilesets/terrain.json', TILE_SET],
    ['content/worlds/valley.json', world('valley')],
    ['content/worlds/ridge.json', world('ridge')],
  ]);

  vi.stubGlobal('fetch', (input: string) => {
    // `assetUrl` resolves against the document base, so what arrives here is
    // absolute; the path is the part these fixtures are keyed by.
    const url = new URL(String(input), 'http://localhost/').pathname.replace(/^\/+/, '');
    const body = files.get(url);
    return Promise.resolve(
      body === undefined
        ? new Response('missing', { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 }),
    );
  });
}

async function open(project: ProjectDefinition = PROJECT): Promise<ProjectStoreService> {
  serveContent(project);
  TestBed.configureTestingModule({});
  const store = TestBed.inject(ProjectStoreService);
  // `localStorage` from another test would be restored instead of the files.
  localStorage.clear();
  await store.ensureLoaded();
  return store;
}

describe('ProjectStoreService — what a save has to write', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('has nothing to write for a project just loaded', async () => {
    const store = await open();

    expect(store.changedWorldIds()).toEqual([]);
    expect(store.orphanedWorlds()).toEqual([]);
    expect(store.manifestNeedsWriting()).toBe(false);
    expect(store.hasUnwrittenChanges()).toBe(false);
  });

  it('does not call a map changed for having been serialised later', async () => {
    const store = await open();
    const first = store.currentDefinition().metadata?.updatedAt;

    // `toDefinition` stamps `updatedAt` on every call. If the baseline compared
    // raw output, the clock alone would make every save rewrite every file.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-03-04T05:06:07.000Z'));
    try {
      expect(store.currentDefinition().metadata?.updatedAt).not.toBe(first);
      expect(store.changedWorldIds()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names only the map that was painted', async () => {
    const store = await open();
    store.selectWorld('valley');
    store.requireDocument().paint({ col: 1, row: 1 }, 'water');
    store.touch();

    expect(store.changedWorldIds()).toEqual(['valley']);
    expect(store.worldNeedsWriting('valley')).toBe(true);
    expect(store.worldNeedsWriting('ridge')).toBe(false);
    expect(store.manifestNeedsWriting()).toBe(false);
  });

  it('forgets a map once its file has been written', async () => {
    const store = await open();
    store.selectWorld('valley');
    store.requireDocument().paint({ col: 1, row: 1 }, 'water');
    store.touch();
    store.markWorldWritten('valley');
    store.refreshDirty();

    expect(store.changedWorldIds()).toEqual([]);
    expect(store.dirty()).toBe(false);
  });

  it('keeps the dirty flag up while another map is still unwritten', async () => {
    const store = await open();
    for (const id of ['valley', 'ridge']) {
      store.selectWorld(id);
      store.requireDocument().paint({ col: 1, row: 1 }, 'water');
    }
    store.touch();
    store.markWorldWritten('valley');
    store.refreshDirty();

    expect(store.changedWorldIds()).toEqual(['ridge']);
    expect(store.dirty()).toBe(true);
  });

  it('wants a new map written, and the manifest with it', async () => {
    const store = await open();
    store.addWorld(
      WorldDocument.fromDefinition(world('north'), store.requireTileSetFor('terrain')),
    );

    expect(store.changedWorldIds()).toEqual(['north']);
    expect(store.worldPath('north')).toBe('worlds/north.json');
    expect(store.manifestNeedsWriting()).toBe(true);
    expect(store.orphanedWorlds()).toEqual([]);
  });

  it('orphans the file of a removed map', async () => {
    const store = await open();

    expect(store.removeWorld('ridge')).toBe(true);
    expect(store.orphanedWorlds()).toEqual([{ id: 'ridge', path: 'worlds/ridge.json' }]);
    expect(store.changedWorldIds()).toEqual([]);
    expect(store.manifestNeedsWriting()).toBe(true);

    store.markWorldDeleted('ridge');
    expect(store.orphanedWorlds()).toEqual([]);
  });

  it('orphans the old file of a renamed map, and writes the new one', async () => {
    const store = await open();
    store.selectWorld('valley');

    expect(store.renameWorld('vale', 'Vale')).toBe(true);
    expect(store.changedWorldIds()).toEqual(['vale']);
    expect(store.orphanedWorlds()).toEqual([{ id: 'valley', path: 'worlds/valley.json' }]);
  });

  it('does not queue a deletion for a map renamed back to itself', async () => {
    const store = await open();
    store.selectWorld('valley');
    store.renameWorld('vale', 'Vale');
    store.renameWorld('valley', 'valley');

    expect(store.orphanedWorlds()).toEqual([]);
    // Renaming and back leaves the document as it was, timestamp aside.
    expect(store.changedWorldIds()).toEqual([]);
  });

  it('wants the manifest written when a project declares no zone', async () => {
    // A zone is mandatory in the model even where the file leaves it out
    // (`docs/adr/ADR-0018-map-zones.md`), so the first save materialises the
    // implicit default. It is a real change to the file, and it converges: the
    // save after it has nothing to write.
    const { zones: _zones, ...unzoned } = PROJECT;
    const store = await open(unzoned as ProjectDefinition);

    expect(store.manifestNeedsWriting()).toBe(true);
    expect(store.changedWorldIds()).toEqual([]);

    store.markManifestWritten();
    expect(store.hasUnwrittenChanges()).toBe(false);
  });

  it('wants the manifest written when a map moves to another zone', async () => {
    const store = await open();
    store.selectWorld('valley');
    store.addZone('north', 'North');
    store.setZone('north');

    expect(store.manifestNeedsWriting()).toBe(true);
    // The zone lives in the map file too, so both have to be written.
    expect(store.changedWorldIds()).toEqual(['valley']);
  });
});

/**
 * The content directory is the project (`docs/adr/ADR-0019-authoring-content-
 * workspace.md`). Browser storage carries a session's work in progress, and a
 * session that outlived a hand-edit must not hide what was written by hand — nor
 * arrive at the next save ready to overwrite it.
 */
describe('ProjectStoreService — the files win over the stored session', () => {
  /** What the editor left in `localStorage` before the directory was edited. */
  function store(project: ProjectDefinition, worlds: readonly WorldDefinition[]): void {
    localStorage.setItem(
      'insulaire.editor.project.v1',
      JSON.stringify({ project, worlds, activeWorldId: project.startWorld }),
    );
  }

  /** `open()` without the `localStorage.clear()`, so a session survives. */
  async function reopen(project: ProjectDefinition): Promise<ProjectStoreService> {
    serveContent(project);
    TestBed.configureTestingModule({});
    const service = TestBed.inject(ProjectStoreService);
    await service.ensureLoaded();
    return service;
  }

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('shows a character declared in the file by hand since the last session', async () => {
    const declared: ProjectDefinition = {
      ...PROJECT,
      characters: [{ id: 'human_player', path: 'characters/human_player.json' }],
    };
    store(PROJECT, [world('valley'), world('ridge')]);

    const service = await reopen(declared);

    expect(service.project()?.characters).toEqual([
      { id: 'human_player', path: 'characters/human_player.json' },
    ]);
    // And the file it came from is not owed a write: it already says this.
    expect(service.manifestNeedsWriting()).toBe(false);
  });

  it('keeps what the session declared and has not written yet', async () => {
    const session: ProjectDefinition = {
      ...PROJECT,
      characters: [{ id: 'goblin', path: 'characters/goblin.json' }],
    };
    store(session, [world('valley'), world('ridge')]);

    const service = await reopen(PROJECT);

    // Nothing on disk declares it, so it survives on the strength of the
    // session alone — and the manifest is owed a write.
    expect(service.project()?.characters).toEqual([
      { id: 'goblin', path: 'characters/goblin.json' },
    ]);
    expect(service.manifestNeedsWriting()).toBe(true);
  });

  it('never lets the session redirect an entry the file declares', async () => {
    const session: ProjectDefinition = {
      ...PROJECT,
      worlds: [
        { id: 'valley', path: 'worlds/somewhere-else.json' },
        { id: 'ridge', path: 'worlds/ridge.json' },
      ],
    };
    store(session, [world('valley'), world('ridge')]);

    const service = await reopen(PROJECT);

    expect(service.project()?.worlds[0]).toEqual({ id: 'valley', path: 'worlds/valley.json' });
  });

  it('loads a map added to the directory while the session was away', async () => {
    // The session knows one map; the manifest now declares two. Merging the
    // manifest without loading the file would declare a map with no document.
    store({ ...PROJECT, worlds: [{ id: 'valley', path: 'worlds/valley.json' }] }, [world('valley')]);

    const service = await reopen(PROJECT);

    expect(service.documents().map((document) => document.id)).toEqual(['valley', 'ridge']);
  });
});
