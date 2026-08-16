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

import { ActivatedRoute } from '@angular/router';

import { Offset, hexDistance, offsetToAxial } from '../../../core/hex/hex-coords';
import { HexLayout } from '../../../core/hex/hex-layout';
import { EntitySnapshot, GameSnapshot, SimEvent, WorldView } from '../../../engine/engine.types';
import { Camera } from '../../../renderer/camera';
import { CanvasView } from '../../../renderer/canvas-view';
import { HexMapRenderer } from '../../../renderer/hex-map-renderer';
import { toProjectionMode } from '../../../renderer/projection';
import { RenderModel, elevationRangeOf } from '../../../renderer/render-model';
import { serializeWorld } from '../../../content/world-serializer';
import { EngineService } from '../../services/engine.service';
import { ProjectStoreService } from '../../services/project-store.service';

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
  private readonly store = inject(ProjectStoreService);
  private readonly route = inject(ActivatedRoute);

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
   * Loads the whole project into the engine and starts a game.
   *
   * *Whole* project, not just the map being played: a door can send the player
   * anywhere the project ships, and the engine can only follow a link to a
   * world it already holds (`docs/adr/ADR-0017-map-links.md`). Tile sets are
   * registered first because a world is validated against its own; every call
   * here goes through the same Rust validator the editor uses.
   */
  private startGame(seed: number): void {
    this.busy.set(true);
    this.error.set(null);
    this.lastRejection.set(null);
    this.log.set([]);

    try {
      // Cleared first: loading is additive, so a map removed in the editor
      // would otherwise still satisfy a door that points at it.
      this.engine.resetContent();
      for (const tileSet of this.store.tileSetDefinitions()) {
        this.engine.loadTileSet(JSON.stringify(tileSet));
      }
      for (const definition of this.store.definitions()) {
        this.engine.loadWorld(serializeWorld(definition));
      }
      this.engine.loadProject(this.store.projectJson());

      // Dangling doors are worth saying out loud rather than discovering by
      // walking into one: the runtime degrades, it does not crash.
      const links = this.engine.validateLinks();
      for (const issue of links.issues) {
        this.pushLog(0, `${issue.code}: ${issue.message}`, 'reject');
      }

      const worldId = this.startWorldId();
      const snapshot = this.engine.createGame(worldId, seed);

      this.snapshot.set(snapshot);
      this.selected.set(null);
      const view = this.loadWorldIntoRenderer(worldId, true);

      this.pushLog(0, `Game started on "${view.name}" with seed ${seed}.`, 'tick');
      this.busy.set(false);
    } catch (cause) {
      this.error.set(describe(cause));
      this.busy.set(false);
    }
  }

  /**
   * The map a new session starts on: the one Play was opened with, else the
   * project's `startWorld`.
   */
  private startWorldId(): string {
    const requested = this.route.snapshot.queryParamMap.get('world');
    const known = this.store.documents().some((document) => document.id === requested);
    return known && requested !== null ? requested : this.store.requireProject().startWorld;
  }

  /**
   * Points the renderer at `worldId`, fetching its packed buffers.
   *
   * Called once at start and again whenever a door changes the map — the two
   * paths are the same because a map change *is* a new world to draw.
   */
  private loadWorldIntoRenderer(worldId: string, attach: boolean): WorldView {
    const view = this.engine.worldView(worldId);
    const terrain = this.engine.terrainBuffer(worldId);
    const elevation = this.engine.elevationBuffer(worldId);
    this.worldView.set(view);

    if (attach || this.renderer === null) {
      this.attachRenderer(view, terrain, elevation);
    } else {
      this.renderer.setModel(this.buildModel(view, terrain, elevation, elevationRangeOf(elevation)));
      this.view?.fit();
    }
    return view;
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

      // A door changed the map: the engine already swapped the session, the UI
      // just has to draw the world it now says it is on.
      if (result.state.worldId !== this.worldView()?.worldId) {
        this.hover.set(null);
        this.selected.set(null);
        this.loadWorldIntoRenderer(result.state.worldId, false);
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
      links: view.links.map((link) => ({
        id: link.id,
        at: { col: link.at[0], row: link.at[1] },
        label: link.name.length > 0 ? link.name : link.targetWorld,
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
      case 'linkTriggered':
        this.pushLog(tick, `door "${event.link}" leads to ${event.toWorld}`, 'move');
        break;
      case 'worldEntered':
        this.pushLog(
          tick,
          `entered ${event.toWorld} at [${event.at[0]}, ${event.at[1]}] (from ${event.fromWorld})`,
          'tick',
        );
        break;
      case 'linkUnresolved':
        this.pushLog(tick, `door "${event.link}" goes nowhere: ${event.reason}`, 'reject');
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
