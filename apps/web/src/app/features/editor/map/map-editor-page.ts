/**
 * The map editor.
 *
 * The component's job is UI: tools, palette, buttons, file dialogs. It owns no
 * simulation and no rendering code — it drives a {@link HexMapRenderer} through
 * a {@link CanvasView}, mutates a {@link WorldDocument}, and asks the Rust
 * engine whether the result is valid.
 *
 * Validation is worth calling out: the "Validate" button and the "Play" button
 * both call `EngineService.validateWorld`, which is the *same* Rust validator
 * the runtime runs at load time. The editor cannot approve a world the runtime
 * would reject. Map links add a second check the editor alone cannot make —
 * a door's target lives in another file — so `validateLinks` runs over the
 * whole loaded project (`docs/adr/ADR-0017-map-links.md`).
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

import { Offset } from '../../../../core/hex/hex-coords';
import { HexLayout } from '../../../../core/hex/hex-layout';
import { ProjectionMode, WorldDefinition } from '../../../../content/content-types';
import { DocumentLink, DocumentTile, WorldDocument } from '../../../../content/world-document';
import { serializeWorld } from '../../../../content/world-serializer';
import { ValidationReport } from '../../../../engine/engine.types';
import { Camera } from '../../../../renderer/camera';
import { CanvasView } from '../../../../renderer/canvas-view';
import { HexMapRenderer } from '../../../../renderer/hex-map-renderer';
import { RenderModel } from '../../../../renderer/render-model';
import { EngineService } from '../../../services/engine.service';
import { ProjectStoreService } from '../../../services/project-store.service';

/** Hex circumradius in world pixels. The camera scales from here. */
const HEX_SIZE = 28;

export type EditorTool = 'paint' | 'raise' | 'lower' | 'player' | 'monster' | 'link' | 'erase';

