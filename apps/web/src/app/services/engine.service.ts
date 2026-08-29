/**
 * The single door between Angular and the Rust engine.
 *
 * Everything Angular knows about the simulation goes through this service:
 * it loads the WASM module once, wraps every call so failures arrive as typed
 * {@link EngineError}s instead of raw JSON strings, and parses the boundary's
 * JSON into the interfaces in `engine.types.ts`.
 *
 * It contains **no game rules**. There is no adjacency check, no passability
 * check and no tick arithmetic here — those live in Rust
 * (`docs/adr/ADR-0001-separation-ui-engine.md`).
 */

import { Injectable, signal } from '@angular/core';

import {
  AnimationRole,
  CharacterCreationDefinition,
  CharacterCreationResult,
  CharacterDefinition,
  CharacterValues,
  DecorationDefinition,
  ObjectDefinition,
  PlacedTileArt,
  ProjectionMode,
  ResolvedCharacter,
  ResolvedDecoration,
  ResolvedObject,
  SettingsDefinition,
  SettingsValues,
  TileArtGeometry,
  TitleScreenDefinition,
} from '../../content/content-types';
import {
  CommandResult,
  ContentSummary,
  EngineCommand,
  EngineError,
  EngineInfo,
  GameSnapshot,
  LoadOutcome,
  LocaleView,
  RawInsulaireEngine,
  ValidationReport,
  WorldView,
} from '../../engine/engine.types';
import { ResolvedTileRender } from '../../renderer/tile-art';
import { loadEngineModule } from '../../engine/load-engine-module';

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * Which animation a character is playing, and how far into it.
 *
 * Time rather than a frame number: a frame is how an author *writes* an
 * animation, milliseconds are how anything *plays* one, and the engine owns the
 * conversion so the editor's preview and a game loop cannot disagree about it
 * (`docs/adr/ADR-0031-characters-animate-by-hierarchy-and-offsets.md`).
 */
export interface CharacterPose {
  /** Id of the animation. One the definition does not declare is the rest pose. */
  animation: string;
  /** Milliseconds since it started; it loops or holds on its own. */
  timeMs: number;
}

@Injectable({ providedIn: 'root' })
export class EngineService {
  private instance: RawInsulaireEngine | null = null;
  private initialisation: Promise<RawInsulaireEngine> | null = null;

  /** Lifecycle of the WASM module, for the UI to reflect. */
  readonly status = signal<EngineStatus>('idle');
  /** Build identity reported by the engine once it is up. */
  readonly info = signal<EngineInfo | null>(null);
  /** Why loading failed, when it did. */
  readonly failure = signal<string | null>(null);

  /** Whether a game is in progress; mirrored from the engine, see {@link hasGame}. */
  private readonly running = signal(false);

  /**
   * Loads and initialises the engine, at most once.
   *
   * @throws Error when the WASM artefacts are missing or fail to start.
   */
  async ready(): Promise<RawInsulaireEngine> {
    this.initialisation ??= this.initialise();
    return this.initialisation;
  }

  private async initialise(): Promise<RawInsulaireEngine> {
    this.status.set('loading');
    try {
      const module = await loadEngineModule();
      const engine = new module.InsulaireEngine();
      this.instance = engine;
      this.info.set(this.parse<EngineInfo>(() => engine.engineInfo()));
      this.status.set('ready');
      this.failure.set(null);
      return engine;
    } catch (cause) {
      this.status.set('failed');
      this.failure.set(cause instanceof Error ? cause.message : String(cause));
      this.initialisation = null;
      throw cause;
    }
  }

  /** `true` once the engine is usable. */
  get isReady(): boolean {
    return this.instance !== null;
  }

  // ---------------------------------------------------------------- content

  /** Registers a tile set. */
  loadTileSet(json: string): LoadOutcome {
    return this.parse<LoadOutcome>(() => this.engine().loadTileSet(json));
  }

  /**
   * Validates a tile set **without** registering it.
   *
   * What the asset editor calls before writing a file: the same validator the
   * runtime loads with (`docs/adr/ADR-0015-shared-content-validation.md`).
   */
  validateTileSet(json: string): ValidationReport {
    return this.parse<ValidationReport>(() => this.engine().validateTileSet(json));
  }

