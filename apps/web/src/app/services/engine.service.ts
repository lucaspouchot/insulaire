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
  SettingsDefinition,
  SettingsValues,
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
import { loadEngineModule } from '../../engine/load-engine-module';

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'failed';

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
