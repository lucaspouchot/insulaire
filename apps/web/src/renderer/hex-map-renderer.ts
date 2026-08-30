/**
 * Canvas renderer for a hex map.
 *
 * Framework-free on purpose: Angular components own a `<canvas>` and hand this
 * class a {@link RenderModel}, but nothing here knows Angular exists
 * (`CLAUDE.md`, "Keep rendering code separate from Angular components").
 *
 * # Three properties that matter at scale
 *
 * **Viewport culling.** Only the cells returned by
 * {@link HexLayout.visibleRange} are touched. Drawing cost follows the window,
 * not the map: a 2048x2048 world costs the same per frame as a 20x20 one.
 *
 * **Batched filling.** Terrain is drawn by accumulating one `Path2D` per palette
 * entry and issuing a single `fill()` for each. A six-tile palette costs six
 * fills regardless of how many hexes are on screen, instead of one state change
 * per hex.
 *
 * **Shared pictures.** A cell's art is not resolved, and its layers are not
 * stacked, once per cell per frame: identical-looking cells share one composed
 * picture out of {@link TileAppearanceCache}, and a cell costs one lookup and
 * one blit. Nothing is drawn from that art until it has all arrived, so a map
 * appears whole rather than filling in as its files land
 * (`docs/adr/ADR-0027-a-map-is-drawn-from-shared-pictures.md`).
 *
 * **Two draw paths.** A top-down world is one band covering the whole viewport,
 * which is the single-batch case above. An isometric world is drawn a row at a
 * time from back to front, because elevated cells overlap the row behind them —
 * batching is then per row, and everything standing on a row (overlays,
 * entities, markers) is drawn with it so terrain in front can occlude it
 * (`docs/adr/ADR-0013-isometric-projection.md`). Captions are the exception and
 * come last, unoccluded; see {@link HexMapRenderer.drawLayered}.
 */

import { MAX_REVEAL_RADIUS, bandLevels, shoulderLine } from '../content/content-types';
import {
  MapBounds,
  Offset,
  axialToOffset,
  fromIndex,
  indexIn,
  mapBounds,
  maxRow,
  minRow,
  offsetToAxial,
  sameOffset,
} from '../core/hex/hex-coords';
import { HexLayout, Point, Rect } from '../core/hex/hex-layout';
import { Camera } from './camera';
import { SpriteSource, drawCharacter } from './character-renderer';
import { Projection } from './projection';
import { TileAppearance, TileAppearanceCache } from './tile-appearance';
import { ResolvedTileRender, projectionRatiosOf } from './tile-art';
import {
  RenderDecoration,
  RenderEntity,
  RenderLink,
  RenderLocation,
  RenderModel,
  RenderOverlay,
  emptyRenderModel,
} from './render-model';
import { SpriteRegistry } from './sprite-registry';

/** Colours that belong to the tool, not to the content. */
const CHROME = {
  background: '#11161d',
  outOfBounds: '#0b0e13',
  hover: 'rgba(255, 255, 255, 0.85)',
  selection: '#ffd166',
  locationFill: 'rgba(255, 255, 255, 0.85)',
  locationText: '#11161d',
  /** Doors read as a way out, so they get their own colour rather than a star. */
  linkFill: '#7ec8e3',
  linkText: '#0b1620',
  linkLabel: 'rgba(126, 200, 227, 0.9)',
  entityOutline: 'rgba(10, 12, 16, 0.85)',
  entityText: '#11161d',
  coordinates: 'rgba(255, 255, 255, 0.55)',
  /** Darkens the side of an elevated tile, so relief reads as relief. */
  wallShade: 'rgba(6, 8, 12, 0.42)',
  /** Separates a cliff face from the tile top above it. */
  wallEdge: 'rgba(6, 8, 12, 0.55)',
  /** Grounds a token standing on a tile in isometric mode. */
  entityShadow: 'rgba(6, 8, 12, 0.35)',
} as const;

/**
 * Rows searched either side of the band hit-testing computes.
 *
 * The band comes from `cellAt`, which snaps to the *nearest* hex centre — worth
 * half a row — and a hexagon reaches `size` beyond its centre, which is another
 * two thirds of a row. Two rows of slack covers both; without it, the top of a
 * tall cell stops responding to the pointer.
 */
const ROW_SEARCH_SLACK = 2;

/**
 * How much fainter the extent's empty cells are drawn than the grid itself.
 *
 * Enough to read as "you may draw here", not enough to be mistaken for a hex
 * the map has (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
 */
const EXTENT_GHOST_ALPHA = 0.4;

/**
 * How much of a hex's top face has to be hidden before it counts as buried.
 *
 * Buried is what the pointer may claim back from the relief standing in front
 * of it, so the threshold decides how much of a map the reveal takes over. With
 * the shipped set's geometry a cell one row behind a neighbour raised three
 * levels keeps about a third of its face — enough to aim at — and one behind a
 * neighbour raised four keeps about a twentieth, which is not
 * (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
 */
const BURIED_COVERAGE = 0.75;

/**
 * Points sampled across a top face to measure how much of it is hidden.
 *
 * A lattice over the hexagon's bounding box, trimmed to the hexagon: every kept
 * sample stands for an equal patch of it, so the covered fraction is the
 * covered count. In units of the circumradius, centred on the cell.
 */
const COVERAGE_SAMPLES: readonly Point[] = buildCoverageSamples();

/** Rows searched in front of a cell for whatever might be hiding it. */
const OCCLUSION_ROW_LIMIT = 8;

/** How much of a cell's top face the relief hides, and which cells hide it. */
interface Occlusion {
  /** Fraction of the top face covered, from `0` to `1`. */
  readonly hidden: number;
  /** Indices of the cells whose silhouettes cover part of it. */
  readonly by: readonly number[];
}

/** The answer for a cell nothing stands in front of. */
const NOTHING_HIDDEN: Occlusion = { hidden: 0, by: [] };

/** Canvas height the map-wide character ratio is defined against. */
const REFERENCE_CHARACTER_HEIGHT_PX = 128;

/**
 * What a screen-space point resolves to.
 *
 * Two answers because the projection is not injective: see
 * {@link HexMapRenderer.resolvePointer}.
 */
export interface PointerTarget {
  /** The hex a click lands on. */
  readonly cell: Offset | null;
  /** The buried hex under the pointer, whatever the click resolves to. */
  readonly buried: Offset | null;
}

/** Statistics from the last frame, surfaced in the UI to make culling visible. */
export interface FrameStats {
  /** Cells considered after culling. */
  cellsDrawn: number;
  /** Total cells in the map. */
  cellsTotal: number;
  /** `fill()` calls issued for terrain. */
  terrainBatches: number;
  /** Distinct tile pictures shared by those cells; see {@link TileAppearanceCache}. */
  tilePictures: number;
  /** Milliseconds spent in the last `draw`. */
  lastFrameMs: number;
  /**
   * The worst `lastFrameMs` of the last {@link PEAK_WINDOW_MS} of drawing.
   *
   * The number that matters when frames are *occasionally* slow. A readout
   * sampled a few times a second reads whatever frame it lands on and never
   * sees the stall — and a stall is what a hand notices. It also tells a frame
   * that is expensive every time apart from one that was expensive once, which
   * is the difference between a renderer to fix and a map that has just loaded.
   */
  peakFrameMs: number;
}

/** The window {@link FrameStats.peakFrameMs} is the worst of. */
const PEAK_WINDOW_MS = 2000;

export class HexMapRenderer {
  private model: RenderModel = emptyRenderModel();
  private projection: Projection;
  private stats: FrameStats = {
    cellsDrawn: 0,
    cellsTotal: 0,
    terrainBatches: 0,
    tilePictures: 0,
    lastFrameMs: 0,
    peakFrameMs: 0,
  };
  private peakFrameMs = 0;
  /** When the current peak window opened. */
  private peakSince = 0;
  private batchCount = 0;
  /**
   * The hex under the pointer, outlined but otherwise inert.
   *
   * Renderer state rather than model state: it changes at the rate a hand
   * moves, and it changes nothing else — no cell, no entity, no reachable set.
   * Keeping it out of the model is what lets a hover cost one redraw instead of
   * a model rebuild and a change-detection pass.
   */
  private hovered: Offset | null = null;
  /**
   * The buried hex the pointer is resting on, drawn back over what hides it.
   *
   * Renderer state for the same reason {@link hovered} is, and separate from it
   * because they answer different questions: what a click lands on, and what
   * the relief is being seen through
   * (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
   */
  private revealed: Offset | null = null;
  /**
   * What hides each cell, and how much of it, by cell index.
   *
   * Measured lazily and kept until the terrain changes: the answer depends on
   * the elevation buffer alone, and a pointer crossing a map asks for the same
   * handful of cells over and over.
   */
  private readonly occlusion = new Map<number, Occlusion>();
  /**
   * The cells drawn see-through this frame, by cell index, and how solidly.
   *
   * Derived from {@link revealed} and the model; rebuilt only when one of the
   * two moves (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
   */
  private fades: ReadonlyMap<number, number> = new Map();
  /** What {@link fades} was built from, so it is not built twice for one hover. */
  private fadesFrom: { cell: Offset | null; model: RenderModel } | null = null;
  /** One shared picture per distinct look; see {@link TileAppearanceCache}. */
  private readonly appearances: TileAppearanceCache;
  /** Set while {@link warmTileArt} is loading the art the model is made of. */
  private warming = false;

