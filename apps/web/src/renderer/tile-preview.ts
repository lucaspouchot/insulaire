/**
 * Drawing tiles outside a map: the asset editor's preview, and its guides.
 *
 * Framework-free, like the two renderers next to it. It exists so the editor
 * can show one tile at a chosen height, or a small board of several, using the
 * **same geometry the game uses** — `HexLayout` for the hex plane, `Projection`
 * for the transform onto the canvas, `tile-art.ts` for what resolves to what
 * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
 *
 * Nothing here re-derives a hexagon. If the preview and the map ever disagreed,
 * the whole editor would be a drawing of a guess
 * (`docs/adr/ADR-0014-hex-coordinate-model.md`).
 */

import { TileArt, TileArtGeometry, faceHeight, shoulderLine } from '../content/content-types';
import { Offset } from '../core/hex/hex-coords';
import { HexLayout, Point } from '../core/hex/hex-layout';
import { SpriteSource } from './character-renderer';
import { Projection } from './projection';
import { CellArt, projectionRatiosOf, resolveTileRender, variantRoll } from './tile-art';

/** Colours the preview draws with; chrome, never content. */
const CHROME = {
  outline: 'rgba(255, 255, 255, 0.55)',
  guide: 'rgba(126, 200, 227, 0.9)',
  guideFaint: 'rgba(126, 200, 227, 0.35)',
  label: 'rgba(126, 200, 227, 0.9)',
  missing: '#f0736a',
  checkerDark: '#20252d',
  checkerLight: '#2a3038',
} as const;

/** One cell of a preview board. */
export interface PreviewCell {
  readonly at: Offset;
  readonly tileId: string;
  readonly art: TileArt | undefined;
  /** Colour drawn when the images are not loaded. */
  readonly fallbackColor: string;
  readonly elevation: number;
  /**
   * Which variants this cell draws, overriding the roll.
   *
   * The map rolls a variant per cell so a field does not repeat, and the editor
   * needs the opposite: the cell being painted must show the image being
   * painted, not whichever one the hash chose
   * (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`).
   */
  readonly choice?: CellArt;
}

/** How a preview board is laid out on the canvas. */
export interface PreviewLayout {
  readonly layout: HexLayout;
  readonly projection: Projection;
  /** Where the hex plane's origin lands on the canvas, in CSS pixels. */
  readonly originX: number;
  readonly originY: number;
  /** What the board actually occupies, padding included, in CSS pixels. */
  readonly contentWidth: number;
  readonly contentHeight: number;
}

/**
 * Smallest hexagon the framing will produce, in CSS pixels.
 *
 * Only there to keep a degenerate box from asking for a size of zero: a real
 * one is decided by whichever side of the frame is tighter.
 */
const MIN_HEX_SIZE = 0.5;

/**
 * The layout that fits `cells` into `width x height`, whole hexes and centred.
 *
 * The hex size is a real number rather than a whole one: a hexagon has no pixel
 * grid of its own, and the images inside it are blitted with smoothing off.
 *
 * `zoom` overrides the fitting: it is **screen pixels per authored pixel**, the
 * same unit the character stage zooms in, so a tile at `6` is a tile whose
 * pixels are six-pixel blocks whatever the panel's size
 * (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`). The board is still
 * centred, and {@link PreviewLayout.contentWidth} says how much room it wants —
 * a caller with a scroller gives it that and lets the rest scroll.
 */
