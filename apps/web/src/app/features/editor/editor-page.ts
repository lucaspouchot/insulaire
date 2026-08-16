/**
 * The MVP world editor.
 *
 * The component's job is UI: tools, palette, buttons, file dialogs. It owns no
 * simulation and no rendering code — it drives a {@link HexMapRenderer} through
 * a {@link CanvasView}, mutates a {@link WorldDocument}, and asks the Rust
 * engine whether the result is valid.
 *
 * Validation is worth calling out: the "Validate" button and the "Play" button
 * both call `EngineService.validateWorld`, which is the *same* Rust validator
 * the runtime runs at load time. The editor cannot approve a world the runtime
 * would reject.
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
import { Router } from '@angular/router';

import { Offset } from '../../../core/hex/hex-coords';
import { HexLayout } from '../../../core/hex/hex-layout';
import { ProjectionMode, WorldDefinition } from '../../../content/content-types';
import { DocumentTile, WorldDocument } from '../../../content/world-document';
import { serializeWorld } from '../../../content/world-serializer';
import { ValidationReport } from '../../../engine/engine.types';
import { Camera } from '../../../renderer/camera';
import { CanvasView } from '../../../renderer/canvas-view';
import { HexMapRenderer } from '../../../renderer/hex-map-renderer';
import { RenderModel } from '../../../renderer/render-model';
import { EngineService } from '../../services/engine.service';
import { WorldStoreService } from '../../services/world-store.service';

/** Hex circumradius in world pixels. The camera scales from here. */
const HEX_SIZE = 28;

export type EditorTool = 'paint' | 'raise' | 'lower' | 'player' | 'monster' | 'erase';