  constructor(
    private readonly context: CanvasRenderingContext2D,
    readonly layout: HexLayout,
    readonly camera: Camera,
    private readonly sprites: SpriteRegistry = new SpriteRegistry(),
    /**
     * Where a tile's images come from, or `null` to draw colours only.
     *
     * The same {@link SpriteSource} a character is drawn through: an editor and
     * the game both hand one in, and neither this class nor that one knows how
     * it loads (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
     */
    private readonly images: SpriteSource | null = null,
    /**
     * Where every tile sprite can be had in one request, or `null` to fetch
     * them one at a time.
     *
     * A map is a hundred and eighty-odd files of about 1.4 kB, and what it
     * waits on is the number of requests rather than the bytes
     * (`docs/adr/ADR-0027-a-map-is-drawn-from-shared-pictures.md`). It is an
     * optimisation: when there is no bundle to be had, {@link warmTileArt}
     * fetches the same pixels file by file and draws the same map.
     */
    private readonly bundleUrl: string | null = null,
  ) {
    this.projection = this.projectionFor(this.model);
    this.appearances = new TileAppearanceCache(images);
  }

  /**
   * Outlines a hex as hovered, or `null` to outline none.
   *
   * Cheap by construction — the next frame draws the new outline — so the
   * caller may set it as often as the pointer moves. It survives
   * {@link setModel}: the world changing under a still pointer does not move
   * the pointer. A host that opens *another* map clears it, since the hex it
   * named is not the same place any more (`CanvasView.clearHover`).
   */
  setHover(cell: Offset | null): void {
    this.hovered = cell;
  }

  /**
   * Names the buried hex the next frame draws back over what hides it, or
   * `null` to draw none.
   *
   * Separate from {@link setHover} on purpose: the reveal follows the pointer
   * whatever a click would resolve to, so a host may show an author what is
   * behind a mountain without changing what clicking the mountain does
   * (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
   */
  setReveal(cell: Offset | null): void {
    this.revealed = cell;
  }

  /** Replaces the model drawn by the next {@link draw}. */
  setModel(model: RenderModel): void {
    this.model = model;
    this.projection = this.projectionFor(model);
    this.appearances.use(model);
    // What hides what is a fact about the elevation buffer, and this is the
    // only door a new one comes through.
    this.occlusion.clear();
  }

  /**
   * Replaces one entity's resolved character without rebuilding the immutable
   * terrain model.
   *
   * A gameplay animation changes at frame rate while tile art does not. Keeping
   * this narrow update out of {@link setModel} avoids re-indexing the world's
   * shared pictures for every pose
   * (`docs/adr/ADR-0030-gameplay-selects-character-animations-by-role.md`).
   */
  setEntityCharacter(id: string, character: RenderEntity['character']): void {
    this.setEntities(
      this.model.entities.map((entity) =>
        entity.id === id ? { ...entity, character } : entity,
      ),
    );
  }

  /** Replaces only entity presentation, leaving terrain picture caches alone. */
  setEntities(entities: readonly RenderEntity[]): void {
    this.model = { ...this.model, entities };
  }

  /**
   * Loads the pictures this map is painted from, and holds it back until they
   * are in.
   *
   * A map used to paint itself as its files landed: colours first, then grass,
   * then rock, over a second or so of watching content arrive. That reads as
   * the tool loading rather than as a world, and it gets worse with every tile
   * a project adds. So the host calls this once per opened world, and until it
   * settles the canvas shows its background and nothing else
   * (`docs/adr/ADR-0027-a-map-is-drawn-from-shared-pictures.md`).
   *
   * What is waited on is what the map's own cells need, not everything its
   * palette could offer: a map painted with four tiles out of forty appears
   * when those four are in. An editor asks for the rest afterwards, through
   * {@link warmPalette}.
   *
   * Only the *first* load is held for: once the art is in hand, an edit that
   * introduces a new picture draws its tile's colour until it arrives, exactly
   * as before — a map must never blank out under the author's cursor.
   *
   * @returns when every asset has loaded or failed; the caller redraws then
   */
  warmTileArt(): Promise<void> {
    const images = this.images;
    if (images === null) {
      return Promise.resolve();
    }
    // The trees standing on the map are part of what the map is made of, so
    // they are waited for with it rather than popping in afterwards
    // (`docs/adr/ADR-0027-a-map-is-drawn-from-shared-pictures.md`).
    const assets = [...this.appearances.paintedAssets(), ...decorationAssets(this.model)];
    if (assets.length === 0) {
      // A map drawn from colours alone must not be held back for art it will
      // never blit.
      return Promise.resolve();
    }
    // Set **synchronously**, before anything is awaited: `draw` paints the
    // background alone while this is true, and a frame slipping through before
    // it would resolve its cells one by one and start exactly the per-file
    // fetches the bundle exists to avoid.
    this.warming = true;
    // A source that fails outright must still let the map through: the tiles it
    // could not fetch draw their colour, which is what a missing file has
    // always looked like (`docs/adr/ADR-0006-assets-tilesets.md`).
    const bundle = this.loadBundle();
    return (bundle === null ? images.preload(assets) : bundle.then(() => images.preload(assets)))
      .catch(() => undefined)
      .finally(() => {
        this.warming = false;
      });
  }

  /**
   * Fetches the sprite bundle, or `null` when there is none to fetch.
   *
   * `null` rather than a resolved promise, so a renderer with no bundle asks
   * its source for the files **synchronously**, exactly as it did before there
   * was a bundle. A microtask between "start warming" and "start fetching" is
   * not something anyone can see, but it is a behaviour change, and a warm is
   * not the place to introduce one.
   *
   * Never rejects: a bundle that cannot be had is not an error but a slower
   * path, and the `preload` that follows fetches the same sprites one at a
   * time (`docs/adr/ADR-0027-a-map-is-drawn-from-shared-pictures.md`).
   */
  private loadBundle(): Promise<void> | null {
    const images = this.images;
    if (images === null || this.bundleUrl === null || images.loadBundle === undefined) {
      return null;
    }
    return images.loadBundle(this.bundleUrl).catch(() => undefined);
  }

  /**
   * Loads the pictures the decorations standing on this map are drawn from.
   *
   * {@link warmTileArt} already asks for them, and that is the normal path: a
   * host that knows its decorations before it builds its first model gets them
   * with the terrain. This is for the host that does **not** — the map editor,
   * whose decoration definitions arrive from the manifest a moment after the
   * map opens. Without it a tree is resolved, placed, and then drawn from an
   * image nobody ever fetched
   * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   *
   * Never held for, unlike the terrain: a tree arriving a moment late redraws
   * itself, while a map arriving in pieces reads as the tool loading.
   *
   * @returns when every frame has loaded or failed; the caller redraws then
   */
  warmDecorations(): Promise<void> {
    const images = this.images;
    const assets = decorationAssets(this.model);
    if (images === null || assets.length === 0) {
      return Promise.resolve();
    }
    return images.preload(assets).catch(() => undefined);
  }

  /**
   * Loads the rest of the palette — the brushes, not the map.
   *
   * Never held for, and deliberately second: an author who picks an unused
   * tile should find it drawn, but nobody should watch a map wait for pictures
   * it is not made of. Play never calls this; the map it is showing is the
   * whole of what it draws.
   */
  warmPalette(): Promise<void> {
    const images = this.images;
    if (images === null) {
      return Promise.resolve();
    }
    // Through the bundle too, on the chance the map was drawn from colours and
    // never warmed: once a map has loaded this is already in hand and resolves
    // without a request.
    const bundle = this.loadBundle();
    const assets = (): Promise<void> => images.preload(this.appearances.assets());
    return (bundle === null ? assets() : bundle.then(assets)).catch(() => undefined);
  }

  /** `true` while the map is being held back for its art; see {@link warmTileArt}. */
  get isWarming(): boolean {
    return this.warming;
  }

  /**
   * The transform a model implies: its mode, tilted by its tile set's art.
   *
   * Every caller goes through here, so the picture, the hit-test and the
   * culling margin cannot be computed from three different tilts.
   */
  private projectionFor(model: RenderModel): Projection {
    const { tilt, elevationRatio } = projectionRatiosOf(model.tileArt);
    return Projection.from(model.projection, this.layout.size, tilt, elevationRatio);
  }

  /** The model currently being drawn. */
  get currentModel(): RenderModel {
    return this.model;
  }

  /** The transform the current model implies. */
  get currentProjection(): Projection {
    return this.projection;
  }

