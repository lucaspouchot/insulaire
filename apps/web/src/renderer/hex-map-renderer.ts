/**
 * Canvas renderer for a hex map.
 *
 * Framework-free on purpose: Angular components own a `<canvas>` and hand this
 * class a {@link RenderModel}, but nothing here knows Angular exists
 * (`CLAUDE.md`, "Keep rendering code separate from Angular components").
 *
 * # Two properties that matter at scale
 *
 * **Viewport culling.** Only the cells returned by
 * {@link HexLayout.visibleRange} are touched. Drawing cost follows the window,
 * not the map: a 2048x2048 world costs the same per frame as a 20x20 one.
 *
 * **Batched filling.** Terrain is drawn by accumulating one `Path2D` per palette
 * entry and issuing a single `fill()` for each. A six-tile palette costs six
 * fills regardless of how many hexes are on screen, instead of one state change
 * per hex.
 */

import { Offset, fromIndex, indexIn, sameOffset } from '../core/hex/hex-coords';
import { HexLayout, Point } from '../core/hex/hex-layout';
import { Camera } from './camera';
import { RenderModel, emptyRenderModel } from './render-model';
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
  entityOutline: 'rgba(10, 12, 16, 0.85)',
  entityText: '#11161d',
  coordinates: 'rgba(255, 255, 255, 0.55)',
} as const;

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
  private stats: FrameStats = { cellsDrawn: 0, cellsTotal: 0, terrainBatches: 0, lastFrameMs: 0 };

  constructor(
    private readonly context: CanvasRenderingContext2D,
    readonly layout: HexLayout,
    readonly camera: Camera,
    private readonly sprites: SpriteRegistry = new SpriteRegistry(),
  ) {}

  /** Replaces the model drawn by the next {@link draw}. */
  setModel(model: RenderModel): void {
    this.model = model;
  }

  /** The model currently being drawn. */
  get currentModel(): RenderModel {
    return this.model;
  }

  /** Statistics from the last frame. */
  get frameStats(): FrameStats {
    return this.stats;
  }

  /** The sprite registry used to resolve visual ids. */
  get spriteRegistry(): SpriteRegistry {
    return this.sprites;
  }

  /** The offset cell under a screen-space point, or `null` when off the map. */
  cellAtScreen(point: Point, model: RenderModel = this.model): Offset | null {
    const cell = this.layout.cellAt(this.camera.toWorld(point));
    return indexIn(cell, model.width, model.height) >= 0 ? cell : null;
  }

  /** Frames the whole map in a `width x height` viewport. */
  fitToViewport(width: number, height: number): void {
    if (this.model.width === 0 || this.model.height === 0) {
      return;
    }
    this.camera.fit(this.layout.boundsOf(this.model.width, this.model.height), width, height);
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

    const view = this.camera.visibleWorldRect(width, height);
    const range = this.layout.visibleRange(view, model.width, model.height);

    const cellsDrawn = this.drawTerrain(model, range);
    if (model.showGrid) {
      this.drawGrid(model, range);
    }
    this.drawOverlays(model);
    this.drawLocations(model);
    this.drawHighlight(model.hover, CHROME.hover, 2);
    this.drawHighlight(model.selected, CHROME.selection, 3);
    this.drawEntities(model);
    if (model.showCoordinates) {
      this.drawCoordinates(model, range);
    }

    ctx.restore();

    this.stats = {
      cellsDrawn,
      cellsTotal: model.width * model.height,
      terrainBatches: this.lastBatchCount,
      lastFrameMs: performance.now() - startedAt,
    };
  }

  private lastBatchCount = 0;

  /**
   * Draws terrain, one `fill()` per palette entry present on screen.
   *
   * Returns the number of cells visited.
   */
  private drawTerrain(model: RenderModel, range: VisibleRange): number {
    const ctx = this.context;
    const paths = new Map<number, Path2D>();
    let visited = 0;

    for (let row = range.minRow; row <= range.maxRow; row += 1) {
      for (let col = range.minCol; col <= range.maxCol; col += 1) {
        const index = row * model.width + col;
        const paletteIndex = model.terrain[index];
        if (paletteIndex === undefined) {
          continue;
        }
        visited += 1;

        let path = paths.get(paletteIndex);
        if (path === undefined) {
          path = new Path2D();
          paths.set(paletteIndex, path);
        }
        this.addHexTo(path, { col, row });
      }
    }

    for (const [paletteIndex, path] of paths) {
      const tile = model.palette[paletteIndex];
      ctx.fillStyle = tile
        ? this.sprites.resolve(tile.visualId, tile.fallbackColor)
        : CHROME.outOfBounds;
      ctx.fill(path);
    }

    this.lastBatchCount = paths.size;
    return visited;
  }

  /** Draws hex outlines as a single stroked path. */
  private drawGrid(model: RenderModel, range: VisibleRange): void {
    const ctx = this.context;
    const grid = new Path2D();
    for (let row = range.minRow; row <= range.maxRow; row += 1) {
      for (let col = range.minCol; col <= range.maxCol; col += 1) {
        this.addHexTo(grid, { col, row });
      }
    }
    ctx.lineWidth = 1 / this.camera.zoom;
    ctx.strokeStyle = CHROME.grid;
    ctx.stroke(grid);
  }

  private drawOverlays(model: RenderModel): void {
    const ctx = this.context;
    for (const overlay of model.overlays) {
      if (overlay.cells.length === 0) {
        continue;
      }
      const path = new Path2D();
      for (const cell of overlay.cells) {
        this.addHexTo(path, cell);
      }
      ctx.fillStyle = overlay.fill;
      ctx.fill(path);
      ctx.lineWidth = 2 / this.camera.zoom;
      ctx.strokeStyle = overlay.stroke;
      ctx.stroke(path);
    }
  }

  private drawLocations(model: RenderModel): void {
    const ctx = this.context;
    const radius = this.layout.size * 0.22;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const location of model.locations) {
      const center = this.layout.centerOf(location.at);
      ctx.beginPath();
      ctx.arc(center.x, center.y - this.layout.size * 0.15, radius, 0, Math.PI * 2);
      ctx.fillStyle = CHROME.locationFill;
      ctx.fill();

      ctx.fillStyle = CHROME.locationText;
      ctx.font = `${Math.round(radius * 1.3)}px system-ui, sans-serif`;
      ctx.fillText('★', center.x, center.y - this.layout.size * 0.13);

      if (this.camera.zoom > 0.7) {
        ctx.fillStyle = CHROME.locationFill;
        ctx.font = `${Math.round(this.layout.size * 0.28)}px system-ui, sans-serif`;
        ctx.fillText(location.name, center.x, center.y + this.layout.size * 0.5);
      }
    }
  }

  private drawHighlight(cell: Offset | null, color: string, width: number): void {
    if (cell === null) {
      return;
    }
    const ctx = this.context;
    const path = new Path2D();
    this.addHexTo(path, cell);
    ctx.lineWidth = width / this.camera.zoom;
    ctx.strokeStyle = color;
    ctx.stroke(path);
  }

  private drawEntities(model: RenderModel): void {
    const ctx = this.context;
    const radius = this.layout.size * 0.52;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const entity of model.entities) {
      const center = this.layout.centerOf(entity.at);

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

  private drawCoordinates(model: RenderModel, range: VisibleRange): void {
    if (this.camera.zoom < 0.6) {
      return;
    }
    const ctx = this.context;
    ctx.fillStyle = CHROME.coordinates;
    ctx.font = `${Math.round(this.layout.size * 0.26)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let row = range.minRow; row <= range.maxRow; row += 1) {
      for (let col = range.minCol; col <= range.maxCol; col += 1) {
        if (indexIn({ col, row }, model.width, model.height) < 0) {
          continue;
        }
        const center = this.layout.centerOf({ col, row });
        ctx.fillText(`${col},${row}`, center.x, center.y - this.layout.size * 0.55);
      }
    }
  }

  private addHexTo(path: Path2D, cell: Offset): void {
    const corners = this.layout.corners(this.layout.centerOf(cell));
    const first = corners[0];
    if (first === undefined) {
      return;
    }
    path.moveTo(first.x, first.y);
    for (let i = 1; i < corners.length; i += 1) {
      const corner = corners[i];
      if (corner !== undefined) {
        path.lineTo(corner.x, corner.y);
      }
    }
    path.closePath();
  }
}

interface VisibleRange {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}

/** Re-exported so callers can build models without importing two modules. */
export { fromIndex, indexIn, sameOffset };