export function fitPreview(
  cells: readonly PreviewCell[],
  geometry: TileArtGeometry,
  width: number,
  height: number,
  mode: 'topDown' | 'isometric' = 'isometric',
  padding = 12,
  zoom: number | null = null,
): PreviewLayout {
  const { tilt, elevationRatio } = projectionRatiosOf(geometry);
  const probe = new HexLayout(1);
  const probeProjection = Projection.from(mode, 1, tilt, elevationRatio);

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const perPixel = probe.hexWidth / Math.max(1, geometry.width);
  for (const cell of cells) {
    const centre = probeProjection.project(probe.centerOf(cell.at), cell.elevation);
    const top = centre.y - probe.hexHeight * probeProjection.tilt * 0.5;
    minX = Math.min(minX, centre.x - probe.hexWidth / 2);
    maxX = Math.max(maxX, centre.x + probe.hexWidth / 2);
    minY = Math.min(minY, top);
    if (mode !== 'isometric') {
      // A flat cell is its hexagon and nothing else: no tilt to allow for, and
      // no cliff hanging below it
      // (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
      maxY = Math.max(maxY, top + probe.hexHeight);
      continue;
    }
    // The bottom of the *lowest* face, not the topmost one: a cell standing at
    // height `n` is a stack of `n` images, each a step further down, and framing
    // to the top one alone crops the cliff out of its own preview.
    const steps = Math.max(0, cell.elevation);
    if (steps === 0) {
      // A cell on the ground draws no faces at all, so framing for a cliff it
      // does not have leaves a third of the box empty under it — which matters
      // now that the hexagon is what a tile is painted on
      // (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`).
      maxY = Math.max(maxY, top + geometry.surfaceHeight * perPixel);
      continue;
    }
    maxY = Math.max(
      maxY,
      top +
        (shoulderLine(geometry) + geometry.elevationHeight) * perPixel +
        Math.max(0, steps - 1) * probeProjection.elevationStep,
    );
  }
  if (!Number.isFinite(minX)) {
    return {
      layout: new HexLayout(1),
      projection: Projection.from(mode, 1, tilt, elevationRatio),
      originX: 0,
      originY: 0,
      contentWidth: 0,
      contentHeight: 0,
    };
  }

  const usableWidth = Math.max(1, width - padding * 2);
  const usableHeight = Math.max(1, height - padding * 2);
  // No floor beyond "not zero": a hexagon too small to read is a legible
  // answer to a box too small to draw in, and a *minimum* size is not — it
  // makes the board overflow a short box, which the frame then clips. The
  // preview scales; it never crops
  // (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`).
  const fitted = Math.max(
    MIN_HEX_SIZE,
    Math.min(usableWidth / Math.max(1e-6, maxX - minX), usableHeight / Math.max(1e-6, maxY - minY)),
  );
  // An asked-for zoom is in authored pixels; the probe says what one hexagon of
  // size 1 measures, and the ratio is the size that makes the two agree.
  const size =
    zoom === null
      ? fitted
      : Math.max(MIN_HEX_SIZE, (geometry.width * zoom) / Math.max(1e-6, probe.hexWidth));

  return {
    layout: new HexLayout(size),
    projection: Projection.from(mode, size, tilt, elevationRatio),
    originX: width / 2 - ((minX + maxX) / 2) * size,
    originY: height / 2 - ((minY + maxY) / 2) * size,
    contentWidth: (maxX - minX) * size + padding * 2,
    contentHeight: (maxY - minY) * size + padding * 2,
  };
}

/**
 * Draws a board of tiles, back to front.
 *
 * Painter's order is the map renderer's: rows back to front, so a raised cell
 * in front covers the one behind it. A cell whose images are not loaded is
 * drawn as its hexagon filled with `fallbackColor`, exactly as the map does
 * while a texture loads.
 */
export function drawPreview(
  context: CanvasRenderingContext2D,
  cells: readonly PreviewCell[],
  geometry: TileArtGeometry,
  view: PreviewLayout,
  images: SpriteSource | null,
): void {
  context.save();
  context.translate(view.originX, view.originY);
  context.imageSmoothingEnabled = false;

  const ordered = [...cells].sort((left, right) =>
    left.at.row === right.at.row ? left.at.col - right.at.col : left.at.row - right.at.row,
  );
  for (const cell of ordered) {
    drawPreviewCell(context, cell, geometry, view, images);
  }
  context.restore();
}

