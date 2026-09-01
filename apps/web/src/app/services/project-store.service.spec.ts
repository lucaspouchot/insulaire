/**
 * What {@link ProjectStoreService} promises a load: the content directory is
 * the project, and browser storage is only a session's work in progress.
 *
 * The content directory is the project (`docs/adr/ADR-0019-authoring-content-
 * workspace.md`). A session that outlived a hand-edit must not hide what was
 * written by hand — nor arrive at the next save ready to overwrite it.
 *
 * What a save then *does* with the difference is `WriteLedger`'s, and is spec'd
 * with it.
 */
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectStoreService } from './project-store.service';
import { ProjectDefinition } from '../../content/generated/project';
import { WorldDefinition } from '../../content/generated/world';
import { PROJECT, contentFiles, fetchFrom, world } from '../project/project-fixture';
import { ProjectManifest } from '../project/project-manifest';
import { WorldLibrary } from '../project/world-library';
import { WriteLedger } from '../project/write-ledger';

/** Serves the manifest, the tile set and two maps, as the dev server would. */
function serveContent(project: ProjectDefinition): void {
  vi.stubGlobal('fetch', fetchFrom(contentFiles(project)));
}

describe('ProjectStoreService — the files win over the stored session', () => {
  /** What the editor left in `localStorage` before the directory was edited. */
  function store(project: ProjectDefinition, worlds: readonly WorldDefinition[]): void {
    localStorage.setItem(
      'insulaire.editor.project.v1',
      JSON.stringify({ project, worlds, activeWorldId: project.startWorld }),
    );
  }

  /** Loads without clearing `localStorage`, so a stored session survives. */
  async function reopen(project: ProjectDefinition): Promise<{
    manifest: ProjectManifest;
    worlds: WorldLibrary;
    ledger: WriteLedger;
  }> {
    serveContent(project);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    await TestBed.inject(ProjectStoreService).ensureLoaded();
    return {
      manifest: TestBed.inject(ProjectManifest),
      worlds: TestBed.inject(WorldLibrary),
      ledger: TestBed.inject(WriteLedger),
    };
  }

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('mirrors nothing for a project that has only been loaded', async () => {
    // The mirror follows the edit counters, and an effect runs once on
    // subscription. Writing on that first run would leave storage holding a
    // project nobody edited — and the *next* load would call itself restored.
    serveContent(PROJECT);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    await TestBed.inject(ProjectStoreService).ensureLoaded();
    TestBed.tick();

    expect(localStorage.getItem('insulaire.editor.project.v1')).toBe(null);
    expect(TestBed.inject(WorldLibrary).source()).toBe('shipped');
  });

  it('mirrors the session once something has been edited', async () => {
    serveContent(PROJECT);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    await TestBed.inject(ProjectStoreService).ensureLoaded();
    TestBed.inject(ProjectManifest).declareCharacter('goblin', 'characters/goblin.json');
    TestBed.tick();

    const stored = localStorage.getItem('insulaire.editor.project.v1');
    expect(stored).not.toBe(null);
    expect(stored).toContain('goblin');
  });

  it('leaves the mirror cleared after a reset to the shipped content', async () => {
    // The mirror is an effect, so it runs *after* `resetToShipped` has cleared
    // storage. Guarding it on "anything edited since the process started" would
    // let it write the session straight back over the clearing.
    serveContent(PROJECT);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const store = TestBed.inject(ProjectStoreService);
    await store.ensureLoaded();
    TestBed.inject(ProjectManifest).declareCharacter('goblin', 'characters/goblin.json');
    TestBed.tick();
    expect(localStorage.getItem('insulaire.editor.project.v1')).not.toBe(null);

    await store.resetToShipped();
    TestBed.tick();

    expect(localStorage.getItem('insulaire.editor.project.v1')).toBe(null);
    expect(TestBed.inject(WorldLibrary).source()).toBe('shipped');
  });

  it('shows a character declared in the file by hand since the last session', async () => {
    const declared: ProjectDefinition = {
      ...PROJECT,
      characters: [{ id: 'human_player', path: 'characters/human_player.json' }],
    };
    store(PROJECT, [world('valley'), world('ridge')]);

    const { manifest, ledger } = await reopen(declared);

    expect(manifest.characters()).toEqual([
      { id: 'human_player', path: 'characters/human_player.json' },
    ]);
    // And the file it came from is not owed a write: it already says this.
    expect(ledger.manifestNeedsWriting()).toBe(false);
  });

  it('keeps what the session declared and has not written yet', async () => {
    const session: ProjectDefinition = {
      ...PROJECT,
      characters: [{ id: 'goblin', path: 'characters/goblin.json' }],
    };
    store(session, [world('valley'), world('ridge')]);

    const { manifest, worlds, ledger } = await reopen(PROJECT);

    // Nothing on disk declares it, so it survives on the strength of the
    // session alone — and the manifest is owed a write.
    expect(manifest.characters()).toEqual([{ id: 'goblin', path: 'characters/goblin.json' }]);
    expect(ledger.manifestNeedsWriting()).toBe(true);
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

    const { manifest, worlds, ledger } = await reopen(PROJECT);

    expect(manifest.worlds()[0]).toEqual({ id: 'valley', path: 'worlds/valley.json' });
  });

  it('loads a map added to the directory while the session was away', async () => {
    // The session knows one map; the manifest now declares two. Merging the
    // manifest without loading the file would declare a map with no document.
    store({ ...PROJECT, worlds: [{ id: 'valley', path: 'worlds/valley.json' }] }, [
      world('valley'),
    ]);

    const { manifest, worlds, ledger } = await reopen(PROJECT);

    expect(worlds.documents().map((document) => document.id)).toEqual(['valley', 'ridge']);
  });
});
