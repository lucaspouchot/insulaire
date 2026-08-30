/**
 * The one policy this application has about drawing on a canvas.
 *
 * Three things every canvas here has to get right, written once:
 *
 * * **density** — how many device pixels one CSS pixel is worth, capped;
 * * **fit** — the largest whole zoom a drawing fits its frame at;
 * * **zoom** — the ladder a zoom button steps through.
 *
 * They were written six times, and had already drifted: three preview panes
 * rendered at three different effective resolutions on the same high-DPI
 * screen, two of them uncapped. A cap is not a detail — an uncapped ratio on a
 * 3x screen asks a tab for nine times the memory, and above four screen pixels
 * per authored pixel it buys nothing at all, because the block is already a
 * block.
 *
 * Framework-free and DOM-free: it takes a `CanvasRenderingContext2D` in its
 * constructor rather than being a component, which is the same bargain
 * `HexMapRenderer` makes and the reason both can be read back by a test
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`). In `renderer/`
 * because a running game draws on a canvas as much as the editor does
 * (`docs/adr/ADR-0015-client-delivery-build.md`).
 */

/**
 * The most device pixels this application will draw one CSS pixel as.
 *
 * Three, not the device's own: past this the picture is indistinguishable and
 * the backing store is not.
 */
export const MAX_DENSITY = 3;

/**
 * The zoom at which a device ratio stops being worth its memory.
 *
 * One authored pixel is already a block four screen pixels wide, and no ratio
 * makes a square of flat colour crisper.
 */
const FLAT_ZOOM = 4;

/**
 * The zooms a pixel surface steps through, in screen pixels per authored pixel.
 *
 * Whole numbers, for the reason every zoom in this project is one: a pixel is
 * a square block of screen pixels or it is a smear
 * (`docs/adr/ADR-0024-character-definitions.md`).
 */
export const PIXEL_ZOOMS: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

/** A rectangle in CSS pixels — a frame to draw in, or a drawing to place. */
export interface Box {
  readonly width: number;
  readonly height: number;
}

/** What a surface may know about itself beyond the box it is drawn in. */
export interface SurfaceOptions {
  /**
   * Device pixels per CSS pixel, when the caller knows better than the window.
   *
   * Defaults to `devicePixelRatio`. A test states it rather than moving a
   * global, which is what keeps this module readable without a browser.
   */
  readonly devicePixelRatio?: number;
  /**
   * Screen pixels per authored pixel already being applied, if any.
   *
   * A stage showing a 32-pixel icon at 8x passes 8. Above {@link FLAT_ZOOM} the
   * device ratio is dropped.
   */
  readonly zoom?: number;
  /**
   * Whatever else is scaling the page, measured rather than assumed.
   *
   * The editor shell is zoomed by the interface scale (`app/app.css`), so a
   * layout pixel is not a screen pixel; the backing store follows the screen or
   * a scaled interface resamples the sprites this pipeline exists not to
   * resample.
   */
  readonly scale?: number;
  /** Longest backing-store side this surface will ask a tab for, in device pixels. */
  readonly maxSide?: number;
}

/** How many device pixels one CSS pixel is worth on a surface of this size. */
export function surfaceDensity(box: Box, options: SurfaceOptions = {}): number {
  const reported = options.devicePixelRatio ?? globalThis.devicePixelRatio;
  const device = Number.isFinite(reported) && reported > 0 ? reported : 1;
  const capped = (options.zoom ?? 1) >= FLAT_ZOOM ? 1 : Math.min(device, MAX_DENSITY);
  const wanted = capped * (options.scale ?? 1);

  const maxSide = options.maxSide;
  if (maxSide === undefined) {
    return wanted;
  }
  // A backing store a tab refuses to allocate draws nothing at all, so the
  // ratio gives way rather than the picture.
  return Math.min(wanted, maxSide / Math.max(1, box.width, box.height));
}

/**
 * Sizes a context's backing store for a CSS box, then leaves it drawing in CSS
 * pixels on a cleared surface.
 *
 * The element's own CSS size is set with it, because the two are one decision:
 * a backing store that does not match what CSS says the element is, is the
 * blurry canvas this module exists to stop.
 *
 * @returns the density used — what a hit test has to divide by
 */
export function prepareSurface(
  context: CanvasRenderingContext2D,
  box: Box,
  options: SurfaceOptions = {},
): number {
  const width = Math.max(1, Math.floor(box.width));
  const height = Math.max(1, Math.floor(box.height));
  const density = surfaceDensity({ width, height }, options);

  const canvas = context.canvas;
  canvas.width = Math.floor(width * density);
  canvas.height = Math.floor(height * density);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  context.setTransform(density, 0, 0, density, 0, 0);
  context.clearRect(0, 0, width, height);
  return density;
}

/**
 * The largest whole zoom `content` fits inside `box` at, never below 1.
 *
 * `padding` is room left on **each** side. Below 1 the answer would be a
 * fraction of a screen pixel per authored pixel, which is a smear; content too
 * big for its frame is clipped instead, and the frame scrolls or the author
 * zooms out.
 */
export function fitZoom(content: Box, box: Box, padding = 0): number {
  return Math.max(
    1,
    Math.floor(
      Math.min(
        (box.width - 2 * padding) / Math.max(1, content.width),
        (box.height - 2 * padding) / Math.max(1, content.height),
      ),
    ),
  );
}

/**
 * The next zoom up or down the ladder.
 *
 * Shared, because the file bar steps the zoom of whichever surface is open and
 * they all step through the same numbers
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 */
export function zoomBy(from: number, steps: number): number {
  const first = PIXEL_ZOOMS[0] ?? 1;
  const last = PIXEL_ZOOMS[PIXEL_ZOOMS.length - 1] ?? 1;
  const exact = PIXEL_ZOOMS.indexOf(from);
  if (exact >= 0) {
    return PIXEL_ZOOMS[Math.max(0, Math.min(PIXEL_ZOOMS.length - 1, exact + steps))] ?? from;
  }
  // Off the ladder — a *fitted* zoom is whatever the panel worked out — so the
  // first step in the direction asked, rather than index arithmetic that would
  // skip one on the way up.
  return steps > 0
    ? (PIXEL_ZOOMS.find((step) => step > from) ?? last)
    : ([...PIXEL_ZOOMS].reverse().find((step) => step < from) ?? first);
}
