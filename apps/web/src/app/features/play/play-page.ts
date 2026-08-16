/**
 * The playable test game.
 *
 * This is the vertical slice the MVP exists to prove. One click follows this
 * path and no other:
 *
 * ```text
 *   click a hex
 *     -> EngineService.dispatch({ type: 'moveTo', to: [col, row] })   Angular
 *       -> validate, move player, tick++, move monsters               Rust/WASM
 *     <- CommandResult { accepted, events, state }
 *   -> render the new state                                           Canvas
 * ```
 *
 * The component never decides whether a move is legal, never moves an entity
 * and never touches the tick. It sends a command and draws what comes back.
 * Highlighted hexes come from `snapshot.legalMoves`, computed in Rust, so the
 * UI cannot disagree with the rules it is showing.
 *
 * The world it plays is whatever the editor currently holds — the editor's own
 * export, fed straight into `loadWorld`.
 */

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { Offset, hexDistance, offsetToAxial } from '../../../core/hex/hex-coords';
import { HexLayout } from '../../../core/hex/hex-layout';
import { EntitySnapshot, GameSnapshot, SimEvent, WorldView } from '../../../engine/engine.types';
import { Camera } from '../../../renderer/camera';
import { CanvasView } from '../../../renderer/canvas-view';
import { HexMapRenderer } from '../../../renderer/hex-map-renderer';
import { toProjectionMode } from '../../../renderer/projection';
import { RenderModel, elevationRangeOf } from '../../../renderer/render-model';
import { EngineService } from '../../services/engine.service';
import { WorldStoreService } from '../../services/world-store.service';

const HEX_SIZE = 28;
const MAX_LOG_ENTRIES = 60;

/** One rendered line in the event log. */
interface LogEntry {
  readonly id: number;
  readonly tick: number;
  readonly text: string;
  readonly kind: 'move' | 'hold' | 'tick' | 'reject';
}