  /**
   * Resolves what to draw for one cell of a tile set **passed in** — the asset
   * editor's preview, for content that is not registered yet
   * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
   *
   * `projection` is the world's own: `'isometric'` resolves the surface and the
   * cliff, anything else the flat image
   * (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
   *
   * `choice` is what the cell picked by hand, resolved against the set passed
   * in; the default rolls everything, which is what a plain preview wants
   * (`docs/adr/ADR-0036-a-cell-may-choose-its-tile-art.md`).
   */
  previewTileRender(
    tileSetJson: string,
    tileId: string,
    projection: ProjectionMode,
    elevation: number,
    base = 0,
    roll = 0,
    choice: PlacedTileArt = {},
  ): ResolvedTileRender {
    return this.parse<ResolvedTileRender>(() =>
      this.engine().previewTileRender(
        tileSetJson,
        tileId,
        projection,
        elevation,
        base,
        roll,
        JSON.stringify(choice),
      ),
    );
  }

  /** Registers a world, replacing any world with the same id. */
  loadWorld(json: string): LoadOutcome {
    return this.parse<LoadOutcome>(() => this.engine().loadWorld(json));
  }

  /**
   * Registers the project manifest, after the content it lists.
   *
   * The engine validates it against what is actually loaded, so a bundle
   * missing a file fails here rather than when a player walks through a door.
   */
  loadProject(json: string): LoadOutcome {
    return this.parse<LoadOutcome>(() => this.engine().loadProject(json));
  }

  /**
   * Registers one locale file under a language and a namespace.
   *
   * The namespace prefixes every key in the file, so `menu.json` loaded as
   * `menu` answers `menu.title.buttons.newGame`
   * (`docs/adr/ADR-0023-localised-content-keys.md`).
   */
  loadLocale(language: string, namespace: string, json: string): LoadOutcome {
    return this.parse<LoadOutcome>(() => this.engine().loadLocale(language, namespace, json));
  }

  /**
   * One language's text, with the project's default language filling the gaps.
   *
   * Resolution happens in Rust so every host answers a key the same way — the
   * UI never implements a fallback of its own.
   */
  locale(language: string): LocaleView {
    return this.parse<LocaleView>(() => this.engine().locale(language));
  }

  /**
   * Compares the loaded languages against the manifest and each other.
   *
   * The editor's translation report: missing translations, orphan keys and
   * empty values.
   */
  validateLocales(): ValidationReport {
    return this.parse<ValidationReport>(() => this.engine().validateLocales());
  }

  /**
   * Registers the title screen a client opens on.
   *
   * Load it before the project, which validates that the screen it names is
   * actually loaded (`docs/adr/ADR-0024-authored-title-screen.md`).
   */
  loadTitleScreen(json: string): LoadOutcome {
    return this.parse<LoadOutcome>(() => this.engine().loadTitleScreen(json));
  }

  /**
   * Validates a title screen without registering it — the editor's check.
   *
   * Unlike loading, this also resolves the keys it references against the
   * loaded languages.
   */
  validateTitleScreen(json: string): ValidationReport {
    return this.parse<ValidationReport>(() => this.engine().validateTitleScreen(json));
  }

  /** The registered title screen, defaults filled in by the engine. */
  titleScreen(): TitleScreenDefinition {
    return this.parse<TitleScreenDefinition>(() => this.engine().titleScreen());
  }

  /**
   * Registers a character definition, before the project that lists it.
   *
   * A definition says how a *kind* of character is drawn — the player's, an
   * NPC's, a monster's — and offers the choices that may be made about one
   * (`docs/adr/ADR-0028-character-definitions.md`).
   */
  loadCharacter(json: string): LoadOutcome {
    return this.parse<LoadOutcome>(() => this.engine().loadCharacter(json));
  }

  /** Validates a character definition without registering it, keys included. */
  validateCharacter(json: string): ValidationReport {
    return this.parse<ValidationReport>(() => this.engine().validateCharacter(json));
  }

  /** A registered character definition, defaults filled in by the engine. */
  character(id: string): CharacterDefinition {
    return this.parse<CharacterDefinition>(() => this.engine().character(id));
  }

  /** Ids of every registered character definition. */
  characterIds(): string[] {
    return this.parse<string[]>(() => this.engine().characterIds());
  }

  /**
   * Registers a decoration definition, before the project that lists it.
   *
   * A decoration is a kind of thing that stands on a hex — a tree, a chest, a
   * bush — with the anchor, plane and order that decide how it shares that hex
   * with the characters walking over it
   * (`docs/adr/ADR-0048-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   */
  loadDecoration(json: string): LoadOutcome {
    return this.parse<LoadOutcome>(() => this.engine().loadDecoration(json));
  }

