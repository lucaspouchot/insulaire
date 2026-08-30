/**
 * The pixel toolbar: the tools, the colour, the alpha, undo, zoom, the guides.
 *
 * Presentational and stateless. It holds no buffer and paints nothing — it
 * shows what its host's state is and reports what was clicked — which is what
 * lets the same bar sit over two very different surfaces: the flat image the
 * {@link PixelEditor} draws, and the composed figure a character is painted on
 * (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`,
 * `docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 *
 * It carries no zoom: that, the fit and the pixel grid live in the file bar,
 * above every surface, so an author finds them in one place whichever one is
 * open (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
 *
 * The guides are optional, because hex guides mean nothing over a cape. The
 * tools are not: a pencil means the same thing wherever this appears.
 */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { TranslatePipe } from '../../../i18n/translate.pipe';

/** The tools, in the order the toolbar shows them. */
export type PixelTool = 'pencil' | 'eraser' | 'picker';

/**
 * The tools, for a template to iterate.
 *
 * Three, and the list is the decision: a fill and a movable rectangular
 * selection were built for tiles and are gone again, because what an author
 * needs here is the last few pixels judged in place. Anything past that is a
 * real pixel editor and the import button (ADR-0028).
 */
export const PIXEL_TOOLS: readonly PixelTool[] = ['pencil', 'eraser', 'picker'];

@Component({
  selector: 'app-pixel-tools',
  imports: [TranslatePipe],
  templateUrl: './pixel-tools.html',
  styleUrl: './pixel-tools.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PixelTools {
  readonly tool = input.required<PixelTool>();
  readonly color = input.required<string>();
  /** Opacity of the pencil, `0..255`. */
  readonly alpha = input(255);
  readonly canUndo = input(false);
  readonly canRedo = input(false);

  /**
   * Which way the bar runs.
   *
   * `column` is a strip down the side of the surface, and it exists for one
   * reason: a horizontal bar over a composed character costs a hundred and
   * thirty pixels of the height the figure needs, and the figure is what the
   * author is judging (`docs/adr/ADR-0028-one-editor-for-everything-drawn.md`).
   * A flat image is wide and short, so it keeps the row.
   */
  readonly orientation = input<'row' | 'column'>('row');
  /** `false` when there is nothing open to paint on. */
  readonly enabled = input(true);

  /** Whether to offer the guide toggle at all. */
  readonly hasGuides = input(false);
  readonly showGuides = input(false);

  /** Label of the button that empties the image, or the selection in it. */
  readonly clearLabel = input('');

  /**
   * The colours on offer, most used first.
   *
   * The palette is part of the bar because it is part of the tool: a palette
   * made of the drawing rather than a fixed ramp is what keeps a composed
   * figure — or a tile set — on one set of tones (ADR-0028).
   */
  readonly palette = input<readonly string[]>([]);

  readonly toolPicked = output<PixelTool>();
  readonly colorPicked = output<string>();
  readonly alphaPicked = output<number>();
  readonly undone = output<void>();
  readonly redone = output<void>();
  readonly cleared = output<void>();
  readonly guidesToggled = output<void>();

  protected readonly tools = PIXEL_TOOLS;

  protected onColorInput(event: Event): void {
    this.colorPicked.emit((event.target as HTMLInputElement).value);
  }

  protected onAlphaInput(event: Event): void {
    this.alphaPicked.emit(Number((event.target as HTMLInputElement).value));
  }
}
