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
  CommandResult,
  ContentSummary,
  EngineCommand,
  EngineError,
  EngineInfo,
  GameSnapshot,
  LoadOutcome,
  RawHexEngine,
  ValidationReport,
  WorldView,
} from '../../engine/engine.types';
import { loadEngineModule } from '../../engine/load-engine-module';

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'failed';

@Injectable({ providedIn: 'root' })
export class EngineService {
  private instance: RawHexEngine | null = null;
  private initialisation: Promise<RawHexEngine> | null = null;

  /** Lifecycle of the WASM module, for the UI to reflect. */
  readonly status = signal<EngineStatus>('idle');
  /** Build identity reported by the engine once it is up. */
  readonly info = signal<EngineInfo | null>(null);
  /** Why loading failed, when it did. */
  readonly failure = signal<string | null>(null);

  /**
   * Loads and initialises the engine, at most once.
   *
   * @throws Error when the WASM artefacts are missing or fail to start.
   */
  async ready(): Promise<RawHexEngine> {
    this.initialisation ??= this.initialise();
    return this.initialisation;
  }

  private async initialise(): Promise<RawHexEngine> {
    this.status.set('loading');
    try {
      const module = await loadEngineModule();
      const engine = new module.HexEngine();
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

  /** Starts a game. The engine owns the seed from here on. */
  createGame(worldId: string, seed: number): GameSnapshot {
    return this.parse<GameSnapshot>(() => this.engine().createGame(worldId, seed));
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
  }

  /** `true` when a game is in progress. */
  hasGame(): boolean {
    return this.instance?.hasGame() ?? false;
  }

  // ------------------------------------------------------------------ plumbing

  private engine(): RawHexEngine {
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
