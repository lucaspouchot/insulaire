/**
 * Canvas plumbing: sizing, device pixel ratio, the frame loop and pointer input.
 *
 * Also framework-free. An Angular component creates one of these over its
 * `<canvas>`, subscribes to the callbacks, and never touches the DOM geometry
 * itself.
 *
 * Input is translated into *hex* terms before it leaves this class: consumers
 * receive offset coordinates, never pixels.
 */

import { Offset, sameOffset } from '../core/hex/hex-coords';
import { Point } from '../core/hex/hex-layout';
import { HexMapRenderer } from './hex-map-renderer';

/** How far the pointer may travel during a press and still count as a click. */
const CLICK_SLOP_PX = 4;

/** How often {@link CanvasViewHandlers.onFrameDrawn} may fire, in milliseconds. */
const STATS_SAMPLE_MS = 250;

export interface CanvasViewHandlers {
  /** The hex under the cursor changed (or the cursor left the map). */
  onHover?(cell: Offset | null): void;
  /**
   * A hex was clicked without dragging — on release, never on press.
   *
   * A press that turns into a stroke reports through {@link onDragPaint} only,
   * so a consumer that implements both never sees the same press twice.
   */
  onClick?(cell: Offset, event: PointerEvent): void;
  /**
   * The pointer was dragged across a hex with the primary button held.
   *
   * The cell the press started on is reported here too, but only once the press
   * has become a stroke — a press and release on a single hex is a click.
   */
  onDragPaint?(cell: Offset): void;
  /** The viewport was resized, in CSS pixels. */
  onResize?(width: number, height: number): void;
  /**
   * A frame was drawn, so the renderer's statistics are fresh.
   *
   * Throttled to {@link STATS_SAMPLE_MS} rather than fired per frame: a host
   * turns this into a signal write, and a change-detection pass inside the
   * frame loop would be measuring itself. It exists for a debug readout, which
   * is unreadable faster than this anyway.
   */
  onFrameDrawn?(): void;
}

export class CanvasView {
  private readonly observer: ResizeObserver;
  private readonly disposers: Array<() => void> = [];
  private frameHandle = 0;
  private needsRedraw = true;
  private disposed = false;
  /** When {@link CanvasViewHandlers.onFrameDrawn} last fired. */
  private statsSampledAt = 0;

  private viewportWidth = 0;
  private viewportHeight = 0;

