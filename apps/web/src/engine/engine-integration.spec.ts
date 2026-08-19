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
  ResolvedCharacter,
  TileSetDefinition,
  WorldDefinition,
} from '../content/content-types';
import { WorldDocument } from '../content/world-document';
import { serializeWorld } from '../content/world-serializer';
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
   * these too (`docs/adr/ADR-0023-localised-content-keys.md`).
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
   * without it (`docs/adr/ADR-0024-authored-title-screen.md`).
   */
  function loadShippedTitleScreen(instance: RawInsulaireEngine): void {
    instance.loadTitleScreen(readText('content/menu/title-screen.json'));
    instance.loadSettings(readText('content/settings.json'));
  }

  /** Every character definition the manifest lists; the project needs them all. */
  function loadShippedCharacters(instance: RawInsulaireEngine): void {
    instance.loadCharacter(readText('content/characters/human_player.json'));
  }

  it('reports that it is running as WebAssembly', () => {
    const info = JSON.parse(engine().engineInfo()) as EngineInfo;

    expect(info.name).toBe('insulaire-engine');
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
    expect(monsterAfter.some((monster, index) => monster.at.join() !== monsterBefore[index]?.at.join())).toBe(
      true,
    );

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
    expect(result.events).toEqual([
      { type: 'actionRejected', reason: result.rejection },
    ]);
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
      const result = JSON.parse(fresh.dispatch(JSON.stringify({ type: 'moveTo', to }))) as CommandResult;
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
    const snapshot = JSON.parse(instance.createGame(outcome.id, 1, '{}')) as GameSnapshot;
    expect(snapshot.entities.filter((entity) => entity.kind === 'monster')).toHaveLength(3);
  });

  /**
   * The whole map-link loop across the real boundary: the client loads the
   * project, walks onto a door, and the engine hands back a snapshot on the
   * other map (`docs/adr/ADR-0017-map-links.md`).
   */
  it('changes map when the player walks onto a door', () => {
    const instance = engine();
    instance.loadTileSet(tileSetJson());
    instance.loadWorld(worldJson());
    instance.loadWorld(readText('content/worlds/demo_refuge.json'));
    loadShippedLocales(instance);
    loadShippedTitleScreen(instance);
    loadShippedCharacters(instance);
    const project = JSON.parse(instance.loadProject(readText('content/project.json'))) as LoadOutcome;
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
   * (`docs/adr/ADR-0023-localised-content-keys.md`).
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
                fields: [
                  { id: 'f', labelKey: 'menu.play', control: 'toggle', default: false },
                ],
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
   * replace the loaded ones (`docs/adr/ADR-0027-authoring-creates-keys.md`).
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
   * (`docs/adr/ADR-0028-character-definitions.md`).
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
      'hairStyle',
      'hairColor',
      'armor',
      'cape',
    ]);

    const resolved = JSON.parse(
      instance.resolveCharacter('human_player', JSON.stringify({ hairColor: '#f2c14e' }), undefined, 0),
    ) as ResolvedCharacter;
    expect(resolved.layers.map((layer) => layer.layer)).toEqual([
      'cape',
      'hairBack',
      'body',
      'boots',
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

  /**
   * The animation pipeline, end to end and through the real types: one track
   * moves the body, the hierarchy moves what hangs off it, and the boots stay
   * on the ground (`docs/adr/ADR-0031-characters-animate-by-hierarchy-and-offsets.md`).
   */
  it('plays the shipped idle through the layer hierarchy', () => {
    const instance = engine();
    loadShippedCharacters(instance);

    const definition = JSON.parse(
      instance.character('human_player'),
    ) as CharacterDefinition;
    const idle = definition.animations?.find((animation) => animation.id === 'idle');
    expect(idle?.looping).toBe(true);
    expect(idle?.frames).toBe(4);
    // Two tracks for seven layers: the rest move because of the tree.
    expect(idle?.tracks).toHaveLength(2);

    const at = (timeMs: number): ResolvedCharacter =>
      JSON.parse(instance.resolveCharacter('human_player', '{}', 'idle', timeMs)) as
        ResolvedCharacter;
    const offsetOf = (resolved: ResolvedCharacter, layer: string): number =>
      resolved.layers.find((drawn) => drawn.layer === layer)?.offset[1] ?? Number.NaN;

    const rest = at(0);
    expect(rest.pose).toEqual({ animation: 'idle', frame: 0, timeMs: 0 });
    expect(rest.layers.every((layer) => layer.offset[0] === 0 && layer.offset[1] === 0)).toBe(true);

    // Frame 1: the top of the breath.
    const duration = (idle?.frameDurationMs ?? 0) as number;
    const up = at(duration);
    expect(up.pose?.frame).toBe(1);
    for (const layer of ['body', 'cape', 'hairBack', 'hairFront', 'top', 'skirt']) {
      expect(offsetOf(up, layer)).toBe(-1);
    }
    expect(offsetOf(up, 'boots')).toBe(0);

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
    const outcome = JSON.parse(instance.loadProject(readText('content/project.json'))) as LoadOutcome;
    expect(outcome.report.valid).toBe(true);
    const summary = JSON.parse(instance.contentSummary()) as ContentSummary;
    expect(summary.characters).toEqual(['human_player']);
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