  /**
   * Validates a decoration definition without registering it.
   *
   * `cell` is the pixel grid it will stand among. Without one the file's own
   * shape is still checked and only `decoration.overflowsCell` is skipped —
   * which is why the editor, which knows its tile set, passes one
   * (`docs/adr/ADR-0048-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   */
  validateDecoration(json: string, cell?: TileArtGeometry): ValidationReport {
    return this.parse<ValidationReport>(() =>
      this.engine().validateDecoration(json, cell === undefined ? '' : JSON.stringify(cell)),
    );
  }

  /** A registered decoration definition, defaults filled in by the engine. */
  decoration(id: string): DecorationDefinition {
    return this.parse<DecorationDefinition>(() => this.engine().decoration(id));
  }

  /** Ids of every registered decoration definition. */
  decorationIds(): string[] {
    return this.parse<string[]>(() => this.engine().decorationIds());
  }

  /**
   * Resolves a registered decoration at a moment of one of its animations.
   *
   * `animation` of `undefined` — or an id the definition does not declare — is
   * its resting appearance.
   */
  resolveDecoration(id: string, animation?: string, timeMs = 0): ResolvedDecoration {
    return this.parse<ResolvedDecoration>(() =>
      this.engine().resolveDecoration(id, animation ?? undefined, Math.max(0, Math.round(timeMs))),
    );
  }

  /**
   * Resolves a decoration definition **in hand**, without registering it.
   *
   * What the editor previews with, for the reason {@link previewCharacter}
   * exists: the definition being written is not registered, and may not be
   * valid yet, but it still has to be visible.
   */
  previewDecoration(
    decoration: DecorationDefinition,
    animation?: string,
    timeMs = 0,
  ): ResolvedDecoration {
    return this.parse<ResolvedDecoration>(() =>
      this.engine().previewDecoration(
        JSON.stringify(decoration),
        animation ?? undefined,
        Math.max(0, Math.round(timeMs)),
      ),
    );
  }

  /**
   * Registers an object definition, before the project that lists it.
   *
   * An object is carried, not placed: an inventory item, a piece of equipment,
   * a quest token (`docs/adr/ADR-0049-an-object-is-carried-not-placed.md`).
   */
  loadObject(json: string): LoadOutcome {
    return this.parse<LoadOutcome>(() => this.engine().loadObject(json));
  }

  /** Validates an object definition without registering it, keys included. */
  validateObject(json: string): ValidationReport {
    return this.parse<ValidationReport>(() => this.engine().validateObject(json));
  }

  /** A registered object definition, defaults filled in by the engine. */
  object(id: string): ObjectDefinition {
    return this.parse<ObjectDefinition>(() => this.engine().object(id));
  }

  /** Ids of every registered object definition. */
  objectIds(): string[] {
    return this.parse<string[]>(() => this.engine().objectIds());
  }

  /**
   * Resolves a registered object's icon at a moment of its flipbook.
   *
   * The frame arithmetic is Rust's, so an inventory panel and the editor's
   * preview cannot disagree about which drawing is on screen
   * (`docs/adr/ADR-0050-an-object-icon-is-a-flipbook.md`).
   */
  resolveObject(id: string, timeMs = 0): ResolvedObject {
    return this.parse<ResolvedObject>(() =>
      this.engine().resolveObject(id, Math.max(0, Math.round(timeMs))),
    );
  }

  /**
   * Resolves an object definition **in hand**, without registering it.
   *
   * What the object editor previews with: the definition being written is not
   * registered and may not be valid yet, and it still has to be visible.
   */
  previewObject(object: ObjectDefinition, timeMs = 0): ResolvedObject {
    return this.parse<ResolvedObject>(() =>
      this.engine().previewObject(JSON.stringify(object), Math.max(0, Math.round(timeMs))),
    );
  }

  /** Registers the generic player-character creation declaration. */
  loadCharacterCreation(json: string): LoadOutcome {
    return this.parse<LoadOutcome>(() => this.engine().loadCharacterCreation(json));
  }

  /** Validates a creation declaration against the loaded character library. */
  validateCharacterCreation(json: string): ValidationReport {
    return this.parse<ValidationReport>(() => this.engine().validateCharacterCreation(json));
  }

  /** The registered creation declaration, defaults filled in by Rust. */
  characterCreation(): CharacterCreationDefinition {
    return this.parse<CharacterCreationDefinition>(() => this.engine().characterCreation());
  }