  /** Statistics from the last frame. */
  get frameStats(): FrameStats {
    return this.stats;
  }

  /** The sprite registry used to resolve visual ids. */
  get spriteRegistry(): SpriteRegistry {
    return this.sprites;
  }

  /**
   * The offset cell under a screen-space point, or `null` when off the map.
   *
   * Top-down inverts the layout directly. Isometric has to respect what the
   * viewer sees: an elevated cell covers part of the row behind it, so the
   * search runs front-to-back — the *last* cell drawn that contains the point is
   * the one the pointer is on — and a cell counts as hit through its side face
   * as well as its top.
   */
  cellAtScreen(point: Point, model: RenderModel = this.model): Offset | null {
    const drawing = this.camera.toWorld(point);
    const projection = model === this.model ? this.projection : this.projectionFor(model);

    if (projection.isIdentity) {
      const cell = this.layout.cellAt(drawing);
      return this.hittable(model, cell) ? cell : null;
    }

    const { min, max } = model.elevationRange;
    const frontRow = this.layout.cellAt(projection.unproject(drawing, max)).row + ROW_SEARCH_SLACK;
    const backRow = this.layout.cellAt(projection.unproject(drawing, min)).row - ROW_SEARCH_SLACK;

    for (
      let row = Math.min(frontRow, maxRow(model.bounds));
      row >= Math.max(backRow, minRow(model.bounds));
      row -= 1
    ) {
      // Which columns can reach `drawing.x` on this row: odd rows are shifted
      // half a hex right, so the centre of `col` sits at `hexWidth * col`.
      const shift = row % 2 === 0 ? 0 : 0.5;
      const approximate = Math.round(drawing.x / this.layout.hexWidth - shift);

      for (const col of [approximate, approximate - 1, approximate + 1]) {
        const cell = { col, row };
        if (!this.hittable(model, cell)) {
          continue;
        }
        if (this.cellCovers(model, projection, cell, drawing)) {
          return cell;
        }
      }
    }
    return null;
  }

  /**
   * What the pointer is on: what a click lands on, and what the relief hides
   * there.
   *
   * Two answers rather than one because the projection gives the same pixels to
   * more than one hex. A cell raised four levels is drawn all but exactly on top
   * of the cell one row behind it, so nothing in the picture says which of the
   * two the pointer means — the front one is what a click has always resolved
   * to, and `peek` is the extra bit of intent that asks for the other. The
   * reveal needs no such bit: showing what is behind changes nothing, so
   * {@link PointerTarget.buried} is answered whether or not `peek` is set
   * (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
   */
  resolvePointer(point: Point, peek = false): PointerTarget {
    const front = this.cellAtScreen(point);
    const buried = this.buriedCellAtScreen(point);
    return { cell: peek && buried !== null ? buried : front, buried };
  }

  /**
   * The frontmost buried hex whose top face contains a screen-space point.
   *
   * Its *face* alone, not its side: a cliff is the picture of the cell that owns
   * it, and a buried cell's cliff is buried under that cliff rather than beside
   * it. Searching front to back matches the order the reveal draws in, so the
   * window the pointer is over is the one it names.
   */
  buriedCellAtScreen(point: Point, model: RenderModel = this.model): Offset | null {
    const projection = model === this.model ? this.projection : this.projectionFor(model);
    if (projection.isIdentity) {
      return null;
    }
    const drawing = this.camera.toWorld(point);
    const { min, max } = model.elevationRange;
    const frontRow = this.layout.cellAt(projection.unproject(drawing, max)).row + ROW_SEARCH_SLACK;
    const backRow = this.layout.cellAt(projection.unproject(drawing, min)).row - ROW_SEARCH_SLACK;

    for (
      let row = Math.min(frontRow, maxRow(model.bounds));
      row >= Math.max(backRow, minRow(model.bounds));
      row -= 1
    ) {
      const shift = row % 2 === 0 ? 0 : 0.5;
      const approximate = Math.round(drawing.x / this.layout.hexWidth - shift);

      for (const col of [approximate, approximate - 1, approximate + 1]) {
        const cell = { col, row };
        if (!this.hittable(model, cell) || !this.isBuried(model, projection, cell)) {
          continue;
        }
        if (containsPoint(this.cornersOf(cell, this.elevationOf(model, cell), projection), drawing)) {
          return cell;
        }
      }
    }
    return null;
  }

  /**
   * Whether a click on `cell` resolves to anything.
   *
   * A hole is only clickable where the extent is shown — the editor, so that
   * "put a hex back here" has something to aim at. Play resolves present cells
   * alone (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
   */
  private hittable(model: RenderModel, cell: Offset): boolean {
    const index = indexIn(cell, model.bounds);
    return index >= 0 && (model.showExtent || model.presence[index] === 1);
  }

  /**
   * The tightest extent covering the hexes the map actually has.
   *
   * What the camera frames, so an island drawn in the corner of a large canvas
   * fills the viewport instead of sitting in a sea of nothing. Falls back to the
   * whole extent while the map has no hex at all, which is what an author sees
   * on a blank canvas before drawing the first one.
   */
  private presentExtent(model: RenderModel): MapBounds {
    let firstCol = Number.POSITIVE_INFINITY;
    let lastCol = Number.NEGATIVE_INFINITY;
    let firstRow = Number.POSITIVE_INFINITY;
    let lastRow = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < model.presence.length; index += 1) {
      if (model.presence[index] !== 1) {
        continue;
      }
      const cell = fromIndex(index, model.bounds);
      firstCol = Math.min(firstCol, cell.col);
      lastCol = Math.max(lastCol, cell.col);
      firstRow = Math.min(firstRow, cell.row);
      lastRow = Math.max(lastRow, cell.row);
    }

