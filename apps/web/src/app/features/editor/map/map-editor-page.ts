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
 * whole loaded project (`docs/adr/ADR-0014-map-links.md`).
 *
 * Saving is the other half of that: the buttons write the map, and the manifest
 * that goes with it, straight into the content directory through the authoring
 * server (`docs/adr/ADR-0019-authoring-content-workspace.md`). Invalid content
 * is never written — the files on disk are what the runtime boots on.
 */

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { Offset } from '../../../../core/hex/hex-coords';
import { HexLayout } from '../../../../core/hex/hex-layout';
import {
  DEFAULT_GRID_ALPHA,
  DEFAULT_GRID_COLOR,
  DEFAULT_GRID_LINE_WIDTH,
  MAX_CHARACTER_HEIGHT_TILES,
  MAX_GRID_LINE_WIDTH,
  MAX_REVEAL_RADIUS,
  MIN_CHARACTER_HEIGHT_TILES,
  RevealStyle,
  MIN_GRID_LINE_WIDTH,
  ProjectionMode,
  ResolvedCharacter,
  MAX_DECORATION_OFFSET,
  PixelOffset,
  ResolvedDecoration,
  WorldDefinition,
} from '../../../../content/content-types';
import { TILE_ART_BUNDLE } from '../../../../content/sprite-bundle';
import {
  CellOccupant,
  DocumentEntity,
  DocumentLink,
  DocumentTile,
  WorldDocument,
  previewCharacterOf,
} from '../../../../content/world-document';
import { serializeWorld } from '../../../../content/world-serializer';
import { ValidationReport } from '../../../../engine/engine.types';
import { Camera } from '../../../../renderer/camera';
import { CanvasView } from '../../../../renderer/canvas-view';
import { SpriteCache } from '../../../../renderer/character-renderer';
import { HexMapRenderer } from '../../../../renderer/hex-map-renderer';
import { renderDecorations } from '../../../../renderer/decoration-model';
import { RenderModel, resolveCellArtChoices } from '../../../../renderer/render-model';
import { SpriteRegistry } from '../../../../renderer/sprite-registry';
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import { ENGINE_SHORTCUT } from '../../../settings/engine-settings.schema';
import { SettingsService } from '../../../settings/settings.service';
import { CharacterLibraryService } from '../../../services/character-library.service';
import { DecorationLibraryService } from '../../../services/decoration-library.service';
import { ObjectLibraryService } from '../../../services/object-library.service';
import { TitleScreenService } from '../../../services/title-screen.service';
import { EngineService } from '../../../services/engine.service';
import { ContentWorkspaceService } from '../../../services/content-workspace.service';
import { ProjectStoreService, contentUrl } from '../../../services/project-store.service';

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
  | 'addCell'
  | 'removeCell'
  | 'player'
  | 'monster'
  | 'decoration'
  | 'link'
  | 'erase';

