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
 *
 * Saving is the other half of that: the buttons write the map, and the manifest
 * that goes with it, straight into the content directory through the authoring
 * server (`docs/adr/ADR-0022-authoring-content-workspace.md`). Invalid content
 * is never written — the files on disk are what the runtime boots on.
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
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import { SettingsService } from '../../../settings/settings.service';
import { TitleScreenService } from '../../../services/title-screen.service';
import { EngineService } from '../../../services/engine.service';
import { ContentWorkspaceService } from '../../../services/content-workspace.service';
import { ProjectStoreService } from '../../../services/project-store.service';

/** Hex circumradius in world pixels. The camera scales from here. */
const HEX_SIZE = 28;

/**
 * Prefix on the zone picker's option values.
 *
 * A zone name is free text, so it could be anything the "every zone" option
 * might use as its own value — including `all` and the empty string, which is
 * the unzoned bucket. Prefixing the real zones keeps the two apart.
 */
const ZONE_OPTION = 'zone:';

/**
 * What a click on the canvas does — and, for the tools that need content, what
 * the right dock offers.
 *
 * `map` edits nothing on the canvas: it is the project browser, and it earns a
 * place here because the dock it opens is chosen by the tool like any other.
 */
export type EditorTool =
  | 'map'
  | 'paint'
  | 'raise'
  | 'lower'
  | 'player'
  | 'monster'
  | 'link'
  | 'erase';