@Component({
  selector: 'app-map-editor-page',
  templateUrl: './map-editor-page.html',
  styleUrl: './map-editor-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapEditorPage implements AfterViewInit, OnDestroy {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly store = inject(ProjectStoreService);
  private readonly engine = inject(EngineService);
  private readonly router = inject(Router);

  private view: CanvasView | null = null;
  private renderer: HexMapRenderer | null = null;

  protected readonly document = this.store.document;
  protected readonly dirty = this.store.dirty;
  protected readonly source = this.store.source;
  protected readonly maps = this.store.worldChoices;
  protected readonly activeWorldId = this.store.activeWorldId;

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

  protected readonly palette = computed<readonly DocumentTile[]>(() => {
    this.revision();
    return this.document()?.palette ?? [];
  });

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

  /** Every door on the open map, for the links panel. */
  protected readonly links = computed<readonly DocumentLink[]>(() => {
    this.revision();
    return this.document()?.placedLinks ?? [];
  });

  /** The door under the selection, which the inspector edits. */
  protected readonly selectedLink = computed<DocumentLink | null>(() => {
    this.revision();
    const cell = this.selected();
    const document = this.document();
    return cell === null || document === null ? null : document.linkAt(cell);
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
   * Every branch that changes something calls {@link ProjectStoreService.touch},
   * which persists the project and marks it dirty.
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
      case 'link': {
        // A new door points at the first *other* map, which is the common case;
        // the inspector below the canvas is where the author corrects it.
        const target = this.maps().find((map) => map.id !== document.id)?.id ?? document.id;
        changed = document.placeLink(cell, target) !== null;
        break;
      }
      case 'erase':
        changed =
          document.removeEntityAt(cell) || document.removeLinkAt(cell) || document.removeLocationAt(cell);
        break;
    }

    if (changed) {
      this.store.touch();
      this.report.set(null);
      this.message.set(null);
    }
    this.refresh();
  }

  // ------------------------------------------------------------------ links

  /** Repoints the selected door at another map. */
  protected setLinkTarget(worldId: string): void {
    this.updateSelectedLink({ targetWorld: worldId });
  }

  /**
   * Moves where the selected door lands.
   *
   * The arrival is *not* checked against the target map's bounds here: whether
   * it is in bounds, passable and free is the Rust validator's verdict, and
   * "Validate doors" reports it as `link.targetOutOfBounds`,
   * `link.targetImpassable` or `link.targetOccupied`.
   */
  protected setLinkArrival(colInput: string, rowInput: string): void {
    this.updateSelectedLink({
      targetAt: { col: clampCoordinate(colInput), row: clampCoordinate(rowInput) },
    });
  }

  protected setLinkName(name: string): void {
    this.updateSelectedLink({ name: name.trim() });
  }

  /** Removes the selected door. */
  protected removeSelectedLink(): void {
    const cell = this.selected();
    const document = this.store.document();
    if (cell === null || document === null || !document.removeLinkAt(cell)) {
      return;
    }
    this.store.touch();
    this.report.set(null);
    this.rebuild();
  }

  /** Selects a door from the list, so the inspector opens on it. */
  protected selectLink(link: DocumentLink): void {
    this.selected.set(link.at);
    this.tool.set('link');
    this.refresh();
  }

  private updateSelectedLink(patch: Partial<Omit<DocumentLink, 'id' | 'at'>>): void {
    const cell = this.selected();
    const document = this.store.document();
    if (cell === null || document === null || !document.updateLink(cell, patch)) {
      return;
    }
    this.store.touch();
    this.report.set(null);
    this.rebuild();
  }

  /**
   * Resolves every door across the whole project, in Rust.
   *
   * Single-map validation cannot do this: a door's target is in another file.
   */
  protected validateLinks(): void {
    this.message.set(null);
    if (!this.engine.isReady) {
      this.message.set('The engine is still loading — try again in a moment.');
      return;
    }
    try {
      this.loadProjectIntoEngine();
      const report = this.engine.validateLinks();
      this.report.set(report);
      this.message.set(
        report.valid ? 'Every door in the project leads somewhere.' : 'Some doors do not resolve.',
      );
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // ------------------------------------------------------------------- maps

  protected switchMap(worldId: string): void {
    this.store.selectWorld(worldId);
    const document = this.store.document();
    if (document !== null) {
      this.selectedTile.set(document.palette[0]?.id ?? null);
    }
    this.selected.set(null);
    this.hover.set(null);
    this.report.set(null);
    this.message.set(null);
    this.rebuild();
    this.view?.fit();
  }

  protected async createWorld(widthInput: string, heightInput: string, name: string): Promise<void> {
    const width = clampDimension(widthInput);
    const height = clampDimension(heightInput);
    try {
      const document = WorldDocument.create({
        id: this.freeId(slugify(name) || 'new_map'),
        name: name.trim() || 'New Map',
        width,
        height,
        tileSet: this.store.requireTileSet(),
      });
      this.store.addWorld(document);
      this.selectedTile.set(document.palette[0]?.id ?? null);
      this.report.set(null);
      this.message.set(`Added a ${width}x${height} map. Place a player before playing.`);
      this.rebuild();
      this.view?.fit();
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }

  protected renameWorld(id: string, name: string): void {
    const nextId = slugify(id) || this.store.requireDocument().id;
    if (!this.store.renameWorld(nextId, name.trim() || nextId)) {
      this.error.set(`Another map already uses the id "${nextId}".`);
      return;
    }
    this.message.set(`Renamed to ${nextId}; doors pointing at it were repointed.`);
    this.rebuild();
  }

  protected removeWorld(): void {
    const document = this.store.document();
    if (document === null) {
      return;
    }
    if (!this.store.removeWorld(document.id)) {
      this.error.set('A project must keep at least one map.');
      return;
    }
    this.message.set(`Removed ${document.id}. Doors that pointed at it now dangle — validate links.`);
    this.selected.set(null);
    this.rebuild();
    this.view?.fit();
  }

  protected async resetToShipped(): Promise<void> {
    try {
      await this.store.resetToShipped();
    } catch (cause) {
      this.error.set(`Could not reload content/: ${cause instanceof Error ? cause.message : cause}`);
      return;
    }
    this.selected.set(null);
    this.selectedTile.set(this.store.document()?.palette[0]?.id ?? null);
    this.report.set(null);
    this.message.set('Reloaded the project from content/.');
    this.rebuild();
    this.view?.fit();
  }

  // ---------------------------------------------------------------- content

  /** Runs the engine's validator over the open map. */
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

  /** Downloads the open map as JSON, in the same layout as the shipped files. */
  protected exportWorld(): void {
    const definition = this.store.currentDefinition();
    download(`${definition.id}.json`, serializeWorld(definition));
    this.store.markExported();
    this.message.set(`Exported ${definition.id}.json`);
  }

  /**
   * Downloads every map plus `project.json`.
   *
   * This is the set of files a delivered build needs: drop them into
   * `content/` and `just deliver` produces a bundle that boots on them.
   */
  protected exportProject(): void {
    for (const definition of this.store.definitions()) {
      download(`${definition.id}.json`, serializeWorld(definition));
    }
    download('project.json', this.store.projectJson());
    this.store.markExported();
    this.message.set('Exported every map and project.json — save them under content/.');
  }

  /** Loads a world file chosen from disk into the project. */
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

  /** Validates, then hands the project to Play mode. */
  protected async playWorld(): Promise<void> {
    const report = this.validate();
    if (report === null) {
      return;
    }
    if (!report.valid) {
      this.message.set('Fix the errors below before playing.');
      return;
    }
    await this.router.navigate(['/play'], { queryParams: { world: this.store.requireDocument().id } });
  }

  /**
   * Registers the whole project with the engine, for link validation.
   *
   * The registry is cleared first: loading is additive, so a map removed or
   * renamed in the editor would otherwise still be there to satisfy a door that
   * points at it, and the check would pass on content that no longer exists.
   */
  private loadProjectIntoEngine(): void {
    this.engine.resetContent();
    for (const tileSet of this.store.tileSetDefinitions()) {
      this.engine.loadTileSet(JSON.stringify(tileSet));
    }
    for (const definition of this.store.definitions()) {
      this.engine.loadWorld(serializeWorld(definition));
    }
  }

  private freeId(base: string): string {
    const taken = new Set(this.maps().map((map) => map.id));
    if (!taken.has(base)) {
      return base;
    }
    for (let n = 2; ; n += 1) {
      const candidate = `${base}_${n}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
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
      links: document.placedLinks.map((link) => ({
        id: link.id,
        at: link.at,
        label: link.name.length > 0 ? link.name : link.targetWorld,
      })),
      overlays: [],
      hover: this.hover(),
      selected: this.selected(),
      showGrid: this.showGrid(),
      showCoordinates: this.showCoordinates(),
    };
  }
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = window.document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function clampDimension(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.min(256, Math.max(1, parsed)) : 20;
}

function clampCoordinate(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