@Component({
  selector: 'app-editor-page',
  templateUrl: './editor-page.html',
  styleUrl: './editor-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditorPage implements AfterViewInit, OnDestroy {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly store = inject(WorldStoreService);
  private readonly engine = inject(EngineService);
  private readonly router = inject(Router);

  private view: CanvasView | null = null;
  private renderer: HexMapRenderer | null = null;

  protected readonly document = this.store.document;
  protected readonly dirty = this.store.dirty;
  protected readonly source = this.store.source;

  protected readonly tool = signal<EditorTool>('paint');
  protected readonly selectedTile = signal<string | null>(null);
  protected readonly hover = signal<Offset | null>(null);
  protected readonly selected = signal<Offset | null>(null);
  protected readonly showGrid = signal(true);
  protected readonly showCoordinates = signal(false);
  protected readonly report = signal<ValidationReport | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  /** Bumped on every document mutation so computed views recompute. */
  protected readonly revision = signal(0);

  protected readonly palette = computed<readonly DocumentTile[]>(() => this.document()?.palette ?? []);

  protected readonly hoveredTile = computed(() => {
    this.revision();
    const cell = this.hover();
    const document = this.document();
    return cell === null || document === null ? null : document.tileAt(cell);
  });

  protected readonly entityCounts = computed(() => {
    this.revision();
    const entities = this.document()?.placedEntities ?? [];
    return {
      players: entities.filter((entity) => entity.templateId === 'player').length,
      monsters: entities.filter((entity) => entity.templateId === 'monster').length,
    };
  });

  protected readonly stats = computed(() => {
    this.revision();
    return this.renderer?.frameStats ?? null;
  });

  async ngAfterViewInit(): Promise<void> {
    // The engine is only needed to *judge* a world, not to edit one, so a
    // failed WASM load degrades the editor rather than breaking it. The shell's
    // status badge already reports the failure.
    void this.engine.ready().catch(() => undefined);

    try {
      await this.store.ensureLoaded();
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : String(cause));
      return;
    }

    const document = this.store.requireDocument();
    this.selectedTile.set(document.palette[0]?.id ?? null);

    const context = this.canvasRef().nativeElement.getContext('2d');
    if (context === null) {
      this.error.set('This browser did not provide a 2D canvas context.');
      return;
    }

    this.renderer = new HexMapRenderer(context, new HexLayout(HEX_SIZE), new Camera());
    this.renderer.setModel(this.buildModel(document));

    this.view = new CanvasView(this.canvasRef().nativeElement, this.renderer, {
      onHover: (cell) => {
        this.hover.set(cell);
        this.refresh();
      },
      onClick: (cell) => {
        this.selected.set(cell);
        this.applyTool(cell);
      },
      onDragPaint: (cell) => this.applyTool(cell),
      onResize: () => this.view?.fit(),
    });
    this.view.fit();
  }

  ngOnDestroy(): void {
    this.view?.dispose();
  }

  // ------------------------------------------------------------------ tools

  protected selectTool(tool: EditorTool): void {
    this.tool.set(tool);
  }

  protected selectTile(tileId: string): void {
    this.selectedTile.set(tileId);
    this.tool.set('paint');
  }

  /**
   * Applies the active tool to a cell.
   *
   * Every branch that changes something calls {@link WorldStoreService.touch},
   * which persists the document and marks it dirty.
   */
  private applyTool(cell: Offset): void {
    const document = this.store.document();
    if (document === null) {
      return;
    }

    let changed = false;
    switch (this.tool()) {
      case 'paint': {
        const tileId = this.selectedTile();
        changed = tileId !== null && document.paint(cell, tileId);
        break;
      }
      case 'raise':
        changed = document.raise(cell, 1);
        break;
      case 'lower':
        changed = document.raise(cell, -1);
        break;
      case 'player':
        changed = document.placeEntity(cell, 'player', true) !== null;
        break;
      case 'monster':
        changed = document.placeEntity(cell, 'monster', false) !== null;
        break;
      case 'erase':
        changed = document.removeEntityAt(cell) || document.removeLocationAt(cell);
        break;
    }

    if (changed) {
      this.store.touch();
      this.report.set(null);
      this.message.set(null);
    }
    this.refresh();
  }

  // ------------------------------------------------------------------ world

  protected async createWorld(widthInput: string, heightInput: string, name: string): Promise<void> {
    const width = clampDimension(widthInput);
    const height = clampDimension(heightInput);
    try {
      const document = WorldDocument.create({
        id: slugify(name) || 'new_world',
        name: name.trim() || 'New World',
        width,
        height,
        tileSet: this.store.requireTileSet(),
      });
      this.store.replaceDocument(document, 'new');
      this.selectedTile.set(document.palette[0]?.id ?? null);
      this.report.set(null);
      this.message.set(`Created a ${width}x${height} world. Place a player before playing.`);
      this.rebuild();
      this.view?.fit();
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }

  protected async resetToDemo(): Promise<void> {
    await this.store.resetToDemo();
    this.report.set(null);
    this.message.set('Reloaded content/worlds/demo_world.json.');
    this.rebuild();
    this.view?.fit();
  }

  /** Runs the engine's validator over the current document. */
  protected validate(): ValidationReport | null {
    this.message.set(null);
    if (!this.engine.isReady) {
      this.message.set('The engine is still loading — try again in a moment.');
      return null;
    }
    try {
      // A world is validated *against its tile set*, so the tile set has to be
      // registered first. Loading it again is harmless: the registry replaces
      // an existing entry with the same id.
      this.engine.loadTileSet(JSON.stringify(this.store.requireTileSet()));
      const report = this.engine.validateWorld(this.store.currentJson());
      this.report.set(report);
      return report;
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }

  /** Downloads the world as JSON, in the same layout as the shipped files. */
  protected exportWorld(): void {
    const definition = this.store.currentDefinition();
    const json = serializeWorld(definition);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const link = window.document.createElement('a');
    link.href = url;
    link.download = `${definition.id}.json`;
    link.click();
    URL.revokeObjectURL(url);

    this.store.markExported();
    this.message.set(`Exported ${definition.id}.json`);
  }

  /** Loads a world file chosen from disk. */
  protected async importWorld(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    try {
      const definition = JSON.parse(await file.text()) as WorldDefinition;
      const document = this.store.importDefinition(definition);
      this.selectedTile.set(document.palette[0]?.id ?? null);
      this.report.set(null);
      this.message.set(`Imported ${file.name}.`);
      this.rebuild();
      this.view?.fit();
    } catch (cause) {
      this.error.set(`Could not import ${file.name}: ${cause instanceof Error ? cause.message : cause}`);
    } finally {
      input.value = '';
    }
  }

  /** Validates, then hands the world to Play mode. */
  protected async playWorld(): Promise<void> {
    const report = this.validate();
    if (report === null) {
      return;
    }
    if (!report.valid) {
      this.message.set('Fix the errors below before playing.');
      return;
    }
    await this.router.navigate(['/play']);
  }

  // -------------------------------------------------------------- rendering

  protected fitView(): void {
    this.view?.fit();
  }

  protected zoom(factor: number): void {
    this.view?.zoomByStep(factor);
  }

  protected toggleGrid(): void {
    this.showGrid.update((value) => !value);
    this.rebuild();
  }

  protected toggleCoordinates(): void {
    this.showCoordinates.update((value) => !value);
    this.rebuild();
  }

  /**
   * Switches the world between top-down and isometric.
   *
   * This edits the *document*, not the view: the projection is authored content
   * (`docs/adr/ADR-0016-isometric-projection.md`), so the runtime will render
   * the exported world exactly the way the editor shows it.
   */
  protected toggleProjection(): void {
    const document = this.store.document();
    if (document === null) {
      return;
    }
    document.projection = document.projection === 'isometric' ? 'topDown' : 'isometric';
    this.store.touch();
    this.report.set(null);
    this.message.set(null);
    this.rebuild();
    this.view?.fit();
  }

  /** The projection the document is currently authored with. */
  protected readonly projection = computed<ProjectionMode>(() => {
    this.revision();
    return this.document()?.projection ?? 'topDown';
  });

  /** Elevation of the hovered cell, for the status bar. */
  protected readonly hoveredElevation = computed<number | null>(() => {
    this.revision();
    const cell = this.hover();
    const document = this.document();
    return cell === null || document === null ? null : document.elevationAt(cell);
  });

  protected dismissError(): void {
    this.error.set(null);
  }

  /** Rebuilds the render model from the document and redraws. */
  private rebuild(): void {
    const document = this.store.document();
    if (document !== null) {
      this.renderer?.setModel(this.buildModel(document));
    }
    this.refresh();
  }

  /** Redraws with the current model and lets computed views recompute. */
  private refresh(): void {
    const document = this.store.document();
    if (document !== null && this.renderer !== null) {
      this.renderer.setModel(this.buildModel(document));
    }
    this.revision.update((value) => value + 1);
    this.view?.invalidate();
  }

  private buildModel(document: WorldDocument): RenderModel {
    return {
      width: document.width,
      height: document.height,
      projection: document.projection,
      palette: document.palette,
      terrain: document.terrain,
      elevation: document.elevation,
      elevationRange: document.elevationRange,
      entities: document.placedEntities.map((entity) => ({
        id: entity.id,
        at: entity.at,
        visualId: `entity.${entity.templateId}`,
        fallbackColor: entity.templateId === 'player' ? '#f2c14e' : '#c0392b',
        glyph: entity.templateId === 'player' ? '@' : 'M',
        emphasised: false,
      })),
      locations: document.placedLocations.map((location) => ({
        id: location.id,
        at: location.at,
        name: location.name,
      })),
      overlays: [],
      hover: this.hover(),
      selected: this.selected(),
      showGrid: this.showGrid(),
      showCoordinates: this.showCoordinates(),
    };
  }
}

function clampDimension(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.min(256, Math.max(1, parsed)) : 20;
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