@Component({
  selector: 'app-map-editor-page',
  imports: [TranslatePipe],
  templateUrl: './map-editor-page.html',
  styleUrl: './map-editor-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapEditorPage implements AfterViewInit, OnDestroy {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly store = inject(ProjectStoreService);
  private readonly engine = inject(EngineService);
  private readonly i18n = inject(I18nService);
  private readonly settings = inject(SettingsService);
  private readonly titleScreen = inject(TitleScreenService);
  private readonly workspace = inject(ContentWorkspaceService);

  private view: CanvasView | null = null;
  private renderer: HexMapRenderer | null = null;
  /** Set once the map has been framed; see {@link frameOnce}. */
  private framed = false;

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
  /** The renderer readout, floated over the canvas rather than docked. */
  protected readonly showStats = signal(false);
  protected readonly report = signal<ValidationReport | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  /** Bumped on every document mutation so computed views recompute. */
  protected readonly revision = signal(0);
  /** The zone whose maps the picker lists; `null` lists every map. */
  protected readonly zoneFilter = signal<string | null>(null);
  /** Set while a save is in flight, so the buttons cannot be pressed twice. */
  protected readonly busy = signal(false);

  /**
   * `true` once the authoring server has answered — the editor is honest about
   * being unable to write (`docs/adr/ADR-0022-authoring-content-workspace.md`).
   */
  protected readonly writable = computed(() => this.workspace.status() !== null);

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

  /**
   * The project's zones, in author order, with how many maps each holds.
   *
   * Author order, not alphabetical: the first zone is the default one, and a
   * list that reorders itself would hide which that is.
   */
  protected readonly zones = computed(() => {
    const counts = new Map<string, number>();
    for (const map of this.maps()) {
      counts.set(map.zone, (counts.get(map.zone) ?? 0) + 1);
    }
    return this.store.zones().map((zone) => ({
      id: zone.id,
      label: zone.name === undefined || zone.name.length === 0 ? zone.id : zone.name,
      count: counts.get(zone.id) ?? 0,
    }));
  });

  /** The display name of a zone id, for captions. */
  protected zoneLabel(id: string): string {
    return this.zones().find((zone) => zone.id === id)?.label ?? id;
  }

  /** The zone the open map is in, with the default resolved. */
  protected readonly openZoneId = computed(() => {
    this.revision();
    const zone = this.document()?.zone ?? '';
    return zone.length > 0 ? zone : this.store.defaultZoneId();
  });

  /** The maps the picker lists: those of the chosen zone, or all of them. */
  protected readonly visibleMaps = computed(() => {
    const zone = this.zoneFilter();
    const maps = this.maps();
    return zone === null ? maps : maps.filter((map) => map.zone === zone);
  });

  /**
   * Which resource palette the right dock offers, or `null` to close it.
   *
   * A palette is a *tool's* content: the terrain list is the paint tool's brush
   * box and has no meaning while raising ground or placing doors. Closing the
   * dock rather than greying it out gives the canvas the width back, which is
   * the point — the palette will only grow (`docs/adr/ADR-0009-assets-tilesets.md`).
   */
  protected readonly resourceDock = computed<'terrain' | 'maps' | null>(() => {
    switch (this.tool()) {
      case 'paint':
        return 'terrain';
      case 'map':
        return 'maps';
      default:
        return null;
    }
  });

  /** Which inspector the left dock shows below the tool picker, if any. */
  protected readonly inspector = computed<'brush' | 'elevation' | 'placement' | 'doors' | 'none'>(() => {
    switch (this.tool()) {
      case 'map':
        // The map tool's whole content — browser, settings, new map — is in the
        // right dock; repeating any of it on the left would only split it.
        return 'none';
      case 'paint':
        return 'brush';
      case 'raise':
      case 'lower':
        return 'elevation';
      case 'link':
        return 'doors';
      default:
        return 'placement';
    }
  });

  /** The palette entry the paint tool is holding. */
  protected readonly brush = computed<DocumentTile | null>(() => {
    const id = this.selectedTile();
    return this.palette().find((tile) => tile.id === id) ?? null;
  });

  /** Everything authored on the selected hex, for the placement inspector. */
  protected readonly selection = computed(() => {
    this.revision();
    const cell = this.selected();
    const document = this.document();
    if (cell === null || document === null) {
      return null;
    }
    return {
      at: cell,
      tile: document.tileAt(cell),
      elevation: document.elevationAt(cell),
      entity: document.entityAt(cell),
      link: document.linkAt(cell),
      location:
        document.placedLocations.find(
          (location) => location.at.col === cell.col && location.at.row === cell.row,
        ) ?? null,
    };
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

    // Not awaited: the editor opens and paints without the languages, the
    // settings or an authoring server, and the panels and buttons that need
    // them re-render as soon as they arrive.
    void this.i18n.ensureAdopted().catch(() => undefined);
    void this.workspace.ensureProbed().catch(() => undefined);
    void this.settings.ensureLoaded().catch(() => undefined);

    const document = this.store.requireDocument();
    this.selectedTile.set(document.palette[0]?.id ?? null);

    const context = this.canvasRef().nativeElement.getContext('2d');
    if (context === null) {
      this.error.set(this.i18n.t('ui.common.noCanvas'));
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
      onResize: () => this.frameOnce(),
    });
    this.frameOnce();
  }

  /**
   * Frames the map the first time the canvas has a real size, and never again.
   *
   * The canvas may still be laid out when the view is built, so the first useful
   * size arrives through the resize observer — but every *later* resize is a
   * dock opening or a window being dragged, and refitting there would throw away
   * the author's zoom and pan. `CanvasView` keeps the viewport centre steady
   * across those instead.
   */
  private frameOnce(): void {
    if (this.framed || this.view === null) {
      return;
    }
    const { width, height } = this.view.viewport;
    if (width <= 1 || height <= 1) {
      return;
    }
    this.framed = true;
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
      case 'map':
        // Browsing the project, not editing the map: a click only selects.
        break;
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
      this.message.set(this.i18n.t('ui.editor.map.message.engineLoading'));
      return;
    }
    try {
      this.loadProjectIntoEngine();
      const report = this.engine.validateLinks();
      this.report.set(report);
      this.message.set(
        this.i18n.t(
          report.valid ? 'ui.editor.map.message.doorsResolve' : 'ui.editor.map.message.doorsDangle',
        ),
      );
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // ------------------------------------------------------------------- maps

  /** Points the picker at a zone, or at every map. */
  protected setZoneFilter(option: string): void {
    this.zoneFilter.set(option.startsWith(ZONE_OPTION) ? option.slice(ZONE_OPTION.length) : null);
  }

  /**
   * Applies the open map's id, name and zone in one go.
   *
   * The zone is set first: renaming may be refused for a duplicate id, and the
   * move it was bundled with should not be lost with it.
   */
  protected applyMapSettings(id: string, name: string, zone: string): void {
    if (this.store.setZone(zone)) {
      // Follow the map into its new zone rather than letting the picker filter
      // out the map it is meant to be showing.
      if (this.zoneFilter() !== null) {
        this.zoneFilter.set(zone);
      }
      this.message.set(this.i18n.t('ui.editor.map.message.movedToZone', { zone }));
    }
    this.renameWorld(id, name);
  }

  /** Declares a zone, named by the author; the id is derived from the name. */
  protected createZone(name: string): void {
    const id = slugify(name);
    if (!this.store.addZone(id, name)) {
      this.error.set(
        id.length === 0
          ? 'Give the zone a name.'
          : `The project already has a zone called "${id}".`,
      );
      return;
    }
    this.zoneFilter.set(id);
    this.message.set(this.i18n.t('ui.editor.map.message.zoneAdded', { zone: id }));
    this.rebuild();
  }

  /** Removes the zone the picker is filtered on, if it is empty. */
  protected removeFilteredZone(): void {
    const zone = this.zoneFilter();
    if (zone === null) {
      return;
    }
    if (!this.store.removeZone(zone)) {
      this.error.set(
        `Zone "${zone}" still holds maps, or is the project's only zone. Move its maps first.`,
      );
      return;
    }
    this.zoneFilter.set(null);
    this.message.set(this.i18n.t('ui.editor.map.message.zoneRemoved', { zone }));
    this.rebuild();
  }

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

  protected async createWorld(
    widthInput: string,
    heightInput: string,
    name: string,
    zone: string,
  ): Promise<void> {
    const width = clampDimension(widthInput);
    const height = clampDimension(heightInput);
    try {
      const document = WorldDocument.create({
        id: this.freeId(slugify(name) || 'new_map'),
        name: name.trim() || 'New Map',
        width,
        height,
        tileSet: this.store.requireTileSet(),
        zone: zone.length > 0 ? zone : this.store.defaultZoneId(),
      });
      this.store.addWorld(document);
      this.selectedTile.set(document.palette[0]?.id ?? null);
      if (this.zoneFilter() !== null) {
        // The map that was just opened has to be one the picker lists.
        this.zoneFilter.set(document.zone);
      }
      this.report.set(null);
      this.message.set(this.i18n.t('ui.editor.map.message.mapAdded', { width, height }));
      this.rebuild();
      this.view?.fit();
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause.message : String(cause));
    }
  }

  protected renameWorld(id: string, name: string): void {
    const nextId = slugify(id) || this.store.requireDocument().id;
    if (!this.store.renameWorld(nextId, name.trim() || nextId)) {
      this.error.set(this.i18n.t('ui.editor.map.error.idTaken', { id: nextId }));
      return;
    }
    this.message.set(this.i18n.t('ui.editor.map.message.mapRenamed', { id: nextId }));
    this.rebuild();
  }

  protected removeWorld(): void {
    const document = this.store.document();
    if (document === null) {
      return;
    }
    if (!this.store.removeWorld(document.id)) {
      this.error.set(this.i18n.t('ui.editor.map.error.lastMap'));
      return;
    }
    this.message.set(this.i18n.t('ui.editor.map.message.mapRemoved', { id: document.id }));
    this.selected.set(null);
    this.rebuild();
    this.view?.fit();
  }

  protected async resetToShipped(): Promise<void> {
    try {
      await this.store.resetToShipped();
    } catch (cause) {
      this.error.set(this.i18n.t('ui.editor.map.error.reloadFailed', { reason: describe(cause) }));
      return;
    }
    this.selected.set(null);
    this.selectedTile.set(this.store.document()?.palette[0]?.id ?? null);
    this.report.set(null);
    this.message.set(this.i18n.t('ui.editor.map.message.reloaded'));
    this.rebuild();
    this.view?.fit();
  }

  // ---------------------------------------------------------------- content

  /** Runs the engine's validator over the open map. */
  protected validate(): ValidationReport | null {
    this.message.set(null);
    if (!this.engine.isReady) {
      this.message.set(this.i18n.t('ui.editor.map.message.engineLoading'));
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

  /**
   * Writes the open map into the content directory.
   *
   * The map is validated first and an invalid one is **not** written: the file
   * on disk is what the runtime boots on, so the editor never puts content
   * there that the runtime would refuse to load.
   *
   * A map that already matches its file is left alone — see
   * {@link reconcileManifest} for the rest of what a save owes the directory.
   */
  protected async saveWorld(): Promise<void> {
    const definition = this.store.currentDefinition();
    const path = this.store.worldPath(definition.id);

    await this.write(async () => {
      const report = this.validate();
      if (report === null) {
        return null;
      }
      if (!report.valid) {
        this.error.set(this.i18n.t('ui.editor.map.error.notWritten'));
        return null;
      }

      const parts: string[] = [];
      if (this.store.worldNeedsWriting(definition.id)) {
        await this.workspace.writeJson(path, serializeWorld(definition));
        this.store.markWorldWritten(definition.id);
        parts.push(this.i18n.t('ui.editor.map.message.savedMap', { file: path }));
      } else {
        parts.push(this.i18n.t('ui.editor.map.message.mapUpToDate', { file: path }));
      }
      parts.push(...(await this.reconcileManifest()));
      return parts.join(' \u00b7 ');
    });
  }

  /**
   * Brings the whole content directory in line with the project.
   *
   * Only the maps that actually differ are written: authored content is kept
   * under version control, and rewriting untouched files would bury the real
   * change in a diff of timestamps.
   */
  protected async saveProject(): Promise<void> {
    await this.write(async () => {
      const report = this.validateProject();
      if (report === null) {
        return null;
      }
      if (!report.valid) {
        this.error.set(this.i18n.t('ui.editor.map.error.notWritten'));
        return null;
      }

      const byId = new Map(
        this.store.definitions().map((definition) => [definition.id, definition]),
      );
      const changed = this.store.changedWorldIds();
      for (const id of changed) {
        const definition = byId.get(id);
        if (definition === undefined) {
          continue;
        }
        await this.workspace.writeJson(this.store.worldPath(id), serializeWorld(definition));
        this.store.markWorldWritten(id);
      }

      const parts =
        changed.length === 0
          ? []
          : [this.i18n.t('ui.editor.map.message.savedProject', { count: changed.length })];
      parts.push(...(await this.reconcileManifest()));
      return parts.length === 0
        ? this.i18n.t('ui.editor.map.message.upToDate')
        : parts.join(' \u00b7 ');
    });
  }

  /**
   * Writes `project.json` when it no longer describes the project, then deletes
   * the files of maps the editor no longer holds — removed, or renamed, which
   * leaves the old file behind just the same.
   *
   * The manifest goes first on purpose: a manifest still naming a file that has
   * been deleted is content the runtime cannot load, while a file no manifest
   * names is only clutter. If one of the two fails, this is the half to have
   * done.
   */
  private async reconcileManifest(): Promise<string[]> {
    const parts: string[] = [];

    if (this.store.manifestNeedsWriting()) {
      await this.workspace.writeJson('project.json', this.store.projectJson());
      this.store.markManifestWritten();
      parts.push(this.i18n.t('ui.editor.map.message.savedManifest'));
    }

    const orphans = this.store.orphanedWorlds();
    for (const orphan of orphans) {
      await this.workspace.remove(orphan.path);
      this.store.markWorldDeleted(orphan.id);
    }
    if (orphans.length > 0) {
      parts.push(
        this.i18n.t('ui.editor.map.message.removedMaps', {
          count: orphans.length,
          files: orphans.map((orphan) => orphan.path).join(', '),
        }),
      );
    }

    return parts;
  }

  /**
   * Runs a write, owning the parts every save shares: the busy flag, the
   * cleared notices, and turning a failed request into a message rather than a
   * rejected promise. The body returns the note to show, or `null` when it
   * decided not to write and has already said why.
   */
  private async write(body: () => Promise<string | null>): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.message.set(null);
    try {
      this.message.set(await body());
    } catch (cause) {
      this.error.set(describe(cause));
    } finally {
      // Once, at the end: what is still unwritten is a question about every map,
      // and asking it per file would cost a serialisation of the whole project
      // per file written.
      this.store.refreshDirty();
      this.busy.set(false);
    }
  }

  /**
   * Validates every map plus the doors between them.
   *
   * A project is only loadable if each of its files is *and* every door
   * resolves, so saving the project checks both (`docs/adr/ADR-0017-map-links.md`).
   * `null` means the engine was not ready and nothing was checked.
   */
  private validateProject(): ValidationReport | null {
    if (!this.engine.isReady) {
      this.message.set(this.i18n.t('ui.editor.map.message.engineLoading'));
      return null;
    }
    try {
      // Each world is validated *before* it is registered: `loadWorld` throws on
      // content the validator would reject, and a thrown error is a worse
      // report than the one the validator writes.
      this.resetEngineContent();
      for (const definition of this.store.definitions()) {
        const json = serializeWorld(definition);
        const report = this.engine.validateWorld(json);
        if (!report.valid) {
          this.report.set(report);
          return report;
        }
        this.engine.loadWorld(json);
      }
      const links = this.engine.validateLinks();
      this.report.set(links);
      return links;
    } catch (cause) {
      this.error.set(describe(cause));
      return null;
    }
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
      this.message.set(this.i18n.t('ui.editor.map.message.imported', { file: file.name }));
      this.rebuild();
      this.view?.fit();
    } catch (cause) {
      this.error.set(this.i18n.t('ui.editor.map.error.importFailed', { file: file.name, reason: describe(cause) }));
    } finally {
      input.value = '';
    }
  }

  /**
   * Registers the whole project with the engine, for link validation.
   *
   * The registry is cleared first: loading is additive, so a map removed or
   * renamed in the editor would otherwise still be there to satisfy a door that
   * points at it, and the check would pass on content that no longer exists.
   */
  private loadProjectIntoEngine(): void {
    this.resetEngineContent();
    for (const definition of this.store.definitions()) {
      this.engine.loadWorld(serializeWorld(definition));
    }
  }

  /**
   * Clears the registry and puts back everything a world is judged against:
   * the locales, the title screen, the settings and every tile set.
   *
   * Locales go back in with the rest; `resetContent` cleared them, and the
   * manifest will not load without the languages it declares
   * (`docs/adr/ADR-0023-localised-content-keys.md`).
   */
  private resetEngineContent(): void {
    this.engine.resetContent();
    this.i18n.register();
    this.titleScreen.register();
    this.settings.register();
    for (const tileSet of this.store.tileSetDefinitions()) {
      this.engine.loadTileSet(JSON.stringify(tileSet));
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

  protected toggleStats(): void {
    this.showStats.update((value) => !value);
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

  /** Clears the floating notices: the error, the note and the last report. */
  protected dismissNotices(): void {
    this.error.set(null);
    this.message.set(null);
    this.report.set(null);
  }

  /**
   * Drops the zone filter when the project no longer declares that zone.
   *
   * An *empty* zone is not stale — a zone is created before it holds anything —
   * so only an undeclared one resets the picker.
   */
  private syncZoneFilter(): void {
    const zone = this.zoneFilter();
    if (zone !== null && !this.zones().some((entry) => entry.id === zone)) {
      this.zoneFilter.set(null);
    }
  }

  /** Rebuilds the render model from the document and redraws. */
  private rebuild(): void {
    this.syncZoneFilter();
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

/** An unknown failure as a sentence, for the `{reason}` of a message key. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
