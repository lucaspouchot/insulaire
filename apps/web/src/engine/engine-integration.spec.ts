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

import {
  CharacterDefinition,
  CharacterCreationDefinition,
  CharacterCreationResult,
  DECORATION_SCHEMA_VERSION,
  DecorationDefinition,
  OBJECT_SCHEMA_VERSION,
  ObjectDefinition,
  ResolvedCharacter,
  ResolvedDecoration,
  ResolvedObject,
  TILE_SET_SCHEMA_VERSION,
  TileDefinition,
  TileSetDefinition,
  WORLD_SCHEMA_VERSION,
  WorldDefinition,
  bandLevels,
  tileArtGeometry,
} from '../content/content-types';
import { WorldDocument } from '../content/world-document';
import { serializeDecoration } from '../content/decoration-serializer';
import { serializeObject } from '../content/object-serializer';
import { serializeWorld } from '../content/world-serializer';
import { ResolvedTileRender, resolveTileRender, variantRoll } from '../renderer/tile-art';
import { offsetToAxial, hexDistance } from '../core/hex/hex-coords';
import {
  CommandResult,
  ContentSummary,
  EngineInfo,
  GameSnapshot,
  InsulaireEngineModule,
  LoadOutcome,
  LocaleView,
  RawInsulaireEngine,
  ValidationReport,
  WorldView,
} from './engine.types';

// Vitest runs with `apps/web` as its root, so the repository root is two levels up.
const repoRoot = resolve(process.cwd(), '../..');
const pkgDir = resolve(process.cwd(), 'public/wasm');
const glueUrl = pathToFileURL(resolve(pkgDir, 'insulaire_engine.js')).href;
const wasmPath = resolve(pkgDir, 'insulaire_engine_bg.wasm');

const built = existsSync(wasmPath);

