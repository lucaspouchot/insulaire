/**
 * The pixel editor: one image, edited a pixel at a time.
 *
 * A retouching tool grown up. `sprite-document.ts` already held the buffer, the
 * stroke, the undo history and the palette for the character stage
 * (`docs/adr/ADR-0030-the-editor-paints-its-sprites.md`); this is the same core
 * given the tools a **tile** needs — a fill, a rectangular selection you can
 * move, and an alpha, because a tile is blitted as it stands rather than tinted
 * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
 *
 * It is still not a drawing application. No sub-layers, no brush size, no
 * filters, no animation. When a job needs those the answer is a real pixel
 * editor and the import button next to this one.
 *
 * It is a **component**, not a page: the asset editor embeds it, and the next
 * kind of asset will embed the same one. Nothing in it knows what a tile is
 * beyond the guides it is handed.
 *
 * # Pixel-perfect
 *
 * Whole-number zoom, smoothing off, and a pointer measured against the
 * element rather than the layout — the interface scale zooms the whole shell,
 * so the box a pointer arrives in has been multiplied while the box the canvas
 * drew in has not. Dividing one by the other is what keeps a click landing on
 * the pixel it points at, at any interface scale (ADR-0030).
 */

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { TileArtGeometry } from '../../../../content/content-types';
import { PALETTE_SIZE, PixelSelection, SpriteDocument } from '../../../../content/sprite-document';
import { drawChecker, drawGuides } from '../../../../renderer/tile-preview';
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';

/** The tools, in the order the toolbar shows them. */
export type PixelTool = 'pencil' | 'eraser' | 'fill' | 'picker' | 'select';

/** The tools, for the template to iterate. */
export const PIXEL_TOOLS: readonly PixelTool[] = ['pencil', 'eraser', 'fill', 'picker', 'select'];

/**
 * The zooms the editor steps through, in screen pixels per authored pixel.
 *
 * Whole numbers, for the reason every zoom in this project is one: a pixel is
 * a square block of screen pixels or it is a smear
 * (`docs/adr/ADR-0029-characters-are-composed-sprites.md`).
 */
const ZOOM_STEPS: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

/** Below this zoom a pixel grid is more noise than help. */
const GRID_ZOOM = 6;

/** Largest backing store the stage will ask a tab for, on either side. */
const MAX_STAGE = 2048;