  private pointerDownAt: Point | null = null;
  private pointerDownCell: Offset | null = null;
  private panning = false;
  private painting = false;
  /** Set once a press has left the hex it started on, making it a stroke. */
  private stroking = false;
  private lastPaintedCell: Offset | null = null;
  private hovered: Offset | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: HexMapRenderer,
    private readonly handlers: CanvasViewHandlers = {},
  ) {
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);

    this.listen('pointerdown', this.handlePointerDown);
    this.listen('pointermove', this.handlePointerMove);
    this.listen('pointerup', this.handlePointerUp);
    this.listen('pointercancel', this.handlePointerUp);
    this.listen('pointerleave', this.handlePointerLeave);
    this.listen('wheel', this.handleWheel, { passive: false });
    this.listen('contextmenu', this.handleContextMenu);

    this.resize();
    this.loop();
  }

  /** Requests a redraw on the next animation frame. */
  invalidate(): void {
    this.needsRedraw = true;
  }

  /**
   * Forgets the hovered hex, as if the pointer had left the canvas.
   *
   * The host calls this when what the cursor is over stops meaning anything —
   * another map opened, a door crossed. It has to come through here rather than
   * the host clearing its own state: the pointer has not moved, so nothing else
   * would clear the outline the renderer is still drawing, and this class would
   * go on believing the cursor is over a hex it has already reported.
   */
  clearHover(): void {
    if (this.hovered !== null) {
      this.setHover(null);
    }
  }

  /** Current viewport size in CSS pixels. */
  get viewport(): { width: number; height: number } {
    return { width: this.viewportWidth, height: this.viewportHeight };
  }

  /** Frames the whole map. */
  fit(): void {
    this.renderer.fitToViewport(this.viewportWidth, this.viewportHeight);
    this.invalidate();
  }

  /** Zooms by a factor about the viewport centre. */
  zoomByStep(factor: number): void {
    this.renderer.camera.zoomBy(factor, { x: this.viewportWidth / 2, y: this.viewportHeight / 2 });
    this.invalidate();
  }

  /** Stops the frame loop and detaches every listener. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.observer.disconnect();
    for (const dispose of this.disposers) {
      dispose();
    }
  }

  private listen<K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    const bound = handler.bind(this) as EventListener;
    this.canvas.addEventListener(type, bound, options);
    this.disposers.push(() => this.canvas.removeEventListener(type, bound, options));
  }

  /**
   * Resizes the backing store to the device pixel ratio.
   *
   * The canvas is sized in device pixels but the renderer draws in CSS pixels;
   * the DPR scale below bridges the two so lines stay crisp on retina screens.
   *
   * The camera is re-anchored on the viewport centre rather than left alone: a
   * dock opening beside the canvas takes its width off one side only, and a
   * pan-free resize would slide the world sideways under the cursor. Whatever
   * was in the middle stays in the middle.
   */
  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const ratio = Math.min(window.devicePixelRatio || 1, 3);

    this.canvas.width = Math.floor(width * ratio);
    this.canvas.height = Math.floor(height * ratio);

    if (this.viewportWidth > 0 && this.viewportHeight > 0) {
      this.renderer.camera.panBy(
        (width - this.viewportWidth) / 2,
        (height - this.viewportHeight) / 2,
      );
    }

    this.viewportWidth = width;
    this.viewportHeight = height;
    this.handlers.onResize?.(width, height);
    this.invalidate();
  }

  private loop = (): void => {
    if (this.disposed) {
      return;
    }
    if (this.needsRedraw) {
      this.needsRedraw = false;
      const context = this.canvas.getContext('2d');
      if (context !== null) {
        const ratio = this.canvas.width / Math.max(1, this.viewportWidth);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        this.renderer.draw(this.viewportWidth, this.viewportHeight);
        this.sampleStats();
      }
    }
    this.frameHandle = requestAnimationFrame(this.loop);
  };

  /** Announces fresh statistics, at most every {@link STATS_SAMPLE_MS}. */
  private sampleStats(): void {
    if (this.handlers.onFrameDrawn === undefined) {
      return;
    }
    const now = performance.now();
    if (now - this.statsSampledAt < STATS_SAMPLE_MS) {
      return;
    }
    this.statsSampledAt = now;
    this.handlers.onFrameDrawn();
  }

  private pointAt(event: PointerEvent | WheelEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /**
   * Arms a press without acting on it.
   *
   * Nothing is reported here on purpose: a press whose tool is not idempotent —
   * raise, lower — would otherwise be applied twice, once now and once as the
   * click on release. The press only becomes a stroke when the pointer leaves
   * the hex it started on, and until then the release decides.
   */
  private handlePointerDown(event: PointerEvent): void {
    this.canvas.setPointerCapture(event.pointerId);
    this.pointerDownAt = this.pointAt(event);

    // Middle button, right button or space-less secondary drag pans; the primary
    // button paints or selects.
    this.panning = event.button === 1 || event.button === 2;
    this.painting = event.button === 0 && this.handlers.onDragPaint !== undefined;
    this.stroking = false;
    this.pointerDownCell = this.renderer.cellAtScreen(this.pointerDownAt);
    this.lastPaintedCell = this.pointerDownCell;
  }

  private handlePointerMove(event: PointerEvent): void {
    const point = this.pointAt(event);

    if (this.panning && this.pointerDownAt !== null) {
      this.renderer.camera.panBy(event.movementX, event.movementY);
      this.invalidate();
      return;
    }

    // Off the map on both sides counts as unchanged: a pointer wandering the
    // margin around a map reports nothing and redraws nothing.
    const cell = this.renderer.cellAtScreen(point);
    const unchanged = cell === null ? this.hovered === null : sameOffset(cell, this.hovered);
    if (!unchanged) {
      this.setHover(cell);
    }

    if (this.painting && cell !== null && !sameOffset(cell, this.lastPaintedCell)) {
      // Leaving the first hex is what turns a press into a stroke; that hex is
      // reported now, since the release will no longer count as a click.
      if (!this.stroking) {
        this.stroking = true;
        if (this.pointerDownCell !== null) {
          this.handlers.onDragPaint?.(this.pointerDownCell);
        }
      }
      this.lastPaintedCell = cell;
      this.handlers.onDragPaint?.(cell);
    }
  }

  private handlePointerUp(event: PointerEvent): void {
    const start = this.pointerDownAt;
    const from = this.pointerDownCell;
    const wasStroking = this.stroking;
    this.pointerDownAt = null;
    this.pointerDownCell = null;

    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }

    const wasPanning = this.panning;
    this.panning = false;
    this.painting = false;
    this.stroking = false;
    this.lastPaintedCell = null;

    // A stroke has already reported every hex it crossed, including the first.
    if (wasPanning || wasStroking || start === null || event.button !== 0) {
      return;
    }

    const end = this.pointAt(event);
    const cell = this.renderer.cellAtScreen(end);
    if (cell === null) {
      return;
    }

    // Releasing on the hex the press started on is a click however far the
    // pointer wandered inside it — hex identity is the real threshold, and a
    // hexagon is far wider than the pixel slop. The slop still decides presses
    // that started off the map, where there is no hex to compare against.
    const travelled = Math.hypot(end.x - start.x, end.y - start.y);
    if (travelled > CLICK_SLOP_PX && !sameOffset(cell, from)) {
      return; // a drag, not a click
    }

    this.handlers.onClick?.(cell, event);
  }

  private handlePointerLeave(): void {
    this.clearHover();
  }

  /**
   * Moves the outline, then tells the host.
   *
   * The renderer is set *here* rather than by the host: the outline is chrome
   * over the map, not part of what the map is, so a hover costs this class one
   * assignment and one frame. What the host does with the news — a coordinate
   * readout, a tooltip — is its own business and must not be on the path
   * between the hand and the highlight.
   */
  private setHover(cell: Offset | null): void {
    this.hovered = cell;
    this.renderer.setHover(cell);
    this.invalidate();
    this.handlers.onHover?.(cell);
  }

  private handleWheel(event: WheelEvent): void {
    event.preventDefault();
    // A fixed ratio per notch keeps zooming symmetric: in then out returns you
    // exactly where you started.
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.renderer.camera.zoomBy(factor, this.pointAt(event));
    this.invalidate();
  }

  private handleContextMenu(event: MouseEvent): void {
    // The right button pans, so suppress the browser menu over the map.
    event.preventDefault();
  }
}