function readText(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

/**
 * A `ResolvedTileRender` off the wire, filled in the way the mirror writes it.
 *
 * Rust skips the fields that are absent, so what the boundary sends back has
 * holes where the mirror has explicit `null`s and empty arrays. Filling them
 * here rather than comparing field by field keeps a *new* field a failing test
 * instead of a silently ignored one.
 */
function wire(render: ResolvedTileRender): ResolvedTileRender {
  return {
    tileId: render.tileId,
    elevation: render.elevation,
    flat: render.flat ?? null,
    surface: render.surface ?? null,
    layers: render.layers ?? [],
  };
}

describe.skipIf(!built)('engine boundary', () => {
  let module: InsulaireEngineModule;
  const tileSetJson = () => readText('content/tilesets/mvp_terrain.json');
  const worldJson = () => readText('content/worlds/demo_world.json');

  beforeAll(async () => {
    module = (await import(/* @vite-ignore */ glueUrl)) as InsulaireEngineModule;
    // Node cannot `fetch` a file:// URL, so the bytes are handed over directly.
    // wasm-bindgen accepts a BufferSource in place of a URL.
    await module.default({ module_or_path: readFileSync(wasmPath) as unknown as string });
  });

  function engine(): RawInsulaireEngine {
    return new module.InsulaireEngine();
  }

  function loaded(): RawInsulaireEngine {
    const instance = engine();
    instance.loadTileSet(tileSetJson());
    instance.loadWorld(worldJson());
    return instance;
  }

  /**
   * Registers the shipped locale files.
   *
   * The manifest declares its languages, and a declared language with no file
   * is a load error — so anything that loads the real `project.json` loads
   * these too (`docs/adr/ADR-0020-localised-content-keys.md`).
   */
  function loadShippedLocales(instance: RawInsulaireEngine): void {
    for (const language of ['en', 'fr']) {
      for (const namespace of ['menu', 'game']) {
        instance.loadLocale(
          language,
          namespace,
          readText(`content/locales/${language}/${namespace}.json`),
        );
      }
    }
  }

  /**
   * Registers the shipped title screen.
   *
   * Like the languages: the manifest names it, so the manifest will not load
   * without it (`docs/adr/ADR-0021-authored-title-screen.md`).
   */
  function loadShippedTitleScreen(instance: RawInsulaireEngine): void {
    instance.loadTitleScreen(readText('content/menu/title-screen.json'));
    instance.loadSettings(readText('content/settings.json'));
  }

  /** Every character definition and the creation file that depends on them. */
  function loadShippedCharacters(instance: RawInsulaireEngine): void {
    instance.loadCharacter(readText('content/characters/human_player.json'));
    instance.loadCharacterCreation(readText('content/character-creation.json'));
  }

  it('reports that it is running as WebAssembly', () => {
    const info = JSON.parse(engine().engineInfo()) as EngineInfo;

    expect(info.name).toBe('insulaire-engine');
    expect(info.targetArch).toBe('wasm32');
    expect(info.pointerWidth).toBe(32);
    expect(info.worldSchemaVersion).toBe(WORLD_SCHEMA_VERSION);
  });

  it('resolves tile art exactly as the TypeScript mirror does', () => {
    // The renderer resolves this itself, once per visible cell per frame, and
    // may not cross the boundary to do it. So the two implementations are held
    // together here, against the real WASM build
    // (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
    const set: TileSetDefinition = {
      id: 'art',
      schemaVersion: TILE_SET_SCHEMA_VERSION,
      art: { width: 32, flatHeight: 37, surfaceHeight: 20, elevationHeight: 13, elevationStep: 8 },
      tiles: [
        {
          id: 'cliff',
          terrain: 'rock',
          movementCost: 1,
          visual: { visualId: 'terrain.rock', fallbackColor: '#7a7169' },
          art: {
            // Fewer flats than surfaces, so the wrap a shared index implies is
            // held together across the boundary as well
            // (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
            flat: [{ id: 'a', asset: 'assets/tiles/flat_a.png' }],
            surface: [
              { id: 'a', asset: 'assets/tiles/top_a.png' },
              { id: 'b', asset: 'assets/tiles/top_b.png' },
            ],
            elevation: {
              levels: [
                { variants: [{ id: 'a', asset: 'assets/tiles/side_a.png' }] },
                {
                  variants: [
                    { id: 'a', asset: 'assets/tiles/rock_a.png' },
                    { id: 'b', asset: 'assets/tiles/rock_b.png' },
                  ],
                },
              ],
              repeat: { pattern: [1, 2] },
            },
          },
        },
        {
          id: 'meadow',
          terrain: 'grass',
          movementCost: 1,
          visual: { visualId: 'terrain.grass', fallbackColor: '#4a7c3f' },
          // A surface and no ladder of its own: what a cell borrows one for.
          art: {
            surface: [
              { id: 'a', asset: 'assets/tiles/turf_a.png' },
              { id: 'b', asset: 'assets/tiles/turf_b.png' },
            ],
          },
        },
      ],
    };
    const json = JSON.stringify(set);
    const instance = engine();

    expect((JSON.parse(instance.validateTileSet(json)) as ValidationReport).valid).toBe(true);

    // Both projections, because they resolve from different lists and a mirror
    // that agreed on only one of them would be half a mirror
    // (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
    for (const projection of ['isometric', 'topDown'] as const) {
      for (const elevation of [0, 1, 2, 3, 4, 10]) {
        for (const roll of [0, 1, 7, 12345]) {
          const rust = JSON.parse(
            instance.previewTileRender(json, 'cliff', projection, elevation, 0, roll, '{}'),
          ) as ResolvedTileRender;
          const mirror = resolveTileRender(
            'cliff',
            set.tiles[0]?.art,
            projection,
            elevation,
            0,
            roll,
          );

          expect(mirror, `${projection} at ${elevation}, roll ${roll}`).toEqual(wire(rust));
        }
      }
    }

    // And the roll itself, which decides which variant a cell gets.
    const roll = variantRoll(3, 4, 'cliff');
    const rolled = JSON.parse(
      instance.previewTileRender(json, 'cliff', 'isometric', 0, 0, roll, '{}'),
    ) as ResolvedTileRender;
    expect(rolled.surface).toBe(
      resolveTileRender('cliff', set.tiles[0]?.art, 'isometric', 0, 0, roll).surface,
    );

    // The same agreement for a cell that chose by hand, including a ladder
    // borrowed from another tile — the ids are resolved by Rust, the drawing by
    // the mirror (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
    const meadow = set.tiles[1] as TileDefinition;
    for (const [choice, cell] of [
      [{ surface: 'b' }, { surface: 1 }],
      [{ elevationTile: 'cliff' }, { elevation: set.tiles[0]?.art }],
      [
        { surface: 'a', elevationTile: 'cliff', elevation: 'b' },
        { surface: 0, elevation: set.tiles[0]?.art, elevationVariant: 1 },
      ],
    ] as const) {
      for (const elevation of [0, 2, 5]) {
        const rust = JSON.parse(
          instance.previewTileRender(
            json,
            'meadow',
            'isometric',
            elevation,
            0,
            3,
            JSON.stringify(choice),
          ),
        ) as ResolvedTileRender;
        const mirror = resolveTileRender('meadow', meadow.art, 'isometric', elevation, 0, 3, cell);

        expect(mirror).toEqual(wire(rust));
      }
    }

    // A tile with no flat image resolves to nothing top-down, on both sides, so
    // the renderer falls back to its colour rather than to a surface.
    const bare = JSON.parse(
      instance.previewTileRender(json, 'meadow', 'topDown', 0, 0, 0, '{}'),
    ) as ResolvedTileRender;
    expect(bare.flat ?? null).toBeNull();
    expect(resolveTileRender('meadow', meadow.art, 'topDown', 0, 0, 0).flat).toBeNull();
  });

  it('resolves a step shorter than its band exactly as the mirror does', () => {
    // The shipped shape since the relief was halved: a level lifts half a band,
    // so one image spans two levels and the stack is bands rather than slices.
    // Rust reads the span off the tile set; the mirror is told it, and the two
    // have to agree layer for layer
    // (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
    const set: TileSetDefinition = {
      id: 'halved',
      schemaVersion: TILE_SET_SCHEMA_VERSION,
      art: { width: 32, flatHeight: 37, surfaceHeight: 20, elevationHeight: 13, elevationStep: 4 },
      tiles: [
        {
          id: 'cliff',
          terrain: 'rock',
          movementCost: 1,
          visual: { visualId: 'terrain.rock', fallbackColor: '#7a7169' },
          art: {
            surface: [{ id: 'a', asset: 'assets/tiles/top_a.png' }],
            elevation: {
              levels: [
                { variants: [{ id: 'a', asset: 'assets/tiles/side_a.png' }] },
                { variants: [{ id: 'a', asset: 'assets/tiles/rock_a.png' }] },
              ],
              repeat: { level: 2 },
            },
          },
        },
      ],
    };
    const json = JSON.stringify(set);
    const instance = engine();
    expect((JSON.parse(instance.validateTileSet(json)) as ValidationReport).valid).toBe(true);

    const span = bandLevels(tileArtGeometry(set));
    expect(span).toBe(2);

    for (const elevation of [0, 1, 2, 3, 4, 9]) {
      for (const base of [0, 1, 3]) {
        const rust = JSON.parse(
          instance.previewTileRender(json, 'cliff', 'isometric', elevation, base, 0, '{}'),
        ) as ResolvedTileRender;
        const mirror = resolveTileRender(
          'cliff',
          set.tiles[0]?.art,
          'isometric',
          elevation,
          base,
          0,
          {},
          span,
        );

        expect(mirror, `at ${elevation} over ${base}`).toEqual(wire(rust));
      }
    }

    // And the shape itself, so a mirror that drifted *together* would still be
    // caught: three steps of cliff are one whole band and half of the next.
    const three = resolveTileRender('cliff', set.tiles[0]?.art, 'isometric', 3, 0, 0, {}, span);
    expect(three.layers.map((layer) => [layer.level, layer.drop])).toEqual([
      [1, 1],
      [2, -1],
    ]);
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

    expect(view.bounds).toEqual({ origin: [0, 0], width: 20, height: 20 });
    expect(view.palette).toHaveLength(7);
    expect(terrain).toBeInstanceOf(Uint8Array);
    expect(terrain.length).toBe(view.cellCount);

    // The shipped art rides on the palette, which is the renderer's one lookup
    // per cell (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
    // The step is half the 16-pixel band the ladders draw: the shipped set lifts
    // a level by half its own faces, so cliffs read at half height without a
    // single asset being redrawn.
    expect(view.tileArt).toEqual({
      width: 64,
      flatHeight: 74,
      surfaceHeight: 40,
      elevationHeight: 26,
      elevationStep: 8,
    });
    expect(view.palette.find((tile) => tile.id === 'grass')?.art?.surface).toHaveLength(8);
    expect(view.palette.find((tile) => tile.id === 'dirt')?.art?.elevation?.levels).toHaveLength(3);

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
    expect(view.characterHeightTiles).toBe(2);
    expect(view.grid).toEqual({ lineWidth: 1, color: '#000000', alpha: 0.25 });
    expect(elevation).toBeInstanceOf(Int8Array);
    expect(elevation.length).toBe(view.cellCount);
    // The demo has relief, and it lines up with the terrain buffer cell for cell.
    expect(Math.max(...elevation)).toBeGreaterThan(0);
  });

  it('advances exactly one tick per accepted move, and moves the monsters', () => {
    const instance = loaded();
    const start = JSON.parse(instance.createGame('demo_world', 2026, '{}')) as GameSnapshot;

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
    expect(
      monsterAfter.some((monster, index) => monster.at.join() !== monsterBefore[index]?.at.join()),
    ).toBe(true);

    expect(result.events.some((event) => event.type === 'tickAdvanced')).toBe(true);
    expect(result.events.filter((event) => event.type === 'entityMoved').length).toBeGreaterThan(1);
  });

  it('refuses an illegal move without advancing anything', () => {
    const instance = loaded();
    const start = JSON.parse(instance.createGame('demo_world', 2026, '{}')) as GameSnapshot;

    const result = JSON.parse(
      instance.dispatch(JSON.stringify({ type: 'moveTo', to: [19, 19] })),
    ) as CommandResult;

    expect(result.accepted).toBe(false);
    expect(result.rejection?.code).toBe('notAdjacent');
    expect(result.state).toEqual(start);
    expect(result.events).toEqual([{ type: 'actionRejected', reason: result.rejection }]);
  });

  it('only reports legal moves that the engine will actually accept', () => {
    const instance = loaded();
    const start = JSON.parse(instance.createGame('demo_world', 1, '{}')) as GameSnapshot;
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
      fresh.createGame('demo_world', 1, '{}');
      const result = JSON.parse(
        fresh.dispatch(JSON.stringify({ type: 'moveTo', to })),
      ) as CommandResult;
      expect(result.accepted).toBe(legal.has(to.join()));
    }
  });

  it('replays identically for the same seed and inputs', () => {
    const run = (): GameSnapshot => {
      const instance = loaded();
      instance.createGame('demo_world', 4242, '{}');
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
    const start = JSON.parse(instance.createGame('demo_world', 2026, '{}')) as GameSnapshot;
    const playerAxial = offsetToAxial({ col: start.player!.at[0], row: start.player!.at[1] });

    const distanceOf = (snapshot: GameSnapshot): number =>
      Math.min(
        ...snapshot.entities
          .filter((entity) => entity.kind === 'monster')
          .map((monster) =>
            hexDistance(offsetToAxial({ col: monster.at[0], row: monster.at[1] }), playerAxial),
          ),
      );

    const before = distanceOf(start);
    let last = start;
    for (let i = 0; i < 20; i += 1) {
      last = (JSON.parse(instance.dispatch(JSON.stringify({ type: 'wait' }))) as CommandResult)
        .state;
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
    const outcome = JSON.parse(
      instance.loadWorld(serializeWorld(document.toDefinition())),
    ) as LoadOutcome;

    expect(outcome.report.valid).toBe(true);
    const snapshot = JSON.parse(instance.createGame(outcome.id, 1, '{}')) as GameSnapshot;
    expect(snapshot.entities.filter((entity) => entity.kind === 'monster')).toHaveLength(3);
  });

  /**
   * A shape authored in the editor, through the real boundary and back out as
   * an engine verdict (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
   */
  it('carries a custom map shape across the boundary', () => {
    const tileSet = readJson<TileSetDefinition>('content/tilesets/mvp_terrain.json');
    const definition = readJson<WorldDefinition>('content/worlds/demo_world.json');

    const document = WorldDocument.fromDefinition(definition, tileSet);
    // A bay carved out of a corner nothing stands on, and the canvas pushed
    // north so the origin has to survive the round trip.
    const carved = [
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 0, row: 1 },
    ];
    for (const cell of carved) {
      expect(document.setPresent(cell, false)).toBe(true);
    }
    expect(document.resize({ origin: { col: 0, row: -2 }, width: 20, height: 22 })).toBe(true);

    const instance = engine();
    instance.loadTileSet(JSON.stringify(tileSet));
    const outcome = JSON.parse(
      instance.loadWorld(serializeWorld(document.toDefinition())),
    ) as LoadOutcome;
    expect(outcome.report.valid).toBe(true);

    const view = JSON.parse(instance.worldView(outcome.id)) as WorldView;
    expect(view.bounds).toEqual({ origin: [0, -2], width: 20, height: 22 });
    expect(view.cellCount).toBe(440);
    // Three cells carved, and the two rows of new canvas are empty too.
    expect(view.presentCellCount).toBe(400 - carved.length);

    const presence = instance.presenceBuffer(outcome.id);
    expect(presence).toBeInstanceOf(Uint8Array);
    expect(presence.length).toBe(view.cellCount);
    for (const cell of carved) {
      const index = (cell.row - view.bounds.origin[1]) * view.bounds.width + cell.col;
      expect(presence[index]).toBe(0);
    }

    // And the rule follows without asking: a hole is outside the map.
    const snapshot = JSON.parse(instance.createGame(outcome.id, 1, '{}')) as GameSnapshot;
    for (const [col, row] of snapshot.legalMoves) {
      expect(carved).not.toContainEqual({ col, row });
    }
  });

  /**
   * The whole map-link loop across the real boundary: the client loads the
   * project, walks onto a door, and the engine hands back a snapshot on the
   * other map (`docs/adr/ADR-0014-map-links.md`).
   */
  it('changes map when the player walks onto a door', () => {
    const instance = engine();
    instance.loadTileSet(tileSetJson());
    instance.loadWorld(worldJson());
    instance.loadWorld(readText('content/worlds/demo_refuge.json'));
    loadShippedLocales(instance);
    loadShippedTitleScreen(instance);
    loadShippedCharacters(instance);
    const project = JSON.parse(
      instance.loadProject(readText('content/project.json')),
    ) as LoadOutcome;
    expect(project.id).toBe('insulaire');

    expect((JSON.parse(instance.validateLinks()) as ValidationReport).valid).toBe(true);

    const view = JSON.parse(instance.worldView('demo_world')) as WorldView;
    expect(view.links).toHaveLength(1);
    const door = view.links[0] as WorldView['links'][number];
    expect(door.targetWorld).toBe('demo_refuge');

    instance.createGame('demo_world', 2026, '{}');
    const result = JSON.parse(
      instance.dispatch(JSON.stringify({ type: 'moveTo', to: door.at })),
    ) as CommandResult;

    expect(result.accepted).toBe(true);
    expect(result.state.worldId).toBe('demo_refuge');
    expect(result.state.player?.at).toEqual(door.targetAt);
    expect(result.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['linkTriggered', 'worldEntered']),
    );

    // The map the session moved to is drawable without another load.
    const inside = JSON.parse(instance.worldView(result.state.worldId)) as WorldView;
    expect(instance.terrainBuffer(inside.worldId).length).toBe(inside.cellCount);
  });

  it('refuses a project whose worlds are not loaded', () => {
    const instance = engine();
    instance.loadTileSet(tileSetJson());
    instance.loadWorld(worldJson());

    expect(() => instance.loadProject(readText('content/project.json'))).toThrow();
    const report = JSON.parse(instance.validateLinks()) as ValidationReport;
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain('link.unknownTargetWorld');
  });

  /**
   * The shipped languages, across the real boundary: the files this repository
   * ships load, resolve, and answer the same keys
   * (`docs/adr/ADR-0020-localised-content-keys.md`).
   */
  it('loads the shipped languages and resolves their keys', () => {
    const instance = loaded();
    instance.loadWorld(readText('content/worlds/demo_refuge.json'));

    for (const language of ['en', 'fr']) {
      const outcome = JSON.parse(
        instance.loadLocale(language, 'menu', readText(`content/locales/${language}/menu.json`)),
      ) as LoadOutcome;
      expect(outcome.id).toBe(`${language}/menu`);
    }
    loadShippedTitleScreen(instance);
    loadShippedCharacters(instance);
    instance.loadProject(readText('content/project.json'));

    const fr = JSON.parse(instance.locale('fr')) as LocaleView;
    expect(fr.language).toBe('fr');
    expect(fr.entries['menu.buttons.newGame']).toBe('Nouvelle partie');
    // Both shipped languages are complete, so nothing is served by fallback.
    expect(fr.fallbacks).toEqual([]);

    const report = JSON.parse(instance.validateLocales()) as ValidationReport;
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);

    const summary = JSON.parse(instance.contentSummary()) as ContentSummary;
    expect(summary.project?.languages.map((language) => language.id)).toEqual(['en', 'fr']);
    expect(summary.project?.languages[0]?.isDefault).toBe(true);
  });

  it('serves an untranslated key from the default language, and says so', () => {
    const instance = loaded();
    instance.loadWorld(readText('content/worlds/demo_refuge.json'));
    instance.loadLocale('en', 'menu', '{ "play": "Play", "quit": "Quit" }');
    instance.loadLocale('fr', 'menu', '{ "play": "Jouer" }');
    // A stand-in for the shipped screen: the manifest still requires the id it
    // names, but its keys have to be the ones these stub languages define.
    instance.loadTitleScreen(
      JSON.stringify({
        id: 'main',
        schemaVersion: 1,
        titleKey: 'menu.play',
        buttons: [{ action: 'newGame', labelKey: 'menu.play' }],
      }),
    );
    // The manifest names a settings file too, and its label keys have to resolve
    // against these stub languages just like the menu's.
    instance.loadSettings(
      JSON.stringify({
        id: 'insulaire_game',
        schemaVersion: 1,
        sections: [
          {
            id: 's',
            labelKey: 'menu.play',
            groups: [
              {
                id: 'g',
                labelKey: 'menu.play',
                fields: [{ id: 'f', labelKey: 'menu.play', control: 'toggle', default: false }],
              },
            ],
          },
        ],
      }),
    );
    loadShippedCharacters(instance);
    instance.loadProject(readText('content/project.json'));

    const fr = JSON.parse(instance.locale('fr')) as LocaleView;
    expect(fr.entries['menu.play']).toBe('Jouer');
    expect(fr.entries['menu.quit']).toBe('Quit');
    expect(fr.fallbacks).toEqual(['menu.quit']);

    const report = JSON.parse(instance.validateLocales()) as ValidationReport;
    expect(report.valid).toBe(true);
    expect(report.issues.map((issue) => issue.code)).toContain('locale.missingTranslation');
  });

  /**
   * The two halves of authoring text while the editor is running: a key that
   * exists but has no text yet behaves like a missing one, and edited files can
   * replace the loaded ones (`docs/adr/ADR-0020-localised-content-keys.md`).
   */
  it('treats an empty translation as a gap, and takes edited files back', () => {
    const instance = loaded();
    instance.loadWorld(readText('content/worlds/demo_refuge.json'));
    loadShippedTitleScreen(instance);

    // The shipped languages, plus one key an author has just created: written
    // in the default language, still empty in the other.
    const withKey = (path: string, text: string): string => {
      const tree = readJson<Record<string, Record<string, string>>>(path);
      tree['settings'] = { ...tree['settings'], unwritten: text };
      return JSON.stringify(tree);
    };
    instance.loadLocale('en', 'menu', readText('content/locales/en/menu.json'));
    instance.loadLocale('fr', 'menu', readText('content/locales/fr/menu.json'));
    instance.loadLocale('en', 'game', withKey('content/locales/en/game.json', 'Unwritten'));
    instance.loadLocale('fr', 'game', withKey('content/locales/fr/game.json', ''));
    loadShippedCharacters(instance);
    // The manifest names the default language, which is what a gap falls back to.
    instance.loadProject(readText('content/project.json'));

    const fr = JSON.parse(instance.locale('fr')) as LocaleView;
    // Created but not written: the default language answers, and the editor is
    // told the cell is still a gap.
    expect(fr.entries['game.settings.unwritten']).toBe('Unwritten');
    expect(fr.fallbacks).toContain('game.settings.unwritten');

    // What the language editor does after writing the files it just edited.
    instance.resetLocales();
    instance.loadLocale('en', 'game', withKey('content/locales/en/game.json', 'Unwritten'));
    instance.loadLocale('fr', 'game', withKey('content/locales/fr/game.json', 'Écrit'));

    const edited = JSON.parse(instance.locale('fr')) as LocaleView;
    expect(edited.entries['game.settings.unwritten']).toBe('Écrit');
    expect(edited.fallbacks).not.toContain('game.settings.unwritten');
    // The worlds the registry held are untouched by a language reset.
    expect((JSON.parse(instance.worldView('demo_world')) as WorldView).worldId).toBe('demo_world');
  });

  /**
   * The character pipeline, end to end and through the real types: the shipped
   * definition loads, resolves into drawable layers, and honours the choices it
   * offers. The editor's preview is this same call
   * (`docs/adr/ADR-0024-character-definitions.md`).
   */
  it('resolves the shipped character into layers a renderer can draw', () => {
    const instance = engine();
    const characterJson = readText('content/characters/human_player.json');

    const outcome = JSON.parse(instance.loadCharacter(characterJson)) as LoadOutcome;
    expect(outcome.id).toBe('human_player');
    expect(outcome.report.issues).toEqual([]);
    expect(JSON.parse(instance.characterIds()) as string[]).toEqual(['human_player']);

    const definition = JSON.parse(instance.character('human_player')) as CharacterDefinition;
    expect(definition.category).toBe('player');
    expect(definition.resolution).toEqual({ width: 64, height: 128 });
    expect(definition.parameters?.map((parameter) => parameter.id)).toEqual([
      'lineage',
      'gender',
      'hairStyle',
      'hairColor',
      'eyeColor',
      'height',
      'bust',
      'armor',
      'cape',
    ]);

    const resolved = JSON.parse(
      instance.resolveCharacter(
        'human_player',
        JSON.stringify({ hairColor: '#f2c14e' }),
        undefined,
        0,
      ),
    ) as ResolvedCharacter;
    expect(resolved.layers.map((layer) => layer.layer)).toEqual([
      'cape',
      'hairBack',
      'body',
      'legs',
      'top',
      'skirt',
      'hairFront',
    ]);
    // Every tint is resolved on the Rust side: the renderer only blits.
    const hair = resolved.layers.find((layer) => layer.layer === 'hairFront');
    expect(hair?.asset).toBe('assets/characters/hair_front.png');
    expect(hair?.tint).toBe('#f2c14e');
    // A sprite with no tint says so as an empty string, not as a colour.
    expect(resolved.layers.find((layer) => layer.layer === 'body')?.tint).toBe('');

    // A choice swaps a variant, and every box is whole pixels inside the canvas.
    const plated = JSON.parse(
      instance.resolveCharacter('human_player', JSON.stringify({ armor: 'plate' }), undefined, 0),
    ) as ResolvedCharacter;
    expect(plated.layers.find((layer) => layer.layer === 'top')?.variant).toBe('plate');
    for (const layer of plated.layers) {
      const [x, y, width, height] = layer.rect;
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(plated.resolution.width);
      expect(y + height).toBeLessThanOrEqual(plated.resolution.height);
    }

    // Turning the cape off removes the layer rather than drawing nothing.
    const bare = JSON.parse(
      instance.resolveCharacter('human_player', JSON.stringify({ cape: false }), undefined, 0),
    ) as ResolvedCharacter;
    expect(bare.layers.some((layer) => layer.layer === 'cape')).toBe(false);
  });

  it('resolves generic character creation without race or gender branches', () => {
    const instance = engine();
    instance.loadCharacter(readText('content/characters/human_player.json'));
    const json = readText('content/character-creation.json');
    const outcome = JSON.parse(instance.loadCharacterCreation(json)) as LoadOutcome;
    expect(outcome.report.issues).toEqual([]);

    const definition = JSON.parse(instance.characterCreation()) as CharacterCreationDefinition;
    expect(definition.choices?.map((choice) => choice.id)).toContain('lineage');
    expect(definition.choices?.map((choice) => choice.id)).not.toContain('armor');

    const result = JSON.parse(
      instance.resolveCharacterCreation(
        JSON.stringify({ lineage: 'elf', gender: 'man', hairStyle: 'long' }),
        JSON.stringify({ name: 'Neris', mana: null }),
      ),
    ) as CharacterCreationResult;
    expect(result.character).toBe('human_player');
    expect(result.parameters).toMatchObject({ lineage: 'elf', gender: 'man', hairStyle: 'long' });
    expect(result.parameters['armor']).toBeUndefined();
    expect(result.characteristics['name']).toBe('Neris');
    expect(result.characteristics['mana']).toBeNull();
  });

  /**
   * The animation pipeline, end to end and through the real types: one track
   * moves the body, the hierarchy moves what hangs off it, and the legs stay
   * on the ground (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`).
   */
  it('plays the shipped idle through the layer hierarchy', () => {
    const instance = engine();
    loadShippedCharacters(instance);

    const definition = JSON.parse(instance.character('human_player')) as CharacterDefinition;
    const idle = definition.animations?.find((animation) => animation.id === 'idle');
    expect(idle?.looping).toBe(true);
    expect(idle?.frames).toBe(4);
    expect(idle?.role).toBe('idle');
    // Two tracks for seven layers: the rest move because of the tree.
    expect(idle?.tracks).toHaveLength(2);

    const at = (timeMs: number): ResolvedCharacter =>
      JSON.parse(
        instance.resolveCharacter('human_player', '{}', 'idle', timeMs),
      ) as ResolvedCharacter;
    const offsetOf = (resolved: ResolvedCharacter, layer: string): number =>
      resolved.layers.find((drawn) => drawn.layer === layer)?.offset[1] ?? Number.NaN;

    const rest = at(0);
    expect(rest.pose).toEqual({ animation: 'idle', frame: 0, timeMs: 0, durationMs: 560 });
    expect(rest.layers.every((layer) => layer.offset[0] === 0 && layer.offset[1] === 0)).toBe(true);

    // Frame 1: the top of the breath.
    const duration = (idle?.frameDurationMs ?? 0) as number;
    const up = at(duration);
    expect(up.pose?.frame).toBe(1);
    for (const layer of ['body', 'cape', 'hairBack', 'hairFront', 'top', 'skirt']) {
      expect(offsetOf(up, layer)).toBe(-1);
    }
    expect(offsetOf(up, 'legs')).toBe(0);

    // Frame 3: the hair's own keyframe adds to what it inherited.
    const down = at(duration * 3);
    expect(offsetOf(down, 'body')).toBe(1);
    expect(offsetOf(down, 'hairFront')).toBe(2);
    // The offset is already in the box the renderer draws.
    const body = down.layers.find((layer) => layer.layer === 'body');
    const restBody = rest.layers.find((layer) => layer.layer === 'body');
    expect(body?.rect[1]).toBe((restBody?.rect[1] ?? 0) + 1);

    // It loops: a whole cycle later it is the same picture.
    expect(at(duration * 4 * 5).layers).toEqual(rest.layers);

    // An id the definition does not declare is the rest pose, not an error.
    const unknown = JSON.parse(
      instance.resolveCharacter('human_player', '{}', 'walk', 3_000),
    ) as ResolvedCharacter;
    expect(unknown.pose).toBeUndefined();
  });

  /**
   * The shipped walk cycle, through the real WASM build: a leg sprite per
   * frame, and the other direction authored as one line
   * (`docs/adr/ADR-0025-characters-animate-by-hierarchy-and-offsets.md`).
   */
  it('walks the shipped character left, and mirrors it to walk right', () => {
    const instance = engine();
    loadShippedCharacters(instance);

    const at = (animation: string, timeMs: number): ResolvedCharacter =>
      JSON.parse(
        instance.resolveCharacter('human_player', '{}', animation, timeMs),
      ) as ResolvedCharacter;
    const legs = (resolved: ResolvedCharacter) =>
      resolved.layers.find((layer) => layer.layer === 'legs');

    // Every layer that has a side-on drawing takes it for the whole
    // animation, and the legs take a different one every frame.
    const frames = ['sideContact', 'sidePass', 'sideContactBack', 'sidePassBack'];
    const rest = JSON.parse(
      instance.resolveCharacter('human_player', '{}', undefined, 0),
    ) as ResolvedCharacter;
    expect(legs(rest)?.variant).toBe('stand');

    for (const [index, variant] of frames.entries()) {
      const posed = at('walking_left', index * 130);
      expect(legs(posed)?.variant).toBe(variant);
      expect(legs(posed)?.rect).toEqual(legs(rest)?.rect);
      expect(posed.mirrored).toBe(false);
      // The body says `view: side` once and answers all four frames.
      expect(posed.layers.find((layer) => layer.layer === 'body')?.variant).toBe('side');
      expect(posed.pose?.values?.['view']).toBe('side');
    }

    // The cape steps in front of the body while the walk plays, chosen by the
    // same condition that chose its side-on drawing.
    const sideways = at('walking_left', 0);
    const order = sideways.layers.map((layer) => layer.layer);
    expect(order.indexOf('cape')).toBeGreaterThan(order.indexOf('body'));
    const rest2 = JSON.parse(
      instance.resolveCharacter('human_player', '{}', undefined, 0),
    ) as ResolvedCharacter;
    const restOrder = rest2.layers.map((layer) => layer.layer);
    expect(restOrder.indexOf('cape')).toBeLessThan(restOrder.indexOf('body'));

    // Boxes are measured from the joint their layer hangs off, and the engine
    // is what turns that back into a place on the canvas.
    const top = sideways.layers.find((layer) => layer.layer === 'top');
    // The shoulders anchor is at 32, 36 and the top's box is -9, 0 from it.
    expect(top?.origin).toEqual([32, 36]);
    expect(top?.rect).toEqual([23, 36, 18, 14]);

    // A pose is not a customisation: it chose the variants and it is reported,
    // but it never joins the values the character was resolved with.
    const posed = at('walking_left', 130);
    expect(posed.pose?.values?.['step']).toBe('pass');
    expect(posed.values['step']).toBeUndefined();

    // And it combines with the customisation rather than replacing it: plate
    // armour seen from the side is its own drawing, chosen by both at once.
    const plated = JSON.parse(
      instance.resolveCharacter('human_player', '{"armor":"plate"}', 'walking_left', 0),
    ) as ResolvedCharacter;
    expect(plated.layers.find((layer) => layer.layer === 'top')?.variant).toBe('plateSide');

    // walking_right is walking_left with one flag different — same sprites,
    // same boxes, same clock.
    for (const timeMs of [0, 130, 260, 390, 1_000]) {
      const left = at('walking_left', timeMs);
      const right = at('walking_right', timeMs);
      expect(right.mirrored).toBe(true);
      expect(right.layers).toEqual(left.layers);
      expect(right.pose?.animation).toBe('walking_right');
      expect(right.pose?.frame).toBe(left.pose?.frame);
    }

    // Gameplay names the exact hex direction. With no six-way override in the
    // shipped art, west-facing directions share the left cycle and east-facing
    // ones share its mirror.
    const northWest = JSON.parse(
      instance.resolveCharacterRole('human_player', '{}', 'moveNorthWest', 130),
    ) as ResolvedCharacter;
    const southEast = JSON.parse(
      instance.resolveCharacterRole('human_player', '{}', 'moveSouthEast', 130),
    ) as ResolvedCharacter;
    expect(northWest.pose?.animation).toBe('walking_left');
    expect(northWest.mirrored).toBe(false);
    expect(southEast.pose?.animation).toBe('walking_right');
    expect(southEast.mirrored).toBe(true);
    expect(southEast.pose?.durationMs).toBe(520);
  });

  /** What the editor previews with: a definition in hand, not registered. */
  it('previews an unregistered definition and refuses to draw it wrong', () => {
    const instance = engine();
    const definition = readJson<CharacterDefinition>('content/characters/human_player.json');
    const layer = definition.layers?.[0]?.variants?.[0];
    if (layer !== undefined) {
      layer.sprite.asset = '';
    }

    // Previewing is total, so a definition that cannot load still draws.
    const resolved = JSON.parse(
      instance.previewCharacter(JSON.stringify(definition), '{}', undefined, 0),
    ) as ResolvedCharacter;
    expect(resolved.layers).toHaveLength(7);

    // Loading it is what refuses: a sprite layer that names no image.
    const report = JSON.parse(
      instance.validateCharacter(JSON.stringify(definition)),
    ) as ValidationReport;
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain('character.missingAsset');
  });

  /**
   * A decoration crosses the boundary the same way a character does, and the
   * placement box comes back with the anchor already subtracted — the editor
   * and the map both blit at the cell's ground point plus that box
   * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   */
  it('resolves a decoration onto the ground point, frame by frame', () => {
    const instance = engine();
    const torch: DecorationDefinition = {
      id: 'torch',
      schemaVersion: DECORATION_SCHEMA_VERSION,
      resolution: { width: 16, height: 32 },
      anchor: [8, 31],
      plane: 'front',
      order: 2,
      animations: [
        {
          id: 'burning',
          frames: ['assets/decorations/torch_0.png', 'assets/decorations/torch_1.png'],
          frameDurationMs: 100,
          looping: true,
        },
      ],
    };
    const json = serializeDecoration(torch);

    const outcome = JSON.parse(instance.loadDecoration(json)) as LoadOutcome;
    expect(outcome.report.valid).toBe(true);

    const resolved = JSON.parse(
      instance.resolveDecoration('torch', 'burning', 100),
    ) as ResolvedDecoration;
    expect(resolved.asset).toBe('assets/decorations/torch_1.png');
    expect(resolved.placement).toEqual([-8, -31, 16, 32]);
    expect(resolved.plane).toBe('front');
    // Looping, so twice the duration is back to the first drawing.
    expect(
      (JSON.parse(instance.resolveDecoration('torch', 'burning', 200)) as ResolvedDecoration).frame,
    ).toBe(0);

    // Previewing is total: a definition being written still draws.
    const preview = JSON.parse(
      instance.previewDecoration(json, undefined, 0),
    ) as ResolvedDecoration;
    expect(preview.animation).toBe('burning');
  });

  /**
   * The anchor is a position **on the cell**, so it is the drawing leaving the
   * hexagon that is worth reporting — never the anchor leaving the decoration's
   * own canvas, which is what a small prop dropped off-centre looks like
   * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   */
  it('warns about a decoration that overflows its cell, and only then', () => {
    const instance = engine();
    const cell = tileArtGeometry(readJson<TileSetDefinition>('content/tilesets/mvp_terrain.json'));
    const pebble: DecorationDefinition = {
      id: 'pebble',
      schemaVersion: DECORATION_SCHEMA_VERSION,
      resolution: { width: 12, height: 12 },
      // Nowhere near its own 12x12 canvas, and well inside a 64x74 hex.
      anchor: [28, 14],
      animations: [{ id: 'idle', frames: ['assets/decorations/pebble.png'] }],
    };

    const inside = JSON.parse(
      instance.validateDecoration(serializeDecoration(pebble), JSON.stringify(cell)),
    ) as ValidationReport;
    expect(inside.valid).toBe(true);
    expect(inside.issues).toHaveLength(0);

    // A tree taller than its hex: still valid, and now said out loud.
    const tree: DecorationDefinition = {
      ...pebble,
      resolution: { width: 64, height: 120 },
      anchor: [32, 119],
    };
    const over = JSON.parse(
      instance.validateDecoration(serializeDecoration(tree), JSON.stringify(cell)),
    ) as ValidationReport;
    expect(over.valid).toBe(true);
    expect(over.issues.map((issue) => issue.code)).toContain('decoration.overflowsCell');

    // With no cell in hand there is nothing to measure against, and nothing is
    // claimed — which is what loading a decoration does.
    const alone = JSON.parse(
      instance.validateDecoration(serializeDecoration(tree), ''),
    ) as ValidationReport;
    expect(alone.issues).toHaveLength(0);
  });

  /**
   * A placement is what a scenario addresses, and `interactive` is a fact about
   * **this** tree rather than about trees
   * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   */
  it('carries placed decorations through the world view, one interactive', () => {
    const instance = engine();
    instance.loadTileSet(tileSetJson());
    const world = JSON.parse(worldJson()) as WorldDefinition;
    world.decorations = [
      { id: 'oak_0', decoration: 'oak', at: [1, 1] },
      { id: 'oak_1', decoration: 'oak', at: [1, 1], offset: [-6, 2], interactive: true },
    ];
    instance.loadWorld(serializeWorld(world));

    const view = JSON.parse(instance.worldView(world.id)) as WorldView;
    expect((view.decorations ?? []).map((placed) => placed.id)).toEqual(['oak_0', 'oak_1']);
    expect(view.decorations?.[0]?.interactive).toBe(false);
    expect(view.decorations?.[1]?.interactive).toBe(true);
    // Two oaks on one hex, and the nudge is what keeps them from being one
    // oak drawn twice in the same place.
    expect(view.decorations?.[0]?.offset).toEqual([0, 0]);
    expect(view.decorations?.[1]?.offset).toEqual([-6, 2]);

    // Which definitions exist is a project-level question, so a world naming
    // one nothing loaded still loads on its own.
    const report = JSON.parse(instance.validateWorld(serializeWorld(world))) as ValidationReport;
    expect(report.valid).toBe(true);
  });

  it('refuses an object whose stack is impossible, and takes a sound one', () => {
    const instance = engine();
    const potion: ObjectDefinition = {
      id: 'small_potion',
      schemaVersion: OBJECT_SCHEMA_VERSION,
      kind: 'consumable',
      nameKey: 'game.object.smallPotion.name',
      frames: ['assets/objects/small_potion.png'],
      resolution: { width: 16, height: 16 },
      stackSize: 10,
    };

    const outcome = JSON.parse(instance.loadObject(serializeObject(potion))) as LoadOutcome;
    expect(outcome.report.valid).toBe(true);
    expect(JSON.parse(instance.objectIds()) as string[]).toEqual(['small_potion']);

    const report = JSON.parse(
      instance.validateObject(serializeObject({ ...potion, stackSize: 0 })),
    ) as ValidationReport;
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain('object.invalidStackSize');
  });

  /**
   * An icon is a flipbook, and the one frame nearly every object has is the
   * degenerate case of it: still, whenever it is asked for
   * (`docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).
   */
  it('plays an object icon through the real resolver, and holds a still one', () => {
    const instance = engine();
    const gem: ObjectDefinition = {
      id: 'gem',
      schemaVersion: OBJECT_SCHEMA_VERSION,
      kind: 'material',
      nameKey: 'game.object.gem.name',
      frames: ['assets/objects/gem_0.png', 'assets/objects/gem_1.png'],
      frameDurationMs: 100,
      looping: true,
      resolution: { width: 16, height: 16 },
    };

    const loaded = JSON.parse(instance.loadObject(serializeObject(gem))) as LoadOutcome;
    expect(loaded.report.valid).toBe(true);

    const first = JSON.parse(instance.resolveObject('gem', 0)) as ResolvedObject;
    expect(first.asset).toBe('assets/objects/gem_0.png');
    expect(first.durationMs).toBe(200);

    const second = JSON.parse(instance.resolveObject('gem', 150)) as ResolvedObject;
    expect(second.frame).toBe(1);
    expect(second.asset).toBe('assets/objects/gem_1.png');

    // Past the end it wraps, because this one loops: 250ms is 50ms into the
    // second play.
    expect((JSON.parse(instance.resolveObject('gem', 250)) as ResolvedObject).frame).toBe(0);

    // A still icon, previewed from the editor's hand rather than registered.
    const still = JSON.parse(
      instance.previewObject(
        serializeObject({
          id: 'letter',
          schemaVersion: OBJECT_SCHEMA_VERSION,
          nameKey: 'game.object.letter.name',
          frames: ['assets/objects/letter.png'],
        }),
        9_000,
      ),
    ) as ResolvedObject;
    expect(still.frame).toBe(0);
    expect(still.frames).toBe(1);
    expect(still.asset).toBe('assets/objects/letter.png');
  });

  /**
   * An object blocked out before its art exists still saves: no frame is a
   * warning, and a frame naming nothing is the error
   * (`docs/adr/ADR-0036-an-object-is-carried-not-placed.md`).
   */
  it('warns about an object with no icon, and refuses one with an empty frame', () => {
    const instance = engine();
    const blank = JSON.parse(
      instance.validateObject(
        serializeObject({ id: 'draft', schemaVersion: OBJECT_SCHEMA_VERSION }),
      ),
    ) as ValidationReport;
    expect(blank.valid).toBe(true);
    expect(blank.issues.map((issue) => issue.code)).toContain('object.noFrames');

    const empty = JSON.parse(
      instance.validateObject(
        serializeObject({
          id: 'draft',
          schemaVersion: OBJECT_SCHEMA_VERSION,
          nameKey: 'game.object.draft.name',
          frames: [''],
        }),
      ),
    ) as ValidationReport;
    expect(empty.valid).toBe(false);
    expect(empty.issues.map((issue) => issue.code)).toContain('object.missingFrame');
  });

  it('refuses a project naming a character it never loaded', () => {
    const instance = engine();
    instance.loadTileSet(tileSetJson());
    instance.loadWorld(worldJson());
    instance.loadWorld(readText('content/worlds/demo_refuge.json'));
    loadShippedLocales(instance);
    loadShippedTitleScreen(instance);

    expect(() => instance.loadProject(readText('content/project.json'))).toThrow(
      /project.unloadedCharacter/,
    );

    loadShippedCharacters(instance);
    const outcome = JSON.parse(
      instance.loadProject(readText('content/project.json')),
    ) as LoadOutcome;
    expect(outcome.report.valid).toBe(true);
    const summary = JSON.parse(instance.contentSummary()) as ContentSummary;
    expect(summary.characters).toEqual(['human_player']);
    expect(summary.characterCreation).toBe('new_game');
  });

  it('rejects a world with no player, listing the reason', () => {
    const definition = readJson<WorldDefinition>('content/worlds/demo_world.json');
    definition.entities = (definition.entities ?? []).filter(
      (entity) => entity.templateId !== 'player',
    );

    const instance = engine();
    instance.loadTileSet(tileSetJson());

    const report = JSON.parse(
      instance.validateWorld(serializeWorld(definition)),
    ) as ValidationReport;
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