@Component({
  selector: 'app-tile-pixel-editor',
  imports: [TranslatePipe],
  templateUrl: './tile-pixel-editor.html',
  styleUrl: './tile-pixel-editor.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TilePixelEditor implements AfterViewInit, OnDestroy {
  /** The image being edited, or `null` when nothing is open. */
  readonly sprite = input<SpriteDocument | null>(null);
  /** The pixel grid the image belongs to, for the guides. */
  readonly geometry = input.required<TileArtGeometry>();
  /** Which guides to draw: a surface image has no faces below it. */
  readonly kind = input<'surface' | 'elevation'>('surface');
  /** A label for the image, shown in the toolbar. */
  readonly label = input('');
  /** Colours offered beside the ones this image already uses. */
  readonly sharedPalette = input<readonly string[]>([]);

  /** Emitted whenever a stroke changes a pixel, so the host can redraw. */
  readonly edited = output<void>();
  /** Emitted when the eyedropper takes a colour, so the host can share it. */
  readonly pickedColor = output<string>();

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('stage');

  protected readonly tool = signal<PixelTool>('pencil');
  protected readonly color = signal('#8ec07c');
  /** Opacity of the pencil, `0..255`. */
  protected readonly alpha = signal(255);
  protected readonly zoomIndex = signal(4);
  protected readonly showGrid = signal(true);
  protected readonly showGuides = signal(true);
  /** Bumped by every edit, so the palette and the buttons re-read the buffer. */
  protected readonly revision = signal(0);
  /** The rectangle the select tool is holding, in image pixels. */
  protected readonly selection = signal<PixelSelection | null>(null);

  /** Where the pointer was when it last painted, in image pixels. */
  private last: { x: number; y: number } | null = null;
  /** Where a drag started: the selection anchor, or the move origin. */
  private anchor: { x: number; y: number } | null = null;
  private dragging: 'paint' | 'select' | 'move' | null = null;
  private frame = 0;

  private readonly onKey = (event: KeyboardEvent): void => this.handleKey(event);

  constructor(private readonly i18n: I18nService) {
    effect(() => {
      // Re-read every input the stage draws from, then repaint.
      this.sprite();
      this.geometry();
      this.kind();
      this.zoom();
      this.showGrid();
      this.showGuides();
      this.selection();
      this.revision();
      this.schedule();
    });
  }

  ngAfterViewInit(): void {
    window.addEventListener('keydown', this.onKey);
    this.schedule();
  }

  ngOnDestroy(): void {
    window.removeEventListener('keydown', this.onKey);
    cancelAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------------- state

  protected readonly zoom = computed(() => ZOOM_STEPS[this.zoomIndex()] ?? 4);

  protected readonly canUndo = computed(() => {
    this.revision();
    return this.sprite()?.canUndo ?? false;
  });

  protected readonly canRedo = computed(() => {
    this.revision();
    return this.sprite()?.canRedo ?? false;
  });

  protected readonly unsaved = computed(() => {
    this.revision();
    return this.sprite()?.unsaved ?? false;
  });

  protected readonly size = computed(() => {
    const sprite = this.sprite();
    return sprite === null ? null : { width: sprite.width, height: sprite.height };
  });

  /**
   * The colours on offer: this image's own first, then the ones shared with it.
   *
   * A palette made of the drawing rather than a fixed ramp, for the reason
   * ADR-0030 gave: the tones that matter are the ones already there, and a tile
   * set that shares them is a tile set whose tiles sit next to each other
   * without clashing.
   */
  protected readonly palette = computed<readonly string[]>(() => {
    this.revision();
    const seen = new Set<string>();
    const colors: string[] = [];
    for (const color of [...(this.sprite()?.palette(PALETTE_SIZE) ?? []), ...this.sharedPalette()]) {
      if (!seen.has(color)) {
        seen.add(color);
        colors.push(color);
      }
      if (colors.length >= PALETTE_SIZE) {
        break;
      }
    }
    return colors;
  });

  protected readonly tools = PIXEL_TOOLS;
  protected readonly gridZoom = GRID_ZOOM;

  // ----------------------------------------------------------------- actions

  protected setTool(tool: PixelTool): void {
    this.tool.set(tool);
    if (tool !== 'select') {
      this.selection.set(null);
    }
  }

  protected setColor(color: string): void {
    this.color.set(color);
  }

  protected onColorInput(event: Event): void {
    this.color.set((event.target as HTMLInputElement).value);
  }

  protected onAlphaInput(event: Event): void {
    this.alpha.set(Number((event.target as HTMLInputElement).value));
  }

  protected stepZoom(by: number): void {
    this.zoomIndex.update((index) => Math.max(0, Math.min(ZOOM_STEPS.length - 1, index + by)));
  }

  protected toggleGrid(): void {
    this.showGrid.update((on) => !on);
  }

  protected toggleGuides(): void {
    this.showGuides.update((on) => !on);
  }

  protected undo(): void {
    if (this.sprite()?.undo() === true) {
      this.after();
    }
  }

  protected redo(): void {
    if (this.sprite()?.redo() === true) {
      this.after();
    }
  }

  /** Clears the selection, or the whole image when nothing is selected. */
  protected clear(): void {
    const sprite = this.sprite();
    if (sprite === null) {
      return;
    }
    const box = this.selection() ?? { x: 0, y: 0, width: sprite.width, height: sprite.height };
    sprite.begin();
    for (let y = box.y; y < box.y + box.height; y += 1) {
      for (let x = box.x; x < box.x + box.width; x += 1) {
        sprite.plot(x, y, null);
      }
    }
    sprite.end();
    this.after();
  }

  /** Nudges the selection by whole pixels, which is what the arrow keys do. */
  protected nudge(dx: number, dy: number): void {
    const sprite = this.sprite();
    const box = this.selection();
    if (sprite === null || box === null) {
      return;
    }
    sprite.begin();
    const moved = sprite.moveSelection(box, dx, dy);
    sprite.end();
    if (moved) {
      this.selection.set({ ...box, x: box.x + dx, y: box.y + dy });
      this.after();
    }
  }

  // ---------------------------------------------------------------- pointers

  protected onPointerDown(event: PointerEvent): void {
    const sprite = this.sprite();
    const at = this.pixelUnder(event);
    if (sprite === null || at === null) {
      return;
    }
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);

    // Alt is the eyedropper wherever you are: reaching for the tool to take a
    // colour and reaching back is most of what makes painting slow (ADR-0030).
    if (this.tool() === 'picker' || event.altKey) {
      this.take(at.x, at.y);
      return;
    }

    if (this.tool() === 'select') {
      const box = this.selection();
      if (box !== null && inside(box, at)) {
        this.dragging = 'move';
        this.anchor = at;
        sprite.begin();
      } else {
        this.dragging = 'select';
        this.anchor = at;
        this.selection.set({ x: at.x, y: at.y, width: 1, height: 1 });
      }
      return;
    }

    if (this.tool() === 'fill') {
      sprite.begin();
      const changed = sprite.fill(at.x, at.y, this.color(), this.alpha());
      sprite.end();
      if (changed) {
        this.after();
      }
      return;
    }

    this.dragging = 'paint';
    sprite.begin();
    this.last = at;
    this.paintTo(at.x, at.y);
  }

  protected onPointerMove(event: PointerEvent): void {
    const at = this.pixelUnder(event);
    if (at === null || this.dragging === null) {
      return;
    }
    if (this.dragging === 'paint') {
      this.paintTo(at.x, at.y);
      return;
    }
    const anchor = this.anchor;
    if (anchor === null) {
      return;
    }
    if (this.dragging === 'select') {
      this.selection.set({
        x: Math.min(anchor.x, at.x),
        y: Math.min(anchor.y, at.y),
        width: Math.abs(at.x - anchor.x) + 1,
        height: Math.abs(at.y - anchor.y) + 1,
      });
      return;
    }
    // Moving: the delta is applied one step at a time so the drag reads live.
    const box = this.selection();
    if (box === null || (at.x === anchor.x && at.y === anchor.y)) {
      return;
    }
    if (this.sprite()?.moveSelection(box, at.x - anchor.x, at.y - anchor.y) === true) {
      this.selection.set({ ...box, x: box.x + (at.x - anchor.x), y: box.y + (at.y - anchor.y) });
      this.anchor = at;
      this.after();
    }
  }

  protected onPointerUp(): void {
    if (this.dragging === 'paint' || this.dragging === 'move') {
      this.sprite()?.end();
      this.after();
    }
    this.dragging = null;
    this.anchor = null;
    this.last = null;
  }

  /** Ctrl or Cmd with the wheel zooms; a plain wheel is left to the scroller. */
  protected onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    this.stepZoom(event.deltaY < 0 ? 1 : -1);
  }

  private paintTo(x: number, y: number): void {
    const sprite = this.sprite();
    if (sprite === null) {
      return;
    }
    const color = this.tool() === 'eraser' ? null : this.color();
    const from = this.last ?? { x, y };
    const changed = sprite.stroke(from.x, from.y, x, y, color, this.alpha());
    this.last = { x, y };
    if (changed) {
      this.after();
    }
  }

  private take(x: number, y: number): void {
    const color = this.sprite()?.colorAt(x, y) ?? null;
    if (color === null) {
      return;
    }
    this.color.set(color);
    this.pickedColor.emit(color);
    if (this.tool() === 'picker') {
      this.tool.set('pencil');
    }
  }

  private handleKey(event: KeyboardEvent): void {
    if (isTyping(event.target)) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
      return;
    }
    if (this.selection() === null) {
      return;
    }
    const nudges: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const nudge = nudges[event.key];
    if (nudge !== undefined) {
      event.preventDefault();
      this.nudge(nudge[0], nudge[1]);
    }
  }

  /** Records an edit: repaint, and tell the host its preview is stale. */
  private after(): void {
    this.revision.update((value) => value + 1);
    this.edited.emit();
  }

  // -------------------------------------------------------------------- view

  /**
   * The image pixel under a pointer.
   *
   * The canvas is drawn at the origin, so the whole of the transform is the
   * zoom — except for whatever scaled the page, which is why the element's
   * **rendered** box is divided by the box it was **drawn** in rather than
   * trusted directly (ADR-0030).
   */
  private pixelUnder(event: PointerEvent): { x: number; y: number } | null {
    const canvas = this.canvasRef()?.nativeElement;
    const sprite = this.sprite();
    if (canvas === undefined || sprite === null) {
      return null;
    }
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return null;
    }
    const drawnWidth = sprite.width * this.zoom();
    const drawnHeight = sprite.height * this.zoom();
    const x = Math.floor(
      (((event.clientX - bounds.left) * drawnWidth) / bounds.width) / this.zoom(),
    );
    const y = Math.floor(
      (((event.clientY - bounds.top) * drawnHeight) / bounds.height) / this.zoom(),
    );
    return sprite.holds(x, y) ? { x, y } : null;
  }

  private schedule(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.paint());
  }

  private paint(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const sprite = this.sprite();
    if (canvas === undefined) {
      return;
    }
    const zoom = this.zoom();
    const width = Math.min(MAX_STAGE, (sprite?.width ?? 1) * zoom);
    const height = Math.min(MAX_STAGE, (sprite?.height ?? 1) * zoom);
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext('2d');
    if (context === null || sprite === null) {
      return;
    }
    context.imageSmoothingEnabled = false;
    // The checker is painted in authored pixels so it zooms with the drawing,
    // rather than putting a second grid on the stage at another scale (ADR-0030).
    drawChecker(context, sprite.width, sprite.height, zoom);

    const surface = sprite.surface();
    if (surface !== null) {
      context.drawImage(surface, 0, 0, width, height);
    }

    if (this.showGrid() && zoom >= GRID_ZOOM) {
      context.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      context.lineWidth = 1;
      context.beginPath();
      for (let x = 1; x < sprite.width; x += 1) {
        context.moveTo(x * zoom + 0.5, 0);
        context.lineTo(x * zoom + 0.5, height);
      }
      for (let y = 1; y < sprite.height; y += 1) {
        context.moveTo(0, y * zoom + 0.5);
        context.lineTo(width, y * zoom + 0.5);
      }
      context.stroke();
    }

    if (this.showGuides()) {
      drawGuides(context, this.geometry(), this.kind(), zoom, {
        surface: this.i18n.t('ui.editor.asset.faces.surface'),
        southWest: this.i18n.t('ui.editor.asset.faces.southWest'),
        southEast: this.i18n.t('ui.editor.asset.faces.southEast'),
      });
    }

    const box = this.selection();
    if (box !== null) {
      context.save();
      context.strokeStyle = '#ffd166';
      context.setLineDash([4, 3]);
      context.lineWidth = 1;
      context.strokeRect(
        box.x * zoom + 0.5,
        box.y * zoom + 0.5,
        box.width * zoom - 1,
        box.height * zoom - 1,
      );
      context.restore();
    }
  }
}

function inside(box: PixelSelection, at: { x: number; y: number }): boolean {
  return (
    at.x >= box.x && at.y >= box.y && at.x < box.x + box.width && at.y < box.y + box.height
  );
}

function isTyping(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
