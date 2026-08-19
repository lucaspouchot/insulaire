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
 * **Two draw paths.** A top-down world is one band covering the whole viewport,
 * which is the single-batch case above. An isometric world is drawn a row at a
 * time from back to front, because elevated cells overlap the row behind them —
 * batching is then per row, and everything standing on a row (overlays,
 * entities, markers) is drawn with it so terrain in front can occlude it
 * (`docs/adr/ADR-0016-isometric-projection.md`). Captions are the exception and
 * come last, unoccluded; see {@link HexMapRenderer.drawLayered}.
 */

import { shoulderLine } from '../content/content-types';
import { Offset, fromIndex, indexIn, sameOffset } from '../core/hex/hex-coords';
import { HexLayout, Point, Rect } from '../core/hex/hex-layout';
import { Camera } from './camera';
import { SpriteSource } from './character-renderer';
import { Projection } from './projection';
import {
  ResolvedTileRender,
  projectionRatiosOf,
  resolveTileRender,
  variantRoll,
} from './tile-art';
import {
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
  grid: 'rgba(0, 0, 0, 0.25)',
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

/** Statistics from the last frame, surfaced in the UI to make culling visible. */
export interface FrameStats {
  /** Cells considered after culling. */
  cellsDrawn: number;
  /** Total cells in the map. */
  cellsTotal: number;
  /** `fill()` calls issued for terrain. */
  terrainBatches: number;
  /** Milliseconds spent in the last `draw`. */
  lastFrameMs: number;
}

export class HexMapRenderer {
  private model: RenderModel = emptyRenderModel();
  private projection: Projection;
  private stats: FrameStats = { cellsDrawn: 0, cellsTotal: 0, terrainBatches: 0, lastFrameMs: 0 };
  private batchCount = 0;

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
     * it loads (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
     */
    private readonly images: SpriteSource | null = null,
  ) {
    this.projection = this.projectionFor(this.model);
  }

  /** Replaces the model drawn by the next {@link draw}. */
  setModel(model: RenderModel): void {
    this.model = model;
    this.projection = this.projectionFor(model);
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
      return indexIn(cell, model.width, model.height) >= 0 ? cell : null;
    }

    const { min, max } = model.elevationRange;
    const frontRow = this.layout.cellAt(projection.unproject(drawing, max)).row + ROW_SEARCH_SLACK;
    const backRow = this.layout.cellAt(projection.unproject(drawing, min)).row - ROW_SEARCH_SLACK;

    for (let row = Math.min(frontRow, model.height - 1); row >= Math.max(backRow, 0); row -= 1) {
      // Which columns can reach `drawing.x` on this row: odd rows are shifted
      // half a hex right, so the centre of `col` sits at `hexWidth * col`.
      const shift = row % 2 === 0 ? 0 : 0.5;
      const approximate = Math.round(drawing.x / this.layout.hexWidth - shift);

      for (const col of [approximate, approximate - 1, approximate + 1]) {
        const cell = { col, row };
        if (indexIn(cell, model.width, model.height) < 0) {
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
    const plane = this.layout.boundsOf(model.width, model.height);
    const projection = model === this.model ? this.projection : this.projectionFor(model);
    if (projection.isIdentity || model.width === 0 || model.height === 0) {
      return projection.projectRect(plane);
    }

    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let row = 0; row < model.height; row += 1) {
      let peak = 0;
      let floor = 0;
      for (let col = 0; col < model.width; col += 1) {
        const elevation = this.elevationAt(model, row * model.width + col);
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
    if (this.model.width === 0 || this.model.height === 0) {
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

    if (model.width === 0 || model.height === 0) {
      ctx.restore();
      this.stats = { cellsDrawn: 0, cellsTotal: 0, terrainBatches: 0, lastFrameMs: 0 };
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
      model.width,
      model.height,
    );

    this.batchCount = 0;
    const cellsDrawn = this.projection.isIdentity
      ? this.drawFlat(model, range)
      : this.drawLayered(model, range);

    ctx.restore();

    this.stats = {
      cellsDrawn,
      cellsTotal: model.width * model.height,
      terrainBatches: this.batchCount,
      lastFrameMs: performance.now() - startedAt,
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
    this.drawHighlight(model, model.hover, CHROME.hover, 2);
    this.drawHighlight(model, model.selected, CHROME.selection, 3);
    this.drawLocations(model, model.locations);
    this.drawLinks(model, model.links);
    this.drawEntities(model, model.entities);
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
    const entitiesByRow = groupByRow(model.entities, (entity) => entity.at);

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
      if (model.hover?.row === row) {
        this.drawHighlight(model, model.hover, CHROME.hover, 2);
      }
      if (model.selected?.row === row) {
        this.drawHighlight(model, model.selected, CHROME.selection, 3);
      }
      this.drawLocations(model, locationsByRow.get(row) ?? []);
      this.drawLinks(model, linksByRow.get(row) ?? []);
      this.drawEntities(model, entitiesByRow.get(row) ?? []);
      if (model.showCoordinates) {
        this.drawCoordinates(model, range, row, row);
      }
    }
    this.drawLabels(model, model.locations, model.links);
    return cellsDrawn;
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
    let visited = 0;

    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = range.minCol; col <= range.maxCol; col += 1) {
        const index = row * model.width + col;
        const paletteIndex = model.terrain[index];
        if (paletteIndex === undefined) {
          continue;
        }
        visited += 1;

        const cell = { col, row };
        const elevation = this.elevationAt(model, index);
        const base = this.wallBaseOf(model, cell);

        const render = this.renderOf(model, paletteIndex, cell, elevation, base);
        if (render !== null) {
          painted.push({ cell, elevation, render });
          // A tile may author a top face and no cliff art at all — grass at the
          // edge of a ditch. Its faces are still exposed, so the colour wall is
          // filled behind the art that does exist: whatever is authored covers
          // it, and what is not reads as a drop instead of a hole.
          if (this.facesAreShort(render, elevation, base)) {
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

    return visited;
  }

  /**
   * `true` when a cell exposes more faces than its art covers.
   *
   * Surface art without elevation art is the common case — a tile drawn as a
   * flat top that has never been given a cliff — and a drop past
   * `MAX_STACKED_LEVELS` falls short at its bottom. Either way the colour wall
   * goes back behind the blits, because a cell standing above its neighbours
   * has to *look* like it
   * (`docs/adr/ADR-0009-assets-tilesets.md`: `fallbackColor` is what is drawn
   * wherever a texture is not).
   */
  private facesAreShort(render: ResolvedTileRender, elevation: number, base: number): boolean {
    return render.layers.length < Math.max(0, elevation - base);
  }

  /**
   * What a cell's authored art draws, or `null` to fall back to colour.
   *
   * `null` covers three cases that mean the same thing to the caller: the tile
   * declares no art, the resolver found nothing for this height, or the images
   * have not finished loading. The last one is why `fallbackColor` is worth
   * keeping — it is the colour drawn while a texture loads
   * (`docs/adr/ADR-0009-assets-tilesets.md`).
   */
  private renderOf(
    model: RenderModel,
    paletteIndex: number,
    cell: Offset,
    elevation: number,
    base: number,
  ): ResolvedTileRender | null {
    const tile = model.palette[paletteIndex];
    if (this.images === null || tile === undefined || tile.art === undefined) {
      return null;
    }
    const render = resolveTileRender(
      tile.id,
      tile.art,
      elevation,
      base,
      variantRoll(cell.col, cell.row, tile.id),
    );
    if (render.surface === null && render.layers.length === 0) {
      return null;
    }
    const loaded =
      (render.surface === null || this.images.image(render.surface) !== null) &&
      render.layers.every((layer) => this.images?.image(layer.asset) !== null);
    return loaded ? render : null;
  }

  /**
   * Blits one cell: its faces, lowest first, then its top face over them.
   *
   * The destination is the *projected* top face's bounding box, so the picture
   * agrees with the polygon path, with hit-testing and with the grid by
   * construction. An elevation image starts at the hexagon's lower shoulders —
   * it is the faces alone — and a repeated level is the same image moved down
   * whole steps, nothing inside it transformed
   * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
   */
  private drawPaintedCell(model: RenderModel, painted: PaintedCell): void {
    const ctx = this.context;
    const centre = this.projection.project(this.layout.centerOf(painted.cell), painted.elevation);
    const width = this.layout.hexWidth;
    const left = centre.x - width / 2;
    const top = centre.y - (this.layout.hexHeight * this.projection.tilt) / 2;
    const perPixel = width / Math.max(1, model.tileArt.width);
    const shoulder = top + shoulderLine(model.tileArt) * perPixel;

    ctx.imageSmoothingEnabled = false;
    for (const layer of painted.render.layers) {
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
    if (painted.render.surface !== null) {
      const image = this.images?.image(painted.render.surface);
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
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = range.minCol; col <= range.maxCol; col += 1) {
        const cell = { col, row };
        this.addHexTo(grid, cell, this.elevationOf(model, cell));
      }
    }
    ctx.lineWidth = 1 / this.camera.zoom;
    ctx.strokeStyle = CHROME.grid;
    ctx.stroke(grid);
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
      const path = new Path2D();
      for (const cell of cells) {
        this.addHexTo(path, cell, this.elevationOf(model, cell));
      }
      ctx.fillStyle = overlay.fill;
      ctx.fill(path);
      ctx.lineWidth = 2 / this.camera.zoom;
      ctx.strokeStyle = overlay.stroke;
      ctx.stroke(path);
    }
  }

  private drawLocations(model: RenderModel, locations: readonly RenderLocation[]): void {
    const ctx = this.context;
    const radius = this.layout.size * 0.22;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const location of locations) {
      const center = this.centerOf(model, location.at);
      ctx.beginPath();
      ctx.arc(center.x, center.y - this.layout.size * 0.15, radius, 0, Math.PI * 2);
      ctx.fillStyle = CHROME.locationFill;
      ctx.fill();

      ctx.fillStyle = CHROME.locationText;
      ctx.font = `${Math.round(radius * 1.3)}px system-ui, sans-serif`;
      ctx.fillText('★', center.x, center.y - this.layout.size * 0.13);
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
   * Draws entity tokens.
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
      const base = this.centerOf(model, entity.at);

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
        if (indexIn(cell, model.width, model.height) < 0) {
          continue;
        }
        const center = this.centerOf(model, cell);
        ctx.fillText(`${col},${row}`, center.x, center.y - this.layout.size * 0.55);
      }
    }
  }

  // ------------------------------------------------------------- geometry

  /** The authored elevation of a cell by buffer index, or `0`. */
  private elevationAt(model: RenderModel, index: number): number {
    return model.elevation[index] ?? 0;
  }

  /** The authored elevation of a cell, or `0` when out of bounds. */
  private elevationOf(model: RenderModel, cell: Offset): number {
    const index = indexIn(cell, model.width, model.height);
    return index < 0 ? 0 : this.elevationAt(model, index);
  }

  /** The projected centre of a cell, on top of whatever it is standing on. */
  private centerOf(model: RenderModel, cell: Offset): Point {
    return this.projection.project(this.layout.centerOf(cell), this.elevationOf(model, cell));
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
    // (`docs/adr/ADR-0014-hex-coordinate-model.md`).
    const west = cell.row % 2 === 0 ? cell.col - 1 : cell.col;
    return Math.min(
      this.elevationOf(model, { col: west, row: cell.row + 1 }),
      this.elevationOf(model, { col: west + 1, row: cell.row + 1 }),
    );
  }

  /** The projected corners of a cell's top face. */
  private cornersOf(cell: Offset, elevation: number): Point[] {
    return this.layout
      .corners(this.layout.centerOf(cell))
      .map((corner) => this.projection.project(corner, elevation));
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
    const elevation = this.elevationOf(model, cell);
    const corners = this.layout
      .corners(this.layout.centerOf(cell))
      .map((corner) => projection.project(corner, elevation));

    if (containsPoint(corners, drawing)) {
      return true;
    }

    const lift = projection.liftOf(elevation - this.wallBaseOf(model, cell));
    if (lift <= 0) {
      return false;
    }
    const front = [corners[1], corners[2], corners[3]].filter(
      (corner): corner is Point => corner !== undefined,
    );
    return (
      front.length === 3 &&
      containsPoint(
        [...front, ...front.map((corner) => ({ x: corner.x, y: corner.y + lift })).reverse()],
        drawing,
      )
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
  readonly render: ResolvedTileRender;
}

interface VisibleRange {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
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
