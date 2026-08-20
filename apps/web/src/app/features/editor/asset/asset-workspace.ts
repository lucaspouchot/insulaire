/**
 * The frame every asset category is edited in.
 *
 * A layout component: the category rail with the open category's list under it,
 * the scene, a draggable divider, and the inspector
 * (`docs/adr/ADR-0039-one-editor-for-everything-drawn.md`).
 *
 * ```text
 * ┌───────────┬──────────────────────────┬──────────────┐
 * │ Tiles     │ toolbar — file, save     │              │
 * │ Characters├──────────────────────────┼──────────────┤
 * │ Objects   │                          │              │
 * ├───────────┤          scene           ║  inspector   │
 * │ <search>  │                          ║              │
 * │ Grass     │                          ║              │
 * │ Dirt      │                          ║              │
 * └───────────┴──────────────────────────┴──────────────┘
 * ```
 *
 * Two things it does *not* do any more, both because they cost the scene the
 * height and width it needs:
 *
 * **No bottom dock.** A strip along the bottom took two hundred pixels off
 * every screen to hold something only one category had a use for, and a figure
 * 128 pixels tall at a readable zoom did not fit in what was left. What was in
 * it went back where it belongs: the timeline is an inspector tab, and a tile's
 * hexagon shares the scene with the pixels.
 *
 * **No column of its own for the list.** The rail is a column already, and
 * a list of characters is three words wide; stacking them buys the scene the
 * whole 240 pixels the list used to hold.
 *
 * The divider is the answer to the proportions being wrong in both directions
 * at once: an animation timeline wants a wide inspector, a figure wants a wide
 * scene, and the author is the one who knows which they are doing.
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { TranslatePipe } from '../../../i18n/translate.pipe';
import { ASSET_CATEGORIES } from './asset-categories';

/** How narrow and how wide the inspector may be dragged, in CSS pixels. */
const INSPECTOR_MIN = 280;
const INSPECTOR_MAX = 900;

/** What it opens at: enough for a layer list without starving the scene. */
const INSPECTOR_DEFAULT = 420;

@Component({
  selector: 'app-asset-workspace',
  imports: [TranslatePipe, RouterLink, RouterLinkActive],
  templateUrl: './asset-workspace.html',
  styleUrl: './asset-workspace.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssetWorkspace {
  private readonly host = inject(ElementRef<HTMLElement>);

  /**
   * Whether this category fills the inspector at all.
   *
   * A placeholder has nothing to put there, and an empty column with a drag
   * handle beside it invites an author to resize nothing.
   */
  readonly hasInspector = input(true);

  protected readonly categories = ASSET_CATEGORIES;

  private readonly width = signal(INSPECTOR_DEFAULT);
  private dragging = false;

  protected readonly inspectorWidth = computed(() => `${this.width()}px`);

  /**
   * The divider drags the inspector's *left* edge, so the width is measured
   * from the frame's right side rather than from the pointer's own movement —
   * a delta accumulates the rounding of every move event.
   */
  protected onDividerDown(event: PointerEvent): void {
    this.dragging = true;
    (event.target as Element).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  protected onDividerMove(event: PointerEvent): void {
    if (!this.dragging) {
      return;
    }
    const box = (this.host.nativeElement as HTMLElement).getBoundingClientRect();
    const next = box.right - event.clientX;
    this.width.set(Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, Math.round(next))));
  }

  protected onDividerUp(event: PointerEvent): void {
    this.dragging = false;
    (event.target as Element).releasePointerCapture?.(event.pointerId);
  }
}