  /** Resolves generic choices into a character, appearance and characteristics. */
  resolveCharacterCreation(
    choices: Record<string, unknown>,
    characteristics: Record<string, unknown>,
  ): CharacterCreationResult {
    return this.parse<CharacterCreationResult>(() =>
      this.engine().resolveCharacterCreation(
        JSON.stringify(choices),
        JSON.stringify(characteristics),
      ),
    );
  }

  /** Resolves the definition currently held by the editor. */
  previewCharacterCreation(
    definition: CharacterCreationDefinition,
    choices: Record<string, unknown>,
    characteristics: Record<string, unknown>,
  ): CharacterCreationResult {
    return this.parse<CharacterCreationResult>(() =>
      this.engine().previewCharacterCreation(
        JSON.stringify(definition),
        JSON.stringify(choices),
        JSON.stringify(characteristics),
      ),
    );
  }

  /**
   * Turns a definition, a customisation and a moment of an animation into
   * something drawable.
   *
   * Every host draws what *this* produced: the editor's preview and the game
   * call the same resolver, so a preview cannot flatter the result — animation
   * included (`docs/adr/ADR-0031-characters-animate-by-hierarchy-and-offsets.md`).
   *
   * `pose` of `undefined` is the rest pose, and so is an animation id the
   * definition does not declare.
   */
  resolveCharacter(
    id: string,
    values: CharacterValues = {},
    pose?: CharacterPose,
  ): ResolvedCharacter {
    return this.parse<ResolvedCharacter>(() =>
      this.engine().resolveCharacter(
        id,
        JSON.stringify(values),
        pose?.animation ?? undefined,
        Math.max(0, Math.round(pose?.timeMs ?? 0)),
      ),
    );
  }

  /** Resolves the animation assigned to a gameplay role. */
  resolveCharacterRole(
    id: string,
    values: CharacterValues,
    role: AnimationRole,
    timeMs: number,
  ): ResolvedCharacter {
    return this.parse<ResolvedCharacter>(() =>
      this.engine().resolveCharacterRole(
        id,
        JSON.stringify(values),
        role,
        Math.max(0, Math.round(timeMs)),
      ),
    );
  }

  /**
   * Resolves a definition **in hand** against a customisation, at a moment of
   * an animation.
   *
   * What the editor previews with: the definition being written is not
   * registered, and may not be valid yet, but it still has to be visible.
   */
  previewCharacter(
    character: CharacterDefinition,
    values: CharacterValues = {},
    pose?: CharacterPose,
  ): ResolvedCharacter {
    return this.parse<ResolvedCharacter>(() =>
      this.engine().previewCharacter(
        JSON.stringify(character),
        JSON.stringify(values),
        pose?.animation ?? undefined,
        Math.max(0, Math.round(pose?.timeMs ?? 0)),
      ),
    );
  }

  /** Registers the game's settings declaration, before the project. */
  loadSettings(json: string): LoadOutcome {
    return this.parse<LoadOutcome>(() => this.engine().loadSettings(json));
  }

  /** Validates a settings declaration without registering it, keys included. */
  validateSettings(json: string): ValidationReport {
    return this.parse<ValidationReport>(() => this.engine().validateSettings(json));
  }

  /** The registered settings declaration, defaults filled in by the engine. */
  settings(): SettingsDefinition {
    return this.parse<SettingsDefinition>(() => this.engine().settings());
  }

  /**
   * Resolves values against the declaration: defaults filled, unknown keys
   * dropped, numbers clamped.
   *
   * The screen and `createGame` both go through this, so what a player sees and
   * what the game is created with cannot disagree.
   */
  resolveSettings(values: SettingsValues): SettingsValues {
    return this.parse<SettingsValues>(() => this.engine().resolveSettings(JSON.stringify(values)));
  }

  /**
   * Forgets every loaded tile set, world, locale and project.
   *
   * Loading is additive, so a host re-loading a whole project calls this first
   * — otherwise content deleted in the editor keeps answering for itself. A
   * running game is unaffected.
   */
  resetContent(): void {
    this.engine().resetContent();
  }

  /**
   * Forgets every loaded language, keeping worlds, tile sets and project.
   *
   * What the language editor calls after writing its files: loading is additive
   * and refuses a key twice, so edited text only replaces the old text once the
   * old bundles are gone (`docs/adr/ADR-0027-authoring-creates-keys.md`).
   */
  resetLocales(): void {
    this.engine().resetLocales();
  }

