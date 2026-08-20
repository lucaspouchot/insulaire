/**
 * The pixel editor: one image, flat, edited a pixel at a time.
 *
 * A retouching tool. `sprite-document.ts` holds the buffer, the stroke, the
 * undo history and the palette (`docs/adr/ADR-0030-the-editor-paints-its-
 * sprites.md`); this puts a canvas, a zoom and the guides around them, with an
 * alpha for art that is blitted as it stands
 * (`docs/adr/ADR-0035-tile-art-is-authored-and-resolved-by-level.md`).
 *
 * It is deliberately not a drawing application: three tools, no sub-layers, no
 * brush size, no filters, no animation. When a job needs more the answer is a
 * real pixel editor and the import button next to this one.
 *
 * It is a **component**, not a page, and every asset category embeds the same
 * one: a tile's surface, a character's cape seen flat, and whatever objects and
 * decorations turn out to be
 * (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`). Nothing in it knows
 * what it is drawing beyond the guides it is handed — and it may be handed
 * none.
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
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { TileArtGeometry } from '../../../../content/content-types';
import { PALETTE_SIZE, SpriteDocument } from '../../../../content/sprite-document';
import { ImageKind, drawChecker, drawGuides } from '../../../../renderer/tile-preview';
import { I18nService } from '../../../i18n/i18n.service';
import { TranslatePipe } from '../../../i18n/translate.pipe';
import { PixelTool, PixelTools } from './pixel-tools';

/**
 * The zooms the editor steps through, in screen pixels per authored pixel.
 *
 * Whole numbers, for the reason every zoom in this project is one: a pixel is
 * a square block of screen pixels or it is a smear
 * (`docs/adr/ADR-0029-characters-are-composed-sprites.md`).
 */
export const PIXEL_ZOOMS: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

/** Below this zoom a pixel grid is more noise than help. */
const GRID_ZOOM = 6;

/** Largest backing store the stage will ask a tab for, on either side. */
const MAX_STAGE = 2048;

@Component({
  selector: 'app-pixel-editor',
  imports: [TranslatePipe, PixelTools],
  templateUrl: './pixel-editor.html',
  styleUrl: './pixel-editor.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PixelEditor implements AfterViewInit, OnDestroy {
  /** The image being edited, or `null` when nothing is open. */
  readonly sprite = input<SpriteDocument | null>(null);
  /**
   * The pixel grid the image belongs to, for the guides — `null` when it has
   * none.
   *
   * A tile is drawn onto a hexagon and wants the shoulders and the fold marked;
   * a character's cape is drawn onto nothing at all. The component asks for
   * guides rather than knowing what it is drawing
   * (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`).
   */
  readonly geometry = input<TileArtGeometry | null>(null);
  /** Which guides to draw: only an elevation image has faces below it. */
  readonly kind = input<ImageKind>('surface');
  /** A label for the image, shown in the toolbar. */
  readonly label = input('');
  /** Colours offered beside the ones this image already uses. */
  readonly sharedPalette = input<readonly string[]>([]);

  /**
   * Screen pixels per authored pixel, owned by the host.
   *
   * A `model` rather than internal state because the zoom lives in the file
   * bar now, above every surface: an author should not have to find a
   * different set of buttons depending on which one is open
   * (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`).
   */
  readonly zoom = model(6);

  /** Whether the pixel grid is drawn over the image. Also the host's. */
  readonly showGrid = model(true);

  /** Emitted whenever a stroke changes a pixel, so the host can redraw. */
  readonly edited = output<void>();
  /** Emitted when the eyedropper takes a colour, so the host can share it. */
  readonly pickedColor = output<string>();

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('stage');

  protected readonly tool = signal<PixelTool>('pencil');
  protected readonly color = signal('#8ec07c');
  /** Opacity of the pencil, `0..255`. */
  protected readonly alpha = signal(255);
  protected readonly showGuides = signal(true);
  /** Bumped by every edit, so the palette and the buttons re-read the buffer. */
  protected readonly revision = signal(0);

  /** Where the pointer was when it last painted, in image pixels. */
  private last: { x: number; y: number } | null = null;
  private painting = false;
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
    for (const color of [
      ...(this.sprite()?.palette(PALETTE_SIZE) ?? []),
      ...this.sharedPalette(),
    ]) {
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

  protected readonly gridZoom = GRID_ZOOM;

  // ----------------------------------------------------------------- actions

  protected setTool(tool: PixelTool): void {
    this.tool.set(tool);
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
    this.zoom.set(steppedZoom(this.zoom(), by));
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

  /** Empties the image. */
  protected clear(): void {
    const sprite = this.sprite();
    if (sprite === null) {
      return;
    }
    sprite.begin();
    for (let y = 0; y < sprite.height; y += 1) {
      for (let x = 0; x < sprite.width; x += 1) {
        sprite.plot(x, y, null);
      }
    }
    sprite.end();
    this.after();
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

    this.painting = true;
    sprite.begin();
    this.last = at;
    this.paintTo(at.x, at.y);
  }

  protected onPointerMove(event: PointerEvent): void {
    const at = this.pixelUnder(event);
    if (at === null || !this.painting) {
      return;
    }
    this.paintTo(at.x, at.y);
  }

  protected onPointerUp(): void {
    if (this.painting) {
      this.sprite()?.end();
      this.after();
    }
    this.painting = false;
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
    const x = Math.floor(((event.clientX - bounds.left) * drawnWidth) / bounds.width / this.zoom());
    const y = Math.floor(
      ((event.clientY - bounds.top) * drawnHeight) / bounds.height / this.zoom(),
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

    const geometry = this.geometry();
    if (this.showGuides() && geometry !== null) {
      drawGuides(context, geometry, this.kind(), zoom, {
        flat: this.i18n.t('ui.editor.asset.faces.flat'),
        surface: this.i18n.t('ui.editor.asset.faces.surface'),
        southWest: this.i18n.t('ui.editor.asset.faces.southWest'),
        southEast: this.i18n.t('ui.editor.asset.faces.southEast'),
      });
    }
  }
}

function isTyping(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * The next zoom up or down the ladder.
 *
 * Shared, because the file bar steps the zoom of whichever surface is open and
 * they all step through the same numbers
 * (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`).
 */
export function steppedZoom(from: number, by: number): number {
  const first = PIXEL_ZOOMS[0] ?? 1;
  const last = PIXEL_ZOOMS[PIXEL_ZOOMS.length - 1] ?? 1;
  const exact = PIXEL_ZOOMS.indexOf(from);
  if (exact >= 0) {
    return PIXEL_ZOOMS[Math.max(0, Math.min(PIXEL_ZOOMS.length - 1, exact + by))] ?? from;
  }
  // Off the ladder — a *fitted* zoom is whatever the panel worked out — so the
  // first step in the direction asked, rather than index arithmetic that would
  // skip one on the way up.
  return by > 0
    ? (PIXEL_ZOOMS.find((step) => step > from) ?? last)
    : ([...PIXEL_ZOOMS].reverse().find((step) => step < from) ?? first);
}
