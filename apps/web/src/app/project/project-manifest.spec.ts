/**
 * What {@link ProjectManifest} promises: `project.json`'s field names stop
 * here.
 *
 * Two things are worth defending. A caller asks for the declared characters and
 * gets a list whether the project ships one, an empty one, or no key at all —
 * which is what lets ten modules stop writing `?.characters ?? []`. And a
 * declaration the editor makes is *additive and idempotent*: an author creating
 * a character should not have to hand-edit the manifest for it to exist
 * (`docs/adr/ADR-0024-character-definitions.md`), and creating one twice must
 * not list it twice.
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { PROJECT } from './project-fixture';
import { ProjectManifest } from './project-manifest';
import { DEFAULT_ZONE_ID, ProjectDefinition } from '../../content/content-types';

function manifestOf(project: ProjectDefinition = PROJECT): ProjectManifest {
  TestBed.configureTestingModule({});
  const manifest = TestBed.inject(ProjectManifest);
  manifest.adopt(project);
  return manifest;
}

describe('ProjectManifest — what the project declares', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('answers every list before a project is loaded, without throwing', () => {
    TestBed.configureTestingModule({});
    const manifest = TestBed.inject(ProjectManifest);

    expect(manifest.loaded()).toBe(false);
    expect(manifest.characters()).toEqual([]);
    expect(manifest.decorations()).toEqual([]);
    expect(manifest.objects()).toEqual([]);
    expect(manifest.languages()).toEqual([]);
    expect(manifest.titleScreen()).toBe(null);
    expect(manifest.settings()).toBe(null);
    expect(manifest.characterCreation()).toBe(null);
    expect(manifest.name()).toBe(null);
    expect(() => manifest.require()).toThrow();
  });

  it('reads an absent list as an empty one, not as undefined', () => {
    // The whole point: a caller never writes `?.characters ?? []` again, so the
    // absent case has to be indistinguishable from the empty one.
    const manifest = manifestOf();

    expect(manifest.characters()).toEqual([]);
    expect(manifest.worlds()).toHaveLength(2);
    expect(manifest.name()).toBe('P');
    expect(manifest.startWorld()).toBe('valley');
  });

  it('materialises one implicit zone for a project that declares none', () => {
    // Zones are mandatory in the model even where the file leaves them out
    // (`docs/adr/ADR-0018-map-zones.md`).
    const { zones: _zones, ...unzoned } = PROJECT;
    const manifest = manifestOf(unzoned as ProjectDefinition);

    expect(manifest.zones()).toEqual([{ id: DEFAULT_ZONE_ID, name: 'Default' }]);
    expect(manifest.defaultZoneId()).toBe(DEFAULT_ZONE_ID);
  });

  it('takes the first declared zone as the default', () => {
    const manifest = manifestOf({
      ...PROJECT,
      zones: [
        { id: 'north', name: 'North' },
        { id: 'south', name: 'South' },
      ],
    });

    expect(manifest.defaultZoneId()).toBe('north');
  });

  it('declares a character once, and says so when it is already declared', () => {
    const manifest = manifestOf();

    expect(manifest.declareCharacter('goblin', 'characters/goblin.json')).toBe(true);
    expect(manifest.characters()).toEqual([{ id: 'goblin', path: 'characters/goblin.json' }]);

    expect(manifest.declareCharacter('goblin', 'characters/elsewhere.json')).toBe(false);
    expect(manifest.characters()).toEqual([{ id: 'goblin', path: 'characters/goblin.json' }]);
  });

  it('undeclares only what it holds', () => {
    const manifest = manifestOf();
    manifest.declareDecoration('rock', 'decorations/rock.json');

    expect(manifest.undeclareDecoration('tree')).toBe(false);
    expect(manifest.undeclareDecoration('rock')).toBe(true);
    expect(manifest.decorations()).toEqual([]);
  });

  it('answers a path by convention for a definition nobody declared', () => {
    const manifest = manifestOf();

    expect(manifest.objectPath('lantern')).toBe('objects/lantern.json');
    manifest.declareObject('lantern', 'props/lantern.json');
    expect(manifest.objectPath('lantern')).toBe('props/lantern.json');
  });

  it('counts an edit only when something changed', () => {
    // What the ledger derives `dirty` from: a refused declaration is not an
    // edit, or a second "add" of the same character would owe the disk a write.
    const manifest = manifestOf();
    const before = manifest.edits();

    manifest.declareCharacter('goblin', 'characters/goblin.json');
    expect(manifest.edits()).toBe(before + 1);

    manifest.declareCharacter('goblin', 'characters/goblin.json');
    expect(manifest.edits()).toBe(before + 1);
  });

  it('does not count adopting a project as an edit', () => {
    // Loading and resetting start editing rather than continue it.
    const manifest = manifestOf();
    manifest.declareCharacter('goblin', 'characters/goblin.json');
    const after = manifest.edits();

    manifest.adopt(PROJECT);
    expect(manifest.edits()).toBe(after);
  });

  it('opens a namespace for the first key of a language that has none', () => {
    const manifest = manifestOf();

    expect(manifest.declareLocaleFile('fr', 'menu', 'locales/fr/menu.json')).toBe(true);
    expect(manifest.languages()).toEqual([
      { id: 'fr', files: [{ id: 'menu', path: 'locales/fr/menu.json' }] },
    ]);

    expect(manifest.declareLocaleFile('fr', 'items', 'locales/fr/items.json')).toBe(true);
    expect(manifest.languages()[0]?.files).toHaveLength(2);

    // The same namespace twice is the manifest already saying it.
    expect(manifest.declareLocaleFile('fr', 'menu', 'locales/fr/menu.json')).toBe(false);
  });

  it('replaces the single character-creation declaration rather than listing it', () => {
    const manifest = manifestOf();

    manifest.declareCharacterCreation('creation', 'character-creation.json');
    expect(manifest.characterCreationPath()).toBe('character-creation.json');

    manifest.declareCharacterCreation('creation', 'menu/creation.json');
    expect(manifest.characterCreation()).toEqual({ id: 'creation', path: 'menu/creation.json' });
  });

  it('answers a tile set path from the manifest, or by convention', () => {
    const manifest = manifestOf();

    expect(manifest.tileSetPath('terrain')).toBe('tilesets/terrain.json');
    expect(manifest.tileSetPath('cave')).toBe('tilesets/cave.json');
  });
});
