/**
 * What {@link WorldLibrary} promises: the set of maps stays coherent.
 *
 * The rules that are easy to lose and expensive to lose: a project may not end
 * up with no map; renaming one repoints every link that named it, across the
 * other maps and in the manifest's `startWorld`
 * (`docs/adr/ADR-0014-map-links.md`); and a zone may not be removed while a map
 * is still in it, because moving those maps somewhere is the author's decision
 * (`docs/adr/ADR-0018-map-zones.md`).
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { PROJECT, TILE_SET, world } from './project-fixture';
import { ProjectManifest } from './project-manifest';
import { WorldLibrary } from './world-library';
import { WorldDefinition } from '../../content/generated/world';
import { WorldDocument } from '../../content/world-document';

function documentOf(definition: WorldDefinition): WorldDocument {
  return WorldDocument.fromDefinition(definition, TILE_SET);
}

interface Held {
  readonly worlds: WorldLibrary;
  readonly manifest: ProjectManifest;
}

function open(definitions: readonly WorldDefinition[] = [world('valley'), world('ridge')]): Held {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({});
  const manifest = TestBed.inject(ProjectManifest);
  const worlds = TestBed.inject(WorldLibrary);
  manifest.adopt(PROJECT);
  worlds.adopt(definitions.map(documentOf), 'valley', 'shipped');
  return { worlds, manifest };
}

describe('WorldLibrary — the set of maps', () => {
  let held: Held;

  beforeEach(() => {
    held = open();
  });

  it('opens the map it was told to, and falls back when that one is absent', () => {
    expect(held.worlds.activeWorldId()).toBe('valley');

    held.worlds.adopt([documentOf(world('ridge'))], 'valley', 'shipped');
    expect(held.worlds.activeWorldId()).toBe('ridge');
  });

  it('refuses to remove the last map', () => {
    expect(held.worlds.removeWorld('ridge')).toBe(true);
    expect(held.worlds.removeWorld('valley')).toBe(false);
    expect(held.worlds.documents().map((document) => document.id)).toEqual(['valley']);
  });

  it('opens what is left when the open map is removed', () => {
    held.worlds.selectWorld('valley');

    expect(held.worlds.removeWorld('valley')).toBe(true);
    expect(held.worlds.activeWorldId()).toBe('ridge');
  });

  it('refuses a rename onto an id another map already has', () => {
    held.worlds.selectWorld('valley');

    expect(held.worlds.renameWorld('ridge', 'Ridge')).toBe(false);
    expect(held.worlds.requireDocument().id).toBe('valley');
  });

  it('repoints the manifest start world when the map it names is renamed', () => {
    held.worlds.selectWorld('valley');

    expect(held.worlds.renameWorld('vale', 'Vale')).toBe(true);
    expect(held.manifest.startWorld()).toBe('vale');
  });

  it('leaves the start world alone when another map is renamed', () => {
    held.worlds.selectWorld('ridge');
    held.worlds.renameWorld('crest', 'Crest');

    expect(held.manifest.startWorld()).toBe('valley');
  });

  it('resolves the zone of a map that names none', () => {
    // Callers group maps without having to know that a map naming no zone is in
    // the default one.
    expect(held.worlds.worldChoices().map((choice) => choice.zone)).toEqual(['valley', 'valley']);

    held.worlds.selectWorld('ridge');
    held.worlds.addZone('north', 'North');
    held.worlds.setZone('north');

    expect(held.worlds.worldChoices()).toContainEqual({
      id: 'ridge',
      name: 'ridge',
      zone: 'north',
    });
  });

  it('refuses a zone that is empty or already declared', () => {
    expect(held.worlds.addZone('', 'Nowhere')).toBe(false);
    expect(held.worlds.addZone('valley', 'Again')).toBe(false);
    expect(held.worlds.addZone('north', 'North')).toBe(true);
  });

  it('names a zone after its id when the name is blank', () => {
    held.worlds.addZone('north', '   ');

    expect(held.manifest.zones()).toContainEqual({ id: 'north', name: 'north' });
  });

  it('refuses to remove a zone a map is still in', () => {
    held.worlds.addZone('north', 'North');
    held.worlds.selectWorld('ridge');
    held.worlds.setZone('north');

    expect(held.worlds.removeZone('north')).toBe(false);

    held.worlds.setZone('valley');
    expect(held.worlds.removeZone('north')).toBe(true);
  });

  it('refuses to remove the last zone', () => {
    expect(held.worlds.removeZone('valley')).toBe(false);
  });

  it('counts an edit only when something changed', () => {
    held.worlds.setZone('north');
    const before = held.worlds.edits();

    // Already in it: nothing moved, so nothing is owed the disk.
    expect(held.worlds.setZone('north')).toBe(false);
    expect(held.worlds.edits()).toBe(before);

    expect(held.worlds.setZone('valley')).toBe(true);
    expect(held.worlds.edits()).toBe(before + 1);
  });

  it('counts a brush stroke nothing else can see', () => {
    // A document is a mutable object held in a signal, so painting changes no
    // signal. `markEdited` is the whole of what `WriteLedger.touch()` does here.
    const before = held.worlds.edits();
    held.worlds.requireDocument().paint({ col: 1, row: 1 }, 'water');

    expect(held.worlds.edits()).toBe(before);
    held.worlds.markEdited();
    expect(held.worlds.edits()).toBe(before + 1);
  });

  it('replaces a map of the same id rather than listing it twice', () => {
    held.worlds.addWorld(documentOf(world('ridge')));

    expect(held.worlds.documents().map((document) => document.id)).toEqual(['valley', 'ridge']);
    expect(held.worlds.activeWorldId()).toBe('ridge');
  });

  it('opens an imported map', () => {
    const document = held.worlds.importDefinition(world('north'), TILE_SET);

    expect(document.id).toBe('north');
    expect(held.worlds.activeWorldId()).toBe('north');
  });
});