    if (firstRow > lastRow) {
      return model.bounds;
    }
    return mapBounds(lastCol - firstCol + 1, lastRow - firstRow + 1, {
      col: firstCol,
      row: firstRow,
    });
  }

  /**
   * The drawing-plane rectangle the map actually covers.
   *
   * Deliberately not `projectRect(plane, min, max)`: that lifts the *whole*
   * plane by the map's highest cell and drops it by its lowest, which is a
   * bound, not the picture. A map whose back rows are flat is then framed with
   * a band of empty sky above it — the height of its tallest peak, wherever
   * that peak stands — and the world sits too low in the viewport.
   *
   * The extent is measured per row instead: a row's tops rise by that row's own
   * peak, and only the front row's side faces hang below the plane, down to the
   * ground the skirt is anchored on ({@link wallBaseOf}). Every other row's
   * faces stop at the row in front of it, which already reaches lower.
   */
  contentBounds(model: RenderModel = this.model): Rect {
    // Framed on the hexes the map has, not on the box they are stored in
    // (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
    const drawn = model.showExtent ? model.bounds : this.presentExtent(model);
    const plane = this.layout.boundsOf(drawn);
    const projection = model === this.model ? this.projection : this.projectionFor(model);
    if (projection.isIdentity || drawn.width === 0 || drawn.height === 0) {
      return projection.projectRect(plane);
    }

    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let row = minRow(drawn); row <= maxRow(drawn); row += 1) {
      let peak = 0;
      let floor = 0;
      for (let col = drawn.origin.col; col < drawn.origin.col + drawn.width; col += 1) {
        const index = indexIn({ col, row }, model.bounds);
        if (index < 0 || model.presence[index] !== 1) {
          continue;
        }
        const elevation = this.elevationAt(model, index);
        peak = Math.max(peak, elevation);
        floor = Math.min(floor, elevation);
      }
      // `floor` starts at ground rather than at the row's own minimum: a face
      // reaches down to whatever stands in front of it, and the row in front is
      // at ground unless it is dug lower — as is everything off the map, which
      // is what gives the front row its skirt.
      const center = this.layout.rowStep * row;
      const top = (center - this.layout.size) * projection.tilt - projection.liftOf(peak);
      const bottom = (center + this.layout.size) * projection.tilt - projection.liftOf(floor);
      minY = Math.min(minY, top);
      maxY = Math.max(maxY, bottom);
    }

    return { minX: plane.minX, maxX: plane.maxX, minY, maxY };
  }

  /** Frames the whole map in a `width x height` viewport. */
  fitToViewport(width: number, height: number): void {
    if (this.model.bounds.width === 0 || this.model.bounds.height === 0) {
      return;
    }
    this.camera.fit(this.contentBounds(), width, height);
  }

  /**
   * Draws one frame into a `width x height` (CSS pixel) viewport.
   *
   * The caller is responsible for the device-pixel-ratio transform; see
   * {@link CanvasView}.
   */
  draw(width: number, height: number): void {
    const startedAt = performance.now();
    const ctx = this.context;
    const model = this.model;

    ctx.save();
    ctx.fillStyle = CHROME.background;
    ctx.fillRect(0, 0, width, height);

    // A map with no cells, and a map whose pictures are still on the wire, are
    // the same frame: the background, and nothing drawn on it
    // (`docs/adr/ADR-0027-a-map-is-drawn-from-shared-pictures.md`).
    if (model.bounds.width === 0 || model.bounds.height === 0 || this.warming) {
      ctx.restore();
      this.recordFrame(startedAt, model, 0, 0);
      return;
    }

    ctx.translate(this.camera.pan.x, this.camera.pan.y);
    ctx.scale(this.camera.zoom, this.camera.zoom);

    // Cull in the hex plane, which is where `visibleRange` works: the visible
    // drawing-plane rectangle covers a taller slice of the plane once tiles can
    // be lifted out of their row.
    const view = this.camera.visibleWorldRect(width, height);
    const { min, max } = model.elevationRange;
    const range = this.layout.visibleRange(
      this.projection.unprojectRect(view, min, max),
      model.bounds,
    );

    // What the relief has to be seen through, decided once for the frame: the
    // terrain pass reads it per cell in its innermost loop
    // (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
    this.fadesFor(model);

    this.batchCount = 0;
    const cellsDrawn = this.projection.isIdentity
      ? this.drawFlat(model, range)
      : this.drawLayered(model, range);

    ctx.restore();

    this.recordFrame(startedAt, model, cellsDrawn, this.batchCount);
  }

  /** Books what a frame cost, and keeps the worst of the recent ones. */
  private recordFrame(
    startedAt: number,
    model: RenderModel,
    cellsDrawn: number,
    terrainBatches: number,
  ): void {
    const finishedAt = performance.now();
    const lastFrameMs = finishedAt - startedAt;
    if (finishedAt - this.peakSince > PEAK_WINDOW_MS) {
      this.peakSince = finishedAt;
      this.peakFrameMs = 0;
    }
    this.peakFrameMs = Math.max(this.peakFrameMs, lastFrameMs);
    this.stats = {
      cellsDrawn,
      cellsTotal: model.bounds.width * model.bounds.height,
      terrainBatches,
      tilePictures: this.appearances.size,
      lastFrameMs,
      peakFrameMs: this.peakFrameMs,
    };
  }

  // ------------------------------------------------------------- draw paths

  /** One band for the whole viewport: no cell can overlap another. */
  private drawFlat(model: RenderModel, range: VisibleRange): number {
    const cellsDrawn = this.drawTerrainBand(model, range, range.minRow, range.maxRow);
    if (model.showGrid) {
      this.drawGrid(model, range, range.minRow, range.maxRow);
    }
    this.drawOverlays(model, model.overlays.map((overlay) => ({ overlay, cells: overlay.cells })));
    this.drawHighlight(model, this.hovered, CHROME.hover, 2);
    this.drawHighlight(model, model.selected, CHROME.selection, 3);
    this.drawLocations(model, model.locations);
    this.drawLinks(model, model.links);
    this.drawDecorations(model, model.decorations, 'behind');
    this.drawEntities(model, model.entities);
    this.drawDecorations(model, model.decorations, 'front');
    this.drawLabels(model, model.locations, model.links);
    if (model.showCoordinates) {
      this.drawCoordinates(model, range, range.minRow, range.maxRow);
    }
    return cellsDrawn;
  }

  /**
   * One band per row, back to front.
   *
   * Everything that belongs to a row is drawn with that row, so a hill in front
   * hides what stands behind it. Within a row nothing overlaps, so batching
   * still holds — it is simply per row rather than per viewport.
   *
   * Names are the one exception: a caption is written *below* the marker it
   * belongs to, which is where the next row is about to be painted, so drawing
   * it with its own row leaves it sliced in half by whatever stands in front. A
   * caption is chrome rather than scenery — it labels the map for the reader
   * instead of standing in it — so all of them are written after the last row.
   */
  private drawLayered(model: RenderModel, range: VisibleRange): number {
    const overlaysByRow = model.overlays.map((overlay) => ({
      overlay,
      byRow: groupByRow(overlay.cells, (cell) => cell),
    }));
    const locationsByRow = groupByRow(model.locations, (location) => location.at);
    const linksByRow = groupByRow(model.links, (link) => link.at);
    const entitiesByRow = groupByRow(model.entities, (entity) => this.entityDepthCell(entity));
    const decorationsByRow = groupByRow(model.decorations, (decoration) => decoration.at);

    let cellsDrawn = 0;
    for (let row = range.minRow; row <= range.maxRow; row += 1) {
      cellsDrawn += this.drawTerrainBand(model, range, row, row);
      if (model.showGrid) {
        this.drawGrid(model, range, row, row);
      }
      this.drawOverlays(
        model,
        overlaysByRow
          .map(({ overlay, byRow }) => ({ overlay, cells: byRow.get(row) ?? [] }))
          .filter(({ cells }) => cells.length > 0),
      );
      if (this.hovered?.row === row) {
        this.drawHighlight(model, this.hovered, CHROME.hover, 2);
      }
      if (model.selected?.row === row) {
        this.drawHighlight(model, model.selected, CHROME.selection, 3);
      }
      this.drawLocations(model, locationsByRow.get(row) ?? []);
      this.drawLinks(model, linksByRow.get(row) ?? []);
      // The two planes with the characters between them, per row, which is
      // what makes a walker pass behind a canopy and in front of the grass
      // (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
      const decorations = decorationsByRow.get(row) ?? [];
      this.drawDecorations(model, decorations, 'behind');
      this.drawEntities(model, entitiesByRow.get(row) ?? []);
      this.drawDecorations(model, decorations, 'front');
      if (model.showCoordinates) {
        this.drawCoordinates(model, range, row, row);
      }
    }
    this.drawRevealedOutline(model);
    this.drawLabels(model, model.locations, model.links);
    return cellsDrawn;
  }

  /**
   * How solidly each cell in the way of the revealed hexes is drawn, by index.
   *
   * The reveal works on the *occluders*: a hex the relief hides is not painted
   * back over the relief — that reads as a tile floating in front of a cliff,
   * because it is one. What the relief hides is seen by drawing the relief
   * see-through, which is the only way round that keeps the mountain in front
   * and the hex behind (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
   *
   * A cell in the way of the hex the pointer rests on is drawn at
   * `reveal.opacity`, one in the way of the ring around it at
   * `reveal.neighbourOpacity`; a cell in the way of both takes the fainter of
   * the two, because the hex being aimed at wins.
   *
   * Rebuilt only when the pointer or the model moves: the answer costs a
   * coverage measurement per revealed hex, and a frame does not change it.
   */
  private fadesFor(model: RenderModel): ReadonlyMap<number, number> {
    if (
      this.fadesFrom !== null &&
      this.fadesFrom.model === model &&
      sameOffset(this.fadesFrom.cell, this.revealed)
    ) {
      return this.fades;
    }
    this.fades = this.buildFades(model);
    this.fadesFrom = { cell: this.revealed, model };
    return this.fades;
  }

  private buildFades(model: RenderModel): ReadonlyMap<number, number> {
    const fades = new Map<number, number>();
    const anchor = this.revealed;
    if (anchor === null || this.projection.isIdentity) {
      return fades;
    }
    const fade = (cell: Offset, alpha: number): void => {
      for (const index of this.occlusionOf(model, this.projection, cell).by) {
        const current = fades.get(index);
        if (current === undefined || alpha < current) {
          fades.set(index, alpha);
        }
      }
    };

    const radius = Math.min(Math.max(Math.trunc(model.reveal.radius), 0), MAX_REVEAL_RADIUS);
    const ring = Math.min(Math.max(model.reveal.neighbourOpacity, 0), 1);
    if (ring < 1) {
      for (const cell of this.buriedRing(model, anchor, radius)) {
        fade(cell, ring);
      }
    }
    fade(anchor, Math.min(Math.max(model.reveal.opacity, 0), 1));
    return fades;
  }

  /**
   * Re-outlines the revealed hex once the relief in front of it is out of the
   * way.
   *
   * Its row drew the outline before anything could hide it, and the see-through
   * relief in front dulls it along with everything else. The outline is chrome
   * rather than scenery — it says which hex the pointer holds — so it is drawn
   * again, crisp, after the last row.
   */
  private drawRevealedOutline(model: RenderModel): void {
    const anchor = this.revealed;
    if (anchor === null || this.projection.isIdentity) {
      return;
    }
    if (sameOffset(model.selected, anchor)) {
      this.drawHighlight(model, model.selected, CHROME.selection, 3);
    }
    if (sameOffset(this.hovered, anchor)) {
      this.drawHighlight(model, this.hovered, CHROME.hover, 2);
    }
  }

  /**
   * The buried hexes within `radius` rings of `anchor`.
   *
   * Sorted back to front, which is the order their occluders are collected in;
   * a cell in the way of two of them keeps the fainter answer either way.
   */
  private buriedRing(model: RenderModel, anchor: Offset, radius: number): Offset[] {
    if (radius <= 0) {
      return [];
    }
    const centre = offsetToAxial(anchor);
    const cells: Offset[] = [];
    for (let q = -radius; q <= radius; q += 1) {
      const from = Math.max(-radius, -q - radius);
      const to = Math.min(radius, -q + radius);
      for (let r = from; r <= to; r += 1) {
        if (q === 0 && r === 0) {
          continue;
        }
        const cell = axialToOffset({ q: centre.q + q, r: centre.r + r });
        if (this.hittable(model, cell) && this.isBuried(model, this.projection, cell)) {
          cells.push(cell);
        }
      }
    }
    return cells.sort((left, right) => left.row - right.row);
  }

  // -------------------------------------------------------------- primitives

  /**
   * Draws the terrain of rows `minRow..maxRow`, one `fill()` per palette entry
   * present — plus, in isometric mode, the side faces of elevated cells.
   *
   * Returns the number of cells visited.
   */
  private drawTerrainBand(
    model: RenderModel,
    range: VisibleRange,
    minRow: number,
    maxRow: number,
  ): number {
    const ctx = this.context;
    const tops = new Map<number, Path2D>();
    const walls = new Map<number, Path2D>();
    /** Cells whose art is loaded; blitted after the colour batches. */
    const painted: PaintedCell[] = [];
    /** Cells in the way of a revealed hex; drawn one by one, see-through. */
    const faded: { cell: Offset; index: number; paletteIndex: number; alpha: number }[] = [];
    let visited = 0;
    // How many levels one drawn band covers, so a stack that is one image for
    // every two steps is not mistaken for a cliff whose art ran out.
    const span = bandLevels(model.tileArt);

    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = range.minCol; col <= range.maxCol; col += 1) {
        const cell = { col, row };
        const index = indexIn(cell, model.bounds);
        const paletteIndex = model.terrain[index];
        // A hole is not drawn at all — no top, no faces, no colour. Its paint
        // is still in the buffer, waiting for the hex to come back
        // (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
        if (paletteIndex === undefined || model.presence[index] !== 1) {
          continue;
        }
        visited += 1;

        // A cell standing in front of a revealed hex leaves the batches: it is
        // drawn on its own, at its own opacity, once the batches are down. At
        // nothing it is not drawn at all, and what it hides is simply there
        // (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
        const alpha = this.fades.get(index);
        if (alpha !== undefined && alpha < 1) {
          if (alpha > 0) {
            faded.push({ cell, index, paletteIndex, alpha });
          }
          continue;
        }

        const elevation = this.elevationAt(model, index);
        const base = this.wallBaseOf(model, cell);

        const appearance = this.appearances.of(paletteIndex, index, cell, elevation, base);
        if (appearance !== null && appearance.ready) {
          painted.push({ cell, elevation, appearance });
          // A tile may author a top face and no cliff art at all — grass at the
          // edge of a ditch. Its faces are still exposed, so the colour wall is
          // filled behind the art that does exist: whatever is authored covers
          // it, and what is not reads as a drop instead of a hole.
          if (this.facesAreShort(appearance.render, elevation, base, span)) {
            this.addWallTo(pathFor(walls, paletteIndex), cell, elevation, base);
          }
          continue;
        }

        if (elevation > base) {
          this.addWallTo(pathFor(walls, paletteIndex), cell, elevation, base);
        }
        this.addHexTo(pathFor(tops, paletteIndex), cell, elevation);
      }
    }

    // Side faces first: they hang below the tile they belong to, and the tops of
    // the row are painted over them.
    for (const [paletteIndex, path] of walls) {
      ctx.fillStyle = this.fillFor(model, paletteIndex);
      ctx.fill(path);
      this.batchCount += 1;
    }
    if (walls.size > 0) {
      ctx.fillStyle = CHROME.wallShade;
      for (const path of walls.values()) {
        ctx.fill(path);
      }
      ctx.lineWidth = 1 / this.camera.zoom;
      ctx.strokeStyle = CHROME.wallEdge;
      for (const path of walls.values()) {
        ctx.stroke(path);
      }
    }

    for (const [paletteIndex, path] of tops) {
      ctx.fillStyle = this.fillFor(model, paletteIndex);
      ctx.fill(path);
      this.batchCount += 1;
    }

    // Art last, over the colours: within a band nothing overlaps horizontally,
    // and between bands the row order already puts the front row on top.
    for (const cell of painted) {
      this.drawPaintedCell(model, cell);
    }

    // See-through cells close the band, still inside it: a row further forward
    // has to be able to cover them, so they cannot wait until the end of the
    // frame. Within a band nothing overlaps, so drawing them one at a time is
    // the same picture the batches would have made, only fainter.
    for (const cell of faded) {
      this.drawFadedCell(model, cell.cell, cell.index, cell.paletteIndex, cell.alpha, span);
    }

    return visited;
  }

  /**
   * Draws one cell see-through, on its own, exactly as the batches would have.
   *
   * Out of the batches because opacity is per cell and a `Path2D` is per
   * palette entry: two cells of the same tile, one faded and one not, cannot
   * share a fill. There are only ever a handful of them — what stands in front
   * of a hex or two — so the batching this gives up costs nothing
   * (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
   */
  private drawFadedCell(
    model: RenderModel,
    cell: Offset,
    index: number,
    paletteIndex: number,
    alpha: number,
    span: number,
  ): void {
    const ctx = this.context;
    const elevation = this.elevationAt(model, index);
    const base = this.wallBaseOf(model, cell);
    const found = this.appearances.of(paletteIndex, index, cell, elevation, base);
    const appearance = found !== null && found.ready ? found : null;

    ctx.save();
    ctx.globalAlpha = alpha;

    if (
      appearance === null
        ? elevation > base
        : this.facesAreShort(appearance.render, elevation, base, span)
    ) {
      const wall = new Path2D();
      this.addWallTo(wall, cell, elevation, base);
      ctx.fillStyle = this.fillFor(model, paletteIndex);
      ctx.fill(wall);
      ctx.fillStyle = CHROME.wallShade;
      ctx.fill(wall);
      ctx.lineWidth = 1 / this.camera.zoom;
      ctx.strokeStyle = CHROME.wallEdge;
      ctx.stroke(wall);
      this.batchCount += 1;
    }

    if (appearance !== null) {
      this.drawPaintedCell(model, { cell, elevation, appearance });
    } else {
      const top = new Path2D();
      this.addHexTo(top, cell, elevation);
      ctx.fillStyle = this.fillFor(model, paletteIndex);
      ctx.fill(top);
      this.batchCount += 1;
    }

    ctx.restore();
  }

  /**
   * `true` when a cell exposes more faces than its art covers.
   *
   * Surface art without elevation art is the common case — a tile drawn as a
   * flat top that has never been given a cliff — and a drop past
   * `MAX_STACKED_LEVELS` falls short at its bottom. Either way the colour wall
   * goes back behind the blits, because a cell standing above its neighbours
   * has to *look* like it
   * (`docs/adr/ADR-0006-assets-tilesets.md`: `fallbackColor` is what is drawn
   * wherever a texture is not).
   */
  private facesAreShort(
    render: ResolvedTileRender,
    elevation: number,
    base: number,
    span: number,
  ): boolean {
    const steps = Math.max(0, elevation - base);
    return render.layers.length < Math.ceil(steps / span);
  }

  /**
   * Blits one cell: one shared picture where there is one, its layers where
   * there is not.
   *
   * The destination is the *projected* top face's bounding box, so the picture
   * agrees with the polygon path, with hit-testing and with the grid by
   * construction. An elevation image is the faces alone, hung from the hexagon's
   * lower shoulders and moved by its layer's `drop` — which the resolver
   * measured so that the lowest band of a stack ends on the silhouette, and may
   * therefore be negative for the topmost one, which the surface covers
   * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
   *
   * A composed picture stacked those layers once, at the tile set's own
   * resolution, and every cell that looks like this one blits it
   * (`docs/adr/ADR-0027-a-map-is-drawn-from-shared-pictures.md`). The layer
   * loop below draws exactly the same thing one image at a time, for the cell
   * whose look could not be composed.
   *
   * A top-down cell is one image over the whole hexagon and nothing else: no
   * tilt to fit, no faces to stack
   * (`docs/adr/ADR-0026-tile-art-is-authored-and-resolved-by-level.md`).
   */
  private drawPaintedCell(model: RenderModel, painted: PaintedCell): void {
    const ctx = this.context;
    const { render, picture, pictureHeight } = painted.appearance;
    const centre = this.projection.project(this.layout.centerOf(painted.cell), painted.elevation);
    const width = this.layout.hexWidth;
    const left = centre.x - width / 2;
    const perPixel = width / Math.max(1, model.tileArt.width);
    // A flat hexagon is centred on its cell; everything isometric hangs from
    // the top face's own top edge, which is where a surface image starts.
    const top =
      render.flat !== null
        ? centre.y - (model.tileArt.flatHeight * perPixel) / 2
        : centre.y - (this.layout.hexHeight * this.projection.tilt) / 2;

    ctx.imageSmoothingEnabled = false;

    if (picture !== null) {
      // Scaled from the authored grid, like every other tile image, so the
      // picture and the hexagon the grid stroke draws are the same shape.
      ctx.drawImage(
        picture,
        left,
        top - painted.appearance.pictureTop * perPixel,
        width,
        pictureHeight * perPixel,
      );
      this.batchCount += 1;
      return;
    }

    if (render.flat !== null) {
      const image = this.images?.image(render.flat);
      if (image != null) {
        ctx.drawImage(image, left, top, width, model.tileArt.flatHeight * perPixel);
        this.batchCount += 1;
      }
      return;
    }

    const shoulder = top + shoulderLine(model.tileArt) * perPixel;
    for (const layer of render.layers) {
      const image = this.images?.image(layer.asset);
      if (image == null) {
        continue;
      }
      ctx.drawImage(
        image,
        left,
        shoulder + layer.drop * this.projection.elevationStep,
        width,
        model.tileArt.elevationHeight * perPixel,
      );
      this.batchCount += 1;
    }
    // Last, so the top face is never the thing a face image happens to cover.
    if (render.surface !== null) {
      const image = this.images?.image(render.surface);
      if (image != null) {
        ctx.drawImage(image, left, top, width, model.tileArt.surfaceHeight * perPixel);
        this.batchCount += 1;
      }
    }
  }

  /** Draws hex outlines as a single stroked path. */
  private drawGrid(
    model: RenderModel,
    range: VisibleRange,
    minRow: number,
    maxRow: number,
  ): void {
    const ctx = this.context;
    const grid = new Path2D();
    // The cells the extent covers but the map lacks: drawn fainter, and only
    // where an author can act on them, so the shape's outline is what the grid
    // shows (`docs/adr/ADR-0033-a-map-is-a-set-of-hexes.md`).
    const ghost = new Path2D();
    /** One path per opacity the reveal is drawing cells at. */
    const faded = new Map<number, Path2D>();
    // `Path2D` cannot be asked whether it is empty, and an unshaped map must
    // not pay a second `stroke()` for a path with nothing in it.
    let ghosted = 0;
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = range.minCol; col <= range.maxCol; col += 1) {
        const cell = { col, row };
        const index = indexIn(cell, model.bounds);
        if (index < 0) {
          continue;
        }
        if (model.presence[index] === 1) {
          const alpha = this.fades.get(index);
          if (alpha === undefined) {
            this.addHexTo(grid, cell, this.elevationOf(model, cell));
          } else if (alpha > 0) {
            this.addHexTo(pathFor(faded, alpha), cell, this.elevationOf(model, cell));
          }
        } else if (model.showExtent) {
          this.addHexTo(ghost, cell, 0);
          ghosted += 1;
        }
      }
    }
    ctx.save();
    ctx.lineWidth = model.gridLineWidth / this.camera.zoom;
    ctx.strokeStyle = model.gridLineColor;
    if (ghosted > 0) {
      ctx.globalAlpha = model.gridLineAlpha * EXTENT_GHOST_ALPHA;
      ctx.stroke(ghost);
    }
    for (const [alpha, path] of faded) {
      ctx.globalAlpha = model.gridLineAlpha * alpha;
      ctx.stroke(path);
    }
    ctx.globalAlpha = model.gridLineAlpha;
    ctx.stroke(grid);
    ctx.restore();
  }

  private drawOverlays(
    model: RenderModel,
    parts: readonly { overlay: RenderOverlay; cells: readonly Offset[] }[],
  ): void {
    const ctx = this.context;
    for (const { overlay, cells } of parts) {
      if (cells.length === 0) {
        continue;
      }
      // One path per opacity, so an overlay on a cell the reveal is looking
      // through fades with it rather than hanging over the gap.
      const paths = new Map<number, Path2D>();
      for (const cell of cells) {
        const alpha = this.alphaAt(model, cell);
        if (alpha > 0) {
          this.addHexTo(pathFor(paths, alpha), cell, this.elevationOf(model, cell));
        }
      }
      ctx.save();
      for (const [alpha, path] of paths) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = overlay.fill;
        ctx.fill(path);
        ctx.lineWidth = 2 / this.camera.zoom;
        ctx.strokeStyle = overlay.stroke;
        ctx.stroke(path);
      }
      ctx.restore();
    }
  }

  private drawLocations(model: RenderModel, locations: readonly RenderLocation[]): void {
    const ctx = this.context;
    const radius = this.layout.size * 0.22;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const location of locations) {
      const alpha = this.alphaAt(model, location.at);
      if (alpha <= 0) {
        continue;
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      const center = this.centerOf(model, location.at);
      ctx.beginPath();
      ctx.arc(center.x, center.y - this.layout.size * 0.15, radius, 0, Math.PI * 2);
      ctx.fillStyle = CHROME.locationFill;
      ctx.fill();

      ctx.fillStyle = CHROME.locationText;
      ctx.font = `${Math.round(radius * 1.3)}px system-ui, sans-serif`;
      ctx.fillText('★', center.x, center.y - this.layout.size * 0.13);
      ctx.restore();
    }
  }

  /**
   * Draws a door on every cell that carries a map link.
   *
   * A diamond rather than the locations' star: a door is a transition, not a
   * place, and the two must stay tellable apart on a crowded map.
   */
  private drawLinks(model: RenderModel, links: readonly RenderLink[]): void {
    const ctx = this.context;
    const radius = this.layout.size * 0.24;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const link of links) {
      const alpha = this.alphaAt(model, link.at);
      if (alpha <= 0) {
        continue;
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      const center = this.centerOf(model, link.at);
      const y = center.y - this.layout.size * 0.15;

      ctx.beginPath();
      ctx.moveTo(center.x, y - radius);
      ctx.lineTo(center.x + radius, y);
      ctx.lineTo(center.x, y + radius);
      ctx.lineTo(center.x - radius, y);
      ctx.closePath();
      ctx.fillStyle = CHROME.linkFill;
      ctx.fill();

      ctx.fillStyle = CHROME.linkText;
      ctx.font = `${Math.round(radius * 1.1)}px system-ui, sans-serif`;
      ctx.fillText('\u25B8', center.x, y);
      ctx.restore();
    }
  }

  /**
   * Writes the names of locations and doors, on top of everything already drawn.
   *
   * Deliberately its own pass rather than part of {@link drawLocations} and
   * {@link drawLinks}: see {@link drawLayered}.
   */
  private drawLabels(
    model: RenderModel,
    locations: readonly RenderLocation[],
    links: readonly RenderLink[],
  ): void {
    if (this.camera.zoom <= 0.7) {
      return;
    }
    const ctx = this.context;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(this.layout.size * 0.28)}px system-ui, sans-serif`;

    ctx.fillStyle = CHROME.locationFill;
    for (const location of locations) {
      const center = this.centerOf(model, location.at);
      ctx.fillText(location.name, center.x, center.y + this.layout.size * 0.5);
    }

    ctx.fillStyle = CHROME.linkLabel;
    for (const link of links) {
      if (link.label.length === 0) {
        continue;
      }
      const center = this.centerOf(model, link.at);
      ctx.fillText(link.label, center.x, center.y + this.layout.size * 0.5);
    }
  }

  private drawHighlight(
    model: RenderModel,
    cell: Offset | null,
    color: string,
    width: number,
  ): void {
    if (cell === null) {
      return;
    }
    const ctx = this.context;
    const elevation = this.elevationOf(model, cell);
    const base = this.wallBaseOf(model, cell);
    const path = new Path2D();
    this.addHexTo(path, cell, elevation);
    if (elevation > base) {
      this.addWallTo(path, cell, elevation, base);
    }
    ctx.lineWidth = width / this.camera.zoom;
    ctx.strokeStyle = color;
    ctx.stroke(path);
  }

  /**
   * Draws one plane of the decorations standing on these cells.
   *
   * Everything is already resolved and already sorted: the frame was chosen and
   * the anchor subtracted by the Rust resolver, and the host put the list in
   * draw order, so this multiplies by the tile scale and blits
   * (`docs/adr/ADR-0035-a-decoration-is-anchored-to-a-hex-in-two-planes.md`).
   *
   * A decoration is authored on the tile set's own pixel grid, so one authored
   * pixel is `hexWidth / tileArt.width` world units — exactly the scale a
   * painted cell is drawn at, which is what keeps a trunk on its hex.
   */
  private drawDecorations(
    model: RenderModel,
    decorations: readonly RenderDecoration[],
    plane: RenderDecoration['plane'],
  ): void {
    if (decorations.length === 0) {
      return;
    }
    const ctx = this.context;
    const perPixel = this.layout.hexWidth / Math.max(1, model.tileArt.width);

    for (const decoration of decorations) {
      if (decoration.plane !== plane || decoration.asset.length === 0) {
        continue;
      }
      // A decoration on a cell the reveal is looking through is in the way
      // exactly as the cell is (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
      const alpha = this.alphaAt(model, decoration.at);
      if (alpha <= 0) {
        continue;
      }
      const image = this.images?.image(decoration.asset);
      if (image == null) {
        continue;
      }

      const ground = this.centerOf(model, decoration.at);
      const [x, y, width, height] = decoration.placement;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        image,
        ground.x + x * perPixel,
        ground.y + y * perPixel,
        width * perPixel,
        height * perPixel,
      );
      if (decoration.emphasised === true) {
        ctx.lineWidth = 2 / this.camera.zoom;
        ctx.strokeStyle = CHROME.selection;
        ctx.strokeRect(
          ground.x + x * perPixel,
          ground.y + y * perPixel,
          width * perPixel,
          height * perPixel,
        );
      }
      ctx.restore();
      this.batchCount += 1;
    }
  }

  /**
   * Draws authored characters and fallback entity tokens.
   *
   * In isometric mode a token stands *on* its tile rather than lying flat: an
   * elliptical shadow marks the hex it occupies and the disc sits above it.
   */
  private drawEntities(model: RenderModel, entities: readonly RenderEntity[]): void {
    const ctx = this.context;
    const radius = this.layout.size * 0.52;
    const standing = !this.projection.isIdentity;
    const lift = standing ? radius * this.projection.tilt : 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const entity of entities) {
      // Someone standing on a cell the reveal is looking through is in the way
      // exactly as the cell is (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
      const alpha = this.alphaAt(model, entity.at);
      if (alpha <= 0) {
        continue;
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      const base = this.entityBaseOf(model, entity);

      if (entity.character !== null && entity.character !== undefined) {
        // Layer placement stays in authored whole pixels. The map applies one
        // outer scale so a 128px canvas occupies the number of tile faces this
        // world authored (`docs/adr/ADR-0031-map-entity-presentation.md`).
        const { width, height } = entity.character.resolution;
        const scale = this.characterScale(model);
        ctx.beginPath();
        ctx.ellipse(
          base.x,
          base.y,
          radius * 0.9,
          radius * 0.9 * (standing ? this.projection.tilt : 0.45),
          0,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = CHROME.entityShadow;
        ctx.fill();
        if (entity.emphasised) {
          ctx.lineWidth = 2 / this.camera.zoom;
          ctx.strokeStyle = CHROME.selection;
          ctx.stroke();
        }
        ctx.save();
        ctx.translate(base.x, base.y);
        ctx.scale(scale, scale);
        drawCharacter(ctx, entity.character, { x: -width / 2, y: -height, width, height }, this.images ?? undefined);
        ctx.restore();
        ctx.restore();
        continue;
      }

      if (standing) {
        ctx.beginPath();
        ctx.ellipse(base.x, base.y, radius * 0.9, radius * 0.9 * this.projection.tilt, 0, 0, Math.PI * 2);
        ctx.fillStyle = CHROME.entityShadow;
        ctx.fill();
      }

      const center = { x: base.x, y: base.y - lift };
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = this.sprites.resolve(entity.visualId, entity.fallbackColor);
      ctx.fill();
      ctx.lineWidth = (entity.emphasised ? 3 : 1.5) / this.camera.zoom;
      ctx.strokeStyle = entity.emphasised ? CHROME.selection : CHROME.entityOutline;
      ctx.stroke();

      ctx.fillStyle = CHROME.entityText;
      ctx.font = `bold ${Math.round(radius * 1.1)}px system-ui, sans-serif`;
      ctx.fillText(entity.glyph, center.x, center.y + radius * 0.04);
      ctx.restore();
    }
  }

  private drawCoordinates(
    model: RenderModel,
    range: VisibleRange,
    minRow: number,
    maxRow: number,
  ): void {
    if (this.camera.zoom < 0.6) {
      return;
    }
    const ctx = this.context;
    ctx.fillStyle = CHROME.coordinates;
    ctx.font = `${Math.round(this.layout.size * 0.26)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = range.minCol; col <= range.maxCol; col += 1) {
        const cell = { col, row };
        const index = indexIn(cell, model.bounds);
        if (index < 0 || model.presence[index] !== 1) {
          continue;
        }
        const center = this.centerOf(model, cell);
        ctx.fillText(`${col},${row}`, center.x, center.y - this.layout.size * 0.55);
      }
    }
  }

  // ------------------------------------------------------------- geometry

  /**
   * How solidly whatever stands on `cell` is drawn this frame.
   *
   * `1` for the whole map except the handful of cells the reveal is looking
   * through; everything a cell carries — its grid outline, its overlay, its
   * markers, whoever stands on it — fades with the cell, or the map is left
   * with bright chrome floating over nothing
   * (`docs/adr/ADR-0034-relief-never-hides-a-hex.md`).
   */
  private alphaAt(model: RenderModel, cell: Offset): number {
    return Math.min(this.fades.get(indexIn(cell, model.bounds)) ?? 1, 1);
  }

  /** The authored elevation of a cell by buffer index, or `0`. */
  private elevationAt(model: RenderModel, index: number): number {
    return model.elevation[index] ?? 0;
  }

  /** The authored elevation of a cell, or `0` when out of bounds. */
  private elevationOf(model: RenderModel, cell: Offset): number {
    const index = indexIn(cell, model.bounds);
    return index < 0 ? 0 : this.elevationAt(model, index);
  }

  /** The projected centre of a cell, on top of whatever it is standing on. */
  private centerOf(model: RenderModel, cell: Offset): Point {
    return this.projection.project(this.layout.centerOf(cell), this.elevationOf(model, cell));
  }

  /** Projected ground point, interpolated while an entity is visually moving. */
  private entityBaseOf(model: RenderModel, entity: RenderEntity): Point {
    const destination = this.centerOf(model, entity.at);
    if (entity.motion === undefined) {
      return destination;
    }
    const origin = this.centerOf(model, entity.motion.from);
    const progress = Math.max(0, Math.min(1, entity.motion.progress));
    return {
      x: origin.x + (destination.x - origin.x) * progress,
      y: origin.y + (destination.y - origin.y) * progress,
    };
  }

  /** Row band used for terrain occlusion during a diagonal transition. */
  private entityDepthCell(entity: RenderEntity): Offset {
    if (entity.motion === undefined) {
      return entity.at;
    }
    return {
      col: entity.at.col,
      row: Math.round(
        entity.motion.from.row +
          (entity.at.row - entity.motion.from.row) * Math.max(0, Math.min(1, entity.motion.progress)),
      ),
    };
  }

  /** Fractional outer scale from authored character pixels to map units. */
  private characterScale(model: RenderModel): number {
    const tileFaceHeight = this.layout.hexHeight * this.projection.tilt;
    return (tileFaceHeight * model.characterHeightTiles) / REFERENCE_CHARACTER_HEIGHT_PX;
  }

  /**
   * The elevation a cell's side face has to reach down to.
   *
   * A cliff is only needed where something in *front* of the cell sits lower.
   * The two cells its front edges face — SE and SW, both in the next row — cover
   * everything below their own top faces, so the face has to span exactly the
   * drop to the lower of the two; a cell off the map counts as ground, which is
   * what gives the map a skirt along its front edge.
   *
   * Anchoring the face at `0` instead, as this used to, is wrong in both
   * directions: it extrudes further than anything can see when the neighbours
   * are raised, and — the visible bug — it draws *nothing* for a cell standing
   * at or below `0` next to a cell dug below it, leaving the background showing
   * through the gap the drop opens.
   */
  private wallBaseOf(model: RenderModel, cell: Offset): number {
    // odd-r: even rows put their SW neighbour a column left, odd rows lean right
    // (`docs/adr/ADR-0011-hex-coordinate-model.md`).
    const west = cell.row % 2 === 0 ? cell.col - 1 : cell.col;
    return Math.min(
      this.elevationOf(model, { col: west, row: cell.row + 1 }),
      this.elevationOf(model, { col: west + 1, row: cell.row + 1 }),
    );
  }

  /** The projected corners of a cell's top face. */
  private cornersOf(cell: Offset, elevation: number, projection = this.projection): Point[] {
    return this.layout
      .corners(this.layout.centerOf(cell))
      .map((corner) => projection.project(corner, elevation));
  }

  /**
   * The polygons a cell's terrain is drawn as: its top face, and its side face
   * when it has one.
   *
   * One description of a cell's silhouette, used by everything that has to
   * agree with the picture — what the pointer hits, and what hides what.
   */
  private silhouetteOf(model: RenderModel, projection: Projection, cell: Offset): Point[][] {
    const elevation = this.elevationOf(model, cell);
    const corners = this.cornersOf(cell, elevation, projection);
    const polygons: Point[][] = [corners];

    const lift = projection.liftOf(elevation - this.wallBaseOf(model, cell));
    if (lift <= 0) {
      return polygons;
    }
    const front = [corners[1], corners[2], corners[3]].filter(
      (corner): corner is Point => corner !== undefined,
    );
    if (front.length === 3) {
      polygons.push([
        ...front,
        ...front.map((corner) => ({ x: corner.x, y: corner.y + lift })).reverse(),
      ]);
    }
    return polygons;
  }

  /**
   * `true` when so little of a cell's top face is left showing that the pointer
   * cannot reasonably be asked to aim at it.
   *
   * The threshold is {@link BURIED_COVERAGE}; the measurement is
   * {@link occlusionOf}.
   */
  private isBuried(model: RenderModel, projection: Projection, cell: Offset): boolean {
    return this.occlusionOf(model, projection, cell).hidden >= BURIED_COVERAGE;
  }

  /**
   * How much of a cell's top face the relief in front of it hides, and which
   * cells do the hiding.
   *
   * Measured by sampling rather than by intersecting polygons: the covering set
   * is a handful of overlapping hexagons and side faces, whose union is fiddly
   * to build and worth nothing once built. {@link COVERAGE_SAMPLES} stands for
   * equal patches of the face, so the covered fraction is the covered count.
   *
   * The list of *who* covers it comes out of the same sweep, because it is what
   * the reveal draws see-through: fading exactly the cells whose pixels are in
   * the way, and nothing else.
   *
   * Only cells *in front* can hide a cell: hexagons tile the plane, so an
   * unraised neighbour never overlaps, and a cell behind is drawn before it and
   * covered by it rather than the reverse.
   */
  private occlusionOf(model: RenderModel, projection: Projection, cell: Offset): Occlusion {
    const index = indexIn(cell, model.bounds);
    if (projection.isIdentity || index < 0) {
      return NOTHING_HIDDEN;
    }
    const memoised = this.occlusion.get(index);
    if (memoised !== undefined && projection === this.projection) {
      return memoised;
    }

    const elevation = this.elevationAt(model, index);
    const occluders = this.occludersOf(model, projection, cell, elevation);
    const by = new Set<number>();
    let covered = 0;
    if (occluders.length > 0) {
      const centre = this.layout.centerOf(cell);
      const size = this.layout.size;
      for (const sample of COVERAGE_SAMPLES) {
        const point = projection.project(
          { x: centre.x + sample.x * size, y: centre.y + sample.y * size },
          elevation,
        );
        let hit = false;
        for (const occluder of occluders) {
          if (occluder.polygons.some((polygon) => containsPoint(polygon, point))) {
            by.add(occluder.index);
            hit = true;
          }
        }
        if (hit) {
          covered += 1;
        }
      }
    }

    const found: Occlusion = { hidden: covered / COVERAGE_SAMPLES.length, by: [...by] };
    if (projection === this.projection) {
      this.occlusion.set(index, found);
    }
    return found;
  }

  /** The cells drawn in front of `cell` that can hide it, with their silhouettes. */
  private occludersOf(
    model: RenderModel,
    projection: Projection,
    cell: Offset,
    elevation: number,
  ): { index: number; polygons: Point[][] }[] {
    // How far ahead a cell has to be raised to still reach back over this one:
    // one row of lift is `rowStep * tilt` of drawing, and nothing on the map is
    // raised past `elevationRange.max`.
    const rowLift = this.layout.rowStep * projection.tilt;
    const reach =
      rowLift > 0
        ? Math.ceil(projection.liftOf(model.elevationRange.max - elevation) / rowLift) + 1
        : 1;
    const rows = Math.min(Math.max(reach, 1), OCCLUSION_ROW_LIMIT);

    const occluders: { index: number; polygons: Point[][] }[] = [];
    const last = Math.min(cell.row + rows, maxRow(model.bounds));
    for (let row = cell.row + 1; row <= last; row += 1) {
      // odd-r shifts every other row half a hex, so the columns that can reach
      // back over this cell are the two under it and their outer neighbours.
      const shift = cell.row % 2 === 0 ? -1 : 0;
      for (let col = cell.col + shift - 1; col <= cell.col + shift + 2; col += 1) {
        const front = { col, row };
        const index = indexIn(front, model.bounds);
        if (index < 0 || model.presence[index] !== 1) {
          continue;
        }
        if (this.elevationAt(model, index) <= elevation) {
          continue;
        }
        occluders.push({ index, polygons: this.silhouetteOf(model, projection, front) });
      }
    }
    return occluders;
  }

  private addHexTo(path: Path2D, cell: Offset, elevation: number): void {
    addPolygon(path, this.cornersOf(cell, elevation));
  }

  /**
   * Adds the side face of an elevated cell: the near edges of its top face,
   * dropped down to `base` (see {@link wallBaseOf}).
   *
   * Corners 1, 2 and 3 are the near ones — a pointy-top hexagon puts its corners
   * at `60i - 30` degrees, so those three are the ones below the centre.
   */
  private addWallTo(path: Path2D, cell: Offset, elevation: number, base: number): void {
    const lift = this.projection.liftOf(elevation - base);
    if (lift <= 0) {
      return;
    }
    const corners = this.cornersOf(cell, elevation);
    const front = [corners[1], corners[2], corners[3]].filter(
      (corner): corner is Point => corner !== undefined,
    );
    if (front.length < 3) {
      return;
    }
    addPolygon(path, [
      ...front,
      ...front.map((corner) => ({ x: corner.x, y: corner.y + lift })).reverse(),
    ]);
  }

  /**
   * `true` when `drawing` lands on a cell's top face or its exposed side.
   *
   * The side is measured with {@link wallBaseOf}, the same way it is drawn: the
   * pointer must agree with the picture, so a cliff face that is painted is
   * clickable and one that is not is transparent to the search behind it.
   */
  private cellCovers(
    model: RenderModel,
    projection: Projection,
    cell: Offset,
    drawing: Point,
  ): boolean {
    return this.silhouetteOf(model, projection, cell).some((polygon) =>
      containsPoint(polygon, drawing),
    );
  }

  private fillFor(model: RenderModel, paletteIndex: number): string | CanvasPattern | CanvasGradient {
    const tile = model.palette[paletteIndex];
    return tile ? this.sprites.resolve(tile.visualId, tile.fallbackColor) : CHROME.outOfBounds;
  }
}