  /**
   * Resolves every map link across the loaded worlds.
   *
   * The check no single world file can make: a door's target lives in another
   * file (`docs/adr/ADR-0017-map-links.md`).
   */
  validateLinks(): ValidationReport {
    return this.parse<ValidationReport>(() => this.engine().validateLinks());
  }

  /**
   * Validates a world without registering it.
   *
   * This is the editor's pre-export check, and it is deliberately the *same*
   * validator the runtime uses — see
   * `docs/adr/ADR-0015-shared-content-validation.md`.
   */
  validateWorld(json: string): ValidationReport {
    return this.parse<ValidationReport>(() => this.engine().validateWorld(json));
  }

  /** What the engine's content registry currently holds. */
  contentSummary(): ContentSummary {
    return this.parse<ContentSummary>(() => this.engine().contentSummary());
  }

  /** Dimensions, tile palette and locations of a registered world. */
  worldView(worldId: string): WorldView {
    return this.parse<WorldView>(() => this.engine().worldView(worldId));
  }

  /**
   * The packed terrain buffer: one palette index per cell.
   *
   * Fetched once per world, not once per tile — this is the whole reason the
   * renderer can draw a large map without hammering the boundary.
   */
  terrainBuffer(worldId: string): Uint8Array {
    return this.call(() => this.engine().terrainBuffer(worldId));
  }

  /**
   * The packed elevation buffer: one signed byte per cell, same layout as
   * {@link terrainBuffer}.
   *
   * Presentation only; the renderer uses it in isometric mode.
   */
  elevationBuffer(worldId: string): Int8Array {
    return this.call(() => this.engine().elevationBuffer(worldId));
  }

  /**
   * The packed presence buffer: `1` per hex the map has, `0` per hole, same
   * layout as {@link terrainBuffer}.
   *
   * A map is a set of hexes rather than a rectangle, and `worldView().bounds`
   * is only the box those hexes are stored in
   * (`docs/adr/ADR-0046-a-map-is-a-set-of-hexes.md`).
   */
  presenceBuffer(worldId: string): Uint8Array {
    return this.call(() => this.engine().presenceBuffer(worldId));
  }

  // ------------------------------------------------------------------- game

  /**
   * Starts a game. The engine owns the seed and the settings from here on.
   *
   * `settings` are the game's own, declared by content; the application's
   * settings never cross the boundary (`docs/adr/ADR-0025-settings.md`).
   */
  createGame(worldId: string, seed: number, settings: SettingsValues = {}): GameSnapshot {
    const snapshot = this.parse<GameSnapshot>(() =>
      this.engine().createGame(worldId, seed, JSON.stringify(settings)),
    );
    this.running.set(this.instance?.hasGame() ?? true);
    return snapshot;
  }

  /** The current runtime state. */
  snapshot(): GameSnapshot {
    return this.parse<GameSnapshot>(() => this.engine().snapshot());
  }

  /**
   * Sends a command.
   *
   * An illegal command is *not* an exception: it returns a result with
   * `accepted: false` and a `rejection`, and the state is untouched.
   */
  dispatch(command: EngineCommand): CommandResult {
    const json = JSON.stringify(command);
    return this.parse<CommandResult>(() => this.engine().dispatch(json));
  }

  /** Discards the running game; loaded content stays loaded. */
  endGame(): void {
    this.engine().endGame();
    this.running.set(this.instance?.hasGame() ?? false);
  }

  /**
   * `true` when a game is in progress.
   *
   * A signal, not a call into WASM, because the shell reacts to it: the
   * settings screen locks its `newGame` fields while a game runs, and the
   * navigation bar asks before throwing one away. It is written on either side
   * of the two calls that can change it, and read back from the engine there so
   * the mirror cannot drift.
   */
  readonly hasGame = this.running.asReadonly();

  // ------------------------------------------------------------------ plumbing

  private engine(): RawInsulaireEngine {
    if (this.instance === null) {
      throw new EngineError('notLoaded', 'The engine has not finished loading yet.');
    }
    return this.instance;
  }

  /** Runs a boundary call, converting thrown JSON strings into `EngineError`. */
  private call<T>(operation: () => T): T {
    try {
      return operation();
    } catch (thrown) {
      throw EngineError.fromThrown(thrown);
    }
  }

  private parse<T>(operation: () => string): T {
    return JSON.parse(this.call(operation)) as T;
  }
}
