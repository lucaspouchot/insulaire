/**
 * TypeScript view of the engine boundary.
 *
 * These types are hand-written rather than generated on purpose: they *are* the
 * contract, and writing them by hand keeps the boundary small and reviewable.
 * They mirror `crates/engine/src/dto.rs`; `docs/wasm-api.md` is the shared
 * reference for both sides.
 *
 * Positions cross as offset pairs `[col, row]`.
 */

/** `[col, row]` in odd-r offset coordinates. */
export type OffsetWire = [number, number];

/** Commands the UI may send. This is the whole vocabulary. */
export type EngineCommand = { type: 'moveTo'; to: OffsetWire } | { type: 'wait' };

export type EntityKind = 'player' | 'monster';

export interface AxialWire {
  q: number;
  r: number;
}

export interface EntitySnapshot {
  id: number;
  contentId: string;
  templateId: string;
  kind: EntityKind;
  at: OffsetWire;
  axial: AxialWire;
  visualId: string;
  fallbackColor: string;
  blocksMovement: boolean;
  tags: string[];
}

export interface RngSnapshot {
  state: string;
  increment: string;
  draws: number;
}

/**
 * Runtime state of a game.
 *
 * Note what is *absent*: the map. Terrain is authored, immutable, and travels
 * once per world through {@link WorldView} plus the packed terrain buffer, so a
 * snapshot stays a few hundred bytes however large the world is.
 */
export interface GameSnapshot {
  worldId: string;
  seed: number;
  tick: number;
  player: EntitySnapshot | null;
  entities: EntitySnapshot[];
  /** Hexes the player may move to right now, decided by the engine. */
  legalMoves: OffsetWire[];
  rng: RngSnapshot;
}

export type SimEvent =
  | { type: 'actionRejected'; reason: Rejection }
  | { type: 'entityMoved'; entity: number; contentId: string; from: OffsetWire; to: OffsetWire }
  | { type: 'entityHeld'; entity: number; contentId: string; at: OffsetWire }
  | { type: 'tickAdvanced'; tick: number }
  /** The player entered a hex carrying a map link; the map is about to change. */
  | { type: 'linkTriggered'; link: string; toWorld: string; to: OffsetWire }
  /** The session moved to another map. */
  | { type: 'worldEntered'; fromWorld: string; toWorld: string; at: OffsetWire }
  /** A door could not be followed, so the map did not change. */
  | { type: 'linkUnresolved'; link: string; toWorld: string; reason: string };

export interface Rejection {
  code: string;
  message: string;
}

export interface CommandResult {
  accepted: boolean;
  rejection: Rejection | null;
  events: SimEvent[];
  state: GameSnapshot;
}

export interface PaletteEntry {
  index: number;
  id: string;
  name: string;
  terrain: string;
  movementCost: number;
  passable: boolean;
  visualId: string;
  fallbackColor: string;
  tags: string[];
}

export interface LocationView {
  id: string;
  name: string;
  at: OffsetWire;
  tags: string[];
}

/** An authored door, republished so the client can draw it and name its target. */
export interface LinkView {
  id: string;
  name: string;
  at: OffsetWire;
  targetWorld: string;
  targetAt: OffsetWire;
  /** Currently always `"enter"`. */
  trigger: string;
  tags: string[];
}

export interface WorldView {
  worldId: string;
  name: string;
  width: number;
  height: number;
  orientation: string;
  /** `"topDown"` or `"isometric"`; presentation carried by the content. */
  projection: string;
  tileSetId: string;
  palette: PaletteEntry[];
  locations: LocationView[];
  links: LinkView[];
  cellCount: number;
}

export interface TemplateView {
  id: string;
  name: string;
  kind: EntityKind;
  visualId: string;
  fallbackColor: string;
}

export interface WorldSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  tileSetId: string;
  valid: boolean;
}

/** The loaded project manifest. */
export interface ProjectView {
  id: string;
  name: string;
  startWorld: string;
  worldIds: string[];
}

export interface ContentSummary {
  tileSets: string[];
  worlds: WorldSummary[];
  templates: TemplateView[];
  project: ProjectView | null;
}

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  code: string;
  severity: Severity;
  path: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface LoadOutcome {
  id: string;
  report: ValidationReport;
}

export interface EngineInfo {
  name: string;
  version: string;
  /** `"wasm32"` when the engine really is running as WebAssembly. */
  targetArch: string;
  pointerWidth: number;
  worldSchemaVersion: number;
  tileSetSchemaVersion: number;
}

/** The shape every failing engine call rejects with. */
export interface EngineErrorPayload {
  code: string;
  message: string;
  report?: ValidationReport;
}

/**
 * An engine failure, carrying the structured payload from Rust.
 *
 * Thrown by {@link EngineService}; `report` is populated for content errors so
 * the editor can list every issue at once.
 */
export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly report?: ValidationReport,
  ) {
    super(message);
    this.name = 'EngineError';
  }

  /** Parses the JSON string a WASM call rejects with. */
  static fromThrown(thrown: unknown): EngineError {
    const text = typeof thrown === 'string' ? thrown : (thrown as Error | undefined)?.message;
    if (typeof text === 'string') {
      try {
        const payload = JSON.parse(text) as EngineErrorPayload;
        if (typeof payload.code === 'string' && typeof payload.message === 'string') {
          return new EngineError(payload.code, payload.message, payload.report);
        }
      } catch {
        // Not an engine payload; fall through to the generic case below.
      }
      return new EngineError('unknown', text);
    }
    return new EngineError('unknown', String(thrown));
  }
}

/**
 * The raw class exported by the generated `wasm-bindgen` glue.
 *
 * Every method that can fail throws a JSON string; {@link EngineService} wraps
 * them so the rest of the app only ever sees {@link EngineError}.
 */
export interface RawInsulaireEngine {
  engineInfo(): string;
  loadTileSet(json: string): string;
  loadWorld(json: string): string;
  loadProject(json: string): string;
  resetContent(): void;
  validateLinks(): string;
  validateWorld(json: string): string;
  contentSummary(): string;
  worldView(worldId: string): string;
  terrainBuffer(worldId: string): Uint8Array;
  elevationBuffer(worldId: string): Int8Array;
  createGame(worldId: string, seed: number): string;
  snapshot(): string;
  dispatch(commandJson: string): string;
  endGame(): void;
  hasGame(): boolean;
  free(): void;
}

/** The module shape produced by `wasm-pack build --target web`. */
export interface InsulaireEngineModule {
  default(options?: { module_or_path?: string | URL }): Promise<unknown>;
  InsulaireEngine: new () => RawInsulaireEngine;
}
