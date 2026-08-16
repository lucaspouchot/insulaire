/**
 * Integration test across the real boundary.
 *
 * This loads the actual `wasm-pack` output, feeds it the actual authored
 * content from `content/`, and drives it through the same TypeScript types the
 * application uses. Nothing is mocked — if the glue, the DTO shapes or the
 * command vocabulary drift apart, this fails.
 *
 * It is skipped with a clear message when `npm run wasm:build` has not been run,
 * so a fresh checkout does not fail with an inscrutable module error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { TileSetDefinition, WorldDefinition } from '../content/content-types';
import { WorldDocument } from '../content/world-document';
import { serializeWorld } from '../content/world-serializer';
import { offsetToAxial, hexDistance } from '../core/hex/hex-coords';
import {
  CommandResult,
  EngineInfo,
  GameSnapshot,
  HexEngineModule,
  LoadOutcome,
  RawHexEngine,
  ValidationReport,
  WorldView,
} from './engine.types';

// Vitest runs with `apps/web` as its root, so the repository root is two levels up.
const repoRoot = resolve(process.cwd(), '../..');
const pkgDir = resolve(process.cwd(), 'public/wasm');
const glueUrl = pathToFileURL(resolve(pkgDir, 'hex_engine.js')).href;
const wasmPath = resolve(pkgDir, 'hex_engine_bg.wasm');

const built = existsSync(wasmPath);

function readText(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

describe.skipIf(!built)('engine boundary', () => {
  let module: HexEngineModule;
  const tileSetJson = () => readText('content/tilesets/mvp_terrain.json');
  const worldJson = () => readText('content/worlds/demo_world.json');

  beforeAll(async () => {
    module = (await import(/* @vite-ignore */ glueUrl)) as HexEngineModule;
    // Node cannot `fetch` a file:// URL, so the bytes are handed over directly.
    // wasm-bindgen accepts a BufferSource in place of a URL.
    await module.default({ module_or_path: readFileSync(wasmPath) as unknown as string });
  });

  function engine(): RawHexEngine {
    return new module.HexEngine();
  }

  function loaded(): RawHexEngine {
    const instance = engine();
    instance.loadTileSet(tileSetJson());
    instance.loadWorld(worldJson());
    return instance;
  }

  it('reports that it is running as WebAssembly', () => {
    const info = JSON.parse(engine().engineInfo()) as EngineInfo;

    expect(info.name).toBe('hex-engine');
    expect(info.targetArch).toBe('wasm32');
    expect(info.pointerWidth).toBe(32);
    expect(info.worldSchemaVersion).toBe(1);
  });

  it('loads the shipped content without issues', () => {
    const instance = engine();

    const tileSet = JSON.parse(instance.loadTileSet(tileSetJson())) as LoadOutcome;
    expect(tileSet.id).toBe('mvp_terrain');
    expect(tileSet.report.valid).toBe(true);

    const world = JSON.parse(instance.loadWorld(worldJson())) as LoadOutcome;
    expect(world.id).toBe('demo_world');
    expect(world.report.issues).toEqual([]);
  });

  it('hands over the map once, as a packed buffer', () => {
    const instance = loaded();
    const view = JSON.parse(instance.worldView('demo_world')) as WorldView;
    const terrain = instance.terrainBuffer('demo_world');

    expect(view.width).toBe(20);
    expect(view.height).toBe(20);
    expect(view.palette).toHaveLength(6);
    expect(terrain).toBeInstanceOf(Uint8Array);
    expect(terrain.length).toBe(view.cellCount);

    // Every byte indexes a real palette entry.
    for (const index of terrain) {
      expect(view.palette[index]).toBeDefined();
    }
  });

  it('hands over elevation and projection for the isometric renderer', () => {
    const instance = loaded();
    const view = JSON.parse(instance.worldView('demo_world')) as WorldView;
    const elevation = instance.elevationBuffer('demo_world');

    expect(view.projection).toBe('isometric');
    expect(elevation).toBeInstanceOf(Int8Array);
    expect(elevation.length).toBe(view.cellCount);
    // The demo has relief, and it lines up with the terrain buffer cell for cell.
    expect(Math.max(...elevation)).toBeGreaterThan(0);
  });

  it('advances exactly one tick per accepted move, and moves the monsters', () => {
    const instance = loaded();
    const start = JSON.parse(instance.createGame('demo_world', 2026)) as GameSnapshot;

    expect(start.tick).toBe(0);
    expect(start.legalMoves.length).toBeGreaterThan(0);

    const target = start.legalMoves[0] as [number, number];
    const monsterBefore = start.entities.filter((entity) => entity.kind === 'monster');

    const result = JSON.parse(
      instance.dispatch(JSON.stringify({ type: 'moveTo', to: target })),
    ) as CommandResult;

    expect(result.accepted).toBe(true);
    expect(result.state.tick).toBe(1);
    expect(result.state.player?.at).toEqual(target);

    const monsterAfter = result.state.entities.filter((entity) => entity.kind === 'monster');
    expect(monsterAfter.some((monster, index) => monster.at.join() !== monsterBefore[index]?.at.join())).toBe(
      true,
    );

    expect(result.events.some((event) => event.type === 'tickAdvanced')).toBe(true);
    expect(result.events.filter((event) => event.type === 'entityMoved').length).toBeGreaterThan(1);
  });

  it('refuses an illegal move without advancing anything', () => {
    const instance = loaded();
    const start = JSON.parse(instance.createGame('demo_world', 2026)) as GameSnapshot;

    const result = JSON.parse(
      instance.dispatch(JSON.stringify({ type: 'moveTo', to: [19, 19] })),
    ) as CommandResult;

    expect(result.accepted).toBe(false);
    expect(result.rejection?.code).toBe('notAdjacent');
    expect(result.state).toEqual(start);
    expect(result.events).toEqual([
      { type: 'actionRejected', reason: result.rejection },
    ]);
  });

  it('only reports legal moves that the engine will actually accept', () => {
    const instance = loaded();
    const start = JSON.parse(instance.createGame('demo_world', 1)) as GameSnapshot;
    const legal = new Set(start.legalMoves.map((move) => move.join()));

    // Try all six neighbours of the player; acceptance must match legalMoves.
    const player = start.player;
    expect(player).not.toBeNull();
    const playerAxial = offsetToAxial({ col: player!.at[0], row: player!.at[1] });

    for (const [dq, dr] of [
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
    ]) {
      const neighbour = { q: playerAxial.q + dq, r: playerAxial.r + dr };
      const col = neighbour.q + (neighbour.r - (((neighbour.r % 2) + 2) % 2)) / 2;
      const to: [number, number] = [col, neighbour.r];

      const fresh = loaded();
      fresh.createGame('demo_world', 1);
      const result = JSON.parse(fresh.dispatch(JSON.stringify({ type: 'moveTo', to }))) as CommandResult;
      expect(result.accepted).toBe(legal.has(to.join()));
    }
  });

  it('replays identically for the same seed and inputs', () => {
    const run = (): GameSnapshot => {
      const instance = loaded();
      instance.createGame('demo_world', 4242);
      for (const command of [
        { type: 'wait' },
        { type: 'moveTo', to: [5, 10] },
        { type: 'moveTo', to: [19, 19] },
        { type: 'wait' },
      ]) {
        instance.dispatch(JSON.stringify(command));
      }
      return JSON.parse(instance.snapshot()) as GameSnapshot;
    };

    const first = run();
    expect(run()).toEqual(first);
    expect(first.tick).toBe(3);
  });

  it('closes the distance to a stationary player', () => {
    const instance = loaded();
    const start = JSON.parse(instance.createGame('demo_world', 2026)) as GameSnapshot;
    const playerAxial = offsetToAxial({ col: start.player!.at[0], row: start.player!.at[1] });

    const distanceOf = (snapshot: GameSnapshot): number =>
      Math.min(
        ...snapshot.entities
          .filter((entity) => entity.kind === 'monster')
          .map((monster) => hexDistance(offsetToAxial({ col: monster.at[0], row: monster.at[1] }), playerAxial)),
      );

    const before = distanceOf(start);
    let last = start;
    for (let i = 0; i < 20; i += 1) {
      last = (JSON.parse(instance.dispatch(JSON.stringify({ type: 'wait' }))) as CommandResult).state;
    }

    expect(last.tick).toBe(20);
    expect(distanceOf(last)).toBeLessThan(before);
    expect(distanceOf(last)).toBe(1);
  });

  /**
   * The editor -> runtime guarantee, end to end in TypeScript: take the shipped
   * world through the editor's document model, export it with the editor's
   * serialiser, and load *that* into the engine.
   */
  it('accepts a world exported by the editor pipeline', () => {
    const tileSet = readJson<TileSetDefinition>('content/tilesets/mvp_terrain.json');
    const definition = readJson<WorldDefinition>('content/worlds/demo_world.json');

    const document = WorldDocument.fromDefinition(definition, tileSet);
    document.paint({ col: 0, row: 0 }, 'rock');
    document.placeEntity({ col: 1, row: 0 }, 'monster', false);

    const instance = engine();
    instance.loadTileSet(JSON.stringify(tileSet));
    const outcome = JSON.parse(instance.loadWorld(serializeWorld(document.toDefinition()))) as LoadOutcome;

    expect(outcome.report.valid).toBe(true);
    const snapshot = JSON.parse(instance.createGame(outcome.id, 1)) as GameSnapshot;
    expect(snapshot.entities.filter((entity) => entity.kind === 'monster')).toHaveLength(3);
  });

  it('rejects a world with no player, listing the reason', () => {
    const definition = readJson<WorldDefinition>('content/worlds/demo_world.json');
    definition.entities = (definition.entities ?? []).filter((entity) => entity.templateId !== 'player');

    const instance = engine();
    instance.loadTileSet(tileSetJson());

    const report = JSON.parse(instance.validateWorld(serializeWorld(definition))) as ValidationReport;
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain('world.missingPlayer');
  });
});

describe.skipIf(built)('engine boundary (skipped)', () => {
  it('needs the WASM build', () => {
    console.warn('Skipping engine integration tests: run "npm run wasm:build" first.');
    expect(built).toBe(false);
  });
});