@Component({
  selector: 'app-play-page',
  templateUrl: './play-page.html',
  styleUrl: './play-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlayPage implements AfterViewInit, OnDestroy {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly engine = inject(EngineService);
  private readonly store = inject(WorldStoreService);

  private view: CanvasView | null = null;
  private renderer: HexMapRenderer | null = null;
  private logCounter = 0;

  protected readonly worldView = signal<WorldView | null>(null);
  protected readonly snapshot = signal<GameSnapshot | null>(null);
  protected readonly hover = signal<Offset | null>(null);
  protected readonly selected = signal<Offset | null>(null);
  protected readonly seed = signal(2026);
  protected readonly log = signal<readonly LogEntry[]>([]);
  protected readonly lastRejection = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(true);
  protected readonly showGrid = signal(true);
  protected readonly revision = signal(0);

  protected readonly player = computed<EntitySnapshot | null>(() => this.snapshot()?.player ?? null);

  protected readonly monsters = computed<readonly EntitySnapshot[]>(
    () => this.snapshot()?.entities.filter((entity) => entity.kind === 'monster') ?? [],
  );

  /** Distance from each monster to the player — presentation only. */
  protected readonly monsterDistances = computed(() => {
    const player = this.player();
    if (player === null) {
      return [];
    }
    const playerAxial = offsetToAxial({ col: player.at[0], row: player.at[1] });
    return this.monsters().map((monster) => ({
      id: monster.contentId,
      at: monster.at,
      distance: hexDistance(offsetToAxial({ col: monster.at[0], row: monster.at[1] }), playerAxial),
    }));
  });

  protected readonly stats = computed(() => {
    this.revision();
    return this.renderer?.frameStats ?? null;
  });

  async ngAfterViewInit(): Promise<void> {
    try {
      await this.engine.ready();
      await this.store.ensureLoaded();
      this.startGame(this.seed());
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : String(cause));
      this.busy.set(false);
    }
  }

  ngOnDestroy(): void {
    this.view?.dispose();
    if (this.engine.isReady && this.engine.hasGame()) {
      this.engine.endGame();
    }
  }

  // ------------------------------------------------------------------- game

  /**
   * Loads the editor's current world into the engine and starts a game.
   *
   * The tile set is registered first because a world is validated against it;
   * both calls go through the same Rust validator the editor uses.
   */
  private startGame(seed: number): void {
    this.busy.set(true);
    this.error.set(null);
    this.lastRejection.set(null);
    this.log.set([]);

    try {
      this.engine.loadTileSet(JSON.stringify(this.store.requireTileSet()));
      const outcome = this.engine.loadWorld(this.store.currentJson());

      const view = this.engine.worldView(outcome.id);
      const terrain = this.engine.terrainBuffer(outcome.id);
      const elevation = this.engine.elevationBuffer(outcome.id);
      const snapshot = this.engine.createGame(outcome.id, seed);

      this.worldView.set(view);
      this.snapshot.set(snapshot);
      this.selected.set(null);

      this.attachRenderer(view, terrain, elevation);
      this.pushLog(0, `Game started on "${view.name}" with seed ${seed}.`, 'tick');
      this.busy.set(false);
    } catch (cause) {
      this.error.set(describe(cause));
      this.busy.set(false);
    }
  }

  /** Restarts with the seed currently in the input. */
  protected restart(rawSeed: string): void {
    const parsed = Number.parseInt(rawSeed, 10);
    const seed = Number.isFinite(parsed) && parsed >= 0 ? parsed >>> 0 : 0;
    this.seed.set(seed);
    if (this.engine.hasGame()) {
      this.engine.endGame();
    }
    this.startGame(seed);
  }

  /** Sends a move command for the clicked hex. */
  protected moveTo(cell: Offset): void {
    this.send({ type: 'moveTo', to: [cell.col, cell.row] });
  }

  /** Spends a tick without moving. */
  protected wait(): void {
    this.send({ type: 'wait' });
  }

  /**
   * The one place the UI changes the simulation.
   *
   * Note what is missing: no legality check before sending. The engine decides,
   * and a refusal comes back as `accepted: false` with the tick untouched.
   */
  private send(command: { type: 'moveTo'; to: [number, number] } | { type: 'wait' }): void {
    if (this.busy() || !this.engine.isReady) {
      return;
    }
    try {
      const result = this.engine.dispatch(command);
      this.snapshot.set(result.state);
      this.lastRejection.set(result.accepted ? null : (result.rejection?.message ?? 'Refused.'));
      for (const event of result.events) {
        this.logEvent(result.state.tick, event);
      }
      this.refresh();
    } catch (cause) {
      this.error.set(describe(cause));
    }
  }

  // -------------------------------------------------------------- rendering

  private attachRenderer(view: WorldView, terrain: Uint8Array, elevation: Int8Array): void {
    this.view?.dispose();

    const context = this.canvasRef().nativeElement.getContext('2d');
    if (context === null) {
      this.error.set('This browser did not provide a 2D canvas context.');
      return;
    }

    this.renderer = new HexMapRenderer(context, new HexLayout(HEX_SIZE), new Camera());
    // The elevation range is scanned once per loaded world, never per frame.
    this.renderer.setModel(this.buildModel(view, terrain, elevation, elevationRangeOf(elevation)));

    this.view = new CanvasView(this.canvasRef().nativeElement, this.renderer, {
      onHover: (cell) => {
        this.hover.set(cell);
        this.refresh();
      },
      onClick: (cell) => {
        this.selected.set(cell);
        this.moveTo(cell);
      },
      onResize: () => this.view?.fit(),
    });
    this.view.fit();
  }

  protected fitView(): void {
    this.view?.fit();
  }

  protected zoom(factor: number): void {
    this.view?.zoomByStep(factor);
  }

  protected toggleGrid(): void {
    this.showGrid.update((value) => !value);
    this.refresh();
  }

  protected dismissError(): void {
    this.error.set(null);
  }

  private refresh(): void {
    const view = this.worldView();
    if (view !== null && this.renderer !== null) {
      // Terrain and elevation are authored and immutable during play, so the
      // existing buffers are reused instead of crossing the boundary again.
      const current = this.renderer.currentModel;
      this.renderer.setModel(
        this.buildModel(view, current.terrain, current.elevation, current.elevationRange),
      );
    }
    this.revision.update((value) => value + 1);
    this.view?.invalidate();
  }

  private buildModel(
    view: WorldView,
    terrain: Uint8Array,
    elevation: Int8Array,
    elevationRange: { min: number; max: number },
  ): RenderModel {
    const snapshot = this.snapshot();
    const legal: Offset[] = (snapshot?.legalMoves ?? []).map(([col, row]) => ({ col, row }));

    return {
      width: view.width,
      height: view.height,
      // Authored by the world, transported by the engine, applied here.
      projection: toProjectionMode(view.projection),
      palette: view.palette,
      terrain,
      elevation,
      elevationRange,
      entities: (snapshot?.entities ?? []).map((entity) => ({
        id: entity.contentId,
        at: { col: entity.at[0], row: entity.at[1] },
        visualId: entity.visualId,
        fallbackColor: entity.fallbackColor,
        glyph: entity.kind === 'player' ? '@' : 'M',
        emphasised: entity.kind === 'player',
      })),
      locations: view.locations.map((location) => ({
        id: location.id,
        at: { col: location.at[0], row: location.at[1] },
        name: location.name,
      })),
      overlays: [
        {
          // Straight from the engine: these are the moves Rust says are legal.
          cells: legal,
          fill: 'rgba(255, 209, 102, 0.16)',
          stroke: 'rgba(255, 209, 102, 0.55)',
        },
      ],
      hover: this.hover(),
      selected: this.selected(),
      showGrid: this.showGrid(),
      showCoordinates: false,
    };
  }

  // -------------------------------------------------------------------- log

  private logEvent(tick: number, event: SimEvent): void {
    switch (event.type) {
      case 'entityMoved':
        this.pushLog(
          tick,
          `${event.contentId} moved [${event.from[0]}, ${event.from[1]}] → [${event.to[0]}, ${event.to[1]}]`,
          'move',
        );
        break;
      case 'entityHeld':
        this.pushLog(tick, `${event.contentId} held at [${event.at[0]}, ${event.at[1]}] — nowhere closer`, 'hold');
        break;
      case 'tickAdvanced':
        this.pushLog(event.tick, `tick ${event.tick}`, 'tick');
        break;
      case 'actionRejected':
        this.pushLog(tick, `refused: ${event.reason.message}`, 'reject');
        break;
    }
  }

  private pushLog(tick: number, text: string, kind: LogEntry['kind']): void {
    this.logCounter += 1;
    const entry: LogEntry = { id: this.logCounter, tick, text, kind };
    this.log.update((entries) => [entry, ...entries].slice(0, MAX_LOG_ENTRIES));
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