/** A cell drawn from its authored images rather than from its colour. */
interface PaintedCell {
  readonly cell: Offset;
  readonly elevation: number;
  readonly appearance: TileAppearance;
}

interface VisibleRange {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}

/**
 * A lattice of points inside a pointy-top hexagon of circumradius `1`.
 *
 * Sampled over the bounding box and trimmed to the hexagon, so every kept point
 * stands for an equal patch of it — which is what makes counting them a measure
 * of area. The hexagon is `|y| <= 1 - |x| / sqrt(3)`.
 */
function buildCoverageSamples(): Point[] {
  const SQRT3 = Math.sqrt(3);
  const columns = 7;
  const rows = 9;
  const points: Point[] = [];
  for (let column = 0; column < columns; column += 1) {
    const x = (SQRT3 / 2) * ((2 * (column + 0.5)) / columns - 1);
    for (let row = 0; row < rows; row += 1) {
      const y = (2 * (row + 0.5)) / rows - 1;
      if (Math.abs(y) <= 1 - Math.abs(x) / SQRT3) {
        points.push({ x, y });
      }
    }
  }
  return points;
}

function pathFor(paths: Map<number, Path2D>, key: number): Path2D {
  let path = paths.get(key);
  if (path === undefined) {
    path = new Path2D();
    paths.set(key, path);
  }
  return path;
}

