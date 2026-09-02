import { describe, expect, it } from 'vitest';

import { WorldSavePipeline, WorldSaveServices } from './world-save-pipeline';
import { world } from './project-fixture';
import { ValidationReport } from '../../engine/engine.types';
import { WorldDefinition } from '../../content/generated/world';
import { serializeWorld } from '../../content/world-serializer';

const OK: ValidationReport = { valid: true, issues: [] };
const BAD: ValidationReport = {
  valid: false,
  issues: [{ code: 'world.broken', severity: 'error', path: '', message: 'broken' }],
};

interface Harness {
  readonly pipeline: WorldSavePipeline;
  /** Every call the pipeline made, in order — the sequence itself is testable. */
  readonly trace: string[];
  readonly written: Map<string, string>;
  readonly removed: string[];
  readonly ledgerWorldWritten: string[];
  readonly ledgerWorldDeleted: string[];
  manifestWasWritten: boolean;
}

interface Faults {
  engineNotReady?: boolean;
  invalidWorld?: string;
  changed?: string[];
  orphans?: { id: string; path: string }[];
  manifestDirty?: boolean;
  openWorldDirty?: boolean;
  linksReport?: ValidationReport;
}

function harness(worlds: WorldDefinition[], faults: Faults = {}): Harness {
  const trace: string[] = [];
  const written = new Map<string, string>();
  const removed: string[] = [];
  const ledgerWorldWritten: string[] = [];
  const ledgerWorldDeleted: string[] = [];
  const state = { manifestWasWritten: false };
  const changed = new Set(faults.changed ?? worlds.map((entry) => entry.id));

  const services: WorldSaveServices = {
    engineReady: () => !faults.engineNotReady,
    openWorld: () => worlds[0] as WorldDefinition,
    allWorlds: () => worlds,
    worldPath: (id) => `worlds/${id}.json`,
    worldNeedsWriting: (id) =>
      id === (worlds[0] as WorldDefinition).id ? (faults.openWorldDirty ?? true) : changed.has(id),
    markWorldWritten: (id) => {
      ledgerWorldWritten.push(id);
      changed.delete(id);
    },
    changedWorldIds: () => worlds.map((entry) => entry.id).filter((id) => changed.has(id)),
    orphanedWorlds: () => faults.orphans ?? [],
    markWorldDeleted: (id) => ledgerWorldDeleted.push(id),
    manifestNeedsWriting: () => faults.manifestDirty ?? true,
    projectJson: () => '{"project":"json"}',
    markManifestWritten: () => {
      state.manifestWasWritten = true;
    },
    registerOpenTileSet: () => trace.push('registerOpenTileSet'),
    resetAndRegisterContent: () => trace.push('resetAndRegisterContent'),
    validateWorld: (json) => {
      trace.push(`validateWorld:${JSON.parse(json).id}`);
      return JSON.parse(json).id === faults.invalidWorld ? BAD : OK;
    },
    loadWorld: (json) => trace.push(`loadWorld:${JSON.parse(json).id}`),
    validateLinks: () => {
      trace.push('validateLinks');
      return faults.linksReport ?? OK;
    },
    writeJson: async (path, json) => {
      trace.push(`writeJson:${path}`);
      written.set(path, json);
    },
    removeFile: async (path) => {
      trace.push(`removeFile:${path}`);
      removed.push(path);
    },
  };

  return {
    pipeline: new WorldSavePipeline(services),
    trace,
    written,
    removed,
    ledgerWorldWritten,
    ledgerWorldDeleted,
    get manifestWasWritten() {
      return state.manifestWasWritten;
    },
  };
}