/** Where one image of a cell lands on the canvas, in CSS pixels. */
export interface PreviewImageBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A point on the canvas, in the coordinates the boxes below are given in.
 *
 * `drawPreview` translates the context by the layout's origin and then draws
 * every cell in the hex plane's own coordinates, so a box and a click are in
 * two different frames. This is the one place that says so: a caller turning a
 * pointer into a pixel goes through here first
 * (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`).
 */
export function previewPointOf(point: Point, view: PreviewLayout): Point {
  return { x: point.x - view.originX, y: point.y - view.originY };
}

/**
 * Where a cell's image of `kind` is blitted, at `drop` steps down the stack.
 *
 * In the **hex plane's** coordinates, which is the frame `drawPreviewCell`
 * draws in — put a pointer through {@link previewPointOf} before comparing.
 *
 * The editor's other half of `drawPreviewCell`: a click on the hexagon has to
 * come back as a pixel of the image under it, and the only way the two cannot
 * drift is for both to read this
 * (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`,
 * `docs/adr/ADR-0030-the-editor-paints-its-sprites.md` for the character
 * precedent).
 */
export function previewImageBox(
  cell: PreviewCell,
  geometry: TileArtGeometry,
  view: PreviewLayout,
  kind: ImageKind,
  drop = 0,
): PreviewImageBox {
  const { layout, projection } = view;
  const centre = projection.project(layout.centerOf(cell.at), cell.elevation);
  const width = layout.hexWidth;
  const left = centre.x - width / 2;
  const top = centre.y - (layout.hexHeight * projection.tilt) / 2;
  const perPixel = width / Math.max(1, geometry.width);

  if (kind === 'flat') {
    const height = geometry.flatHeight * perPixel;
    return { x: left, y: centre.y - height / 2, width, height };
  }
  if (kind === 'surface') {
    return { x: left, y: top, width, height: geometry.surfaceHeight * perPixel };
  }
  const shoulder = top + shoulderLine(geometry) * perPixel;
  return {
    x: left,
    y: shoulder + drop * projection.elevationStep,
    width,
    height: geometry.elevationHeight * perPixel,
  };
}

function drawPreviewCell(
  context: CanvasRenderingContext2D,
  cell: PreviewCell,
  geometry: TileArtGeometry,
  view: PreviewLayout,
  images: SpriteSource | null,
): void {
  const { projection } = view;

  // The preview stands on the ground, so its faces reach all the way down —
  // there is no neighbour to hide them behind.
  const render = resolveTileRender(
    cell.tileId,
    cell.art,
    projection.mode,
    cell.elevation,
    0,
    variantRoll(cell.at.col, cell.at.row, cell.tileId),
    cell.choice ?? {},
  );

  // A flat cell is one image over the whole hexagon, or the colour when the
  // tile authors none for this projection — the map renderer's rule exactly
  // (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`).
  if (projection.mode !== 'isometric') {
    const image = render.flat === null ? null : (images?.image(render.flat) ?? null);
    if (image === null) {
      fillSilhouette(context, cell, view, cell.fallbackColor);
      return;
    }
    const box = previewImageBox(cell, geometry, view, 'flat');
    context.drawImage(image, box.x, box.y, box.width, box.height);
    return;
  }

  // Colour behind whatever art exists, on the same rule the map renderer uses:
  // a tile with a top face and no cliff art still has to read as standing above
  // the ground rather than hovering over a hole.
  const bare = render.layers.length < Math.max(0, cell.elevation);
  if (bare) {
    fillSilhouette(context, cell, view, cell.fallbackColor);
  }

  let drewSomething = bare;
  for (const layer of render.layers) {
    const image = images?.image(layer.asset) ?? null;
    if (image === null) {
      continue;
    }
    const box = previewImageBox(cell, geometry, view, 'elevation', layer.drop);
    context.drawImage(image, box.x, box.y, box.width, box.height);
    drewSomething = true;
  }
  if (render.surface !== null) {
    const image = images?.image(render.surface) ?? null;
    if (image !== null) {
      const box = previewImageBox(cell, geometry, view, 'surface');
      context.drawImage(image, box.x, box.y, box.width, box.height);
      drewSomething = true;
    }
  }

  if (!drewSomething) {
    fillSilhouette(context, cell, view, cell.fallbackColor);
  }
}