function addPolygon(path: Path2D, points: readonly Point[]): void {
  const first = points[0];
  if (first === undefined) {
    return;
  }
  path.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    if (point !== undefined) {
      path.lineTo(point.x, point.y);
    }
  }
  path.closePath();
}

/** Buckets items by the row of the cell they sit on. */
function groupByRow<T>(items: readonly T[], cellOf: (item: T) => Offset): Map<number, T[]> {
  const byRow = new Map<number, T[]>();
  for (const item of items) {
    const row = cellOf(item).row;
    const bucket = byRow.get(row);
    if (bucket === undefined) {
      byRow.set(row, [item]);
    } else {
      bucket.push(item);
    }
  }
  return byRow;
}

/**
 * Even-odd ray casting.
 *
 * Deliberately not `CanvasRenderingContext2D.isPointInPath`, which compares
 * against the context's current transform — hit-testing must not depend on
 * whatever the last `draw` left behind.
 */
function containsPoint(polygon: readonly Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) {
      continue;
    }
    const straddles = a.y > point.y !== b.y > point.y;
    if (straddles && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Re-exported so callers can build models without importing two modules. */
export { fromIndex, indexIn, sameOffset };

/** Every distinct image the decorations on a map are drawn from. */
function decorationAssets(model: RenderModel): string[] {
  const assets = new Set<string>();
  for (const decoration of model.decorations) {
    if (decoration.asset.length > 0) {
      assets.add(decoration.asset);
    }
  }
  return [...assets];
}