/** How far one click of the extent controls grows or shrinks a map. */
const EXTENT_STEP = 4;

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
  private readonly characters = inject(CharacterLibraryService);
  private readonly decorations = inject(DecorationLibraryService);
  private readonly objects = inject(ObjectLibraryService);
  private readonly workspace = inject(ContentWorkspaceService);

  /**
   * Keeps the map view on the player's own peek binding.
   *
   * Rebinding happens on the settings screen while a map may already be open,
   * and a view still watching the old key would look through relief on a key
   * that now means something else
   * (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
   */
  private readonly peekBinding = effect(() => {
    this.view?.setPeekKey(this.settings.keyBinding(ENGINE_SHORTCUT.peek));
  });

  private view: CanvasView | null = null;
  private renderer: HexMapRenderer | null = null;
  /**
   * The images tiles are drawn from, loaded on demand.
   *
   * A tile set that ships no art never asks for one, so this costs nothing
   * until an asset editor has painted something
   * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
   */
  private readonly tileImages = new SpriteCache(
    (asset) => contentUrl(asset),
    () => this.refresh(),
  );

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
  protected readonly gridLineWidths = [1, 2, 3, 4] as const;
  /** The four sides the extent controls act on, in reading order. */
  protected readonly extentSides = ['north', 'south', 'west', 'east'] as const;
  protected readonly showCoordinates = signal(false);
  /** Which decoration the decoration brush places. */
  protected readonly selectedDecoration = signal<string | null>(null);
  /** One resolve per definition, kept while the page is open. */
  private readonly decorationResolutions = new Map<string, ResolvedDecoration | null>();
  /** The placement the inspector is showing, so the canvas can outline it. */
  protected readonly selectedPlacement = signal<string | null>(null);
  /** Character brushes stay separate so switching tools does not lose either. */
  private readonly playerPreviewCharacter = signal<string | null>(null);
  private readonly monsterPreviewCharacter = signal<string | null>(null);
  /** Set while the map is waiting for the pictures it is painted from. */
  protected readonly loadingArt = signal(false);
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
   * being unable to write (`docs/adr/ADR-0019-authoring-content-workspace.md`).
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

  /** Character definitions relevant to the active placement tool. */
  protected readonly previewCharacters = computed(() => {
    const tool = this.tool();
    if (tool === 'player') {
      return this.characters.choices().filter((character) => character.category === 'player');
    }
    if (tool === 'monster') {
      return this.characters
        .choices()
        .filter((character) => character.category === 'monster' || character.category === 'enemy');
    }
    return [];
  });

  /** Character held by the active entity brush; `null` keeps the fallback glyph. */
  protected readonly selectedPreviewCharacter = computed(() => {
    switch (this.tool()) {
      case 'player':
        return this.playerPreviewCharacter();
      case 'monster':
        return this.monsterPreviewCharacter();
      default:
        return null;
    }
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

  /**
   * Bumped a few times a second while frames are being drawn, and only while
   * the readout is open.
   *
   * It used to hang off `revision`, which meant it only refreshed when the
   * document changed — and once hovering stopped rebuilding the model, it froze
   * on whichever frame the last edit had drawn. A renderer readout has to be
   * driven by the renderer.
   */
  protected readonly frameTick = signal(0);

  protected readonly stats = computed(() => {
    this.frameTick();
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
   * the point — the palette will only grow (`docs/adr/ADR-0006-assets-tilesets.md`).
   */
  protected readonly resourceDock = computed<'terrain' | 'maps' | 'characters' | null>(() => {
    switch (this.tool()) {
      case 'paint':
        return 'terrain';
      case 'map':
        return 'maps';
      case 'player':
      case 'monster':
        return 'characters';
      default:
        return null;
    }
  });

  /** Which inspector the left dock shows below the tool picker, if any. */
  protected readonly inspector = computed<
    'brush' | 'elevation' | 'shape' | 'placement' | 'decorations' | 'doors' | 'none'
  >(
    () => {
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
        case 'addCell':
        case 'removeCell':
          return 'shape';
        case 'decoration':
          return 'decorations';
        case 'link':
          return 'doors';
        default:
          return 'placement';
      }
    },
  );

  /** The palette entry the paint tool is holding. */
  protected readonly brush = computed<DocumentTile | null>(() => {
    const id = this.selectedTile();
    return this.palette().find((tile) => tile.id === id) ?? null;
  });

  /**
   * What the selected hex is drawn with, and what else it could be.
   *
   * The panel is a set of pickers, so it needs the *options* as much as the
   * current answer: the tile's own surface variants, every tile that ships a
   * cliff, and the variants of whichever cliff is actually drawing. `null` when
   * nothing is selected, which is what closes the panel
   * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
   */
  protected readonly cellArt = computed(() => {
    this.revision();
    const cell = this.selected();
    const document = this.document();
    const tile = cell === null || document === null ? null : document.tileAt(cell);
    if (cell === null || document === null || tile === null) {
      return null;
    }

    const chosen = document.artAt(cell);
    // The cliff that will draw: the borrowed one when there is one, which is
    // also the one whose variants the third picker may offer.
    const ladder =
      (chosen.elevationTile === null
        ? tile
        : (document.palette.find((entry) => entry.id === chosen.elevationTile) ?? null)) ?? tile;

    return {
      at: cell,
      tile,
      chosen,
      surfaces: tile.art?.surface ?? [],
      // A cliff can only be borrowed from a tile that has one to lend.
      cliffs: document.palette.filter((entry) =>
        (entry.art?.elevation?.levels ?? []).some((level) => level.variants.length > 0),
      ),
      // Variant ids are shared across a ladder's levels by construction — level
      // `n`'s `f` is the same cut as level 1's — so the first level's list is
      // the set of answers, not just one level's.
      cliffVariants: ladder.art?.elevation?.levels[0]?.variants ?? [],
    };
  });

  /** Everything authored on the selected hex, for the placement inspector. */
  protected readonly selection = computed(() => {
    this.revision();
    const cell = this.selected();
    const document = this.document();
    if (cell === null || document === null) {
      return null;
    }
    const entity = document.entityAt(cell);
    return {
      at: cell,
      tile: document.tileAt(cell),
      elevation: document.elevationAt(cell),
      entity,
      previewCharacter: entity === null ? null : previewCharacterOf(entity),
      link: document.linkAt(cell),
      location:
        document.placedLocations.find(
          (location) => location.at.col === cell.col && location.at.row === cell.row,
        ) ?? null,
    };
  });

  protected readonly maxOffset = MAX_DECORATION_OFFSET;

  /** The decorations this project ships, for the brush. */
  protected readonly decorationChoices = this.decorations.choices;

  /**
   * The decorations standing on the selected hex, in author order.
   *
   * A list rather than one, because a cell may hold a tree, a bush and a
   * signpost (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   */
  protected readonly placementsHere = computed(() => {
    this.revision();
    const cell = this.selected();
    const document = this.document();
    return cell === null || document === null ? [] : document.decorationsAt(cell);
  });

  /** Picks which decoration the brush plants. */
  protected selectDecoration(id: string): void {
    this.selectedDecoration.set(id);
    this.tool.set('decoration');
  }

  /** Outlines one placement on the canvas, so a row and a tree can be paired. */
  protected selectPlacement(id: string): void {
    this.selectedPlacement.set(this.selectedPlacement() === id ? null : id);
    this.refresh();
  }

  /**
   * Says whether a player may interact with **this** placement.
   *
   * The decision belongs here rather than to the definition: one chest in ten
   * holds the letter, and the other nine are scenery
   * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   */
  protected setPlacementInteractive(id: string, interactive: boolean): void {
    const document = this.store.document();
    if (document === null || !document.updateDecoration(id, { interactive })) {
      return;
    }
    this.store.touch();
    this.report.set(null);
    this.message.set(null);
    this.refresh();
  }

  /**
   * Renames one placement.
   *
   * The id is what the scenario will name, so it is the author's to write. A
   * name already taken on this map is refused and said so: two placements
   * answering to one name is not a state worth passing through
   * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   */
  protected setPlacementId(id: string, input: HTMLInputElement): void {
    const document = this.store.document();
    const next = input.value.trim();
    if (document === null || next === id) {
      return;
    }
    if (!document.renameDecoration(id, next)) {
      this.error.set(this.i18n.t('ui.editor.map.error.decorationIdTaken', { id: next }));
      // Put the real id back in the box by hand: nothing about the document
      // changed, so no binding would, and a field showing a name the placement
      // does not have is the field lying.
      input.value = id;
      return;
    }
    if (this.selectedPlacement() === id) {
      this.selectedPlacement.set(next);
    }
    this.error.set(null);
    this.store.touch();
    this.report.set(null);
    this.message.set(null);
    this.refresh();
  }

  /**
   * Nudges one placement off the anchor its definition gives it.
   *
   * The anchor is where a tree *belongs*; this is the few pixels that keep a
   * row of them from reading as a stamped pattern, and it is per placement
   * because that is the only thing that differs between two trees drawn from
   * one definition (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   */
  protected setPlacementOffset(id: string, axis: 0 | 1, raw: string): void {
    const value = Math.round(Number.parseFloat(raw));
    if (!Number.isFinite(value)) {
      return;
    }
    this.movePlacement(id, (offset) => {
      const next: PixelOffset = [...offset];
      next[axis] = Math.max(-MAX_DECORATION_OFFSET, Math.min(MAX_DECORATION_OFFSET, value));
      return next;
    });
  }

  /** Moves a placement by a pixel, which is what the nudge buttons do. */
  protected nudgePlacement(id: string, dx: number, dy: number): void {
    this.movePlacement(id, (offset) => [
      Math.max(-MAX_DECORATION_OFFSET, Math.min(MAX_DECORATION_OFFSET, offset[0] + dx)),
      Math.max(-MAX_DECORATION_OFFSET, Math.min(MAX_DECORATION_OFFSET, offset[1] + dy)),
    ]);
  }

  /** Puts a placement back exactly where its definition anchors it. */
  protected resetPlacementOffset(id: string): void {
    this.movePlacement(id, () => [0, 0]);
  }

  private movePlacement(id: string, move: (offset: PixelOffset) => PixelOffset): void {
    const document = this.store.document();
    const placed = document?.placedDecorations.find((candidate) => candidate.id === id);
    if (document === null || placed === undefined) {
      return;
    }
    if (!document.updateDecoration(id, { offset: move(placed.offset) })) {
      return;
    }
    this.selectedPlacement.set(id);
    this.store.touch();
    this.report.set(null);
    this.message.set(null);
    this.refresh();
  }

  /** Removes one placement, whatever else stands on its cell. */
  protected removePlacement(id: string): void {
    const document = this.store.document();
    if (document === null || !document.removeDecoration(id)) {
      return;
    }
    if (this.selectedPlacement() === id) {
      this.selectedPlacement.set(null);
    }
    this.store.touch();
    this.report.set(null);
    this.message.set(null);
    this.refresh();
  }

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
    void this.characters
      .ensureLoaded()
      .then(() => this.refresh())
      .catch(() => undefined);
    // Loaded for the same reason the characters are: the manifest names them,
    // and a world is judged against a project that has to load
    // (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
    //
    // And followed through, unlike them: a map opened before its definitions
    // land resolves every tree it places to nothing. Forgetting those misses
    // and drawing again is what makes a dressed map appear on its own, rather
    // than only after a visit to the decoration editor
    // (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
    void this.decorations
      .ensureLoaded()
      .then(() => {
        this.decorationResolutions.clear();
        this.refresh();
        // The model knows the trees now; their pictures still have to arrive.
        return this.renderer?.warmDecorations();
      })
      .then(() => this.refresh())
      .catch(() => undefined);
    void this.objects.ensureLoaded().catch(() => undefined);

    const document = this.store.requireDocument();
    this.selectedTile.set(document.palette[0]?.id ?? null);
    this.syncPreviewBrushes(document);

    const context = this.canvasRef().nativeElement.getContext('2d');
    if (context === null) {
      this.error.set(this.i18n.t('ui.common.noCanvas'));
      return;
    }

    this.renderer = new HexMapRenderer(
      context,
      new HexLayout(HEX_SIZE),
      new Camera(),
      new SpriteRegistry(),
      // A tile drawn from images needs its images; a tile set that ships none
      // simply never asks for one
      // (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
      this.tileImages,
      // All of them in one request rather than one each
      // (`docs/adr/ADR-0027-a-map-is-drawn-from-shared-pictures.md`).
      contentUrl(TILE_ART_BUNDLE),
    );
    this.renderer.setModel(this.buildModel(document));
    this.warmTileArt();

    this.view = new CanvasView(this.canvasRef().nativeElement, this.renderer, {
      // The outline is already drawn by the time this runs: `CanvasView` sets it
      // on the renderer itself. All that is left is the coordinate readout, so
      // no model is rebuilt and no `revision` is bumped here.
      onHover: (cell) => this.hover.set(cell),
      onClick: (cell) => {
        this.selected.set(cell);
        this.applyTool(cell);
      },
      onDragPaint: (cell) => this.applyTool(cell),
      onResize: () => this.frameOnce(),
      onFrameDrawn: () => {
        // Closed readout, no work: the panel is the only reader.
        if (this.showStats()) {
          this.frameTick.update((value) => value + 1);
        }
      },
    });
    this.view.setPeekKey(this.settings.keyBinding(ENGINE_SHORTCUT.peek));
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
   * Chooses the character preview held by an entity tool.
   *
   * The one player already on the map changes immediately. A monster changes
   * when its cell is selected; otherwise the choice applies to the next
   * placement, allowing several monsters to keep different models.
   */
  protected selectPreviewCharacter(character: string): void {
    const tool = this.tool();
    if (tool !== 'player' && tool !== 'monster') {
      return;
    }
    const next = character.length === 0 ? null : character;
    (tool === 'player' ? this.playerPreviewCharacter : this.monsterPreviewCharacter).set(next);

    const document = this.store.document();
    if (document === null) {
      return;
    }
    const selected = this.selected();
    const entity =
      tool === 'player'
        ? document.placedEntities.find((candidate) => candidate.templateId === 'player')
        : selected === null
          ? undefined
          : (document.entityAt(selected) ?? undefined);
    if (
      entity !== undefined &&
      entity.templateId === tool &&
      document.setEntityPreviewCharacter(entity.id, next)
    ) {
      this.store.touch();
      // Choosing the marker again is a real undo; unlike brush strokes this is
      // rare enough that checking every map here is cheap and keeps `dirty`
      // honest.
      this.store.refreshDirty();
      this.report.set(null);
      this.message.set(null);
    }
    this.refresh();
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
      case 'addCell':
        changed = document.setPresent(cell, true);
        break;
      case 'removeCell':
        changed = this.carve(document, cell);
        break;
      case 'player':
        changed =
          document.placeEntity(cell, 'player', true, this.playerPreviewCharacter()) !== null;
        break;
      case 'monster':
        changed =
          document.placeEntity(cell, 'monster', false, this.monsterPreviewCharacter()) !== null;
        break;
      case 'decoration': {
        const decoration = this.selectedDecoration();
        const placed =
          decoration === null ? null : document.placeDecoration(cell, decoration);
        if (placed !== null) {
          // Straight into the inspector: the next decision an author makes about
          // a tree they just planted is whether it can be searched
          // (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
          this.selectedPlacement.set(placed.id);
        }
        changed = placed !== null;
        break;
      }
      case 'link': {
        // A new door points at the first *other* map, which is the common case;
        // the inspector below the canvas is where the author corrects it.
        const target = this.maps().find((map) => map.id !== document.id)?.id ?? document.id;
        changed = document.placeLink(cell, target) !== null;
        break;
      }
      case 'erase':
        // Decorations first, and one at a time: a cell may hold three, and an
        // eraser that took all of them would be a different tool.
        changed =
          document.removeTopDecorationAt(cell) ||
          document.removeEntityAt(cell) ||
          document.removeLinkAt(cell) ||
          document.removeLocationAt(cell);
        break;
    }

    if (changed) {
      this.store.touch();
      this.report.set(null);
      this.message.set(null);
    }
    this.refresh();
  }

  // ------------------------------------------------------------------ shape

  /** How many hexes the map has, out of how many its buffers cover. */
  protected readonly shapeStats = computed(() => {
    this.revision();
    const document = this.document();
    if (document === null) {
      return null;
    }
    return {
      present: document.presentCellCount,
      total: document.width * document.height,
      width: document.width,
      height: document.height,
      col: document.bounds.origin.col,
      row: document.bounds.origin.row,
    };
  });

  /**
   * Carves a hex out of the map, refusing while something stands on it.
   *
   * Refusing rather than taking the entity, the door or the point of interest
   * with it: authored content is never destroyed by a brush stroke
   * (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
   */
  private carve(document: WorldDocument, cell: Offset): boolean {
    const occupants = document.occupantsAt(cell);
    if (occupants.length > 0) {
      const first = occupants[0] as CellOccupant;
      this.error.set(
        this.i18n.t(`ui.editor.map.error.carveBlocked.${first.kind}`, { id: first.id }),
      );
      return false;
    }
    return document.setPresent(cell, false);
  }

  /**
   * Grows or shrinks the extent on one side.
   *
   * Growing north or west moves the origin instead of renumbering the cells, so
   * an authored coordinate — and every door in another map pointing at it —
   * survives the change (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`). New
   * cells arrive absent: blank canvas, not a slab of terrain.
   */
  protected extend(side: 'north' | 'south' | 'east' | 'west', steps: number): void {
    const document = this.store.document();
    if (document === null) {
      return;
    }
    const { origin, width, height } = document.bounds;
    const next =
      side === 'north'
        ? { origin: { col: origin.col, row: origin.row - steps }, width, height: height + steps }
        : side === 'south'
          ? { origin, width, height: height + steps }
          : side === 'west'
            ? { origin: { col: origin.col - steps, row: origin.row }, width: width + steps, height }
            : { origin, width: width + steps, height };

    const stranded = document.occupantsOutside(next);
    if (stranded.length > 0) {
      const first = stranded[0] as CellOccupant;
      this.error.set(
        this.i18n.t(`ui.editor.map.error.trimBlocked.${first.kind}`, { id: first.id }),
      );
      return;
    }
    const hexes = document.presentOutside(next);
    if (hexes > 0) {
      this.error.set(this.i18n.t('ui.editor.map.error.trimBlocked.cells', { count: hexes }));
      return;
    }
    if (!document.resize(next)) {
      return;
    }
    this.store.touch();
    this.report.set(null);
    this.message.set(null);
    this.framed = false;
    this.refresh();
    this.view?.fit();
  }

  /** Grows the extent by {@link EXTENT_STEP} on one side. */
  protected grow(side: 'north' | 'south' | 'east' | 'west'): void {
    this.extend(side, EXTENT_STEP);
  }

  /** Shrinks the extent by {@link EXTENT_STEP} on one side. */
  protected shrink(side: 'north' | 'south' | 'east' | 'west'): void {
    this.extend(side, -EXTENT_STEP);
  }

  // --------------------------------------------------------------- cell art

  /**
   * Chooses what the selected hex is drawn with; `''` puts a field back on the
   * roll.
   *
   * The ids are not checked here. The tile set is the authority on which
   * variants exist and the Rust validator is what reports a dangling one, just
   * as with a door's target — and a choice that stops resolving costs the cell
   * its choice, not its picture
   * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
   */
  protected setCellArt(field: 'surface' | 'elevationTile' | 'elevation', value: string): void {
    const cell = this.selected();
    const document = this.store.document();
    if (cell === null || document === null) {
      return;
    }
    if (!document.setArt(cell, { [field]: value.length === 0 ? null : value })) {
      return;
    }
    this.store.touch();
    this.report.set(null);
    this.refresh();
  }

  /** Puts every choice on the selected hex back on the roll. */
  protected rollCellArt(): void {
    const cell = this.selected();
    const document = this.store.document();
    if (cell === null || document === null) {
      return;
    }
    if (!document.setArt(cell, { surface: null, elevationTile: null, elevation: null })) {
      return;
    }
    this.store.touch();
    this.report.set(null);
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
   * Applies the open map's id, name, zone, character scale and reveal in one go.
   *
   * The zone is set first: renaming may be refused for a duplicate id, and the
   * move it was bundled with should not be lost with it.
   */
  protected applyMapSettings(
    id: string,
    name: string,
    zone: string,
    characterHeightTiles: string,
    revealRadius: string,
    revealOpacity: string,
    revealNeighbourOpacity: string,
  ): void {
    if (this.store.setZone(zone)) {
      // Follow the map into its new zone rather than letting the picker filter
      // out the map it is meant to be showing.
      if (this.zoneFilter() !== null) {
        this.zoneFilter.set(zone);
      }
      this.message.set(this.i18n.t('ui.editor.map.message.movedToZone', { zone }));
    }
    const document = this.store.document();
    const parsedHeight = Number(characterHeightTiles);
    if (document !== null && Number.isFinite(parsedHeight)) {
      const nextHeight = Math.min(
        MAX_CHARACTER_HEIGHT_TILES,
        Math.max(MIN_CHARACTER_HEIGHT_TILES, parsedHeight),
      );
      if (document.characterHeightTiles !== nextHeight) {
        document.characterHeightTiles = nextHeight;
        this.store.touch();
        this.report.set(null);
      }
    }
    if (
      document !== null &&
      this.applyReveal(document, revealRadius, revealOpacity, revealNeighbourOpacity)
    ) {
      this.store.touch();
      this.report.set(null);
    }
    this.renameWorld(id, name);
  }

  /**
   * Clamps and stores how far relief may be seen through; `true` when it moved.
   *
   * Clamped rather than refused: these are two dials on a slider, and an author
   * who types `9` means "as far as it goes"
   * (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
   */
  private applyReveal(
    document: WorldDocument,
    radius: string,
    opacity: string,
    neighbourOpacity: string,
  ): boolean {
    const numbers = [radius, opacity, neighbourOpacity].map(Number);
    if (!numbers.every((value) => Number.isFinite(value))) {
      return false;
    }
    const [parsedRadius = 0, parsedOpacity = 0, parsedNeighbour = 0] = numbers;
    const next: RevealStyle = {
      radius: Math.min(MAX_REVEAL_RADIUS, Math.max(0, Math.trunc(parsedRadius))),
      opacity: Math.min(1, Math.max(0, parsedOpacity)),
      neighbourOpacity: Math.min(1, Math.max(0, parsedNeighbour)),
    };
    if (
      document.reveal.radius === next.radius &&
      document.reveal.opacity === next.opacity &&
      document.reveal.neighbourOpacity === next.neighbourOpacity
    ) {
      return false;
    }
    document.reveal = next;
    return true;
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
      this.syncPreviewBrushes(document);
    }
    this.selected.set(null);
    this.view?.clearHover();
    this.report.set(null);
    this.message.set(null);
    this.rebuild();
    // Another map may be painted from another tile set entirely.
    this.warmTileArt();
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
      this.syncPreviewBrushes(document);
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
    const next = this.store.document();
    if (next !== null) {
      this.syncPreviewBrushes(next);
    }
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
    const document = this.store.document();
    if (document !== null) {
      this.syncPreviewBrushes(document);
    }
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
   * resolves, so saving the project checks both (`docs/adr/ADR-0014-map-links.md`).
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
      this.syncPreviewBrushes(document);
      this.report.set(null);
      this.message.set(this.i18n.t('ui.editor.map.message.imported', { file: file.name }));
      this.rebuild();
      this.view?.fit();
    } catch (cause) {
      this.error.set(
        this.i18n.t('ui.editor.map.error.importFailed', {
          file: file.name,
          reason: describe(cause),
        }),
      );
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
   * the locales, the title screen, the settings, the characters and every tile
   * set.
   *
   * Locales go back in with the rest; `resetContent` cleared them, and the
   * manifest will not load without the languages it declares
   * (`docs/adr/ADR-0020-localised-content-keys.md`).
   */
  private resetEngineContent(): void {
    this.engine.resetContent();
    this.i18n.register();
    this.titleScreen.register();
    this.settings.register();
    this.characters.register();
    this.decorations.register();
    this.objects.register();
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

  /** Chooses a zoom-independent grid stroke width in screen pixels. */
  protected selectGridLineWidth(width: number): void {
    this.updateGridStyle({
      lineWidth: Math.min(MAX_GRID_LINE_WIDTH, Math.max(MIN_GRID_LINE_WIDTH, Math.round(width))),
    });
  }

  /** Chooses the authored six-digit RGB grid colour. */
  protected selectGridLineColor(color: string): void {
    this.updateGridStyle({ color });
  }

  /** Chooses the authored grid opacity from a native range input. */
  protected selectGridLineAlpha(alpha: string): void {
    const value = Number(alpha);
    if (!Number.isFinite(value)) {
      return;
    }
    this.updateGridStyle({ alpha: Math.min(1, Math.max(0, value)) });
  }

  private updateGridStyle(patch: { lineWidth?: number; color?: string; alpha?: number }): void {
    const document = this.store.document();
    if (document === null || !document.setGridStyle(patch)) {
      return;
    }
    this.store.touch();
    this.store.refreshDirty();
    this.report.set(null);
    this.message.set(null);
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
   * (`docs/adr/ADR-0013-isometric-projection.md`), so the runtime will render
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
    // The two views are drawn from two different sets of images, and the one
    // just switched to may never have been asked for
    // (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
    this.warmTileArt();
    this.view?.fit();
  }

  /** The projection the document is currently authored with. */
  protected readonly projection = computed<ProjectionMode>(() => {
    this.revision();
    return this.document()?.projection ?? 'topDown';
  });

  protected readonly gridLineWidth = computed(() => {
    this.revision();
    return this.document()?.grid.lineWidth ?? DEFAULT_GRID_LINE_WIDTH;
  });

  protected readonly gridLineColor = computed(() => {
    this.revision();
    return this.document()?.grid.color ?? DEFAULT_GRID_COLOR;
  });

  protected readonly gridLineAlpha = computed(() => {
    this.revision();
    return this.document()?.grid.alpha ?? DEFAULT_GRID_ALPHA;
  });

  protected readonly gridLineAlphaPercent = computed(() =>
    Math.round(this.gridLineAlpha() * 100),
  );

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

  /** Starts each entity brush from what the newly opened map already uses. */
  private syncPreviewBrushes(document: WorldDocument): void {
    const player = document.placedEntities.find((entity) => entity.templateId === 'player');
    const monster = document.placedEntities.find((entity) => entity.templateId === 'monster');
    this.playerPreviewCharacter.set(player === undefined ? null : previewCharacterOf(player));
    this.monsterPreviewCharacter.set(monster === undefined ? null : previewCharacterOf(monster));
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

  /**
   * Loads the pictures the open map is painted from, and redraws once they are in.
   *
   * The map first, then the rest of the palette: until the map's own images
   * settle the canvas shows its background rather than a map filling in tile by
   * tile, and a brush the author has not picked yet is one they are about to
   * (`docs/adr/ADR-0027-a-map-is-drawn-from-shared-pictures.md`).
   */
  private warmTileArt(): void {
    const renderer = this.renderer;
    if (renderer === null) {
      return;
    }
    this.loadingArt.set(true);
    void renderer
      .warmTileArt()
      .then(() => {
        this.loadingArt.set(false);
        this.refresh();
        // The brushes follow, unwaited: picking an unused tile should find it
        // drawn, and nobody should watch the map wait for it.
        return renderer.warmPalette();
      })
      .then(() => this.refresh());
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
    const characterPreviews = new Map<string, ResolvedCharacter | null>();
    return {
      bounds: document.bounds,
      projection: document.projection,
      characterHeightTiles: document.characterHeightTiles,
      reveal: document.reveal,
      tileArt: document.tileArt,
      palette: document.palette,
      terrain: document.terrain,
      presence: document.presence,
      elevation: document.elevation,
      elevationRange: document.elevationRange,
      artChoices: resolveCellArtChoices(document.palette, document.terrain, document.artOverrides),
      entities: document.placedEntities.map((entity) => ({
        id: entity.id,
        at: entity.at,
        visualId: `entity.${entity.templateId}`,
        fallbackColor: entity.templateId === 'player' ? '#f2c14e' : '#c0392b',
        character: this.resolvePreviewCharacter(entity, characterPreviews),
        glyph: entity.templateId === 'player' ? '@' : 'M',
        emphasised: false,
      })),
      decorations: renderDecorations(
        document.placedDecorations.map((placed) => ({
          id: placed.id,
          decoration: placed.decoration,
          at: [placed.at.col, placed.at.row] as [number, number],
          offset: placed.offset,
          interactive: placed.interactive,
        })),
        (id) => this.resolveDecoration(id),
        this.selectedPlacement(),
      ),
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
      selected: this.selected(),
      // The author needs to see — and click — the canvas they may extend into
      // (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
      showExtent: true,
      showGrid: this.showGrid(),
      gridLineWidth: document.grid.lineWidth,
      gridLineColor: document.grid.color,
      gridLineAlpha: document.grid.alpha,
      showCoordinates: this.showCoordinates(),
    };
  }

  /**
   * What a decoration definition draws, or `null` when nothing loaded it.
   *
   * Through Rust, like every other resolve: the editor and the game place a
   * trunk with the same arithmetic
   * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   */
  private resolveDecoration(id: string): ResolvedDecoration | null {
    if (this.decorationResolutions.has(id)) {
      return this.decorationResolutions.get(id) ?? null;
    }
    let drawn: ResolvedDecoration | null = null;
    try {
      drawn = this.engine.resolveDecoration(id);
    } catch {
      drawn = null;
    }
    this.decorationResolutions.set(id, drawn);
    return drawn;
  }

  /** Resolves a static idle pose for one editor-only entity appearance. */
  private resolvePreviewCharacter(
    entity: DocumentEntity,
    cache: Map<string, ResolvedCharacter | null>,
  ): ResolvedCharacter | null {
    const id = previewCharacterOf(entity);
    if (id === null || !this.engine.isReady) {
      return null;
    }
    const cached = cache.get(id);
    if (cached !== undefined || cache.has(id)) {
      return cached ?? null;
    }
    try {
      const resolved = this.engine.resolveCharacterRole(id, {}, 'idle', 0);
      cache.set(id, resolved);
      return resolved;
    } catch {
      // A removed or unreadable definition never makes the map disappear: its
      // entity falls back to the marker, and the picker no longer offers it.
      cache.set(id, null);
      return null;
    }
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