/** The hexagon and, when the cell is raised, its extruded faces. */
function fillSilhouette(
  context: CanvasRenderingContext2D,
  cell: PreviewCell,
  view: PreviewLayout,
  fill: string,
): void {
  const corners = cornersOf(cell, view);
  const lift = view.projection.liftOf(Math.max(0, cell.elevation));

  if (lift > 0) {
    const front = [corners[1], corners[2], corners[3]].filter(
      (corner): corner is Point => corner !== undefined,
    );
    context.fillStyle = fill;
    trace(context, [
      ...front,
      ...front.map((corner) => ({ x: corner.x, y: corner.y + lift })).reverse(),
    ]);
    context.fill();
    context.fillStyle = 'rgba(6, 8, 12, 0.42)';
    context.fill();
  }

  context.fillStyle = fill;
  trace(context, corners);
  context.fill();
}

function cornersOf(cell: PreviewCell, view: PreviewLayout): Point[] {
  return view.layout
    .corners(view.layout.centerOf(cell.at))
    .map((corner) => view.projection.project(corner, cell.elevation));
}

function trace(context: CanvasRenderingContext2D, points: readonly Point[]): void {
  const first = points[0];
  if (first === undefined) {
    return;
  }
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (const point of points.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.closePath();
}

/**
 * The hexagon the tile occupies, in the authored image's own pixel space.
 *
 * This is what the pixel editor draws over the canvas so the artist can see
 * where the visible shape is. It is the **same** hexagon the renderer draws,
 * scaled from the projected top face into image pixels — not a shape redrawn by
 * eye, which is how a guide and a renderer come to disagree
 * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
 *
 * The corners come out in the order `HexLayout.corners` produces: `1`, `2` and
 * `3` are the near ones, which is what makes the face boundaries below the
 * same three points the renderer extrudes.
 */
export function surfaceHexagon(geometry: TileArtGeometry): Point[] {
  const layout = new HexLayout(geometry.width / Math.sqrt(3));
  const { tilt, elevationRatio } = projectionRatiosOf(geometry);
  const projection = Projection.from('isometric', layout.size, tilt, elevationRatio);
  const centre = { x: geometry.width / 2, y: geometry.surfaceHeight / 2 };

  return layout.corners({ x: 0, y: 0 }).map((corner) => {
    const projected = projection.project(corner);
    return { x: centre.x + projected.x, y: centre.y + projected.y };
  });
}

/**
 * The untilted hexagon, in a flat image's own pixel space.
 *
 * The same shape a top-down map strokes for its grid, so an artist drawing a
 * flat tile is drawing inside the outline the renderer will use
 * (`docs/adr/ADR-0037-a-flat-map-is-drawn-from-flat-art.md`). Nothing squashes
 * it — that is the whole difference between this image and a surface.
 */
export function flatHexagon(geometry: TileArtGeometry): Point[] {
  const layout = new HexLayout(geometry.width / Math.sqrt(3));
  const centre = { x: geometry.width / 2, y: geometry.flatHeight / 2 };
  return layout
    .corners({ x: 0, y: 0 })
    .map((corner) => ({ x: centre.x + corner.x, y: centre.y + corner.y }));
}

/** Which image, or which face of one, a guide marks. */
export type FaceGuide = 'flat' | 'surface' | 'southWest' | 'southEast';

/** The kinds of tile image the editor draws guides for. */
export type ImageKind = 'flat' | 'surface' | 'elevation';

/**
 * Guide lines for an image of `kind`, in the image's own pixel space.
 *
 * A guide is an **aid, never a cut**: nothing here slices the image, and
 * nothing the artist draws is confined to the region a label names. The point
 * is only that the artist can see which pixels end up on which face.
 *
 * Note what the geometry actually exposes. This engine draws **pointy-top**
 * hexagons (`docs/adr/ADR-0014-hex-coordinate-model.md`), whose silhouette has
 * two lower edges meeting at a south vertex — so a raised tile shows a
 * south-west face and a south-east face, and the "south" of a flat-top hex
 * does not exist here. Both are drawn by hand in the one image, and neither is
 * ever produced from the other.
 *
 * A **flat** image is the untilted hexagon, a **surface** image the tilted one.
 * An **elevation** image is the two faces alone: its first row is the lower
 * shoulder line, so the guides it gets are the `V` those edges cut and the
 * faces hanging off it, with nothing above.
 */
export function faceGuides(
  geometry: TileArtGeometry,
  kind: ImageKind,
): { readonly path: readonly Point[]; readonly label: FaceGuide }[] {
  if (kind === 'flat') {
    return [{ path: flatHexagon(geometry), label: 'flat' }];
  }
  const hexagon = surfaceHexagon(geometry);
  if (kind === 'surface') {
    return [{ path: hexagon, label: 'surface' }];
  }

  // An elevation image's own y = 0 is the hexagon's lower shoulder line, so the
  // whole outline is shifted up by everything above that.
  const lift = shoulderLine(geometry);
  const drop = faceHeight(geometry);
  const right = hexagon[1];
  const south = hexagon[2];
  const west = hexagon[3];
  if (right === undefined || south === undefined || west === undefined) {
    return [];
  }
  const shift = (point: Point): Point => ({ x: point.x, y: point.y - lift });

  return [
    {
      path: [
        shift(west),
        shift(south),
        { x: south.x, y: south.y - lift + drop },
        { x: west.x, y: west.y - lift + drop },
      ],
      label: 'southWest',
    },
    {
      path: [
        shift(south),
        shift(right),
        { x: right.x, y: right.y - lift + drop },
        { x: south.x, y: south.y - lift + drop },
      ],
      label: 'southEast',
    },
  ];
}

/** The transparency checker, painted one square per authored pixel. */
export function drawChecker(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  zoom: number,
): void {
  // Two authored pixels per square when one would be too small to read, the
  // same rule the character stage uses (ADR-0030).
  const square = zoom >= 4 ? 1 : 2;
  for (let y = 0; y < height; y += square) {
    for (let x = 0; x < width; x += square) {
      const even = (Math.floor(x / square) + Math.floor(y / square)) % 2 === 0;
      context.fillStyle = even ? CHROME.checkerDark : CHROME.checkerLight;
      context.fillRect(
        x * zoom,
        y * zoom,
        Math.min(square, width - x) * zoom,
        Math.min(square, height - y) * zoom,
      );
    }
  }
}

/** Strokes the guides over a pixel-editor stage drawn at `zoom`. */
export function drawGuides(
  context: CanvasRenderingContext2D,
  geometry: TileArtGeometry,
  kind: ImageKind,
  zoom: number,
  labels: Readonly<Record<FaceGuide, string>>,
): void {
  context.save();
  context.lineWidth = 1;
  context.font = '10px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  for (const guide of faceGuides(geometry, kind)) {
    const whole = guide.label === 'surface' || guide.label === 'flat';
    context.strokeStyle = whole ? CHROME.guide : CHROME.guideFaint;
    trace(
      context,
      guide.path.map((point) => ({ x: point.x * zoom, y: point.y * zoom })),
    );
    context.stroke();

    // The outline of a whole hexagon needs no caption; a face does.
    if (whole) {
      continue;
    }
    const centre = guide.path.reduce(
      (total, point) => ({ x: total.x + point.x, y: total.y + point.y }),
      { x: 0, y: 0 },
    );
    context.fillStyle = CHROME.label;
    context.fillText(
      labels[guide.label],
      (centre.x / guide.path.length) * zoom,
      (centre.y / guide.path.length) * zoom,
    );
  }
  context.restore();
}

/** Colour used to outline an image that could not be loaded. */
export const MISSING_TILE_COLOR = CHROME.missing;

/** Colour used for the preview's hex outline. */
export const PREVIEW_OUTLINE_COLOR = CHROME.outline;