describe('saveOpenWorld', () => {
  it('does nothing while the engine is still loading', async () => {
    const held = harness([world('valley')], { engineNotReady: true });

    expect(await held.pipeline.saveOpenWorld()).toEqual({ status: 'engine-not-ready' });
    expect(held.trace).toEqual([]);
  });

  it('never writes an invalid map', async () => {
    const held = harness([world('valley')], { invalidWorld: 'valley' });

    const result = await held.pipeline.saveOpenWorld();
    expect(result).toEqual({ status: 'invalid', report: BAD });
    expect(held.written.size).toBe(0);
  });

  it('writes the open map, then reconciles the manifest', async () => {
    const held = harness([world('valley')], { manifestDirty: true });

    const result = await held.pipeline.saveOpenWorld();
    expect(result.status).toBe('written');
    expect(held.written.get('worlds/valley.json')).toBe(serializeWorld(world('valley')));
    expect(held.ledgerWorldWritten).toEqual(['valley']);
    // The manifest write goes through projectJson(), which is where the implicit
    // default zone is materialised (docs/adr/ADR-0018-map-zones.md).
    expect(held.written.get('project.json')).toBe('{"project":"json"}');
    expect(held.manifestWasWritten).toBe(true);
    expect(held.trace).toEqual([
      'registerOpenTileSet',
      'validateWorld:valley',
      'writeJson:worlds/valley.json',
      'writeJson:project.json',
    ]);
  });

  it('leaves a map that already matches its file alone', async () => {
    const held = harness([world('valley')], { openWorldDirty: false, manifestDirty: false });

    const result = await held.pipeline.saveOpenWorld();
    expect(result).toMatchObject({
      status: 'written',
      outcome: { openMapUpToDate: true, written: [], manifestWritten: false },
    });
    expect(held.written.size).toBe(0);
  });

  it("deletes a renamed map's old file", async () => {
    const held = harness([world('valley')], {
      manifestDirty: true,
      orphans: [{ id: 'vale', path: 'worlds/vale.json' }],
    });

    const result = await held.pipeline.saveOpenWorld();
    expect(result).toMatchObject({ status: 'written', outcome: { deleted: ['worlds/vale.json'] } });
    expect(held.removed).toEqual(['worlds/vale.json']);
    expect(held.ledgerWorldDeleted).toEqual(['vale']);
    // Manifest first, then the orphan file.
    expect(held.trace.slice(-2)).toEqual(['writeJson:project.json', 'removeFile:worlds/vale.json']);
  });
});

describe('saveProject', () => {
  it('writes every changed world, then reconciles once', async () => {
    const held = harness([world('valley'), world('ridge'), world('crest')], {
      changed: ['valley', 'ridge', 'crest'],
      manifestDirty: true,
    });

    const result = await held.pipeline.saveProject();
    expect(result.status).toBe('written');
    expect([...held.written.keys()]).toEqual([
      'worlds/valley.json',
      'worlds/ridge.json',
      'worlds/crest.json',
      'project.json',
    ]);
    expect(held.ledgerWorldWritten).toEqual(['valley', 'ridge', 'crest']);
  });

  it('validates every world against the re-registered set before writing', async () => {
    const held = harness([world('valley'), world('ridge')], { changed: [], manifestDirty: false });

    await held.pipeline.saveProject();
    expect(held.trace).toEqual([
      'resetAndRegisterContent',
      'validateWorld:valley',
      'loadWorld:valley',
      'validateWorld:ridge',
      'loadWorld:ridge',
      'validateLinks',
    ]);
  });

  it('bails on the first invalid map without writing anything', async () => {
    const held = harness([world('valley'), world('ridge')], { invalidWorld: 'valley' });

    const result = await held.pipeline.saveProject();
    expect(result).toEqual({ status: 'invalid', report: BAD });
    expect(held.trace).toEqual(['resetAndRegisterContent', 'validateWorld:valley']);
    expect(held.written.size).toBe(0);
  });

  it('reports dangling doors as an invalid save', async () => {
    const held = harness([world('valley')], { linksReport: BAD });

    expect(await held.pipeline.saveProject()).toEqual({ status: 'invalid', report: BAD });
    expect(held.written.size).toBe(0);
  });
});

describe('revalidateLinks', () => {
  it('resets, re-registers the whole set, then resolves the doors', () => {
    const held = harness([world('valley'), world('ridge')]);

    expect(held.pipeline.revalidateLinks()).toBe(OK);
    expect(held.trace).toEqual([
      'resetAndRegisterContent',
      'loadWorld:valley',
      'loadWorld:ridge',
      'validateLinks',
    ]);
  });
});
